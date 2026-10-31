import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CharacterCard, Preset } from '../shared/types';
import type { StateRule } from '../shared/state-rules';
import { createNativeTemplate, materializeNativeDocument, validateNativeDocument } from '../shared/native';
import { portableNativeProjection } from '../importer/compiler';
import { applyStateTransaction } from './state-runtime';
import { initializeStory } from './initialization-runtime';
import { SessionStore, project } from './store';
import { createApp } from './app';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const preset = () => createNativeTemplate('preset') as Preset;
function cardFixture(): CharacterCard {
  const card = createNativeTemplate('card') as CharacterCard;
  card.fields = [
    { key: 'onstage', label: 'On stage', type: 'boolean', audience: 'author', editable: true },
    { key: 'presence', label: 'Ordinary field', type: 'boolean', audience: 'public', editable: true },
    { key: 'gate', label: 'Gate', type: 'boolean', audience: 'public', editable: true },
  ];
  card.roles[0].state = { onstage: true, presence: true, gate: false };
  card.roles[0].stateMirrors = { presence: 'onstage' };
  card.initialization = { schema: 'rp.initialization/0.1', openings: [{ id: 'away', title: 'Away', text: '', cast: [{ roleId: 'player', phase: 'active', presence: 'absent', interaction: { mode: 'remote', channel: 'message' } }] }], playerProfiles: [{ id: 'player', title: 'Player', name: 'Player', persona: '' }] };
  return card;
}
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'rp-presence-mirror-'));
  cleanups.push(() => rm(root, { recursive: true, force: true })); return root;
}
async function httpFixture(card: CharacterCard) {
  const root = await directory(), p = preset(); let modelCalls = 0;
  const provider: ModelProvider = { configured: () => true, run: async () => { ++modelCalls; throw new Error('No model calls authorized by this test'); } };
  const service = await createApp({ dataRoot: root, provider, catalog: async () => ({ cards: [card], presets: [p] }) });
  cleanups.push(service.close);
  const server = service.app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  cleanups.push(() => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  return { ...service, root, api, p, modelCalls: () => modelCalls };
}

describe('explicit boolean presence mirrors', () => {
  it('requires a declared boolean actually held by this role and rejects inconsistent baselines', () => {
    const valid = cardFixture(); expect(validateNativeDocument('card', valid).length).toBe(0);
    const mutations = [
      (card: CharacterCard) => { delete card.roles[0].state.onstage; },
      (card: CharacterCard) => { card.roles[0].state.onstage = null; },
      (card: CharacterCard) => { card.roles[0].state.onstage = false; },
      (card: CharacterCard) => { card.fields[0].type = 'string'; card.roles[0].state.onstage = 'true'; },
      (card: CharacterCard) => { card.roles[0].stateMirrors = { presence: 'missing' }; },
    ];
    for (const mutate of mutations) {
      const card = structuredClone(valid); mutate(card);
      expect(validateNativeDocument('card', card).some(issue => issue.path.includes('/stateMirrors'))).toBe(true);
    }
    const malformed = structuredClone(valid); delete malformed.roles[0].state.onstage;
    expect(() => applyStateTransaction(malformed, [], { authority: 'model' })).toThrow(expect.objectContaining({ code: 'STATE_FIELD' }));
  });

  it('composes cast through explicit bindings only, rejects conflicting effective layers and allows opening overrides', () => {
    const card = cardFixture(), before = hash(card);
    const result = initializeStory(card);
    expect(result.roles[0]).toMatchObject({ presence: 'absent', state: { onstage: false, presence: true }, interaction: { mode: 'remote', channel: 'message' } });
    expect(hash(card)).toBe(before);
    card.initialization!.playerProfiles[0].state = [{ roleId: 'player', key: 'onstage', value: true }];
    expect(() => initializeStory(card)).toThrow(expect.objectContaining({ code: 'INITIALIZATION_CONFLICT' }));
    card.initialization!.openings[0].state = [{ roleId: 'player', key: 'onstage', value: false }];
    expect(initializeStory(card).roles[0].state.onstage).toBe(false);
    card.initialization!.openings[0].state[0].value = true;
    expect(() => initializeStory(card)).toThrow(expect.objectContaining({ code: 'INITIALIZATION_CONFLICT' }));
    const legacy = cardFixture(); delete legacy.roles[0].stateMirrors;
    legacy.initialization!.openings[0].state = [{ roleId: 'player', key: 'presence', value: true }];
    const unchangedState = initializeStory(legacy).roles[0];
    expect(unchangedState).toMatchObject({ presence: 'absent', state: { onstage: true, presence: true } });
    expect(unchangedState.stateMirrors).toBeUndefined();
    expect(applyStateTransaction(legacy, [{ roleId: 'player', key: 'presence', value: false }], { authority: 'model' }).nextState.roles[0].presence).toBe('present');
  });

  it('synchronizes direct model/author and derived writes before rules, clears remote arrival and audits its structural effect', () => {
    const card = cardFixture(); delete card.initialization;
    card.roles[0].presence = 'absent'; card.roles[0].state.onstage = false; card.roles[0].interaction = { mode: 'remote', channel: 'screen' };
    const before = hash(card);
    const invariant: StateRule = { id: 'same', type: 'invariant', condition: { path: 'roles.player.presence', equals: 'present' }, message: 'Must arrive' };
    for (const authority of ['model', 'author'] as const) {
      const result = applyStateTransaction(card, [{ roleId: 'player', key: 'onstage', value: true, expectedValue: false }], { authority, owner: 'player', rules: [invariant] });
      expect(result.nextState.roles[0]).toMatchObject({ presence: 'present', state: { onstage: true, presence: true } });
      expect(result.nextState.roles[0].interaction).toBeUndefined();
      expect(result.audit[0].presenceSync).toEqual({ before: 'absent', after: 'present', interactionBefore: { mode: 'remote', channel: 'screen' }, interactionAfter: null });
      expect(hash(card)).toBe(before);
    }
    card.fields[0].writableBy = 'derived';
    const transition: StateRule = { id: 'arrival', type: 'transition', trigger: { roleId: 'player', key: 'gate' }, effects: [{ type: 'set', roleId: '$trigger', key: 'onstage', value: true }] };
    const result = applyStateTransaction(card, [{ roleId: 'player', key: 'gate', value: true }], { authority: 'model', rules: [transition, invariant] });
    expect(result.nextState.roles[0].presence).toBe('present'); expect(result.nextState.roles[0].interaction).toBeUndefined();
    expect(result.audit[1]).toMatchObject({ authority: 'rule', origin: 'rule', ruleId: 'arrival', causeId: 'change:1', presenceSync: { before: 'absent', after: 'present' } });
    // A derived mirror must retain normal authority checks even after arrival.
    expect(() => applyStateTransaction(result.nextState, [{ roleId: 'player', key: 'onstage', value: false }], { authority: 'author' })).toThrow(expect.objectContaining({ code: 'STATE_AUTHORITY' }));
    const blocked = hash(card);
    expect(() => applyStateTransaction(card, [{ roleId: 'player', key: 'gate', value: true }], { authority: 'model', rules: [transition, { ...invariant, condition: { path: 'roles.player.presence', equals: 'absent' } }] })).toThrow(expect.objectContaining({ code: 'STATE_RULE_VIOLATION' }));
    expect(hash(card)).toBe(blocked);
  });

  it('enforces lifecycle readonly/derived/rules and revisions atomically without partial phase, context, event or disk writes', async () => {
    const root = await directory(), store = new SessionStore(root);
    for (const mode of ['readonly', 'derived', 'invariant'] as const) {
      const card = cardFixture();
      if (mode === 'readonly') card.fields[0].editable = false;
      if (mode === 'derived') card.fields[0].writableBy = 'derived';
      if (mode === 'invariant') card.stateRules = [{ id: 'stay-away', type: 'invariant', condition: { path: 'roles.player.presence', equals: 'absent' }, message: 'Stay away' }];
      const id = store.create(card, preset()).id, before = hash(store.get(id));
      expect(() => store.lifecycle(id, { expectedRevision: 0, roleId: 'player', phase: 'faded', presence: 'present' })).toThrow(expect.objectContaining({ code: mode === 'readonly' ? 'STATE_READONLY' : mode === 'derived' ? 'STATE_AUTHORITY' : 'STATE_RULE_VIOLATION' }));
      expect(hash(store.get(id))).toBe(before); expect(hash(new SessionStore(root).get(id))).toBe(before);
    }
    const card = cardFixture();
    card.stateRules = [{ id: 'arrival-mark', type: 'transition', trigger: { roleId: 'player', key: 'onstage' }, when: { path: 'roles.player.presence', equals: 'present' }, effects: [{ type: 'set', roleId: '$trigger', key: 'gate', value: true }] }];
    const id = store.create(card, preset()).id;
    const result = store.lifecycle(id, { expectedRevision: 0, roleId: 'player', phase: 'active', presence: 'present' });
    expect(result.roles[0].state.onstage).toBe(true); expect(result.roles[0].state.gate).toBe(true); expect(result.roles[0].interaction).toBeUndefined();
    expect((store.get(id).events.findLast(event => event.kind === 'state-transaction')!.data as any).audit[0].presenceSync).toMatchObject({ before: 'absent', after: 'present', interactionAfter: null });
    expect(project(store.get(id), 'player').roles[0].stateMirrors).toBeUndefined();
    const before = hash(store.get(id));
    expect(() => store.lifecycle(id, { expectedRevision: 0, roleId: 'player', phase: 'faded', presence: 'absent' })).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }));
    expect(() => store.stateTransaction(id, { expectedRevision: 1, reason: 'stale state', changes: [{ roleId: 'player', key: 'onstage', value: false, expectedValue: false }] })).toThrow(expect.objectContaining({ code: 'STATE_CAS_CONFLICT' }));
    expect(hash(store.get(id))).toBe(before); expect(hash(new SessionStore(root).get(id))).toBe(before);
  });

  it('rejects an absent role self-arrival through a custom mirror while allowing a world-adjudicated arrival', async () => {
    const card = cardFixture(); delete card.initialization; card.fields[0].audience = 'public';
    card.roles[0].peers = ['npc'];
    card.roles.push({ ...structuredClone(card.roles[0]), id: 'npc', name: 'Remote NPC', peers: ['player'], presence: 'absent', state: { onstage: false, presence: false, gate: false }, interaction: { mode: 'remote', channel: 'audio' } });
    const root = await directory(), store = new SessionStore(root), id = store.create(card, preset()).id;
    const calls: AgentRequest[] = []; let worldArrives = false;
    const provider: ModelProvider = { configured: () => true, run: async request => {
      calls.push(request);
      if (request.kind === 'role') return { public: { summary: 'Remote reply.', speech: ['I will arrive.'], actions: [] }, proposals: [{ roleId: 'npc', key: 'onstage', value: true }] };
      if (request.kind === 'world') return { summary: 'The world decides whether arrival occurred.', changes: worldArrives ? [{ roleId: 'npc', key: 'onstage', value: true }] : [], facts: [], acceptedBehaviorIds: [] };
      return { title: 'Decision', text: 'The scene continues.', person: 'third', pov: 'limited' };
    } };
    const engine = new TurnEngine(store, provider); cleanups.push(() => engine.close());
    const turn = async (requestId: string) => { engine.submit(id, { requestId, expectedRevision: store.get(id).revision, action: 'Check whether arrival occurred.', mode: 'action' }); await engine.idle(id); };
    await turn('role-only');
    expect(store.get(id).turns.at(-1)?.status).toBe('completed');
    expect(store.get(id).events.filter(event => event.kind === 'proposal-rejected')).toHaveLength(1);
    expect((calls.find(call => call.kind === 'world')!.input as any).results[0].proposals).toEqual([]);
    expect(store.get(id).roles[1]).toMatchObject({ presence: 'absent', state: { onstage: false }, interaction: { mode: 'remote', channel: 'audio' } });
    worldArrives = true; await turn('world-arrival');
    expect(store.get(id).turns.at(-1)?.status).toBe('completed');
    const arrived = new SessionStore(root).get(id).roles[1];
    expect(arrived.presence).toBe('present'); expect(arrived.state.onstage).toBe(true); expect(arrived.interaction).toBeUndefined();
    expect((store.get(id).events.findLast(event => event.kind === 'state-transaction')!.data as any).audit[0].presenceSync).toMatchObject({ before: 'absent', after: 'present', interactionBefore: { mode: 'remote', channel: 'audio' }, interactionAfter: null });
  });
});
