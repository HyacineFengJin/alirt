import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CharacterCard, Preset, WorldEvent } from '../shared/types';
import { PARALLEL_SCENES_SERVICE_ID, type ParallelSceneDefinition } from '../shared/parallel-scenes';
import { createNativeTemplate } from '../shared/native';
import { ApiError, clone, project, SessionStore, type StoredSession } from './store';
import { SessionServiceRegistry } from './session-services';
import { applyParallelScenes, parallelAppearanceEvidence, parallelScenesService, readParallelScenes, selectParallelScenes } from './parallel-scenes';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function approved(roleId = 'actor', turnId = 'world-turn'): WorldEvent[] {
  const candidate = { id: `${turnId}-${roleId}-behavior`, roleId, kind: 'action', text: '核对已经公开的告示。' };
  return [
    { id: `${turnId}-approval`, at: 'host-time', turnId, kind: 'behavior-adjudication', actor: 'world', audience: 'author', text: 'Approved', data: { candidates: [candidate], acceptedBehaviorIds: [candidate.id], diagnostics: [] } },
    { id: `${turnId}-world`, at: 'host-time', turnId, kind: 'world-adjudication', actor: 'world', audience: 'author', text: 'Committed' },
    { id: `${turnId}-event`, at: 'host-time', turnId, kind: 'role-behavior', actor: roleId, audience: 'public', text: candidate.text, data: candidate },
  ];
}
async function fixture(card?: CharacterCard) {
  const root = await mkdtemp(join(tmpdir(), 'rp-parallel-scenes-')); roots.push(root);
  const document = card ?? createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  if (!card) {
    document.fields.push({ key: 'location', label: '地点', type: 'string', audience: 'public', editable: true });
    document.roles.push(...['actor', 'other'].map(id => ({ id, name: id === 'actor' ? 'Actor' : 'Other', persona: '', goals: [], peers: [], phase: 'active' as const, presence: 'absent' as const, state: { location: '场外车站' }, knowledge: [] })));
  }
  const store = new SessionStore(root), id = store.create(document, preset).id, session = store.get(id);
  if (!card) {
    session.revision = 1;
    for (const [roleId, turnId] of [['actor', 'world-turn'], ['other', 'other-turn']]) {
      session.turns.push({ id: turnId, requestId: `request-${turnId}`, mode: 'action', action: '已有行动', status: 'failed', phase: 'compose-failed', startedAt: 'host-time' });
      session.events.push(...approved(roleId, turnId));
    }
    store.save(session);
  }
  return { root, store, id, filename: join(root, `session-${id}.json`), registry: new SessionServiceRegistry([parallelScenesService]) };
}
const definition = (id = 'scene-a', participantRoleIds = ['actor']): ParallelSceneDefinition => ({ id, title: '场外核对', enabled: true, participantRoleIds, locationKey: 'location', goal: 'PRIVATE_PARALLEL_GOAL: 在已有地点核对告示' });
function run(f: Awaited<ReturnType<typeof fixture>>, operation: Record<string, unknown>, requestId = `request-${f.store.get(f.id).revision}`) {
  return applyParallelScenes(f.store, f.id, { requestId, expectedRevision: f.store.get(f.id).revision, reason: 'PRIVATE_AUTHOR_REASON', ...operation });
}
function rejects(action: () => unknown, code: string) { try { action(); throw Error('expected rejection'); } catch (error) { expect(error).toBeInstanceOf(ApiError); expect((error as ApiError).code).toBe(code); } }
const unchanged = ({ revision: _revision, updatedAt: _updated, hostServices: _services, events: _events, ...session }: StoredSession) => session;

