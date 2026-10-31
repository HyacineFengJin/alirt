import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CharacterCard, Preset, WorldEvent } from '../shared/types';
import { STORY_PROGRESS_CONTROL_SERVICE_ID, type StoryProgressControlView } from '../shared/story-progress-control';
import { validateStateJson } from '../shared/state-value-schema';
import card from '../../content/cards/harbor.json';
import preset from '../../content/presets/basic.json';
import { ApiError, clone, project, SessionStore, type StoredSession } from './store';
import { SessionServiceRegistry } from './session-services';
import { applyStoryProgressControl, readStoryProgressControl, storyProgressControlService } from './story-progress-control';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const reason = 'PRIVATE_AUTHOR_CORRECTION_REASON';
const publicFact = (): WorldEvent => ({ id: 'public-fact', at: 'host-time', turnId: 'world-turn', kind: 'world-event', actor: 'world', audience: 'public', text: '告示已经公开', data: { fact: { text: '告示已经公开', sources: [{ kind: 'world-development' }] } } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rp-story-progress-control-')); roots.push(root);
  const store = new SessionStore(root), id = store.create(clone(card) as CharacterCard, clone(preset) as Preset).id;
  const session = store.get(id);
  session.revision = 1; // A retained committed public-world batch supplies the evidence.
  session.events.push(publicFact(), { ...publicFact(), id: 'private-fact', audience: 'author', text: 'PRIVATE_WORLD_PAYLOAD' }, { ...publicFact(), id: 'raw-report', kind: 'role-result', text: 'PRIVATE_RAW_REPORT' }, { ...publicFact(), id: 'behavior', kind: 'role-behavior' }, { ...publicFact(), id: 'host-output', kind: 'host-output' });
  store.save(session);
  const registry = new SessionServiceRegistry([storyProgressControlService]);
  return { root, store, id, registry, filename: join(root, `session-${id}.json`) };
}
const command = (revision = 1, requestId = 'author-1') => ({ requestId, expectedRevision: revision, reason, patch: { operations: [{ op: 'create', kind: 'main', title: '调查', summary: '核对公开告示', status: 'active', evidence: { factIndexes: [], eventIds: ['public-fact'] } }] } });
const untouched = ({ revision: _revision, updatedAt: _updated, storyProgress: _progress, hostServices: _services, events: _events, ...session }: StoredSession) => session;
function rejects(action: () => unknown, code: string) { try { action(); throw Error('expected rejection'); } catch (error) { expect(error).toBeInstanceOf(ApiError); expect((error as ApiError).code).toBe(code); } }

describe('trusted story progress author controller', () => {
  it('reads and corrects a real-shaped growing ledger over 100k aggregate nodes while every event remains valid', async () => {
    const f = await fixture(), session = f.store.get(f.id);
    // Match the failed production envelope: many private prompt-selection traces
    // (target/phase/ids/injectedIds/plan), not one oversized event or source body.
    for (let index = 0; index < 80; index++) {
      const ref = (item: number) => ({ source: 'preset', documentId: 'fixture', moduleId: `module-${item}`, key: `preset:module-${item}` });
      session.events.push({ id: `prompt-${index}`, at: 'host-time', turnId: `turn-${index}`, kind: 'prompt-selection', actor: 'host', audience: 'author', text: 'Prompt selection trace', data: {
        target: 'prose', phase: 'compose', ids: ['fixture'], injectedIds: ['fixture'], plan: {
          schema: 'rp.prompt-plan/0.1', snapshotRevision: 1, target: 'prose', phase: 'compose', roleId: null,
          sources: [{ source: 'preset', documentId: 'fixture', schema: 'rp.preset/0.1', fingerprint: 'hash', effectiveModulesFingerprint: 'hash' }],
          modules: Array.from({ length: 20 }, (_, item) => ({ ref: ref(item), slot: 'before-context', order: item, priority: item, contentHash: 'hash', characters: 10 })),
          decisions: Array.from({ length: 103 }, (_, item) => ({ ref: ref(item), status: 'included', reasons: [], slot: 'before-context', order: item, priority: item })),
          diagnostics: [], valid: true, worldbook: {}, activation: {},
        },
      } });
    }
    for (let index = 0; index < 159; index++) session.events.push({ id: `notice-${index}`, at: 'host-time', kind: 'fixture-notice', actor: 'host', audience: 'author', text: 'Private fixture notice' });
    expect(session.events).toHaveLength(245);
    expect(validateStateJson(session.events)[0].message).toContain('depth or size');
    expect(session.events.every(event => !validateStateJson(event).length)).toBe(true);
    f.store.save(session); const before = await readFile(f.filename, 'utf8');
    expect(readStoryProgressControl(session).publicEvents).toEqual([{ id: 'public-fact', turnId: 'world-turn', text: '告示已经公开' }]);
    expect(await readFile(f.filename, 'utf8')).toBe(before);
    const result = applyStoryProgressControl(f.store, f.id, command());
    expect(result.progress!.sequence).toBe(1); expect(result.publicEvents).toHaveLength(1);
    expect(f.store.get(f.id).events.slice(0, -1)).toEqual(session.events);
  });

  it('rejects malformed ledger arrays and per-event non-JSON without invoking array or event accessors', async () => {
    const f = await fixture(), good = clone(f.store.get(f.id)); let reads = 0;
    const accessor: WorldEvent[] = []; accessor.length = 1;
    Object.defineProperty(accessor, '0', { enumerable: true, get() { reads++; return publicFact(); } });
    const eventGetter = Object.defineProperty(publicFact(), 'data', { enumerable: true, get() { reads++; return {}; } });
    const bad = [new Array(1), accessor, Object.assign([publicFact()], { extra: true }), Object.setPrototypeOf([publicFact()], {}), Object.defineProperty([publicFact()], 'hidden', { value: 1 }), Object.assign([publicFact()], { [Symbol('extra')]: true }), [eventGetter], [{ ...publicFact(), data: { value: Infinity } }]];
    for (const events of bad) rejects(() => readStoryProgressControl({ ...good, events } as StoredSession), 'STORY_PROGRESS_CONTROL_INTEGRITY');
    expect(reads).toBe(0);
  });

  it('reads frozen detached data without writes and projects canonical event identity/text only', async () => {
    const f = await fixture(), before = await readFile(f.filename, 'utf8');
    const view = f.registry.read(STORY_PROGRESS_CONTROL_SERVICE_ID, f.store.get(f.id)) as unknown as StoryProgressControlView;
    expect(view).toEqual({ schema: 'rp.story-progress-control/0.1', revision: 1, progress: null, publicEvents: [{ id: 'public-fact', turnId: 'world-turn', text: '告示已经公开' }] });
    expect(JSON.stringify(view)).not.toMatch(/PRIVATE_|sources|data/);
    view.publicEvents[0].text = 'edited response';
    expect(readStoryProgressControl(f.store.get(f.id)).publicEvents[0].text).toBe('告示已经公开');
    expect(await readFile(f.filename, 'utf8')).toBe(before);
  });

  it('commits only tracker/revision/metadata receipts and private audit, retaining world roles prose and source controls', async () => {
    const f = await fixture(), before = clone(f.store.get(f.id));
    const result = applyStoryProgressControl(f.store, f.id, command()); const next = f.store.get(f.id);
    expect(result).toMatchObject({ duplicate: false, requestId: 'author-1', appliedRevision: 2, revision: 2, progress: { sequence: 1, nextMainIndex: 2, tasks: [{ id: 'MQ.I' }] } });
    expect(next.storyProgress!.before).toEqual(next.storyProgress!.after); expect(next.storyProgress!.after).toEqual({ time: before.world.time, location: before.world.location });
    expect(untouched(next)).toEqual(untouched(before)); expect(next.events.slice(0, -1)).toEqual(before.events);
    expect(next.events.at(-1)).toMatchObject({ kind: 'story-progress-control', actor: 'author', audience: 'author', data: { reason } });
    const held = next.hostServices![STORY_PROGRESS_CONTROL_SERVICE_ID] as any;
    expect(Object.keys(held.requests[0]).sort()).toEqual(['fingerprint', 'requestId', 'revision']); expect(JSON.stringify(held)).not.toContain(reason);
    expect(JSON.stringify(result)).not.toContain(reason);
    expect(JSON.stringify(project(next, next.playerRoleId))).not.toContain(reason);
    expect((project(next, 'author') as any).storyProgress).toBeUndefined();
    const reloaded = new SessionStore(f.root);
    expect(readStoryProgressControl(reloaded.get(f.id)).progress).toEqual(next.storyProgress);
  });

  it('checks exact-command duplicates before CAS, persists across reload, and rejects changed commands under the same ID', async () => {
    const f = await fixture(), original = command(); applyStoryProgressControl(f.store, f.id, original);
    const before = await readFile(f.filename, 'utf8');
    const reloaded = new SessionStore(f.root), duplicate = applyStoryProgressControl(reloaded, f.id, { patch: original.patch, reason: original.reason, expectedRevision: original.expectedRevision, requestId: original.requestId });
    expect(duplicate).toMatchObject({ duplicate: true, revision: 2, appliedRevision: 2, progress: { sequence: 1 } });
    expect(await readFile(f.filename, 'utf8')).toBe(before);
    rejects(() => applyStoryProgressControl(reloaded, f.id, { ...original, reason: 'different reason' }), 'STORY_PROGRESS_CONTROL_REQUEST');
    rejects(() => applyStoryProgressControl(reloaded, f.id, command(1, 'new-stale')), 'REVISION_CONFLICT');
    expect(await readFile(f.filename, 'utf8')).toBe(before);
  });

  it('allows explicit title/summary/status corrections backed by public events and keeps completed archives immutable', async () => {
    const f = await fixture(); applyStoryProgressControl(f.store, f.id, command());
    const complete = { requestId: 'complete', expectedRevision: 2, reason: '确认完成', patch: { operations: [{ op: 'update', taskId: 'MQ.I', title: '已核对', summary: '公开告示已核对完毕', status: 'completed', evidence: { factIndexes: [], eventIds: ['public-fact'] } }] } };
    const result = applyStoryProgressControl(f.store, f.id, complete);
    expect(result.progress!.tasks[0]).toMatchObject({ id: 'MQ.I', title: '已核对', status: 'completed', createdAtSequence: 1, updatedAtSequence: 2, completedAtSequence: 2 });
    const before = await readFile(f.filename, 'utf8');
    rejects(() => applyStoryProgressControl(f.store, f.id, { ...complete, requestId: 'revise-completed', expectedRevision: 3 }), 'STORY_PROGRESS');
    expect(await readFile(f.filename, 'utf8')).toBe(before);
  });

  it('rejects private/raw/behavior/host-output references, fake IDs/PG and nonempty fact indexes without writes', async () => {
    const f = await fixture(), before = await readFile(f.filename, 'utf8'), c = command();
    for (const id of ['private-fact', 'raw-report', 'behavior', 'host-output', 'unknown']) rejects(() => applyStoryProgressControl(f.store, f.id, { ...c, patch: { operations: [{ ...c.patch.operations[0], evidence: { factIndexes: [], eventIds: [id] } }] } }), 'STORY_PROGRESS');
    for (const input of [{ ...c, PG: 10 }, { ...c, reason: '  ' }, { ...c, patch: { operations: [{ ...c.patch.operations[0], id: 'MQ.V' }] } }, { ...c, patch: { operations: [{ ...c.patch.operations[0], evidence: { factIndexes: [0], eventIds: [] } }] } }]) rejects(() => applyStoryProgressControl(f.store, f.id, input), 'STORY_PROGRESS_CONTROL_INPUT');
    expect(await readFile(f.filename, 'utf8')).toBe(before);
  });

  it('fails corrupt receipts/held state/audit linkage instead of resetting them', async () => {
    const f = await fixture(); applyStoryProgressControl(f.store, f.id, command());
    const good = clone(f.store.get(f.id));
    const malformed: StoredSession[] = [];
    const mutate = (edit: (session: StoredSession) => void) => { const session = clone(good); edit(session); malformed.push(session); };
    mutate(session => { session.hostServices![STORY_PROGRESS_CONTROL_SERVICE_ID] = null; });
    mutate(session => { delete session.hostServices![STORY_PROGRESS_CONTROL_SERVICE_ID]; });
    mutate(session => { (session.hostServices![STORY_PROGRESS_CONTROL_SERVICE_ID] as any).requests[0].fingerprint = 'f'.repeat(64); });
    mutate(session => { (session.hostServices![STORY_PROGRESS_CONTROL_SERVICE_ID] as any).requests.push((session.hostServices![STORY_PROGRESS_CONTROL_SERVICE_ID] as any).requests[0]); });
    mutate(session => { session.storyProgress!.nextMainIndex = 9; });
    mutate(session => { session.events = session.events.filter(event => event.id !== 'public-fact'); });
    mutate(session => { session.events.at(-1)!.audience = 'public'; });
    mutate(session => { session.events.push(null as unknown as WorldEvent); });
    for (const session of malformed) {
      f.store.save(session); const before = await readFile(f.filename, 'utf8');
      rejects(() => readStoryProgressControl(f.store.get(f.id)), 'STORY_PROGRESS_CONTROL_INTEGRITY');
      rejects(() => applyStoryProgressControl(f.store, f.id, { ...command(2, 'next'), patch: { operations: [] } }), 'STORY_PROGRESS_CONTROL_INTEGRITY');
      expect(await readFile(f.filename, 'utf8')).toBe(before);
    }
  });

  it('removing only the trusted service returns 404 and leaves tracker and ordinary story snapshots intact', async () => {
    const f = await fixture(); applyStoryProgressControl(f.store, f.id, command());
    const before = await readFile(f.filename, 'utf8'), removed = new SessionServiceRegistry();
    const snapshot = project(f.store.get(f.id), f.store.get(f.id).playerRoleId);
    rejects(() => removed.read(STORY_PROGRESS_CONTROL_SERVICE_ID, f.store.get(f.id)), 'SESSION_SERVICE_UNKNOWN');
    rejects(() => removed.apply(STORY_PROGRESS_CONTROL_SERVICE_ID, f.store, f.id, command(2, 'removed')), 'SESSION_SERVICE_UNKNOWN');
    expect(project(f.store.get(f.id), f.store.get(f.id).playerRoleId)).toEqual(snapshot);
    expect(f.store.get(f.id).storyProgress!.sequence).toBe(1); expect(await readFile(f.filename, 'utf8')).toBe(before);
  });
});
