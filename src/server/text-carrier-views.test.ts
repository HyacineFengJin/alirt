import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset } from '../shared/types';
import { SessionStore, event, type StoredSession } from './store';
import { applyTextCarrierCommand, readTextCarrierState } from './text-carriers';
import { carrierViewOutcomesSchema, TextCarrierTurn } from './text-carrier-views';
import { compileResultValidator } from './result-schema.mjs';
import { proposeKnowledgeEdit, proposeKnowledgeObservation } from './knowledge-runtime';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rp-carrier-view-')); roots.push(root);
  const card = createNativeTemplate('card') as CharacterCard; card.opening = ''; card.world.location = 'Hall'; card.world.time = 'After class';
  for (const id of ['a', 'b']) card.roles.push({ id, name: id, persona: '', goals: [], peers: [], phase: 'active', presence: 'present', state: {}, knowledge: [] });
  const store = new SessionStore(root), id = store.create(card, createNativeTemplate('preset') as Preset).id;
  const created = applyTextCarrierCommand(store, id, { requestId: 'create', operation: 'create', expectedRevision: store.get(id).revision, reason: 'An explicit author-set notice.',
    content: { medium: 'paper', title: 'Notice', text: 'PRIVATE_BODY_CANARY: the train was cancelled. This may be a false claim.', location: 'Hall', available: true } });
  const session = structuredClone(store.get(id));
  session.turns.push({ id: 'turn', requestId: 'turn-request', action: 'Look around.', mode: 'action', status: 'running', phase: 'roles', startedAt: '2026-10-31' }); store.save(session);
  const controller = new AbortController(), transaction = new TextCarrierTurn(store, id, 'turn', controller.signal), selection = { carrierId: created.carrierId, version: 1 };
  const world = () => { const next = structuredClone(store.get(id)); next.revision++;
    event(next, { kind: 'world-adjudication', actor: 'world', audience: 'author', turnId: 'turn', text: 'World decided the current batch.' }); return next; };
  const outcomes = (outcome: 'viewed' | 'blocked' = 'viewed') => transaction.intents().map(intent => ({ intentId: intent.id, outcome }));
  return { root, store, id, controller, transaction, selection, world, outcomes, file: join(root, `session-${id}.json`) };
}

it('stages metadata-only pending attempts with exact per-reader idempotence and no pre-world knowledge', () => {
  const f = fixture(), initial = structuredClone(f.store.get(f.id)), bridge = f.transaction.forRole('a');
  expect(JSON.stringify(bridge.targets)).not.toContain('PRIVATE_BODY_CANARY'); expect(Object.isFrozen(bridge.targets)).toBe(true);
  const first = bridge.propose(f.selection), pending = readFileSync(f.file, 'utf8');
  expect(first).toMatchObject({ prepared: true, committed: false }); expect(bridge.propose(f.selection)).toEqual(first); expect(readFileSync(f.file, 'utf8')).toBe(pending);
  const player = f.transaction.player(f.selection);
  expect(player.origin).toEqual({ kind: 'player' }); expect(player.readerRoleId).toBe(initial.playerRoleId); expect(player.id).not.toBe(first.intentId);
  expect(f.transaction.candidates()).toHaveLength(1); expect(f.transaction.candidates()[0]).toMatchObject({ id: first.behaviorId, roleId: 'a', kind: 'action' });
  expect(JSON.stringify({ first, player, candidates: f.transaction.candidates(), intents: f.transaction.intents() })).not.toContain('PRIVATE_BODY_CANARY');
  expect(f.store.get(f.id).revision).toBe(initial.revision); expect(f.store.get(f.id).roles).toEqual(initial.roles);
  expect(readTextCarrierState(f.store.get(f.id)).views).toEqual([]);
  const intents = f.transaction.intents(); intents[0].readerRoleId = 'b'; expect(f.transaction.intents()[0].readerRoleId).toBe('a');
  expect(() => f.transaction.forRole(initial.playerRoleId)).toThrow('NPC');
  expect(() => bridge.propose({ ...f.selection, version: 2 })).toThrow(); expect(() => bridge.propose({ ...f.selection, text: 'forged' })).toThrow();
});

