import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset, WorldEvent } from '../shared/types';
import { createApp } from './app';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { clone, project, SessionStore } from './store';
import { bindPromptContext } from './prompt-context';
import { knowledgeBoundary } from './knowledge-context';
import { publicPromptView, runtimeFingerprint } from './prompt-compiler';

type Candidate = { id: string; roleId: string; kind: 'speech' | 'action'; text: string };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Real engine, prompt compilation, state transactions and disk; no remote models. */
class FactProvider implements ModelProvider {
  calls: AgentRequest[] = [];
  role: (request: AgentRequest) => unknown = () => ({ public: { summary: 'ROLE_SUMMARY_ONLY', speech: ['An observable reply.'], actions: ['Raises a hand.'] }, proposals: [] });
  world: (request: AgentRequest) => unknown = () => result([]);
  prose: (request: AgentRequest) => unknown | Promise<unknown> = () => ({ title: 'Room', text: 'Rain taps on the window.', person: 'third', pov: 'limited' });
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request);
    if (request.kind === 'role') return this.role(request);
    if (request.kind === 'world') return this.world(request);
    if (request.kind === 'prose') return this.prose(request);
    throw new Error('Creator dispatch is outside this fixture');
  }
}
const input = (request: AgentRequest) => request.input as any;
const candidates = (request: AgentRequest): Candidate[] => input(request).behaviorCandidates;
const calls = (provider: FactProvider, kind: AgentRequest['kind']) => provider.calls.filter(call => call.kind === kind);
const result = (facts: unknown, changes: unknown[] = [], acceptedBehaviorIds: unknown[] = []) => ({ summary: 'AUTHOR_WORLD_SUMMARY', changes, facts, acceptedBehaviorIds });
const write = (value = 2) => ({ roleId: 'npc', key: 'energy', value });
const data = (event: WorldEvent) => event.data as any;
const committedKinds = new Set(['state-commit', 'state-transaction', 'world-adjudication', 'world-event', 'behavior-adjudication', 'role-behavior']);

async function fixture(configure: (card: CharacterCard, preset: Preset) => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'rp-world-facts-integration-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.id = 'world-facts-card'; preset.id = 'world-facts-preset';
  card.fields = [
    { key: 'energy', label: 'Energy', type: 'number', min: 0, max: 10, editable: true, audience: 'public' },
    { key: 'secret', label: 'Secret', type: 'string', editable: true, audience: 'author' },
    { key: 'ready', label: 'Ready', type: 'boolean', editable: true, audience: 'public', writableBy: 'derived' },
  ];
  card.world.variables = {};
  card.roles[0].state = { energy: 1, secret: 'PRIVATE_PLAYER', ready: false };
  card.roles[0].peers = ['npc'];
  card.roles.push({ id: 'npc', name: 'Keeper', persona: 'A station keeper.', goals: [], peers: ['player'], phase: 'active', presence: 'present', state: { energy: 1, secret: 'PRIVATE_NPC', ready: false }, knowledge: [] });
  configure(card, preset);
  const provider = new FactProvider();
  const service = await createApp({ dataRoot: root, provider, catalog: async () => ({ cards: [card], presets: [preset] }) });
  cleanups.push(service.close);
  const id = service.store.create(card, preset).id;
  let index = 0;
  const turn = async (action = 'Observe the room.', mode: 'action' | 'author' = 'action') => {
    const submitted = service.engine.submit(id, { requestId: `facts-${++index}`, expectedRevision: service.store.get(id).revision, action, mode });
    await service.engine.idle(id);
    return submitted.turnId;
  };
  return { ...service, root, id, provider, turn };
}

