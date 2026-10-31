import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ProseReviewContext, ProseReviewResult, StoredProseReview } from '../shared/prose-review';
import { validateStateJson } from '../shared/state-value-schema';
import { validateEventLedger } from './event-ledger';
import { parseProseReviewContext, parseProseReviewResult } from './prose-review';
import { clone, fail, now, type SessionStore, type StoredSession } from './store';

const bad = (message: string): never => fail('PROSE_REVIEW_JOURNAL', message, 409);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const identity = (value: unknown): value is string => text(value) && value.length <= 512 && !['__proto__', 'constructor', 'prototype'].includes(value);
const exact = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => [...required, ...optional].includes(key));
const active = new Set(['queued', 'running', 'committed']);
function json(value: unknown, label: string) { if (validateStateJson(value).length) bad(`${label} must contain ordinary JSON only`); }
function contextOf(value: StoredProseReview): ProseReviewContext {
  return { target: value.target, targetHash: value.targetHash, materialHash: value.materialHash, segments: value.segments, material: value.material };
}
function assertContext(value: unknown): asserts value is ProseReviewContext { parseProseReviewContext(value); }
/** Validate only this private ledger. Reading it never repairs or reinterprets source modules. */
function reviews(session: Readonly<StoredSession>): StoredProseReview[] {
  const descriptor = Object.getOwnPropertyDescriptor(session, 'proseReviews');
  if (!descriptor) return [];
  if (!('value' in descriptor) || validateEventLedger(descriptor.value).length) return bad('Invalid private review ledger');
  const values = descriptor.value as StoredProseReview[], ids = new Set<string>(), attemptIds = new Set<string>(), requests = new Set<string>();
  const scopes: ProseReviewContext[] = [];
  for (const value of values) {
    if (!record(value) || !exact(value, ['schema', 'id', 'target', 'targetHash', 'materialHash', 'segments', 'material', 'attempts'])
      || value.schema !== 'rp.prose-review/0.1' || !identity(value.id) || ids.has(value.id) || !Array.isArray(value.attempts) || !value.attempts.length) bad('Invalid stored review identity');
    const context = contextOf(value); assertContext(context);
    if (scopes.some(scope => isDeepStrictEqual(scope.target, context.target) && scope.targetHash === context.targetHash && scope.materialHash === context.materialHash)) bad('Duplicate stored review target and hashes');
    scopes.push(context); ids.add(value.id);
    for (const attempt of value.attempts) {
      if (!record(attempt) || !exact(attempt, ['id', 'requestId', 'turnId', 'status', 'startedAt'], ['finishedAt', 'nativeSessionId', 'result', 'error'])
        || !identity(attempt.id) || attemptIds.has(attempt.id) || !identity(attempt.requestId) || requests.has(attempt.requestId) || !identity(attempt.turnId)
        || !text(attempt.startedAt) || !['running', 'completed', 'failed', 'interrupted'].includes(attempt.status)
        || Object.hasOwn(attempt, 'nativeSessionId') && !identity(attempt.nativeSessionId)) bad('Invalid stored review attempt identity');
      if (attempt.status === 'running') {
        if (['finishedAt', 'result', 'error'].some(key => Object.hasOwn(attempt, key))) bad('Running review contains a terminal outcome');
      } else {
        if (!text(attempt.finishedAt)) bad('Terminal review requires its host finish timestamp');
        if (attempt.status === 'completed') {
          if (!Object.hasOwn(attempt, 'result') || Object.hasOwn(attempt, 'error')) bad('Completed review requires only its result');
          parseProseReviewResult(attempt.result, context);
        } else if (!text(attempt.error) || Object.hasOwn(attempt, 'result')) bad('Failed or interrupted review requires only its error');
      }
      attemptIds.add(attempt.id); requests.add(attempt.requestId);
    }
  }
  return values;
}
function ownerIsActive(session: Readonly<StoredSession>, turnId: string): boolean {
  const turns = session.turns.filter(turn => turn.id === turnId);
  return turns.length === 1 && active.has(turns[0].status);
}

