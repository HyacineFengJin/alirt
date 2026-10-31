import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset } from '../shared/types';
import type { ProvenancedKnowledge } from '../shared/knowledge';
import { eligibleKnowledgeReferences, proposeKnowledgeEdit, proposeKnowledgeObservation } from './knowledge-runtime';
import { clone, event, project, SessionStore, type StoredSession } from './store';
import { DerivedMemoryTurn, derivedMemoryAttemptBoundary, derivedMemoryModule } from './derived-memory';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rp-derived-memory-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.roles.push({ id: 'actor', name: 'Actor', persona: '', goals: [], peers: [], phase: 'active', presence: 'present', state: {}, knowledge: [
    { id: 'quote', text: 'An existing quoted report.', audience: ['actor'], status: 'known' },
    { id: 'rumor', text: 'An uncertain existing claim.', audience: ['actor'], status: 'uncertain' },
    { id: 'private', text: 'AUTHOR_PRIVATE_SOURCE', audience: 'author', status: 'known' },
  ] }, { id: 'other', name: 'Other', persona: '', goals: [], peers: [], phase: 'active', presence: 'present', state: {}, knowledge: [
    { id: 'public', text: 'OTHER_PUBLIC_BUT_NOT_DELIVERED', audience: 'public', status: 'known' },
    { id: 'private', text: 'OTHER_PRIVATE_SOURCE', audience: ['other'], status: 'known' },
  ] });
  const store = new SessionStore(root), id = store.create(card, preset).id; let sequence = 0;
  const turn = () => { const turnId = `memory-turn-${++sequence}`, next = clone(store.get(id)); next.turns.push({ id: turnId, requestId: turnId, mode: 'action', action: 'Existing action.', status: 'running', phase: 'role', startedAt: 'host-time' }); store.save(next);
    const controller = new AbortController(), memory = new DerivedMemoryTurn(store, id, turnId, controller.signal); return { memory, turnId, controller }; };
  const view = (roleId = 'actor') => project(store.get(id), roleId);
  const source = (roleId: string, knowledgeId: string) => (store.get(id).roles.find(role => role.id === roleId)!.knowledge.find(entry => entry.id === knowledgeId) as ProvenancedKnowledge).provenance!.sourceId;
  const finish = (memory: DerivedMemoryTurn, turnId: string) => { const draft = clone(store.get(id)); ++draft.revision; event(draft, { kind: 'world-adjudication', actor: 'world', turnId, audience: 'author', text: 'Successful world adjudication.' });
    const next = memory.commit(draft); next.turns.find(turn => turn.id === turnId)!.status = 'completed'; store.save(next); return next; };
  return { root, filename: join(root, `session-${id}.json`), store, id, turn, view, source, finish };
}
const draft = (sourceRefs: string[], key = 'belief') => ({ key, kind: 'inference' as const, text: 'PRIVATE_DERIVED_NOTE: an uncertain inference.', sourceRefs });

it('grants only actual delivered handles, freezes them, and never expands a bridge with subsequently readable sources', async () => {
  const f = await fixture(), { memory } = f.turn(), view = f.view(); view.roles.find(role => role.id === 'other')!.knowledge = [];
  const bridge = memory.forRole(view, 'actor');
  expect(bridge.references.map(reference => reference.id)).toEqual([f.source('actor', 'quote'), f.source('actor', 'rumor')]);
  expect(() => (bridge.references as any).push({ id: 'forged' })).toThrow();
  expect(() => { (bridge.references[0] as any).text = 'Mutate reference'; }).toThrow();
  view.roles.find(role => role.id === 'actor')!.knowledge[0].text = 'Mutated delivered view';
  expect(bridge.references[0].text).toBe('An existing quoted report.');
  const before = await readFile(f.filename, 'utf8');
  for (const ref of [f.source('other', 'public'), f.source('other', 'private'), f.source('actor', 'private'), 'quote', 'old-prose-id', 'unapproved-candidate-id']) expect(() => bridge.prepare(draft([ref]))).toThrow();
  expect(await readFile(f.filename, 'utf8')).toBe(before);
  f.store.save(proposeKnowledgeEdit(f.store.get(f.id), { operation: 'upsert', roleId: 'actor', id: 'new', text: 'New readable knowledge.', status: 'known' }));
  expect(() => bridge.prepare(draft([f.source('actor', 'new')]))).toThrow();
  expect(() => memory.forRole(project(f.store.get(f.id), 'author'), 'actor')).toThrow();
  expect(() => memory.forRole(f.view('player'), 'player')).toThrow();
});