describe('sourced world facts through the real engine and persisted recovery', () => {
  it('supplies only state proposals in results and activates world lore from behavior text rather than role summaries', async () => {
    const f = await fixture(card => {
      card.modules = ['SUMMARY_KEYWORD', 'BEHAVIOR_KEYWORD'].map(key => ({
        id: `lore-${key}`, title: key, category: 'supplement', content: `${key}_LORE_CONTENT`, enabled: true,
        targets: ['world'], phase: 'coordinate', priority: 0, activation: { keys: [key] },
      }));
    });
    f.provider.role = () => ({
      public: { summary: 'SUMMARY_KEYWORD ROLE_PUBLIC_SUMMARY', speech: ['BEHAVIOR_KEYWORD spoken aloud.'], actions: ['An observable gesture.'] },
      summary: 'PRIVATE_LEGACY_SUMMARY', expression: 'PRIVATE_LEGACY_EXPRESSION', decisionMemo: 'PRIVATE_MEMO',
      proposals: [{ roleId: 'npc', key: 'energy', value: 2, extra: 'UNTRUSTED_EXTRA' }],
    });
    await f.turn();
    expect(f.store.get(f.id).turns.at(-1)?.status).toBe('completed');
    const world = calls(f.provider, 'world')[0];
    expect(input(world).results).toEqual([{ roleId: 'npc', proposals: [write()] }]);
    expect(candidates(world).map(candidate => candidate.text)).toEqual(['BEHAVIOR_KEYWORD spoken aloud.', 'An observable gesture.']);
    expect(JSON.stringify(world.input)).not.toMatch(/SUMMARY_KEYWORD|ROLE_PUBLIC_SUMMARY|PRIVATE_LEGACY|PRIVATE_MEMO|UNTRUSTED_EXTRA/);
    const compiled = world.system + JSON.stringify(world.promptLayout);
    expect(compiled).toContain('BEHAVIOR_KEYWORD_LORE_CONTENT');
    expect(compiled).not.toContain('SUMMARY_KEYWORD_LORE_CONTENT');
    const report = f.store.get(f.id).events.find(event => event.kind === 'role-result')!;
    expect(report.audience).toBe('author');
    expect(JSON.stringify(report)).toMatch(/ROLE_PUBLIC_SUMMARY/);
    expect(JSON.stringify(report)).toMatch(/PRIVATE_MEMO/);
    expect(JSON.stringify(report)).toMatch(/PRIVATE_LEGACY_SUMMARY/);
  });

  it('requires sourced facts in the live schema, ignores supplied legacy events and commits resolved sources with behavior and state in one save', async () => {
    const f = await fixture();
    let approved: Candidate;
    f.provider.world = request => {
      const schema = request.resultSchema as any;
      expect(schema.required).toEqual(expect.arrayContaining(['summary', 'changes', 'facts', 'acceptedBehaviorIds']));
      expect(schema.properties).not.toHaveProperty('events');
      approved = candidates(request)[0];
      return { ...result([
        { text: 'The keeper replies while holding two tokens.', sources: [{ kind: 'behavior', id: approved.id }, { kind: 'state', roleId: 'npc', key: 'energy' }] },
        { text: 'The clock strikes above the room.', sources: [{ kind: 'world-development' }] },
        { text: 'The player observes the room.', sources: [{ kind: 'player-action' }] },
      ], [write()], [approved.id]), events: ['LEGACY_EVENT_SMUGGLED'] };
    };
    const durableCommits: unknown[] = [], originalSave = f.store.save.bind(f.store);
    vi.spyOn(f.store, 'save').mockImplementation(session => {
      const before = f.store.get(session.id);
      if (session.revision > before.revision) durableCommits.push(clone(session));
      return originalSave(session);
    });
    f.provider.prose = async request => {
      const disk = JSON.parse(await readFile(join(f.root, `session-${f.id}.json`), 'utf8'));
      expect(disk.revision).toBe(1);
      expect(disk.roles.find((role: any) => role.id === 'npc').state.energy).toBe(2);
      expect(disk.events.filter((event: WorldEvent) => event.kind === 'role-behavior').map(data)).toEqual([approved]);
      expect(disk.events.filter((event: WorldEvent) => event.kind === 'world-event')).toHaveLength(3);
      expect(input(request).acceptedBehaviors).toEqual([approved]);
      expect(JSON.stringify(request)).not.toMatch(/AUTHOR_WORLD_SUMMARY|LEGACY_EVENT_SMUGGLED|ROLE_SUMMARY_ONLY/);
      return { title: 'Tokens', text: 'The keeper replies.', person: 'third', pov: 'limited' };
    };
    await f.turn();
    const session = f.store.get(f.id), publicFacts = session.events.filter(event => event.kind === 'world-event');
    expect(session.turns.at(-1)?.status).toBe('completed');
    expect(durableCommits).toHaveLength(1);
    expect((durableCommits[0] as any).events.filter((event: WorldEvent) => committedKinds.has(event.kind)).map((event: WorldEvent) => event.kind)).toEqual(expect.arrayContaining(['world-event', 'world-adjudication', 'state-transaction', 'behavior-adjudication', 'role-behavior']));
    expect(publicFacts[0]).toMatchObject({ audience: 'public', text: 'The keeper replies while holding two tokens.', data: { fact: { text: 'The keeper replies while holding two tokens.', sources: [
      { kind: 'behavior', id: approved!.id },
      expect.objectContaining({ kind: 'state', roleId: 'npc', key: 'energy', value: 2 }),
    ] } } });
    expect(data(publicFacts[1]).fact.sources).toEqual([expect.objectContaining({ kind: 'world-development' })]);
    expect(data(publicFacts[2]).fact.sources).toEqual([expect.objectContaining({ kind: 'player-action' })]);
    expect(session.events.find(event => event.kind === 'world-adjudication')).toMatchObject({ audience: 'author', text: 'AUTHOR_WORLD_SUMMARY' });
    expect(JSON.stringify(project(session, 'player'))).not.toMatch(/AUTHOR_WORLD_SUMMARY|LEGACY_EVENT_SMUGGLED/);
  });

  it('treats an explicit empty facts list as authoritative and rejects malformed facts instead of falling back to events', async () => {
    for (const facts of [[], null, 'invalid', [{ text: 'Unsupported', sources: [] }], [{ text: 'Unsupported', sources: [{ kind: 'made-up' }] }]]) {
      const f = await fixture();
      f.provider.world = () => ({ ...result(facts, [write()]), events: ['LEGACY_FALLBACK_IS_FORBIDDEN'] });
      await f.turn();
      const session = f.store.get(f.id);
      expect(calls(f.provider, 'world')).toHaveLength(1);
      if (Array.isArray(facts) && facts.length === 0) {
        expect(session.turns.at(-1)?.status).toBe('completed');
        expect(session.revision).toBe(1);
        expect(session.events.filter(event => event.kind === 'world-event')).toEqual([]);
        expect(JSON.stringify(calls(f.provider, 'prose')[0])).not.toMatch(/AUTHOR_WORLD_SUMMARY|LEGACY_FALLBACK/);
      } else {
        expect(session.turns.at(-1)?.status).toBe('failed');
        expect(session.revision).toBe(0);
        expect(session.roles.find(role => role.id === 'npc')!.state.energy).toBe(1);
        expect(session.events.filter(event => committedKinds.has(event.kind))).toEqual([]);
        expect(calls(f.provider, 'prose')).toEqual([]);
      }
    }
  });

  it('rolls back approved behavior, public facts and a valid state write when any source is unknown, unapproved, private or unavailable', async () => {
    for (const invalid of ['unknown-behavior', 'unapproved-behavior', 'private-state', 'unknown-state', 'unknown-role', 'unavailable-opening'] as const) {
      const f = await fixture();
      f.provider.world = request => {
        const proposed = candidates(request), source = {
          'unknown-behavior': { kind: 'behavior', id: 'never-issued' },
          'unapproved-behavior': { kind: 'behavior', id: proposed[1].id },
          'private-state': { kind: 'state', roleId: 'npc', key: 'secret' },
          'unknown-state': { kind: 'state', roleId: 'npc', key: 'undeclared' },
          'unknown-role': { kind: 'state', roleId: 'ghost', key: 'energy' },
          'unavailable-opening': { kind: 'opening-setup' },
        }[invalid];
        return result([
          { text: 'A valid scene fact.', sources: [{ kind: 'behavior', id: proposed[0].id }] },
          { text: 'An invalid scene fact.', sources: [source] },
        ], [write()], [proposed[0].id]);
      };
      await f.turn();
      const session = f.store.get(f.id);
      expect(calls(f.provider, 'world'), invalid).toHaveLength(1);
      expect(session.turns.at(-1)?.status, invalid).toBe('failed');
      expect(session.revision, invalid).toBe(0);
      expect(session.roles.find(role => role.id === 'npc')!.state.energy, invalid).toBe(1);
      expect(session.events.filter(event => committedKinds.has(event.kind)), invalid).toEqual([]);
      expect(calls(f.provider, 'prose'), invalid).toEqual([]);
      const disk = JSON.parse(await readFile(join(f.root, `session-${f.id}.json`), 'utf8'));
      expect(disk.revision, invalid).toBe(0);
      expect(disk.events.filter((event: WorldEvent) => committedKinds.has(event.kind)), invalid).toEqual([]);
    }
  });

  it('resolves public state sources from the final derived transaction and rolls back facts alongside an invalid state batch', async () => {
    const f = await fixture(card => {
      card.stateRules = [{ id: 'ready-after-energy', type: 'transition', trigger: { roleId: 'npc', key: 'energy' }, when: { path: 'trigger.after', equals: 2 }, effects: [{ type: 'set', roleId: '$trigger', key: 'ready', value: true }] }];
    });
    f.provider.world = () => result([{ text: 'The keeper is ready.', sources: [{ kind: 'state', roleId: 'npc', key: 'ready' }] }], [write()]);
    const turnId = await f.turn(), committed = clone(f.store.get(f.id));
    expect(committed.turns.at(-1)?.status).toBe('completed');
    expect(committed.roles.find(role => role.id === 'npc')!.state.ready).toBe(true);
    const fact = committed.events.find(event => event.kind === 'world-event' && event.turnId === turnId)!;
    expect(data(fact).fact.sources).toEqual([expect.objectContaining({ kind: 'state', roleId: 'npc', key: 'ready', value: true })]);
    expect(JSON.stringify(calls(f.provider, 'prose')[0])).not.toContain('PRIVATE_NPC');
    f.provider.world = request => result([{ text: 'A public fact.', sources: [{ kind: 'behavior', id: candidates(request)[0].id }] }], [write(99)], [candidates(request)[0].id]);
    const failedId = await f.turn(), failed = f.store.get(f.id);
    expect(failed.turns.at(-1)?.status).toBe('failed');
    expect(failed.revision).toBe(committed.revision);
    expect(failed.roles).toEqual(committed.roles);
    expect(failed.events.filter(event => event.turnId === failedId && committedKinds.has(event.kind))).toEqual([]);
    expect(calls(f.provider, 'prose')).toHaveLength(1);
  });

  it('rejects a previous turn behavior source and consumes opening setup authority only after the first committed world turn', async () => {
    const f = await fixture(card => {
      card.initialization = {
        schema: 'rp.initialization/0.1',
        openings: [{ id: 'station', title: 'Station', text: 'The station door is shut.', instruction: 'Old private premise.', delivery: { world: 'Place a sealed parcel on the table.' }, cast: card.roles.map(role => ({ roleId: role.id, phase: role.phase, presence: role.presence })) }],
        playerProfiles: [{ id: 'traveler', title: 'Traveler', name: 'Traveler', persona: 'A traveler.' }],
      };
    });
    let oldBehavior = '';
    f.provider.world = request => {
      expect(input(request).openingSetup).toMatchObject({ openingId: 'station' });
      oldBehavior = candidates(request)[0].id;
      return result([{ text: 'A sealed parcel lies on the table.', sources: [{ kind: 'opening-setup' }] }], [], [oldBehavior]);
    };
    await f.turn();
    const before = clone(f.store.get(f.id));
    expect(before.turns.at(-1)?.status).toBe('completed');
    expect(data(before.events.find(event => event.kind === 'world-event')!).fact.sources).toEqual([expect.objectContaining({ kind: 'opening-setup' })]);
    for (const source of [{ kind: 'behavior', id: oldBehavior }, { kind: 'opening-setup' }]) {
      f.provider.world = request => {
        expect(input(request)).not.toHaveProperty('openingSetup');
        expect(candidates(request).some(candidate => candidate.id === oldBehavior)).toBe(false);
        return result([{ text: 'Stale authority.', sources: [source] }], [write(3)], [candidates(request)[0].id]);
      };
      const turnId = await f.turn(), session = f.store.get(f.id);
      expect(session.turns.at(-1)?.status).toBe('failed');
      expect(session.revision).toBe(before.revision);
      expect(session.roles).toEqual(before.roles);
      expect(session.events.filter(event => event.turnId === turnId && committedKinds.has(event.kind))).toEqual([]);
    }
    expect(calls(f.provider, 'prose')).toHaveLength(1);
  });

  it('accepts legacy events only when facts is omitted and records an author warning without publishing its summary', async () => {
    const f = await fixture();
    f.provider.world = () => ({ summary: 'LEGACY_AUTHOR_SUMMARY', changes: [write()], events: ['A public legacy bell rings.'], acceptedBehaviorIds: [] });
    await f.turn();
    const session = f.store.get(f.id);
    expect(session.turns.at(-1)?.status).toBe('completed');
    expect(session.events.filter(event => event.kind === 'world-event')).toEqual([expect.objectContaining({ audience: 'public', text: 'A public legacy bell rings.' })]);
    const warning = session.events.find(event => event.kind === 'world-facts')!;
    expect(warning.audience).toBe('author');
    expect(data(warning).mode).toBe('legacy');
    expect(data(warning).diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'warning' })]));
    expect(JSON.stringify(calls(f.provider, 'prose')[0])).toContain('A public legacy bell rings.');
    expect(JSON.stringify(calls(f.provider, 'prose')[0])).not.toContain('LEGACY_AUTHOR_SUMMARY');
    expect(JSON.stringify(project(session, 'player'))).not.toContain('LEGACY_AUTHOR_SUMMARY');
  });

  it('recovers after a prose failure and restart from public facts without trusting author summaries or old public adjudication summaries', async () => {
    const f = await fixture();
    f.provider.world = request => result([{ text: 'The keeper answers the player.', sources: [{ kind: 'behavior', id: candidates(request)[0].id }] }], [write()], [candidates(request)[0].id]);
    f.provider.prose = () => { throw new Error('Deterministic writer failure'); };
    const materialTurn = await f.turn(), committed = clone(f.store.get(f.id));
    expect(committed.turns.at(-1)).toMatchObject({ status: 'failed', phase: 'compose-failed' });
    expect(committed.revision).toBe(1);
    await f.engine.close();
    const reopened = new SessionStore(f.root), poisoned = clone(reopened.get(f.id));
    const adjudication = poisoned.events.find(event => event.kind === 'world-adjudication' && event.turnId === materialTurn)!;
    // Older persisted sessions may still carry the former public summary event.
    adjudication.audience = 'public'; adjudication.text = 'POISONED_PUBLIC_ADJUDICATION_SUMMARY';
    const report = poisoned.events.find(event => event.kind === 'role-result')!;
    report.text = 'POISONED_ROLE_SUMMARY'; report.data = { expression: 'POISONED_ROLE_EXPRESSION' };
    reopened.save(poisoned);
    const recovery = new FactProvider(), engine = new TurnEngine(reopened, recovery);
    cleanups.push(() => engine.close());
    expect(recovery.calls).toEqual([]);
    engine.submit(f.id, { requestId: 'recover-public-facts', expectedRevision: 1, action: 'Recompose the committed scene.', mode: 'author' });
    await engine.idle(f.id);
    expect(recovery.calls.map(request => request.kind)).toEqual(['prose']);
    const material = input(recovery.calls[0]);
    expect(material.events.filter((event: WorldEvent) => event.kind === 'world-event')).toEqual(committed.events.filter(event => event.kind === 'world-event'));
    expect(material.acceptedBehaviors).toEqual(input(calls(f.provider, 'prose')[0]).acceptedBehaviors);
    expect(JSON.stringify(recovery.calls[0])).not.toMatch(/POISONED|AUTHOR_WORLD_SUMMARY|ROLE_SUMMARY_ONLY/);
    expect(reopened.get(f.id).revision).toBe(1);
    expect(reopened.get(f.id).turns.at(-1)?.status).toBe('completed');
    // With no public facts in an old session, recovery still cannot use a summary fallback.
    const empty = clone(reopened.get(f.id));
    empty.events = empty.events.filter(event => event.kind !== 'world-event');
    reopened.save(empty);
    engine.submit(f.id, { requestId: 'recover-without-facts', expectedRevision: 1, action: 'Recompose again.', mode: 'author' });
    await engine.idle(f.id);
    expect(input(recovery.calls.at(-1)!).events.some((event: WorldEvent) => ['world-adjudication', 'world-event', 'world-facts'].includes(event.kind))).toBe(false);
    expect(JSON.stringify(recovery.calls.at(-1))).not.toContain('POISONED');
  });

  it('rebinds an actual pre-facts prose fingerprint after restart even when its system and admitted modules are unchanged', async () => {
    const f = await fixture(card => {
      card.modules = [{ id: 'quiet-prose', title: 'Quiet prose', category: 'style', content: 'Keep each sentence quiet and concrete.', enabled: true, targets: ['prose'], phase: 'compose', priority: 0 }];
    });
    f.provider.world = () => result([{ text: 'A bell rings.', sources: [{ kind: 'world-development' }] }]);
    await f.turn();
    const committed = clone(f.store.get(f.id));
    expect(committed.turns.at(-1)?.status).toBe('completed');
    const firstProse = calls(f.provider, 'prose')[0];
    const selection = committed.events.findLast(event => event.kind === 'prompt-selection' && event.actor === 'prose')!;
    const refs = data(selection).plan.modules.map((module: any) => module.ref);
    expect(refs).toHaveLength(1);
    expect(committed.card.outputs ?? []).toEqual([]);
    expect(committed.preset.outputs ?? []).toEqual([]);
    expect(input(firstProse)).not.toHaveProperty('openingDelivery');
    // This is the complete previous release's admitted-context structure. It
    // uses the actual dispatched system/layout and executed prompt plan refs.
    const oldContext = {
      system: firstProse.system, layout: firstProse.promptLayout, refs,
      fields: publicPromptView(committed).fields,
      knowledgeBoundary: knowledgeBoundary(committed, 'public'), outputs: [], openingDelivery: undefined,
    };
    const oldFingerprint = runtimeFingerprint(oldContext);
    const currentFingerprint = runtimeFingerprint({ ...oldContext, publicFactsContract: 'rp.world-facts/public-references-0.1' });
    expect(committed.promptContexts!.prose.fingerprint).toBe(currentFingerprint);
    expect(currentFingerprint).not.toBe(oldFingerprint);
    expect(committed.prose.at(-1)!.text).not.toBe('');
    await f.engine.close();
    const legacyBinding = bindPromptContext(f.store, f.id, 'prose', `${f.id}-prose`, oldFingerprint);
    expect(bindPromptContext(f.store, f.id, 'prose', `${f.id}-prose`, oldFingerprint).changed).toBe(false);
    const legacy = clone(f.store.get(f.id));
    expect(legacy.promptContexts!.prose.fingerprint).toBe(oldFingerprint);
    const originalWorldBinding = clone(legacy.promptContexts!.world);
    const originalRoleBinding = clone(legacy.promptContexts!['role:npc']);
    const oldSummary = legacy.events.find(event => event.kind === 'world-adjudication')!;
    oldSummary.audience = 'public'; oldSummary.text = 'OLD_NATIVE_WORLD_SUMMARY';
    f.store.save(legacy);

    const reopened = new SessionStore(f.root), recovery = new FactProvider(), engine = new TurnEngine(reopened, recovery);
    cleanups.push(() => engine.close());
    expect(reopened.get(f.id).promptContexts!.prose).toMatchObject({ fingerprint: oldFingerprint, sessionId: legacyBinding.sessionId, generation: legacyBinding.generation });
    engine.submit(f.id, { requestId: 'migrate-prose-facts-context', expectedRevision: 1, action: 'Recompose the scene.', mode: 'author' });
    await engine.idle(f.id);
    expect(recovery.calls.map(request => request.kind)).toEqual(['prose']);
    const request = recovery.calls[0], migrated = reopened.get(f.id);
    expect(request.system).toBe(firstProse.system);
    expect(request.promptLayout).toEqual(firstProse.promptLayout);
    expect(request.sessionId).not.toBe(legacyBinding.sessionId);
    expect(migrated.promptContexts!.prose).toMatchObject({ fingerprint: currentFingerprint, generation: legacyBinding.generation + 1, sessionId: request.sessionId });
    expect(input(request).previousProse).toBe('');
    expect(JSON.stringify(request)).not.toContain('OLD_NATIVE_WORLD_SUMMARY');
    expect(migrated.promptContexts!.world).toEqual(originalWorldBinding);
    expect(migrated.promptContexts!['role:npc']).toEqual(originalRoleBinding);
    expect(migrated.revision).toBe(1);
    expect(migrated.turns.at(-1)?.status).toBe('completed');
    expect(migrated.events.filter(event => event.kind === 'world-facts')).toHaveLength(1);
  });

});