it('commits immutable literal receipts and owner-only occurrence knowledge atomically, without public text leakage', () => {
  const f = fixture(); f.transaction.forRole('a').propose(f.selection); f.transaction.player(f.selection);
  const next = f.world(), before = structuredClone(next), savedBytes = readFileSync(f.file, 'utf8');
  const committed = f.transaction.commit(next, f.outcomes(), f.transaction.candidates());
  expect(next).toEqual(before); expect(readFileSync(f.file, 'utf8')).toBe(savedBytes);
  const views = readTextCarrierState(committed).views; expect(views).toHaveLength(2); expect(views.map(view => view.readerRoleId)).toEqual(['a', committed.playerRoleId]);
  for (const receipt of views) {
    expect(receipt).toMatchObject({ carrierId: f.selection.carrierId, carrierVersion: 1, materialTurnId: 'turn', worldRevision: committed.revision, location: 'Hall', time: 'After class' });
    expect(receipt.carrier.text).toContain('PRIVATE_BODY_CANARY');
    const source = committed.knowledgeRegistry!.sources.find(source => source.observation?.eventId === receipt.observationEventId)!;
    expect(source).toMatchObject({ ownerRoleId: receipt.readerRoleId, certainty: 'known', sourceRefs: [], audience: [receipt.readerRoleId] });
    expect(source.text).toContain('查看「Notice」'); expect(source.text).toContain('读到');
  }
  expect(committed.roles.find(role => role.id === 'b')!.knowledge).toEqual([]);
  const publicEvents = committed.events.filter(entry => entry.audience === 'public' && entry.kind === 'world-event');
  expect(publicEvents).toHaveLength(2); expect(JSON.stringify(publicEvents)).not.toContain('PRIVATE_BODY_CANARY');
  expect(publicEvents.map(entry => (entry.data as any).fact.sources[0].kind)).toEqual(['behavior', 'player-action']);
  expect(f.transaction.commit(committed, f.outcomes(), f.transaction.candidates())).toEqual(committed);
  f.store.save(committed); const oldViews = structuredClone(views), oldKnowledge = structuredClone(committed.knowledgeRegistry);
  applyTextCarrierCommand(f.store, f.id, { requestId: 'correction', operation: 'update', expectedRevision: committed.revision, reason: 'Correct the notice, keep what was read.',
    carrierId: f.selection.carrierId, expectedVersion: 1, content: { medium: 'paper', title: 'Corrected notice', text: 'A different literal claim.', location: 'Hall', available: true } });
  const restarted = new SessionStore(f.root).get(f.id);
  expect(readTextCarrierState(restarted).views).toEqual(oldViews); expect(restarted.knowledgeRegistry).toEqual(oldKnowledge);
  const first = views[0], own = restarted.roles.find(role => role.id === first.readerRoleId)!.knowledge.find(note => note.id === `observed:${first.observationEventId}`)!;
  const withdrawn = proposeKnowledgeEdit(restarted, { operation: 'retract', roleId: first.readerRoleId, id: own.id });
  expect(proposeKnowledgeObservation(withdrawn, first.readerRoleId, { eventId: first.observationEventId, sceneId: 'main' }).roles.find(role => role.id === first.readerRoleId)!.knowledge.find(note => note.id === own.id)!.lifecycle).toBe('withdrawn');
});

it('requires exact all-intent outcomes and approved NPC actions before activating anything', () => {
  const f = fixture(); f.transaction.forRole('a').propose(f.selection); f.transaction.player(f.selection);
  const next = f.world(), before = structuredClone(next), valid = f.outcomes(), schema = carrierViewOutcomesSchema(f.transaction.intents())!, validate = compileResultValidator(schema);
  expect(validate(valid)).toEqual([]); expect(validate([{ ...valid[0], intentId: 'old-turn' }, valid[1]]).length).toBeGreaterThan(0);
  expect(validate([{ ...valid[0], text: 'model body' }, valid[1]]).length).toBeGreaterThan(0);
  for (const bad of [[], [valid[0]], [valid[0], valid[0]], [{ ...valid[0], outcome: 'approved' }, valid[1]], [{ ...valid[0], intentId: 'other' }, valid[1]]])
    expect(() => f.transaction.commit(next, bad, f.transaction.candidates())).toThrow();
  expect(() => f.transaction.commit(next, valid, [])).toThrow('approved');
  const forged = f.transaction.candidates(); forged[0].text = 'Different approved action';
  expect(() => f.transaction.commit(next, valid, forged)).toThrow('exact approved');
  expect(next).toEqual(before); expect(readTextCarrierState(f.store.get(f.id)).views).toEqual([]);
  const blocked = f.transaction.commit(next, f.outcomes('blocked'), []);
  expect(readTextCarrierState(blocked).views).toEqual([]); expect(blocked.roles).toEqual(before.roles);
  expect(f.transaction.commit(blocked, f.outcomes('blocked'), [])).toEqual(blocked);
});