describe('parallel scene control and pure admission', () => {
  it('uses strict approved behavior despite writer failure, while lifecycle, raw reports and name mentions prove no appearance', async () => {
    const f = await fixture(), session = f.store.get(f.id), evidence = parallelAppearanceEvidence(session);
    expect(evidence.get('actor')).toEqual([{ kind: 'approved-behavior', roleId: 'actor', eventId: 'world-turn-event', turnId: 'world-turn', behaviorId: 'world-turn-actor-behavior' }]);
    for (const mutate of [
      (s: StoredSession) => { s.events = s.events.filter(event => event.kind !== 'world-adjudication'); },
      (s: StoredSession) => { s.events = s.events.filter(event => event.kind !== 'behavior-adjudication'); },
      (s: StoredSession) => { const e = s.events.find(event => event.id === 'world-turn-event')!; e.text = 'rewritten'; },
      (s: StoredSession) => { (s.events.find(event => event.id === 'world-turn-approval')!.data as any).acceptedBehaviorIds = []; },
      (s: StoredSession) => { s.events.find(event => event.id === 'world-turn-event')!.kind = 'role-result'; },
    ]) {
      const s = clone(session); mutate(s);
      s.events.push({ id: 'life', at: 'host-time', kind: 'lifecycle', actor: 'author', audience: 'public', text: 'Actor arrived', data: { roleId: 'actor', presence: 'present' } });
      expect(parallelAppearanceEvidence(s).get('actor')).toBeUndefined();
    }
  });

  it('reads detached frozen views and selects only explicitly stored ready scenes without any writes or dispatch', async () => {
    const f = await fixture(); run(f, { operation: 'upsert', scene: definition() });
    expect(selectParallelScenes(f.store.get(f.id))).toEqual({ scenes: [], blocked: [] });
    run(f, { operation: 'select', selectedSceneIds: ['scene-a'] });
    const before = await readFile(f.filename, 'utf8'), selected = selectParallelScenes(f.store.get(f.id));
    expect(selected.scenes[0]).toMatchObject({ id: 'scene-a', generation: 1, location: '场外车站', participantRoleIds: ['actor'] });
    expect(selected.scenes[0].participants[0].heldStringKeys).toContain('location');
    const view = f.registry.read(PARALLEL_SCENES_SERVICE_ID, f.store.get(f.id)) as any;
    view.grants[0].goal = 'response edit'; view.roles[0].appearanceEvidence.splice(0);
    expect(readParallelScenes(f.store.get(f.id)).grants[0].goal).toContain('PRIVATE_PARALLEL_GOAL');
    expect(await readFile(f.filename, 'utf8')).toBe(before);
  });

  it('keeps all main state/lifecycle/prose/runs unchanged and preserves generations, archives and selection on disable/remove/recreate', async () => {
    const f = await fixture(), before = clone(f.store.get(f.id));
    (f.store.get(f.id) as any).parallelRuns = [{ sentinel: 'PRIVATE_RUN_UNTOUCHED' }];
    (f.store.get(f.id) as any).parallelAttempts = [{ sentinel: 'PRIVATE_ATTEMPT_UNTOUCHED' }];
    const withRuns = clone(f.store.get(f.id));
    run(f, { operation: 'upsert', scene: definition() }); run(f, { operation: 'select', selectedSceneIds: ['scene-a'] });
    run(f, { operation: 'upsert', scene: { ...definition(), enabled: false } });
    expect(selectParallelScenes(f.store.get(f.id)).blocked[0].diagnostics[0].code).toBe('scene-disabled');
    expect(readParallelScenes(f.store.get(f.id)).selectedSceneIds).toEqual(['scene-a']);
    run(f, { operation: 'remove', sceneId: 'scene-a' });
    expect(selectParallelScenes(f.store.get(f.id)).blocked[0].diagnostics[0].code).toBe('scene-removed');
    const result = run(f, { operation: 'upsert', scene: definition() });
    expect(result.grants[0].generation).toBe(3); expect(result.archives.map(grant => grant.generation)).toEqual([1, 2]);
    expect(result.selectedSceneIds).toEqual(['scene-a']); expect(unchanged(f.store.get(f.id))).toEqual(unchanged(withRuns));
    expect(f.store.get(f.id).world).toEqual(before.world); expect(f.store.get(f.id).roles).toEqual(before.roles);
    expect(JSON.stringify(project(f.store.get(f.id), f.store.get(f.id).playerRoleId))).not.toMatch(/PRIVATE_PARALLEL_GOAL|PRIVATE_AUTHOR_REASON/);
  });

  it('limits only selected scenes to two and prevents selected scenes sharing an actor, including a selected upsert change', async () => {
    const f = await fixture();
    run(f, { operation: 'upsert', scene: definition('a') }); run(f, { operation: 'upsert', scene: definition('b', ['other']) }); run(f, { operation: 'upsert', scene: definition('c') });
    run(f, { operation: 'select', selectedSceneIds: ['a', 'b'] }); const before = await readFile(f.filename, 'utf8');
    rejects(() => run(f, { operation: 'select', selectedSceneIds: ['a', 'c'] }), 'PARALLEL_SCENES_OVERLAP');
    rejects(() => run(f, { operation: 'upsert', scene: definition('b') }), 'PARALLEL_SCENES_OVERLAP');
    rejects(() => run(f, { operation: 'select', selectedSceneIds: ['a', 'b', 'c'] }), 'PARALLEL_SCENES_INPUT');
    expect(await readFile(f.filename, 'utf8')).toBe(before);
    expect(selectParallelScenes(f.store.get(f.id)).scenes).toHaveLength(2);
  });

  it('distinguishes unknown/unreadable/mismatched locations and refuses dormant/present/main-remote actors without mutating them', async () => {
    const f = await fixture(); run(f, { operation: 'upsert', scene: definition('a', ['actor', 'other']) }); run(f, { operation: 'select', selectedSceneIds: ['a'] });
    const good = clone(f.store.get(f.id));
    const cases: [string, (session: StoredSession) => void][] = [
      ['location-unknown', s => { s.roles.find(r => r.id === 'actor')!.state.location = ''; }],
      ['location-unreadable', s => { s.fields.find(field => field.key === 'location')!.audience = 'author'; }],
      ['location-mismatch', s => { s.roles.find(r => r.id === 'actor')!.state.location = '另一个车站'; }],
      ['role-inactive', s => { s.roles.find(r => r.id === 'actor')!.phase = 'dormant'; }],
      ['role-present', s => { s.roles.find(r => r.id === 'actor')!.presence = 'present'; }],
      ['role-main-remote', s => { s.roles.find(r => r.id === 'actor')!.interaction = { mode: 'remote', channel: 'message' }; }],
      ['role-interaction-invalid', s => { (s.roles.find(r => r.id === 'actor') as any).interaction = { mode: 'remote', channel: 'invalid' }; }],
    ];
    for (const [code, mutate] of cases) { const session = clone(good); mutate(session); const before = JSON.stringify(session); const result = selectParallelScenes(session); expect(result.scenes).toEqual([]); expect(result.blocked[0].diagnostics.map(d => d.code)).toContain(code); expect(JSON.stringify(session)).toBe(before); }
  });

  it('persists exact-command idempotency before CAS and keeps reason only in private audits/metadata receipts', async () => {
    const f = await fixture(), command = { requestId: 'once', expectedRevision: 1, reason: 'PRIVATE_AUTHOR_REASON', operation: 'upsert', scene: definition() };
    applyParallelScenes(f.store, f.id, command); const before = await readFile(f.filename, 'utf8'), reloaded = new SessionStore(f.root);
    expect(applyParallelScenes(reloaded, f.id, command)).toMatchObject({ duplicate: true, revision: 2, appliedRevision: 2 });
    rejects(() => applyParallelScenes(reloaded, f.id, { ...command, reason: 'different' }), 'PARALLEL_SCENES_REQUEST');
    rejects(() => applyParallelScenes(reloaded, f.id, { ...command, requestId: 'stale' }), 'REVISION_CONFLICT');
    const held = reloaded.get(f.id).hostServices![PARALLEL_SCENES_SERVICE_ID] as any;
    expect(Object.keys(held.receipts[0]).sort()).toEqual(['fingerprint', 'requestId', 'revision']);
    expect(JSON.stringify(held.receipts)).not.toContain('PRIVATE_AUTHOR_REASON'); expect(await readFile(f.filename, 'utf8')).toBe(before);
    const missing = new SessionServiceRegistry(); rejects(() => missing.read(PARALLEL_SCENES_SERVICE_ID, reloaded.get(f.id)), 'SESSION_SERVICE_UNKNOWN');
    expect(readParallelScenes(reloaded.get(f.id)).grants[0].generation).toBe(1);
  });

  it('rejects unknown/player IDs and corrupt generations/receipts instead of inventing identities or resetting history', async () => {
    const f = await fixture();
    for (const roleId of ['unknown', f.store.get(f.id).playerRoleId]) rejects(() => run(f, { operation: 'upsert', scene: definition('bad', [roleId]) }), 'PARALLEL_SCENES_IDENTITY');
    run(f, { operation: 'upsert', scene: definition() }); const good = clone(f.store.get(f.id));
    for (const mutate of [
      (s: StoredSession) => { delete s.hostServices![PARALLEL_SCENES_SERVICE_ID]; },
      (s: StoredSession) => { (s.hostServices![PARALLEL_SCENES_SERVICE_ID] as any).grants[0].generation = 3; },
      (s: StoredSession) => { (s.hostServices![PARALLEL_SCENES_SERVICE_ID] as any).receipts[0].fingerprint = 'f'.repeat(64); },
      (s: StoredSession) => { (s.hostServices![PARALLEL_SCENES_SERVICE_ID] as any).selectedSceneIds = ['missing']; },
    ]) { const session = clone(good); mutate(session); rejects(() => readParallelScenes(session), 'PARALLEL_SCENES_INTEGRITY'); }
  });
});
