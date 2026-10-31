import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset, WorldEvent } from '../shared/types';
import { createApp } from './app';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { clone, project, SessionStore } from './store';

type Candidate = { id: string; roleId: string; kind: 'speech' | 'action'; text: string };
const roots: string[] = [], cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** Real host dispatch and persistence terminate at this local, deterministic provider. */
class BehaviorProvider implements ModelProvider {
  calls: AgentRequest[] = [];
  role?: (request: AgentRequest) => unknown | Promise<unknown>;
  world?: (request: AgentRequest) => unknown | Promise<unknown>;
  prose?: (request: AgentRequest) => unknown | Promise<unknown>;
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request);
    if (request.kind === 'role') return this.role ? this.role(request) : {
      public: { summary: 'PROPOSED_ROLE_SUMMARY', speech: ['PROPOSED_SPEECH'], actions: ['PROPOSED_ACTION'] }, proposals: [],
    };
    if (request.kind === 'world') return this.world ? this.world(request) : {
      summary: 'The room remains quiet.', changes: [], events: ['Rain falls outside.'], acceptedBehaviorIds: [],
    };
    if (request.kind === 'prose') return this.prose ? this.prose(request) : {
      title: 'Rain', text: 'Rain taps against the window.', person: 'third', pov: 'limited',
    };
    throw new Error('Creator dispatch is outside this fixture');
  }
}

async function fixture(twoRoles = false) {
  const root = await mkdtemp(join(tmpdir(), 'rp-behavior-integration-')); roots.push(root);
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.id = 'behavior-card'; preset.id = 'behavior-preset';
  card.fields = [{ key: 'energy', label: 'Energy', type: 'number', min: 0, max: 10, editable: true, audience: 'public' }];
  for (const id of twoRoles ? ['a', 'b'] : ['a']) card.roles.push({
    id, name: id.toUpperCase(), persona: 'An observant visitor.', goals: [], peers: twoRoles ? [id === 'a' ? 'b' : 'a'] : [],
    phase: 'active', presence: 'present', state: { energy: 1 }, knowledge: [],
  });
  const provider = new BehaviorProvider();
  const service = await createApp({ dataRoot: root, provider, catalog: async () => ({ cards: [card], presets: [preset] }) });
  cleanups.push(service.close);
  const id = service.store.create(card, preset).id;
  let index = 0;
  const turn = async (mode: 'action' | 'author' = 'action') => {
    const result = service.engine.submit(id, { requestId: `behavior-${++index}`, expectedRevision: service.store.get(id).revision,
      action: mode === 'author' ? 'Recompose the committed scene.' : 'Observe the room.', mode });
    await service.engine.idle(id);
    return result.turnId;
  };
  return { ...service, root, id, provider, turn };
}

const input = (request: AgentRequest) => request.input as any;
const candidates = (request: AgentRequest): Candidate[] => input(request).behaviorCandidates;
const calls = (provider: BehaviorProvider, kind: AgentRequest['kind']) => provider.calls.filter(call => call.kind === kind);
const data = (event: WorldEvent) => event.data as any;
const worldResult = (acceptedBehaviorIds: unknown, changes: unknown[] = []) => ({
  summary: 'The scene is adjudicated.', changes, events: ['A clock ticks.'], acceptedBehaviorIds,
});
const energyWrite = (value = 2) => ({ roleId: 'a', key: 'energy', value });
const committedKinds = new Set(['state-commit', 'state-transaction', 'world-adjudication', 'world-event', 'behavior-adjudication', 'role-behavior']);