it('prepares pending audits only, replays exact actor keys once, commits private uncertain notes atomically without mutating inputs, and never rebuilds a committed note', async () => {
  const f = await fixture(), { memory, turnId } = f.turn(), bridge = memory.forRole(f.view(), 'actor'), value = draft([f.source('actor', 'quote')]), inputBefore = clone(value);
  const before = clone(f.store.get(f.id)), prepared = bridge.prepare(value);
  expect(prepared).toMatchObject({ prepared: true, committed: false, duplicate: false, kind: 'inference' }); expect(value).toEqual(inputBefore);
  expect(f.store.get(f.id).roles).toEqual(before.roles); expect(f.store.get(f.id).revision).toBe(before.revision);
  const preparedBytes = await readFile(f.filename, 'utf8'); expect(bridge.prepare({ text: value.text, sourceRefs: value.sourceRefs, key: value.key, kind: value.kind })).toEqual({ ...prepared, duplicate: true });
  expect(await readFile(f.filename, 'utf8')).toBe(preparedBytes);
  expect(() => bridge.prepare({ ...value, text: 'Changed effect under the same key.' })).toThrow();
  expect(() => memory.commit(f.store.get(f.id))).toThrow('successful world adjudication');
  const transaction = clone(f.store.get(f.id)); ++transaction.revision; event(transaction, { kind: 'world-adjudication', actor: 'world', turnId, audience: 'author', text: 'Committed world.' });
  const original = clone(transaction), result = memory.commit(transaction);
  expect(transaction).toEqual(original); expect(await readFile(f.filename, 'utf8')).toBe(preparedBytes);
  const entry = result.roles.find(role => role.id === 'actor')!.knowledge.find(entry => entry.id === prepared.knowledgeId) as ProvenancedKnowledge;
  expect(entry).toMatchObject({ status: 'uncertain', audience: ['actor'], lifecycle: 'active', provenance: { kind: 'derived', sourceRefs: value.sourceRefs } });
  expect(entry.provenance).not.toHaveProperty('observation'); expect(result.revision).toBe(transaction.revision);
  expect(result.events.filter(entry => entry.kind === 'derived-memory-committed')).toHaveLength(1);
  expect(memory.commit(result)).toEqual(result); f.store.save(result);
  expect(JSON.stringify(project(result, 'other'))).not.toContain('PRIVATE_DERIVED_NOTE');
  expect(memory.abort(result)).toEqual(result);
});

it('rejects unknown keys, player/owner overrides, duplicate/empty references and accessors without invoking or coercing them', async () => {
  const f = await fixture(), { memory } = f.turn(), bridge = memory.forRole(f.view(), 'actor'), good = draft([f.source('actor', 'quote')]);
  let reads = 0; const accessor = Object.defineProperty({ ...good }, 'text', { enumerable: true, get() { ++reads; return 'Must not read'; } });
  const before = await readFile(f.filename, 'utf8');
  for (const value of [accessor, { ...good, sourceRefs: [] }, { ...good, sourceRefs: [good.sourceRefs[0], good.sourceRefs[0]] }, { ...good, roleId: 'other' },
    { ...good, audience: 'public' }, { ...good, status: 'known' }, { ...good, id: 'observed:existing' }, { ...good, key: ' ' }, { ...good, text: ' ' }, { ...good, kind: 'observation' }, { ...good, sourceRefs: [NaN] }]) expect(() => bridge.prepare(value)).toThrow();
  expect(reads).toBe(0); expect(await readFile(f.filename, 'utf8')).toBe(before);
});

