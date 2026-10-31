import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset } from '../shared/types';
import type { ParallelAttempt, ParallelProse } from '../shared/parallel-output';
import type { ResolvedParallelScene } from '../shared/parallel-scenes';
import { validateStateJson } from '../shared/state-value-schema';
import { applyParallelScenes, selectParallelScenes } from './parallel-scenes';
import type { ParallelDecisionBundle } from './parallel-runtime';
import { proposeKnowledgeEdit, proposeKnowledgeObservation } from './knowledge-runtime';
import { ApiError, clone, project, SessionStore, type StoredSession } from './store';
import { abortParallelAttempts, assertParallelJournal, commitParallelMaterial, finishParallelRender, parallelOutputFor, prepareParallelAttempt, reconcileParallelRestart, startParallelRender } from './parallel-journal';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rp-parallel-journal-')); roots.push(root);
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.fields.push({ key: 'location', label: '地点', type: 'string', audience: 'public', editable: true });
  card.roles.push(...['actor', 'partner', 'spectator'].map(id => ({ id, name: id, persona: '', goals: [], peers: [], phase: 'active' as const, presence: 'present' as const, state: { location: '场外车站' }, knowledge: [] })));
  card.initialization = { schema: 'rp.initialization/0.1', defaultOpeningId: 'opening', defaultPlayerProfileId: 'player-profile', openings: [{ id: 'opening', title: '开场', text: '已声明的开场参与者。', cast: card.roles.map(role => ({ roleId: role.id, phase: 'active', presence: 'present' })) }], playerProfiles: [{ id: 'player-profile', title: '玩家', name: '玩家', persona: '' }] };
  const store = new SessionStore(root), id = store.create(card, preset).id;
  for (const roleId of ['actor', 'partner']) store.lifecycle(id, { expectedRevision: store.get(id).revision, roleId, phase: 'active', presence: 'absent', reason: '明确离开主场' });
  applyParallelScenes(store, id, { requestId: 'grant', expectedRevision: store.get(id).revision, reason: '明确授权场外', operation: 'upsert', scene: { id: 'scene', title: '场外核对', enabled: true, participantRoleIds: ['actor', 'partner'], locationKey: 'location', goal: '核对已知告示' } });
  applyParallelScenes(store, id, { requestId: 'select', expectedRevision: store.get(id).revision, reason: '明确选择', operation: 'select', selectedSceneIds: ['scene'] });
  return { root, store, id, filename: join(root, `session-${id}.json`), grant: selectParallelScenes(store.get(id)).scenes[0] };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function addTurn(f: Fixture, turnId: string) {
  const next = clone(f.store.get(f.id));
  next.turns.push({ id: turnId, requestId: `request-${turnId}`, mode: 'action', action: '主场原行动', status: 'running', phase: 'parallel', startedAt: 'host-time' });
  f.store.save(next);
}
function bundle(grant: ResolvedParallelScene, attempt: ParallelAttempt, rejected = false): ParallelDecisionBundle {
  const candidates = grant.participantRoleIds.map(roleId => ({ id: `${attempt.turnId}-${attempt.epoch}-${roleId}`, roleId, kind: 'action' as const, text: `${roleId}核对已公开告示。` }));
  const acceptedBehaviors = rejected ? candidates.slice(0, 1) : candidates;
  return { sceneId: grant.id, grantGeneration: grant.generation, attemptEpoch: attempt.epoch,
    scope: { kind: 'parallel', sceneId: grant.id, grantGeneration: grant.generation, participantRoleIds: [...grant.participantRoleIds], location: { key: grant.locationKey, value: grant.location } },
    candidates, acceptedBehaviors, rawRejectedCount: candidates.length - acceptedBehaviors.length, rejectedRoleIds: rejected ? ['partner'] : [], summary: '批准核对',
    facts: [{ text: 'actor实际观察了告示上的公开变更。', sources: [{ kind: 'behavior', id: candidates[0].id }], observedBy: ['actor'] }, { text: '仅作者获准阅读的环境补充。', sources: [{ kind: 'world-development' }], observedBy: [] }] };
}
function commit(f: Fixture, turnId: string, rejected = false) {
  addTurn(f, turnId); const attempt = prepareParallelAttempt(f.store, f.id, turnId, f.grant);
  const draft = clone(f.store.get(f.id)); draft.revision++;
  const result = commitParallelMaterial(draft, f.grant, attempt, bundle(f.grant, attempt, rejected)); f.store.save(result.session);
  return { ...result, attempt };
}
function rejects(action: () => unknown) { try { action(); throw Error('expected rejection'); } catch (error) { expect(error).toBeInstanceOf(ApiError); expect((error as ApiError).code).toBe('PARALLEL_JOURNAL'); } }
const prose: ParallelProse = { title: '核对', text: '两人在已经批准的场外场景核对告示。', person: 'third', pov: 'limited' };
const stateWithoutKnowledge = (session: StoredSession) => session.roles.map(({ knowledge: _knowledge, ...role }) => role);
function frozen<T>(value: T): T { if (value && typeof value === 'object') { for (const item of Object.values(value)) frozen(item); Object.freeze(value); } return value; }