/** A request identifies one immutable context/owner attempt, including failures. */
export function prepareProseReview(store: SessionStore, id: string, context: ProseReviewContext, request: { requestId: string; turnId: string }): {
  reviewId: string; attemptId: string; duplicate: boolean; record: StoredProseReview;
} {
  assertContext(context); json(request, 'Review request');
  if (!record(request) || !exact(request, ['requestId', 'turnId']) || !identity(request.requestId) || !identity(request.turnId)) bad('Review requires an exact request and owner turn identity');
  const current = store.get(id), held = reviews(current);
  for (const review of held) {
    const previous = review.attempts.find(attempt => attempt.requestId === request.requestId);
    if (!previous) continue;
    if (previous.turnId !== request.turnId || !isDeepStrictEqual(contextOf(review), context)) bad('Review request ID was already used for another context or owner turn');
    return { reviewId: review.id, attemptId: previous.id, duplicate: true, record: clone(review) };
  }
  if (!ownerIsActive(current, request.turnId)) bad('A new review attempt requires one queued, running or committed owner turn');
  const same = held.find(review => isDeepStrictEqual(review.target, context.target) && review.targetHash === context.targetHash && review.materialHash === context.materialHash);
  if (same && !isDeepStrictEqual(contextOf(same), context)) bad('Review hashes already belong to a different exact context');
  const next = clone(current);
  const review: StoredProseReview = same ? next.proseReviews!.find(review => review.id === same.id)! : {
    schema: 'rp.prose-review/0.1' as const, id: randomUUID(), ...clone(context), attempts: [],
  };
  if (!same) (next.proseReviews ??= []).push(review);
  const attempt = { id: randomUUID(), requestId: request.requestId, turnId: request.turnId, status: 'running' as const, startedAt: now() };
  review.attempts.push(attempt); reviews(next); store.save(next);
  return { reviewId: review.id, attemptId: attempt.id, duplicate: false, record: clone(review) };
}

/** The result remains an author-only annotation; this never edits the first draft. */
export function finishProseReview(store: SessionStore, id: string, reviewId: string, attemptId: string,
  outcome: { result: ProseReviewResult } | { error: string; interrupted?: boolean }, nativeSessionId?: string): StoredProseReview {
  const raw: unknown = outcome; json(raw, 'Review outcome');
  if (!identity(reviewId) || !identity(attemptId) || nativeSessionId !== undefined && !identity(nativeSessionId) || !record(raw)
    || !(Object.hasOwn(raw, 'result') ? exact(raw, ['result']) : exact(raw, ['error'], ['interrupted']) && text(raw.error)
      && (!Object.hasOwn(raw, 'interrupted') || typeof raw.interrupted === 'boolean'))) bad('Invalid exact review completion');
  const current = store.get(id), held = reviews(current), review = held.find(review => review.id === reviewId);
  const attempt = review?.attempts.find(attempt => attempt.id === attemptId);
  if (!review || !attempt) return bad('Review completion does not match its stored target and attempt');
  const completion = 'result' in outcome ? { status: 'completed' as const, result: parseProseReviewResult(outcome.result, contextOf(review)) }
    : { status: outcome.interrupted ? 'interrupted' as const : 'failed' as const, error: outcome.error };
  if (attempt.status !== 'running') {
    const previous = attempt.status === 'completed' ? { status: attempt.status, result: attempt.result } : { status: attempt.status, error: attempt.error };
    if (!isDeepStrictEqual(previous, completion) || attempt.nativeSessionId !== nativeSessionId) bad('A terminal review attempt cannot be rewritten');
    return clone(review);
  }
  if (!ownerIsActive(current, attempt.turnId)) bad('The review owner turn is no longer active; the running attempt is interrupted');
  const next = clone(current), changed = next.proseReviews!.find(review => review.id === reviewId)!, target = changed.attempts.find(attempt => attempt.id === attemptId)!;
  Object.assign(target, completion, { finishedAt: now() }, ...(nativeSessionId === undefined ? [] : [{ nativeSessionId }]));
  reviews(next); store.save(next); return clone(changed);
}

/** Restart/closed-owner status is a detached read projection, never a retry. */
export function readStoredProseReviews(session: Readonly<StoredSession>): StoredProseReview[] {
  const result = clone(reviews(session));
  for (const review of result) for (const attempt of review.attempts) {
    if (attempt.status === 'running' && !ownerIsActive(session, attempt.turnId)) {
      attempt.status = 'interrupted';
      attempt.error = 'The owning turn ended or is unavailable before review completion. No model request was replayed; the first draft remains unchanged.';
    }
  }
  return result;
}