it('revalidates source versions both at prepare and at commit, with all drafts rolled back when a later source expired', async () => {
  const f = await fixture(), { memory, turnId } = f.turn(), bridge = memory.forRole(f.view(), 'actor');
  const first = bridge.prepare(draft([f.source('actor', 'quote')], 'first')), rumor = f.source('actor', 'rumor'); bridge.prepare(draft([rumor], 'second'));
  f.store.save(proposeKnowledgeEdit(f.store.get(f.id), { operation: 'retract', roleId: 'actor', id: 'rumor' }));
  expect(() => bridge.prepare(draft([rumor], 'late'))).toThrow();
  const next = clone(f.store.get(f.id)); ++next.revision; event(next, { kind: 'world-adjudication', actor: 'world', turnId, audience: 'author', text: 'Candidate transaction.' });
  const before = clone(next), persisted = await readFile(f.filename, 'utf8'); expect(() => memory.commit(next)).toThrow();
  expect(next).toEqual(before); expect(await readFile(f.filename, 'utf8')).toBe(persisted);
  expect(next.roles.find(role => role.id === 'actor')!.knowledge.some(entry => entry.id === first.knowledgeId)).toBe(false);
  expect(memory.abort(next).events.filter(entry => entry.kind === 'derived-memory-aborted')).toHaveLength(2);
});

it('refuses to overwrite an entry even if an author creates the pending host ID before world commit', async () => {
  const f = await fixture(), { memory, turnId } = f.turn(), prepared = memory.forRole(f.view(), 'actor').prepare(draft([f.source('actor', 'quote')]));
  f.store.save(proposeKnowledgeEdit(f.store.get(f.id), { operation: 'upsert', roleId: 'actor', id: prepared.knowledgeId, text: 'AUTHOR_OWNS_THIS_ENTRY', status: 'known' }));
  const next = clone(f.store.get(f.id)); event(next, { kind: 'world-adjudication', actor: 'world', turnId, audience: 'author', text: 'World.' });
  expect(() => memory.commit(next)).toThrow('overwrite');
  expect(next.roles.find(role => role.id === 'actor')!.knowledge.find(entry => entry.id === prepared.knowledgeId)!.text).toBe('AUTHOR_OWNS_THIS_ENTRY');
});

it('propagates withdrawal through two new derived aliases while retaining the independent observed occurrence and canonical event', async () => {
  const f = await fixture(); let session = clone(f.store.get(f.id));
  event(session, { kind: 'parallel-world-event', actor: 'parallel-world', audience: 'author', turnId: 'historic-turn', text: 'X said P.', data: { sceneId: 'historic-scene', observerRoleIds: ['actor'], fact: { text: 'X said P.' } } });
  const observedEvent = clone(session.events.at(-1)!); session = proposeKnowledgeObservation(session, 'actor', { sceneId: 'historic-scene', eventId: observedEvent.id });
  session = proposeKnowledgeEdit(session, { operation: 'upsert', roleId: 'actor', id: 'current-claim', text: 'P is a currently supported claim.', status: 'known' }); f.store.save(session);
  const first = f.turn(), firstPrepared = first.memory.forRole(f.view(), 'actor').prepare(draft([f.source('actor', 'current-claim')], 'alias-1')); f.finish(first.memory, first.turnId);
  const second = f.turn(), secondPrepared = second.memory.forRole(f.view(), 'actor').prepare({ ...draft([f.source('actor', firstPrepared.knowledgeId)], 'alias-2'), kind: 'summary' }); f.finish(second.memory, second.turnId);
  const before = clone(f.store.get(f.id)), withdrawn = proposeKnowledgeEdit(before, { operation: 'retract', roleId: 'actor', id: 'current-claim' });
  const entry = (id: string) => withdrawn.roles.find(role => role.id === 'actor')!.knowledge.find(entry => entry.id === id) as ProvenancedKnowledge;
  expect(entry(firstPrepared.knowledgeId).lifecycle).toBe('stale'); expect(entry(secondPrepared.knowledgeId).lifecycle).toBe('stale');
  expect(entry(firstPrepared.knowledgeId).status).toBe('uncertain'); expect(entry(secondPrepared.knowledgeId).status).toBe('uncertain');
  expect(entry(`observed:${observedEvent.id}`)).toMatchObject({ lifecycle: 'active', status: 'known', text: '场外已观察事件：X said P.' });
  expect(withdrawn.events.find(event => event.id === observedEvent.id)).toEqual(observedEvent); expect(before.roles).not.toEqual(withdrawn.roles);
  expect(eligibleKnowledgeReferences(withdrawn, 'actor').some(reference => reference.text === '场外已观察事件：X said P.')).toBe(true);
});