describe('private parallel scene journal', () => {
  it('journals before model work, advances unsafe epochs and preserves committed attempts through main writer failure', async () => {
    const f = await fixture(); addTurn(f, 'aborted-turn');
    const revision = f.store.get(f.id).revision, first = prepareParallelAttempt(f.store, f.id, 'aborted-turn', f.grant);
    expect(first).toMatchObject({ status: 'prepared', epoch: 1 }); expect(f.store.get(f.id).revision).toBe(revision);
    abortParallelAttempts(f.store, f.id, 'aborted-turn'); expect(f.store.get(f.id).parallelAttempts![0].status).toBe('aborted');
    const rejected = commit(f, 'rejected-turn', true); expect(rejected.attempt.epoch).toBe(2);
    expect(f.store.get(f.id).parallelAttempts!.at(-1)).toMatchObject({ status: 'committed', rejectedCandidates: true });
    const clean = commit(f, 'clean-turn'); expect(clean.attempt.epoch).toBe(3);
    addTurn(f, 'next-turn'); expect(prepareParallelAttempt(f.store, f.id, 'next-turn', f.grant).epoch).toBe(3);
    const before = clone(f.store.get(f.id).parallelRuns); abortParallelAttempts(f.store, f.id, 'clean-turn');
    expect(f.store.get(f.id).parallelRuns).toEqual(before); expect(f.store.get(f.id).parallelAttempts!.find(item => item.turnId === 'clean-turn')!.status).toBe('committed');
    abortParallelAttempts(f.store, f.id, 'next-turn');
    const { generation: _generation, ...definition } = f.grant;
    // Only the author definition fields belong in the control command.
    const { participants: _participants, location: _location, ...scene } = definition;
    applyParallelScenes(f.store, f.id, { requestId: 'new-generation', expectedRevision: f.store.get(f.id).revision, reason: '重新授权', operation: 'upsert', scene: { ...scene, title: '新许可' } });
    const fresh = selectParallelScenes(f.store.get(f.id)).scenes[0]; addTurn(f, 'new-generation-turn');
    expect(prepareParallelAttempt(f.store, f.id, 'new-generation-turn', fresh)).toMatchObject({ epoch: 1, grantGeneration: 2 });
  });

  it('commits detached scoped material without saving or declared-state writes and grants only actual owner observations', async () => {
    const f = await fixture(); addTurn(f, 'turn'); const attempt = prepareParallelAttempt(f.store, f.id, 'turn', f.grant);
    const beforeBytes = await readFile(f.filename, 'utf8'), draft = clone(f.store.get(f.id)); draft.revision++;
    const before = clone(draft), result = commitParallelMaterial(frozen(draft), frozen(f.grant), frozen(attempt), frozen(bundle(f.grant, attempt)));
    expect(await readFile(f.filename, 'utf8')).toBe(beforeBytes); expect(draft).toEqual(before);
    expect(result.run.render).toEqual({ status: 'pending', attempts: [] }); expect(result.run.material.events).toHaveLength(2);
    expect(result.session.world).toEqual(before.world); expect(stateWithoutKnowledge(result.session)).toEqual(stateWithoutKnowledge(before)); expect(result.session.prose).toEqual(before.prose);
    expect(result.session.events.slice(before.events.length).every(event => event.audience === 'author')).toBe(true);
    const actor = result.session.roles.find(role => role.id === 'actor')!, partner = result.session.roles.find(role => role.id === 'partner')!, spectator = result.session.roles.find(role => role.id === 'spectator')!;
    expect(actor.knowledge).toHaveLength(2); expect(partner.knowledge).toHaveLength(1); expect(spectator.knowledge).toEqual([]);
    expect(actor.knowledge.every(entry => JSON.stringify(entry.audience) === '["actor"]')).toBe(true);
    expect(partner.knowledge.some(entry => entry.text.includes('actor实际观察'))).toBe(false);
    expect(result.session.roles.every(role => !role.knowledge.some(entry => entry.text.includes('仅作者')))).toBe(true);
    expect(JSON.stringify(project(result.session, result.session.playerRoleId))).not.toMatch(/actor实际观察|仅作者获准|parallel-run/);
    expect((project(result.session, 'author') as any).parallelRuns).toBeUndefined();
    f.store.save(result.session);
    const restarted = new SessionStore(f.root); expect(() => assertParallelJournal(restarted.get(f.id))).not.toThrow();
    expect(restarted.get(f.id).roles.find(role => role.id === 'actor')!.knowledge).toEqual(actor.knowledge);
    result.run.material.events[0].text = 'response mutation'; expect(result.session.parallelRuns![0].material.events[0].text).not.toBe('response mutation');
  });

  it('rejects stale/prepared leases, altered scope, rewritten approval, foreign observers and unapproved sources atomically', async () => {
    const f = await fixture(); addTurn(f, 'turn'); const first = prepareParallelAttempt(f.store, f.id, 'turn', f.grant), latest = prepareParallelAttempt(f.store, f.id, 'turn', f.grant);
    expect(latest.epoch).toBe(2); const draft = clone(f.store.get(f.id)); draft.revision++; const before = JSON.stringify(draft);
    rejects(() => commitParallelMaterial(draft, f.grant, first, bundle(f.grant, first)));
    const mutations = [
      (b: ParallelDecisionBundle) => { b.scope.location.value = '别处'; },
      (b: ParallelDecisionBundle) => { b.acceptedBehaviors[0].text = 'world rewrote candidate'; },
      (b: ParallelDecisionBundle) => { b.facts[0].observedBy = ['spectator']; },
      (b: ParallelDecisionBundle) => { b.facts[0].sources = [{ kind: 'behavior', id: 'foreign' }]; },
      (b: ParallelDecisionBundle) => { b.rawRejectedCount = 1; },
    ];
    for (const mutate of mutations) { const b = bundle(f.grant, latest); b.acceptedBehaviors = clone(b.acceptedBehaviors); mutate(b); rejects(() => commitParallelMaterial(draft, f.grant, latest, b)); }
    expect(JSON.stringify(draft)).toBe(before);
    const result = commitParallelMaterial(draft, f.grant, latest, bundle(f.grant, latest)); f.store.save(result.session);
    abortParallelAttempts(f.store, f.id, 'turn');
    expect(f.store.get(f.id).parallelAttempts!.map(attempt => attempt.status)).toEqual(['aborted', 'committed']);
    rejects(() => commitParallelMaterial(f.store.get(f.id), f.grant, latest, bundle(f.grant, latest)));
  });

  it('renders/retries only the committed run, preserves the first failure and never increments revision or replays withdrawn memories', async () => {
    const f = await fixture(), result = commit(f, 'turn');
    const observationEvent = result.session.events.find(event => event.kind === 'parallel-behavior' && event.actor === 'actor')!;
    let withdrawn = proposeKnowledgeEdit(f.store.get(f.id), { operation: 'retract', roleId: 'actor', id: `observed:${observationEvent.id}` });
    withdrawn = proposeKnowledgeObservation(withdrawn, 'actor', { sceneId: 'scene', eventId: observationEvent.id }); f.store.save(withdrawn);
    const revision = withdrawn.revision, world = clone(withdrawn.world), roles = clone(withdrawn.roles), ordinaryProse = clone(withdrawn.prose);
    const first = startParallelRender(f.store, f.id, result.run.id, 'first-render');
    const firstStartBytes = await readFile(f.filename, 'utf8'); expect(startParallelRender(f.store, f.id, result.run.id, 'first-render')).toEqual(first); expect(await readFile(f.filename, 'utf8')).toBe(firstStartBytes);
    finishParallelRender(f.store, f.id, result.run.id, first.id, { error: 'FIRST_REAL_WRITER_FAILURE' });
    expect(parallelOutputFor(f.store.get(f.id), 'turn').scenes[0]).toMatchObject({ status: 'failed', error: 'FIRST_REAL_WRITER_FAILURE' });
    const second = startParallelRender(f.store, f.id, result.run.id, 'explicit-retry');
    const completed = finishParallelRender(f.store, f.id, result.run.id, second.id, { prose });
    expect(completed.render.attempts).toMatchObject([{ id: first.id, status: 'failed', error: 'FIRST_REAL_WRITER_FAILURE' }, { id: second.id, status: 'completed', prose }]);
    expect(completed.material).toEqual(result.run.material);
    const after = f.store.get(f.id); expect(after.revision).toBe(revision); expect(after.world).toEqual(world); expect(after.roles).toEqual(roles); expect(after.prose).toEqual(ordinaryProse);
    expect(after.roles.find(role => role.id === 'actor')!.knowledge.find(entry => entry.id === `observed:${observationEvent.id}`)!.lifecycle).toBe('withdrawn');
    const beforeBytes = await readFile(f.filename, 'utf8'); finishParallelRender(f.store, f.id, result.run.id, second.id, { prose }); expect(await readFile(f.filename, 'utf8')).toBe(beforeBytes);
    rejects(() => finishParallelRender(f.store, f.id, result.run.id, first.id, { error: 'replacement failure' }));
    rejects(() => startParallelRender(f.store, f.id, result.run.id, 'replace-success'));
  });

  it('filters presentation to the exact material turn and rejects cross-run render identities', async () => {
    const f = await fixture(), first = commit(f, 'first'), second = commit(f, 'second');
    const firstOutput = parallelOutputFor(f.store.get(f.id), 'first'); expect(firstOutput.scenes.map(scene => scene.id)).toEqual([first.run.id]); expect(firstOutput.worldRevision).toBe(first.run.worldRevision);
    expect(parallelOutputFor(f.store.get(f.id), 'second').scenes.map(scene => scene.id)).toEqual([second.run.id]);
    expect(parallelOutputFor(f.store.get(f.id), null).scenes).toEqual([]); expect(parallelOutputFor(f.store.get(f.id), 'unrelated').scenes).toEqual([]);
    const render = startParallelRender(f.store, f.id, first.run.id, 'render-first');
    rejects(() => finishParallelRender(f.store, f.id, second.run.id, render.id, { prose }));
    expect(parallelOutputFor(f.store.get(f.id), 'first').scenes[0].status).toBe('pending');
  });

  it('reconciles a restart without replaying model work, preserves first failures/material and returns detached data without saving', async () => {
    const f = await fixture(), committed = commit(f, 'committed-turn');
    const first = startParallelRender(f.store, f.id, committed.run.id, 'first');
    finishParallelRender(f.store, f.id, committed.run.id, first.id, { error: 'ORIGINAL_FIRST_FAILURE' });
    const running = startParallelRender(f.store, f.id, committed.run.id, 'running-at-stop');
    addTurn(f, 'prepared-at-stop'); prepareParallelAttempt(f.store, f.id, 'prepared-at-stop', f.grant);
    const held = f.store.get(f.id), original = clone(held), bytes = await readFile(f.filename, 'utf8');
    const restarted = reconcileParallelRestart(frozen(held));
    expect(held).toEqual(original); expect(await readFile(f.filename, 'utf8')).toBe(bytes);
    expect(restarted.parallelAttempts!.map(attempt => attempt.status)).toEqual(['committed', 'aborted']);
    expect(restarted.parallelRuns![0].material).toEqual(committed.run.material);
    expect(restarted.parallelRuns![0].render).toMatchObject({ status: 'failed', attempts: [
      { id: first.id, status: 'failed', error: 'ORIGINAL_FIRST_FAILURE' },
      { id: running.id, status: 'failed', error: 'The server stopped during parallel rendering; no model request was replayed.' },
    ] });
    expect(restarted.revision).toBe(original.revision); expect(restarted.world).toEqual(original.world); expect(restarted.roles).toEqual(original.roles); expect(restarted.prose).toEqual(original.prose);
    f.store.save(restarted);
    expect(startParallelRender(f.store, f.id, committed.run.id, 'explicit-recovery-after-restart').status).toBe('running');
  });

  it('fails corrupt journal/history/material explicitly without resetting or repairing it', async () => {
    const f = await fixture(); commit(f, 'turn'); const good = clone(f.store.get(f.id));
    for (const mutate of [
      (s: StoredSession) => { delete s.parallelAttempts; },
      (s: StoredSession) => { delete s.parallelRuns; },
      (s: StoredSession) => { s.parallelAttempts![0].epoch = 2; },
      (s: StoredSession) => { delete s.parallelAttempts![0].rejectedCandidates; },
      (s: StoredSession) => { s.parallelRuns![0].material.acceptedBehaviors[0].text = 'rewritten'; },
      (s: StoredSession) => { (s.parallelRuns![0].material.events[0].data as any).runId = 'foreign'; },
      (s: StoredSession) => { s.parallelRuns![0].render.status = 'completed'; },
      (s: StoredSession) => { (s.events.find(event => event.kind === 'parallel-world-event')!.data as any).observerRoleIds = ['spectator']; },
    ]) { const session = clone(good); mutate(session); const before = JSON.stringify(session); rejects(() => parallelOutputFor(session, 'turn')); expect(JSON.stringify(session)).toBe(before); }
    let reads = 0; const accessor: unknown[] = []; accessor.length = 1; Object.defineProperty(accessor, '0', { enumerable: true, get() { reads++; return good.parallelRuns![0]; } });
    rejects(() => assertParallelJournal({ ...good, parallelRuns: accessor } as StoredSession)); expect(reads).toBe(0);
  });

  it('validates growing event/run archives per record rather than against an aggregate lifetime JSON budget', async () => {
    const f = await fixture(); commit(f, 'turn'); const session = clone(f.store.get(f.id));
    for (let index = 0; index < 100; index++) session.events.push({ id: `trace-${index}`, at: 'host-time', kind: 'prompt-selection', actor: 'host', audience: 'author', text: 'Private trace', data: { plan: Array.from({ length: 1100 }, (_, item) => item) } });
    expect(validateStateJson(session.events)[0].message).toContain('depth or size');
    expect(() => assertParallelJournal(session)).not.toThrow(); expect(parallelOutputFor(session, 'turn').scenes).toHaveLength(1);
    const runs = session.parallelRuns!; (runs as any).extra = true; rejects(() => assertParallelJournal(session));
  });
});