it('rejects a viewed outcome when the final reader or main location leaves scope, without partial receipts', () => {
  const mutations: ((session: StoredSession) => void)[] = [
    session => { session.world.location = 'Other room'; },
    session => { session.roles.find(role => role.id === 'a')!.presence = 'absent'; },
    session => { session.roles.find(role => role.id === 'a')!.phase = 'retired'; },
    session => { session.roles.find(role => role.id === 'a')!.interaction = { mode: 'remote', channel: 'message' }; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); f.transaction.player(f.selection); f.transaction.forRole('a').propose(f.selection);
    const next = f.world(); mutate(next); const before = structuredClone(next);
    expect(() => f.transaction.commit(next, f.outcomes(), f.transaction.candidates())).toThrow('remain available');
    expect(next).toEqual(before); expect(readTextCarrierState(f.store.get(f.id)).views).toEqual([]);
  }
});

it('discards failed attempts, refuses late/cancelled tools, and does not replay pending drafts after restart', () => {
  const f = fixture(), bridge = f.transaction.forRole('a'); bridge.propose(f.selection);
  const baseline = structuredClone(f.store.get(f.id)), aborted = f.transaction.abort(baseline);
  expect(baseline.events.some(entry => entry.kind === 'text-carrier-view-aborted')).toBe(false);
  expect(aborted.roles).toEqual(baseline.roles); expect(aborted.revision).toBe(baseline.revision); expect(readTextCarrierState(aborted).views).toEqual([]);
  expect(f.transaction.abort(aborted)).toEqual(aborted); expect(() => bridge.propose(f.selection)).toThrow('closed');
  expect(() => f.transaction.commit(f.world(), f.outcomes(), f.transaction.candidates())).toThrow('closed');
  f.store.save(aborted); const restartedStore = new SessionStore(f.root), interrupted = structuredClone(restartedStore.get(f.id));
  interrupted.turns.find(turn => turn.id === 'turn')!.status = 'interrupted'; restartedStore.save(interrupted);
  const replacement = new TextCarrierTurn(restartedStore, f.id, 'turn', new AbortController().signal);
  expect(replacement.intents()).toEqual([]); expect(replacement.candidates()).toEqual([]); expect(() => replacement.forRole('a')).toThrow('no longer active');
  const g = fixture(), cancelled = g.transaction.forRole('a'); g.controller.abort(); expect(() => cancelled.propose(g.selection)).toThrow('closed');
  const h = fixture(), closed = h.transaction.forRole('a'); h.transaction.close(); expect(() => closed.propose(h.selection)).toThrow('closed');
});

it('preserves the legacy empty schema and refuses stale grants after an author version change', () => {
  const f = fixture(); expect(carrierViewOutcomesSchema(f.transaction.intents())).toBeUndefined();
  const base = f.store.get(f.id); expect(f.transaction.commit(base, [], [])).toEqual(base);
  const bridge = f.transaction.forRole('a');
  applyTextCarrierCommand(f.store, f.id, { requestId: 'new-version', operation: 'update', expectedRevision: base.revision, reason: 'Author changed the current version.',
    carrierId: f.selection.carrierId, expectedVersion: 1, content: { medium: 'screen', title: 'Other title', text: 'Other text', location: 'Hall', available: true } });
  expect(() => bridge.propose(f.selection)).toThrow('original revision'); expect(f.transaction.intents()).toEqual([]);
});