describe('world-approved role behavior across host dispatch and durable recovery', () => {
  it('advertises only the two required role result fields while retaining legacy operational memo audit', async () => {
    const f = await fixture();
    f.provider.role = () => ({ public: { summary: 'A visitor waits.', speech: [], actions: [] }, proposals: [], decisionMemo: 'LEGACY_OPERATIONAL_NOTE' });
    await f.turn();
    const role = calls(f.provider, 'role')[0];
    const schema = role.resultSchema as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    expect(Object.keys(schema.properties)).toEqual(['public', 'proposals']);
    expect(schema.required).toEqual(['public', 'proposals']);
    expect(schema.additionalProperties).toBe(false);
    expect(role.system).toContain('Return exactly public and proposals, with no other fields.');
    expect(f.store.get(f.id).events.some(event => event.kind === 'role-result' && data(event)?.decisionMemo === 'LEGACY_OPERATIONAL_NOTE' && event.audience === 'author')).toBe(true);
    expect(JSON.stringify(project(f.store.get(f.id), 'player'))).not.toContain('LEGACY_OPERATIONAL_NOTE');
    expect(calls(f.provider, 'world').concat(calls(f.provider, 'prose')).every(request => !JSON.stringify(request.input).includes('LEGACY_OPERATIONAL_NOTE'))).toBe(true);
    const prose = input(calls(f.provider, 'prose')[0]);
    const publicFacts = f.store.get(f.id).events.filter(event => event.kind === 'world-event' && event.audience === 'public' && event.turnId === f.store.get(f.id).turns.at(-1)?.id);
    expect(publicFacts).toHaveLength(1);
    expect(prose.narrationBrief.evidence.factEventIds).toEqual(publicFacts.map(event => event.id));
  });
  it('commits an interleaved two-role subset in world approval order, with matching prose and one durable transaction', async () => {
    const f = await fixture(true);
    f.provider.role = async request => {
      const delivery = input(request).delivery, send = request.tools.find(tool => tool.name === 'peer_send')!;
      if (delivery.to === 'a' && delivery.kind === 'host') await send.execute({
        to: 'b', key: 'ask-b', kind: 'request', replyTo: null, body: 'PRIVATE_PEER_REQUEST',
      });
      if (delivery.to === 'b' && delivery.kind === 'request') await send.execute({
        to: 'a', key: 'answer-a', kind: 'reply', replyTo: delivery.id, body: 'PRIVATE_PEER_REPLY',
      });
      const tag = `${delivery.to}-${delivery.kind}`;
      return { public: { summary: `SUMMARY_${tag}`, speech: [`SPEECH_${tag}`], actions: [`ACTION_${tag}`] }, proposals: [] };
    };
    let approved: Candidate[] = [];
    f.provider.world = request => {
      const proposed = candidates(request);
      expect(proposed.map(item => item.text)).toEqual([
        'SPEECH_a-host', 'ACTION_a-host', 'SPEECH_b-host', 'ACTION_b-host',
        'SPEECH_b-request', 'ACTION_b-request', 'SPEECH_a-reply', 'ACTION_a-reply',
      ]);
      expect(new Set(proposed.map(item => item.id)).size).toBe(proposed.length);
      expect(proposed.every(item => item.id && Object.keys(item).sort().join(',') === 'id,kind,roleId,text')).toBe(true);
      approved = [proposed[7], proposed[0], proposed[4]];
      return worldResult(approved.map(item => item.id), [energyWrite()]);
    };
    f.provider.prose = async request => {
      // The writer is invoked only after all approval records and state are durable.
      const durable = JSON.parse(await readFile(join(f.root, `session-${f.id}.json`), 'utf8'));
      expect(durable.revision).toBe(1);
      expect(durable.roles.find((role: any) => role.id === 'a').state.energy).toBe(2);
      expect(durable.events.filter((event: WorldEvent) => event.kind === 'role-behavior').map(data)).toEqual(approved);
      expect(input(request).acceptedBehaviors).toEqual(approved);
      expect(input(request).expressions).toEqual([
        { roleId: 'a', text: 'SPEECH_a-host', speech: ['SPEECH_a-host'], actions: ['ACTION_a-reply'] },
        { roleId: 'b', text: 'SPEECH_b-request', speech: ['SPEECH_b-request'], actions: [] },
      ]);
      return { title: 'Approved scene', text: 'A clock ticks.', person: 'third', pov: 'limited' };
    };
    const turnId = await f.turn(), session = f.store.get(f.id);
    expect(session.turns.at(-1)?.status).toBe('completed');
    expect(calls(f.provider, 'role').map(request => input(request).delivery.to)).toEqual(['a', 'b', 'b', 'a']);
    const approval = session.events.find(event => event.kind === 'behavior-adjudication')!;
    expect(approval).toMatchObject({ audience: 'author', turnId });
    expect(data(approval)).toMatchObject({ candidates: candidates(calls(f.provider, 'world')[0]), acceptedBehaviorIds: approved.map(item => item.id) });
    expect(session.events.filter(event => event.kind === 'role-behavior')).toEqual(approved.map(item => expect.objectContaining({
      audience: 'public', turnId, actor: item.roleId, text: item.text, data: item,
    })));
  });

  it('keeps rejected speech, actions, summaries, memos and legacy internals out of prose while retaining author diagnostics', async () => {
    const f = await fixture();
    f.provider.role = () => ({
      public: { summary: 'UNAPPROVED_PUBLIC_SUMMARY', speech: ['DENIED_SPEECH'], actions: ['DENIED_ACTION'] },
      decisionMemo: 'PRIVATE_OPERATIONAL_MEMO', summary: 'LEGACY_INTERNAL_SUMMARY', expression: 'LEGACY_INTERNAL_EXPRESSION', proposals: [],
    });
    await f.turn();
    const writer = calls(f.provider, 'prose')[0], world = calls(f.provider, 'world')[0];
    expect(input(writer).acceptedBehaviors).toEqual([]); expect(input(writer).expressions).toEqual([]);
    expect(JSON.stringify(writer)).not.toMatch(/UNAPPROVED_PUBLIC_SUMMARY|DENIED_SPEECH|DENIED_ACTION|PRIVATE_OPERATIONAL_MEMO|LEGACY_INTERNAL/);
    expect(JSON.stringify(world)).not.toMatch(/PRIVATE_OPERATIONAL_MEMO|LEGACY_INTERNAL/);
    const diagnostic = f.store.get(f.id).events.find(event => event.kind === 'role-result')!;
    expect(diagnostic.audience).toBe('author');
    expect(JSON.stringify(diagnostic)).toContain('DENIED_SPEECH');
    expect(JSON.stringify(diagnostic)).toContain('UNAPPROVED_PUBLIC_SUMMARY');
    expect(JSON.stringify(diagnostic)).toContain('PRIVATE_OPERATIONAL_MEMO');
    expect(JSON.stringify(diagnostic)).toContain('LEGACY_INTERNAL_SUMMARY');
    expect(JSON.stringify(diagnostic)).toContain('LEGACY_INTERNAL_EXPRESSION');
    expect(JSON.stringify(project(f.store.get(f.id), 'player'))).not.toMatch(/DENIED_SPEECH|DENIED_ACTION|UNAPPROVED_PUBLIC_SUMMARY|PRIVATE_OPERATIONAL_MEMO|LEGACY_INTERNAL/);
    expect(f.store.get(f.id).events.filter(event => event.kind === 'role-behavior')).toEqual([]);
  });

  it('turns only a legacy role expression into an approvable speech candidate, never its summary', async () => {
    const f = await fixture();
    f.provider.role = () => ({ summary: 'LEGACY_SUMMARY_IS_NOT_BEHAVIOR', expression: 'LEGACY_OBSERVABLE_REPLY', proposals: [] });
    f.provider.world = request => {
      expect(candidates(request)).toEqual([expect.objectContaining({ roleId: 'a', kind: 'speech', text: 'LEGACY_OBSERVABLE_REPLY' })]);
      return worldResult(candidates(request).map(item => item.id));
    };
    await f.turn();
    expect(f.store.get(f.id).turns.at(-1)?.status).toBe('completed');
    expect(input(calls(f.provider, 'prose')[0]).acceptedBehaviors).toEqual(candidates(calls(f.provider, 'world')[0]));
    expect(JSON.stringify(calls(f.provider, 'prose')[0])).not.toContain('LEGACY_SUMMARY_IS_NOT_BEHAVIOR');
  });

  it('requires approval in the live world schema and fails closed with a private warning for legacy omitted approval', async () => {
    const f = await fixture();
    f.provider.world = request => {
      expect((request.resultSchema as any).required).toContain('acceptedBehaviorIds');
      expect((request.resultSchema as any).properties.acceptedBehaviorIds).toMatchObject({ type: 'array', items: { type: 'string' } });
      expect(candidates(request)).toHaveLength(2);
      return { summary: 'Legacy scene.', changes: [energyWrite()], events: ['A bell rings.'] };
    };
    await f.turn();
    const session = f.store.get(f.id), approval = session.events.find(event => event.kind === 'behavior-adjudication')!;
    expect(session.turns.at(-1)?.status).toBe('completed'); expect(session.revision).toBe(1);
    expect(data(approval).acceptedBehaviorIds).toEqual([]);
    expect(data(approval).diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'warning' })]));
    expect(approval.audience).toBe('author');
    expect(input(calls(f.provider, 'prose')[0]).acceptedBehaviors).toEqual([]);
    expect(input(calls(f.provider, 'prose')[0]).expressions).toEqual([]);
    expect(session.events.some(event => event.kind === 'role-behavior')).toBe(false);
  });

  it('rejects malformed, unknown and duplicate approvals before committing an otherwise valid state batch', async () => {
    for (const invalid of ['null', 'string', 'mixed', 'unknown', 'duplicate'] as const) {
      const f = await fixture();
      f.provider.world = request => {
        const id = candidates(request)[0].id;
        const approval = { null: null, string: id, mixed: [id, 7], unknown: ['unissued-behavior-id'], duplicate: [id, id] }[invalid];
        return worldResult(approval, [energyWrite()]);
      };
      await f.turn();
      const session = f.store.get(f.id);
      expect(session.turns.at(-1)?.status, invalid).toBe('failed');
      expect(session.revision, invalid).toBe(0);
      expect(session.roles.find(role => role.id === 'a')!.state.energy, invalid).toBe(1);
      expect(session.events.filter(event => committedKinds.has(event.kind)), invalid).toEqual([]);
      expect(calls(f.provider, 'prose'), invalid).toEqual([]);
      expect(session.events.some(event => event.kind === 'role-result'), invalid).toBe(true);
    }
  });

  it('rolls back valid behavior approval together with an invalid world state change', async () => {
    const f = await fixture();
    f.provider.world = request => worldResult(candidates(request).map(item => item.id), [energyWrite(99)]);
    await f.turn();
    const session = f.store.get(f.id);
    expect(session.turns.at(-1)?.status).toBe('failed'); expect(session.revision).toBe(0);
    expect(session.roles.find(role => role.id === 'a')!.state.energy).toBe(1);
    expect(session.events.filter(event => committedKinds.has(event.kind))).toEqual([]);
    expect(calls(f.provider, 'prose')).toEqual([]);
  });

  it('rejects an earlier turn ID even when that exact behavior was previously approved', async () => {
    const f = await fixture();
    f.provider.world = request => worldResult([candidates(request)[0].id], [energyWrite()]);
    const priorTurn = await f.turn(), prior = clone(f.store.get(f.id));
    const pastId = candidates(calls(f.provider, 'world')[0])[0].id;
    f.provider.world = request => {
      expect(candidates(request).some(item => item.id === pastId)).toBe(false);
      return worldResult([pastId], [energyWrite(3)]);
    };
    const failedTurn = await f.turn(), session = f.store.get(f.id);
    expect(session.turns.at(-1)?.status).toBe('failed'); expect(session.revision).toBe(prior.revision);
    expect(session.roles).toEqual(prior.roles);
    expect(session.events.filter(event => event.turnId === failedTurn && committedKinds.has(event.kind))).toEqual([]);
    expect(session.events.filter(event => event.turnId === priorTurn && committedKinds.has(event.kind))).toEqual(prior.events.filter(event => event.turnId === priorTurn && committedKinds.has(event.kind)));
    expect(calls(f.provider, 'prose')).toHaveLength(1);
  });

  it('recovers prose after restart from the exact durable approved behavior without re-running world or trusting role-result', async () => {
    const f = await fixture();
    f.provider.world = request => worldResult([candidates(request)[1].id, candidates(request)[0].id], [energyWrite()]);
    f.provider.prose = () => { throw new Error('Writer unavailable in this fixture'); };
    const materialTurn = await f.turn(), committed = clone(f.store.get(f.id));
    const approved = input(calls(f.provider, 'prose')[0]).acceptedBehaviors as Candidate[];
    expect(committed.turns.at(-1)).toMatchObject({ status: 'failed', phase: 'compose-failed' });
    expect(committed.revision).toBe(1); expect(approved).toHaveLength(2);
    await f.engine.close();
    const reopened = new SessionStore(f.root), poisoned = clone(reopened.get(f.id));
    const raw = poisoned.events.find(event => event.kind === 'role-result' && event.turnId === materialTurn)!;
    raw.text = 'POISONED_ROLE_RESULT_SUMMARY';
    raw.data = { expression: 'POISONED_ROLE_RESULT_SPEECH', public: { summary: 'POISONED_PUBLIC_SUMMARY', speech: ['POISONED_PUBLIC_SPEECH'], actions: ['POISONED_ACTION'] } };
    reopened.save(poisoned);
    const recovery = new BehaviorProvider(), engine = new TurnEngine(reopened, recovery); cleanups.push(() => engine.close());
    expect(recovery.calls).toEqual([]);
    engine.submit(f.id, { requestId: 'recover-approved-scene', expectedRevision: 1, action: 'Rewrite the scene from committed facts.', mode: 'author' });
    await engine.idle(f.id);
    expect(recovery.calls.map(request => request.kind)).toEqual(['prose']);
    const material = input(recovery.calls[0]);
    expect(material.acceptedBehaviors).toEqual(approved);
    expect(material.events.filter((event: WorldEvent) => event.kind === 'role-behavior').map(data)).toEqual(approved);
    expect(JSON.stringify(recovery.calls[0])).not.toContain('POISONED');
    expect(material.playerControl).toMatchObject({ authorizedAction: 'Observe the room.', mode: 'action' });
    expect(reopened.get(f.id).revision).toBe(1);
    expect(reopened.get(f.id).turns.at(-1)?.status).toBe('completed');
    expect(reopened.get(f.id).events.filter(event => committedKinds.has(event.kind))).toEqual(committed.events.filter(event => committedKinds.has(event.kind)));
  });

  it('uses only public committed world events when recovering old history without behavior approval', async () => {
    const f = await fixture();
    const materialTurn = await f.turn(), legacy = clone(f.store.get(f.id));
    legacy.events = legacy.events.filter(event => !['behavior-adjudication', 'role-behavior'].includes(event.kind));
    const raw = legacy.events.find(event => event.kind === 'role-result' && event.turnId === materialTurn)!;
    raw.text = 'OLD_UNAPPROVED_SUMMARY';
    raw.data = { expression: 'OLD_UNAPPROVED_EXPRESSION', public: { summary: 'OLD_UNAPPROVED_PUBLIC_SUMMARY', speech: ['OLD_UNAPPROVED_SPEECH'], actions: ['OLD_UNAPPROVED_ACTION'] } };
    f.store.save(legacy);
    const before = f.provider.calls.length;
    await f.turn('author');
    const recovery = f.provider.calls.slice(before);
    expect(recovery.map(request => request.kind)).toEqual(['prose']);
    expect(input(recovery[0]).acceptedBehaviors).toEqual([]); expect(input(recovery[0]).expressions).toEqual([]);
    expect(input(recovery[0]).events).toEqual(legacy.events.filter(event => event.turnId === materialTurn && event.audience === 'public'));
    expect(JSON.stringify(recovery[0])).not.toContain('OLD_UNAPPROVED');
    expect(f.store.get(f.id).revision).toBe(legacy.revision);
    expect(f.store.get(f.id).turns.at(-1)?.status).toBe('completed');
  });

  it('preserves the exact user-supplied written message across failed prose and restart without treating a rewrite request as new player speech', async () => {
    const f = await fixture();
    const authorizedAction = '我留在原地，发送短信：“新年快乐。<user> 是代码里的占位符，不替换它。”不出门，也不朗读短信。';
    f.provider.prose = () => { throw new Error('Writer unavailable after world commit'); };
    f.engine.submit(f.id, { requestId: 'literal-message', expectedRevision: 0, action: authorizedAction, mode: 'action' });
    await f.engine.idle(f.id);
    for (const request of f.provider.calls) expect(input(request).playerControl.authorizedAction).toBe(authorizedAction);
    const committed = clone(f.store.get(f.id));
    expect(committed.turns.at(-1)?.status).toBe('failed');
    expect(committed.turns.at(-1)?.action).toBe(authorizedAction);
    await f.engine.close();

    const reopened = new SessionStore(f.root), recovery = new BehaviorProvider();
    const engine = new TurnEngine(reopened, recovery); cleanups.push(() => engine.close());
    const authorInstruction = '保留原短信的字符，不能把这条编辑要求当作主角说出的话。';
    engine.submit(f.id, { requestId: 'literal-message-recompose', expectedRevision: committed.revision, action: authorInstruction, mode: 'author' });
    await engine.idle(f.id);
    expect(recovery.calls.map(request => request.kind)).toEqual(['prose']);
    expect(input(recovery.calls[0]).playerControl).toMatchObject({ authorizedAction, mode: 'action' });
    expect(input(recovery.calls[0]).authorInstruction).toBe(authorInstruction);
    expect(reopened.get(f.id).world).toEqual(committed.world);
    expect(reopened.get(f.id).roles).toEqual(committed.roles);
    expect(reopened.get(f.id).revision).toBe(committed.revision);
  });
});
