import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset } from '../shared/types';
import type { ProseReviewContext, ProseReviewResult } from '../shared/prose-review';
import { ApiError, clone, project, SessionStore, type StoredSession } from './store';
import { finishProseReview, prepareProseReview, readStoredProseReviews } from './prose-review-journal';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const protectedState = ({ revision, world, roles, prose, events, turns }: StoredSession) => clone({ revision, world, roles, prose, events, turns });
const result: ProseReviewResult = { summary: 'Check the presentation against retained material.', findings: [{ segmentId: 'narration-1', quote: 'quiet room',
  category: 'other', severity: 'note', explanation: 'The supplied scene names this room.', sourceRefs: ['scene-1'] }] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rp-prose-review-journal-')); roots.push(root);
  const card = createNativeTemplate('card') as CharacterCard; card.opening = 'The quiet room is unchanged.';
  const store = new SessionStore(root), id = store.create(card, createNativeTemplate('preset') as Preset).id;
  const session = clone(store.get(id));
  session.turns.push({ id: 'owner-turn', requestId: 'owner-request', action: 'Continue.', mode: 'action', status: 'running', phase: 'prose-review', startedAt: '2026-10-31T00:00:00.000Z' });
  store.save(session);
  const context: ProseReviewContext = { target: { kind: 'main', entryId: session.prose[0].id }, targetHash: hash(session.prose[0]), materialHash: hash('scene'),
    segments: [{ id: 'title-1', kind: 'title', text: 'First draft' }, { id: 'narration-1', kind: 'narration', text: 'The quiet room is unchanged.' }],
    material: { references: [{ ref: 'scene-1', kind: 'scene', text: 'The room is quiet.' }], limitations: ['Material checks are not semantic proof.'] } };
  return { root, store, id, context, request: { requestId: 'review-request', turnId: 'owner-turn' }, filename: join(root, `session-${id}.json`) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function reject(action: () => unknown) { expect(action).toThrow(ApiError); }
function changeOwner(f: Fixture, status: StoredSession['turns'][number]['status'] | 'missing') {
  const next = clone(f.store.get(f.id));
  if (status === 'missing') next.turns = [];
  else { next.turns[0].status = status; next.turns[0].finishedAt = '2026-10-31T00:01:00.000Z'; }
  f.store.save(next);
}

describe('private prose review journal', () => {
  it('saves detached host identities, reuses exact contexts and keeps all world, role, event and first-draft state unchanged', async () => {
    const f = await fixture(), before = protectedState(f.store.get(f.id)), contextBefore = clone(f.context);
    const first = prepareProseReview(f.store, f.id, f.context, f.request);
    expect(first).toMatchObject({ duplicate: false, record: { schema: 'rp.prose-review/0.1', attempts: [{ status: 'running', turnId: 'owner-turn' }] } });
    expect(first.reviewId).toMatch(/^[a-f0-9-]{36}$/); expect(first.attemptId).toMatch(/^[a-f0-9-]{36}$/);
    expect(protectedState(f.store.get(f.id))).toEqual(before); expect(f.context).toEqual(contextBefore);
    first.record.material.references[0].text = 'Caller mutation';
    expect(f.store.get(f.id).proseReviews![0].material.references[0].text).toBe(contextBefore.material.references[0].text);
    const bytes = await readFile(f.filename, 'utf8'), duplicate = prepareProseReview(f.store, f.id, clone(f.context), f.request);
    expect(duplicate.duplicate).toBe(true); expect(duplicate.attemptId).toBe(first.attemptId); expect(await readFile(f.filename, 'utf8')).toBe(bytes);
    const second = prepareProseReview(f.store, f.id, f.context, { ...f.request, requestId: 'explicit-second-request' });
    expect(second.reviewId).toBe(first.reviewId); expect(second.attemptId).not.toBe(first.attemptId); expect(second.record.attempts).toHaveLength(2);
    expect(protectedState(f.store.get(f.id))).toEqual(before);
    expect((project(f.store.get(f.id), 'author') as any).proseReviews).toBeUndefined();
    expect((project(f.store.get(f.id), f.store.get(f.id).playerRoleId) as any).proseReviews).toBeUndefined();
    const parallel = clone(f.context); parallel.target = { kind: 'parallel', runId: 'private-run', renderAttemptId: 'private-render' };
    expect(prepareProseReview(f.store, f.id, parallel, { ...f.request, requestId: 'parallel-review' }).reviewId).not.toBe(first.reviewId);
  });

  it('rejects reused request identities, hash collisions, role scope and non-JSON context without saving or executing getters', async () => {
    const f = await fixture(); prepareProseReview(f.store, f.id, f.context, f.request);
    const original = await readFile(f.filename, 'utf8');
    const changed = clone(f.context); changed.segments[1].text += ' altered';
    reject(() => prepareProseReview(f.store, f.id, changed, f.request));
    reject(() => prepareProseReview(f.store, f.id, changed, { ...f.request, requestId: 'hash-collision' }));
    reject(() => prepareProseReview(f.store, f.id, f.context, { ...f.request, turnId: 'foreign-turn' }));
    for (const mutate of [
      (context: any) => { context.target = { kind: 'role', roleId: f.store.get(f.id).playerRoleId }; },
      (context: any) => { context.target.roleId = 'foreign-role'; },
      (context: any) => { context.targetHash = 'not-a-sha256'; },
      (context: any) => { context.material.privateThought = 'Foreign role context'; },
      (context: any) => { context.segments.push(clone(context.segments[0])); },
    ]) {
      const malformed = clone(f.context); mutate(malformed);
      reject(() => prepareProseReview(f.store, f.id, malformed, { ...f.request, requestId: 'invalid-context' }));
    }
    let reads = 0; const accessor = clone(f.context);
    Object.defineProperty(accessor, 'material', { enumerable: true, get() { reads++; return f.context.material; } });
    reject(() => prepareProseReview(f.store, f.id, accessor, f.request)); expect(reads).toBe(0);
    expect(await readFile(f.filename, 'utf8')).toBe(original);
  });

  it('requires an active owner for new attempts and returns the original request even after its owner finishes', async () => {
    for (const status of ['completed', 'failed', 'interrupted', 'missing'] as const) {
      const f = await fixture(), first = prepareProseReview(f.store, f.id, f.context, f.request); changeOwner(f, status);
      expect(prepareProseReview(f.store, f.id, f.context, f.request)).toMatchObject({ duplicate: true, attemptId: first.attemptId });
      reject(() => prepareProseReview(f.store, f.id, f.context, { ...f.request, requestId: 'new-request' }));
      reject(() => finishProseReview(f.store, f.id, first.reviewId, first.attemptId, { result }));
      expect(readStoredProseReviews(f.store.get(f.id))[0].attempts[0]).toMatchObject({ status: 'interrupted' });
    }
    for (const status of ['queued', 'committed'] as const) {
      const f = await fixture(); changeOwner(f, status);
      expect(prepareProseReview(f.store, f.id, f.context, f.request).duplicate).toBe(false);
    }
  });

  it('parses exact finding references and quotes before terminal persistence, with exact idempotence and no first-draft edits', async () => {
    const f = await fixture(), before = protectedState(f.store.get(f.id)), prepared = prepareProseReview(f.store, f.id, f.context, f.request);
    const bytes = await readFile(f.filename, 'utf8');
    for (const mutate of [
      (value: any) => { value.findings[0].sourceRefs = ['foreign-evidence']; },
      (value: any) => { value.findings[0].segmentId = 'foreign-segment'; },
      (value: any) => { value.findings[0].quote = 'Words absent from the segment'; },
      (value: any) => { value.world = { changed: true }; },
    ]) { const malformed = clone(result); mutate(malformed); reject(() => finishProseReview(f.store, f.id, prepared.reviewId, prepared.attemptId, { result: malformed })); }
    reject(() => finishProseReview(f.store, f.id, prepared.reviewId, 'foreign-attempt', { result }));
    expect(await readFile(f.filename, 'utf8')).toBe(bytes);
    const finished = finishProseReview(f.store, f.id, prepared.reviewId, prepared.attemptId, { result }, 'isolated-review-native-session');
    expect(finished.attempts[0]).toMatchObject({ status: 'completed', result, nativeSessionId: 'isolated-review-native-session' });
    expect(protectedState(f.store.get(f.id))).toEqual(before);
    const terminalBytes = await readFile(f.filename, 'utf8');
    finishProseReview(f.store, f.id, prepared.reviewId, prepared.attemptId, { result: clone(result) }, 'isolated-review-native-session');
    expect(await readFile(f.filename, 'utf8')).toBe(terminalBytes);
    reject(() => finishProseReview(f.store, f.id, prepared.reviewId, prepared.attemptId, { error: 'Overwrite' }, 'isolated-review-native-session'));
    reject(() => finishProseReview(f.store, f.id, prepared.reviewId, prepared.attemptId, { result }, 'other-native-session'));
    finished.attempts[0].result!.summary = 'Caller mutation'; expect(f.store.get(f.id).proseReviews![0].attempts[0].result!.summary).toBe(result.summary);
  });

  it('retains failed and explicitly interrupted attempts, never redispatches duplicate requests, and permits a separate explicit attempt', async () => {
    const f = await fixture(), before = protectedState(f.store.get(f.id));
    const first = prepareProseReview(f.store, f.id, f.context, f.request);
    finishProseReview(f.store, f.id, first.reviewId, first.attemptId, { error: 'Original provider failure' }, 'failed-native-context');
    expect(prepareProseReview(f.store, f.id, f.context, f.request)).toMatchObject({ duplicate: true, attemptId: first.attemptId, record: { attempts: [{ status: 'failed', error: 'Original provider failure' }] } });
    const bytes = await readFile(f.filename, 'utf8');
    finishProseReview(f.store, f.id, first.reviewId, first.attemptId, { error: 'Original provider failure' }, 'failed-native-context');
    expect(await readFile(f.filename, 'utf8')).toBe(bytes);
    const next = prepareProseReview(f.store, f.id, f.context, { ...f.request, requestId: 'explicit-after-failure' });
    finishProseReview(f.store, f.id, next.reviewId, next.attemptId, { error: 'Author interrupted', interrupted: true });
    expect(readStoredProseReviews(f.store.get(f.id))[0].attempts.map(attempt => attempt.status)).toEqual(['failed', 'interrupted']);
    expect(protectedState(f.store.get(f.id))).toEqual(before);
  });

  it('derives restart interruption without rewriting records or replaying work, and reads retained data when modules are absent', async () => {
    const f = await fixture(), prepared = prepareProseReview(f.store, f.id, f.context, f.request);
    const restarted = new SessionStore(f.root), session = restarted.get(f.id), bytes = await readFile(f.filename, 'utf8');
    expect(session.turns[0].status).toBe('interrupted'); expect(session.proseReviews![0].attempts[0].status).toBe('running');
    const projection = readStoredProseReviews(session);
    expect(projection[0].attempts[0]).toMatchObject({ status: 'interrupted', error: expect.stringContaining('No model request was replayed') });
    expect(session.proseReviews![0].attempts[0].status).toBe('running'); expect(await readFile(f.filename, 'utf8')).toBe(bytes);
    projection[0].segments[0].text = 'Caller mutation'; expect(readStoredProseReviews(session)[0].segments[0].text).toBe('First draft');
    session.card.modules = []; session.preset.modules = [];
    expect(readStoredProseReviews(session)[0].id).toBe(prepared.reviewId);
    expect(prepareProseReview(restarted, f.id, f.context, f.request)).toMatchObject({ duplicate: true, attemptId: prepared.attemptId });
  });

  it('rejects corrupt stored scopes and attempt histories explicitly without resetting private material', async () => {
    const f = await fixture(); prepareProseReview(f.store, f.id, f.context, f.request); const good = clone(f.store.get(f.id));
    for (const mutate of [
      (session: StoredSession) => { session.proseReviews![0].attempts.push(clone(session.proseReviews![0].attempts[0])); },
      (session: StoredSession) => { session.proseReviews![0].targetHash = 'invalid'; },
      (session: StoredSession) => { session.proseReviews![0].attempts[0].status = 'completed'; },
      (session: StoredSession) => { (session.proseReviews![0] as any).roleId = 'foreign-scope'; },
    ]) { const changed = clone(good); mutate(changed); const before = JSON.stringify(changed); reject(() => readStoredProseReviews(changed)); expect(JSON.stringify(changed)).toBe(before); }
    let reads = 0; const accessor = clone(good);
    Object.defineProperty(accessor, 'proseReviews', { enumerable: true, get() { reads++; return good.proseReviews; } });
    reject(() => readStoredProseReviews(accessor)); expect(reads).toBe(0);
  });
});