it('aborts privately without activating drafts, isolates failed actor attempts, and never reconstructs drafts on restart', async () => {
  const f = await fixture(), { memory, turnId } = f.turn(), own = memory.forRole(f.view(), 'actor').prepare(draft([f.source('actor', 'quote')]));
  const other = memory.forRole(f.view('other'), 'other').prepare(draft([f.source('other', 'public')]));
  const before = clone(f.store.get(f.id)), next = memory.abort(before); next.turns.find(turn => turn.id === turnId)!.status = 'failed'; f.store.save(next);
  expect(before.roles).toEqual(next.roles); expect(before.world).toEqual(next.world); expect(before.revision).toBe(next.revision);
  expect(next.events.filter(event => event.kind === 'derived-memory-aborted').every(event => event.audience === 'author')).toBe(true);
  const staleDraft = clone(before); event(staleDraft, { kind: 'world-adjudication', actor: 'world', turnId, audience: 'author', text: 'A late stale result cannot reactivate aborted memory.' });
  expect(() => memory.commit(staleDraft)).toThrow('closed');
  expect(derivedMemoryAttemptBoundary(next, 'actor')).toEqual({ schema: 'rp.derived-memory-attempt-boundary/0.1', drafts: [{ turnId, knowledgeId: own.knowledgeId }] });
  expect(derivedMemoryAttemptBoundary(next, 'other')).toEqual({ schema: 'rp.derived-memory-attempt-boundary/0.1', drafts: [{ turnId, knowledgeId: other.knowledgeId }] });
  expect(JSON.stringify(derivedMemoryAttemptBoundary(next, 'actor'))).not.toContain('PRIVATE_DERIVED_NOTE');
  const restarted = new SessionStore(f.root), restored = restarted.get(f.id), recovered = new DerivedMemoryTurn(restarted, f.id, turnId, new AbortController().signal);
  expect(recovered.commit(restored)).toEqual(restored); expect(restored.roles).toEqual(before.roles);
  const running = f.turn(); running.memory.forRole(f.view(), 'actor').prepare(draft([f.source('actor', 'quote')], 'running'));
  expect((derivedMemoryAttemptBoundary(f.store.get(f.id), 'actor') as any).drafts).toHaveLength(1);
});

it('exposes the pending tool contract only through an explicit bridge and rejects late calls after close/cancellation', async () => {
  const f = await fixture(), { memory, controller } = f.turn(), bridge = memory.forRole(f.view(), 'actor');
  expect(() => derivedMemoryModule.roleTools!({ roleId: 'actor', view: f.view(), signal: controller.signal })).toThrow('host delivery bridge');
  const tools = derivedMemoryModule.roleTools!({ roleId: 'actor', view: f.view(), signal: controller.signal, derivedMemory: bridge } as any);
  expect(tools.map(tool => tool.name)).toEqual(['derive_memory']);
  expect((tools[0].parameters as any).required).toEqual(['key', 'kind', 'text', 'sourceRefs']);
  expect(tools[0].execute(draft([f.source('actor', 'quote')]))).toMatchObject({ prepared: true, committed: false });
  const before = await readFile(f.filename, 'utf8'); memory.close();
  expect(() => tools[0].execute(draft([f.source('actor', 'quote')], 'late'))).toThrow('closed'); expect(await readFile(f.filename, 'utf8')).toBe(before);
  const next = f.turn(), cancelled = next.memory.forRole(f.view(), 'actor'); next.controller.abort();
  expect(() => cancelled.prepare(draft([f.source('actor', 'quote')], 'cancelled'))).toThrow('closed');
});
