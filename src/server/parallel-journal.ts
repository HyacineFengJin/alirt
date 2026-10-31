import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { BehaviorCandidate } from '../shared/behavior';
import type { ResolvedParallelScene } from '../shared/parallel-scenes';
import { parallelSceneView, validParallelScenesOutput, type ParallelAttempt, type ParallelProse, type ParallelRenderAttempt, type ParallelRun, type ParallelScenesOutput } from '../shared/parallel-output';
import { validateStateJson } from '../shared/state-value-schema';
import type { Json, WorldEvent } from '../shared/types';
import type { ParallelDecisionBundle, ParallelFact } from './parallel-runtime';
import { validateEventLedger } from './event-ledger';
import { proposeKnowledgeObservation } from './knowledge-runtime';
import { selectParallelScenes } from './parallel-scenes';
import { clone, event, fail, now, type SessionStore, type StoredSession } from './store';

function bad(message: string): never { return fail('PARALLEL_JOURNAL', message, 409); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const identity = (value: unknown): value is string => text(value) && value.length <= 512 && !['__proto__', 'constructor', 'prototype'].includes(value);
const integer = (value: unknown, min = 1): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
const exact = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));
const tuple = (value: Pick<ParallelAttempt, 'sceneId' | 'grantGeneration' | 'turnId' | 'epoch'>) => JSON.stringify([value.sceneId, value.grantGeneration, value.turnId, value.epoch]);
const scopeKey = (value: Pick<ParallelAttempt, 'sceneId' | 'grantGeneration'>) => JSON.stringify([value.sceneId, value.grantGeneration]);
function increment(value: number) { if (!integer(value) || value >= Number.MAX_SAFE_INTEGER) return bad('Parallel attempt epoch exhausted'); return value + 1; }
function json(value: unknown, label: string) { const issue = validateStateJson(value)[0]; if (issue) return bad(`${label}: ${issue.message}`); }
function array(value: unknown, label: string): asserts value is unknown[] { if (validateEventLedger(value).length) bad(`Invalid ${label}`); }
function prose(value: unknown): value is ParallelProse {
  return record(value) && exact(value, ['title', 'text', 'person', 'pov']) && typeof value.title === 'string' && text(value.text)
    && ['first', 'third'].includes(value.person as string) && ['limited', 'omniscient'].includes(value.pov as string);
}
function behavior(value: unknown, cast: Set<string>): value is BehaviorCandidate {
  return record(value) && exact(value, ['id', 'roleId', 'kind', 'text']) && identity(value.id) && cast.has(value.roleId as string)
    && ['speech', 'action'].includes(value.kind as string) && text(value.text);
}
function fact(value: unknown, cast: Set<string>, approved: Set<string>): value is ParallelFact {
  if (!record(value) || !exact(value, ['text', 'sources', 'observedBy']) || !text(value.text) || !Array.isArray(value.sources) || !value.sources.length
    || !Array.isArray(value.observedBy) || value.observedBy.some(id => !cast.has(id as string)) || new Set(value.observedBy).size !== value.observedBy.length) return false;
  const sources = new Set<string>();
  return value.sources.every(source => {
    if (!record(source) || !(source.kind === 'behavior' ? exact(source, ['kind', 'id']) && approved.has(source.id as string) : source.kind === 'world-development' && exact(source, ['kind']))) return false;
    const key = source.kind === 'behavior' ? `behavior:${source.id}` : 'world-development';
    if (sources.has(key)) return false; sources.add(key); return true;
  });
}
function privateEvent(value: WorldEvent, run: ParallelRun, kind: 'parallel-behavior' | 'parallel-world-event') {
  if (!record(value) || !exact(value, ['id', 'at', 'turnId', 'kind', 'actor', 'audience', 'text', 'data']) || !identity(value.id) || !text(value.at)
    || value.kind !== kind || value.audience !== 'author' || value.turnId !== run.turnId || !text(value.text) || !record(value.data)
    || !exact(value.data, ['sceneId', 'runId', 'observerRoleIds', kind === 'parallel-behavior' ? 'behavior' : 'fact'])
    || value.data.sceneId !== run.sceneId || value.data.runId !== run.id || !Array.isArray(value.data.observerRoleIds)) bad('Parallel material event has invalid identity or scope');
}

/** Per-run/per-event validation: archives do not consume a shared lifetime JSON
 * budget. No malformed journal is reset, repaired or accepted as empty. */
export function assertParallelJournal(session: Readonly<StoredSession>): void {
  if (!integer(session.revision, 0)) bad('Invalid session revision');
  array(session.events, 'event ledger');
  const events = new Map<string, WorldEvent>(), byRun = new Map<string, { behaviors: WorldEvent[]; facts: WorldEvent[] }>();
  for (const entry of session.events) {
    if (!entry || !identity(entry.id) || events.has(entry.id)) bad('Event identities must be unique');
    events.set(entry.id, entry);
    if (!['parallel-behavior', 'parallel-world-event'].includes(entry.kind)) continue;
    const data = entry.data;
    if (!record(data) || !identity(data.runId)) bad('Private scene material has no valid run identity');
    const material = byRun.get(data.runId) ?? { behaviors: [], facts: [] };
    (entry.kind === 'parallel-behavior' ? material.behaviors : material.facts).push(entry); byRun.set(data.runId, material);
  }
  const attempts = session.parallelAttempts === undefined ? [] : session.parallelAttempts;
  const runs = session.parallelRuns === undefined ? [] : session.parallelRuns;
  array(attempts, 'parallel attempt ledger'); array(runs, 'parallel run ledger');
  const attemptIds = new Set<string>(), attemptsByTuple = new Map<string, ParallelAttempt>(), previous = new Map<string, ParallelAttempt>();
  for (const attempt of attempts) {
    if (!record(attempt) || !exact(attempt, ['id', 'turnId', 'sceneId', 'grantGeneration', 'epoch', 'status'], ['rejectedCandidates'])
      || !identity(attempt.id) || attemptIds.has(attempt.id) || !identity(attempt.turnId) || !identity(attempt.sceneId) || !integer(attempt.grantGeneration) || !integer(attempt.epoch)
      || !['prepared', 'committed', 'aborted'].includes(attempt.status)
      || (attempt.status === 'committed' ? typeof attempt.rejectedCandidates !== 'boolean' : Object.hasOwn(attempt, 'rejectedCandidates'))) bad('Invalid parallel attempt record');
    const last = previous.get(scopeKey(attempt));
    const expected = !last ? 1 : last.status === 'committed' && last.rejectedCandidates === false ? last.epoch : increment(last.epoch);
    if (attempt.epoch !== expected || attemptsByTuple.has(tuple(attempt))) bad('Parallel attempt epoch history is inconsistent');
    attemptIds.add(attempt.id); attemptsByTuple.set(tuple(attempt), attempt); previous.set(scopeKey(attempt), attempt);
  }
  const runIds = new Set<string>(), runAttempts = new Set<string>(), renderIds = new Set<string>(), behaviorIds = new Set<string>(), turns = new Map<string, ParallelRun[]>();
  for (const run of runs) {
    if (!record(run) || !exact(run, ['schema', 'id', 'turnId', 'sceneId', 'grantGeneration', 'attemptEpoch', 'title', 'location', 'time', 'cast', 'worldRevision', 'material', 'render'])
      || run.schema !== 'rp.parallel-run/0.1' || !identity(run.id) || runIds.has(run.id) || !identity(run.turnId) || !identity(run.sceneId)
      || !integer(run.grantGeneration) || !integer(run.attemptEpoch) || !text(run.title) || !text(run.location) || !(run.time === null || typeof run.time === 'string')
      || !integer(run.worldRevision) || run.worldRevision > session.revision || !Array.isArray(run.cast) || !run.cast.length) bad('Invalid committed parallel run');
    const cast = new Set<string>();
    for (const actor of run.cast) {
      if (!record(actor) || !exact(actor, ['roleId', 'name']) || !identity(actor.roleId) || cast.has(actor.roleId) || !text(actor.name)) bad('Invalid committed parallel cast');
      cast.add(actor.roleId);
    }
    const attemptKey = tuple({ sceneId: run.sceneId, grantGeneration: run.grantGeneration, turnId: run.turnId, epoch: run.attemptEpoch }), lease = attemptsByTuple.get(attemptKey);
    if (!lease || lease.status !== 'committed' || runAttempts.has(lease.id)) bad('Committed scene has no unique committed attempt');
    runAttempts.add(lease.id); runIds.add(run.id);
    const sameTurn = turns.get(run.turnId) ?? [];
    if (sameTurn.length >= 2 || sameTurn.some(other => other.sceneId === run.sceneId || other.worldRevision !== run.worldRevision || other.cast.some(actor => cast.has(actor.roleId)))) bad('Parallel scene batch is inconsistent or shares actors');
    sameTurn.push(run); turns.set(run.turnId, sameTurn);
    if (!record(run.material) || !exact(run.material, ['acceptedBehaviors', 'events']) || !Array.isArray(run.material.acceptedBehaviors) || !Array.isArray(run.material.events)) bad('Invalid committed scene material');
    const approved = new Set<string>();
    for (const entry of run.material.acceptedBehaviors) {
      if (!behavior(entry, cast) || approved.has(entry.id) || behaviorIds.has(entry.id)) bad('Invalid or reused committed scene behavior');
      approved.add(entry.id); behaviorIds.add(entry.id);
    }
    const material = byRun.get(run.id) ?? { behaviors: [], facts: [] };
    if (material.behaviors.length !== run.material.acceptedBehaviors.length || !isDeepStrictEqual(material.facts, run.material.events)) bad('Committed scene differs from its retained events');
    material.behaviors.forEach((entry, index) => {
      privateEvent(entry, run, 'parallel-behavior');
      const data = entry.data as Record<string, Json>, approvedBehavior = run.material.acceptedBehaviors[index];
      if (entry.actor !== approvedBehavior.roleId || entry.text !== approvedBehavior.text || !isDeepStrictEqual(data.behavior, approvedBehavior) || !isDeepStrictEqual(data.observerRoleIds, [entry.actor])) bad('Committed behavior observation is inconsistent');
    });
    for (const entry of material.facts) {
      privateEvent(entry, run, 'parallel-world-event');
      const data = entry.data as Record<string, Json>;
      if (entry.actor !== 'parallel-world' || !fact(data.fact, cast, approved) || data.fact.text !== entry.text || !isDeepStrictEqual(data.observerRoleIds, data.fact.observedBy)) bad('Committed fact observation is inconsistent');
    }
    if (!record(run.render) || !exact(run.render, ['status', 'attempts']) || !Array.isArray(run.render.attempts)) bad('Invalid parallel render journal');
    const requests = new Set<string>();
    for (const [index, attempt] of run.render.attempts.entries()) {
      if (!record(attempt) || !exact(attempt, ['id', 'requestId', 'status', 'at'], ['prose', 'error']) || !identity(attempt.id) || renderIds.has(attempt.id)
        || !identity(attempt.requestId) || requests.has(attempt.requestId) || !text(attempt.at) || !['running', 'completed', 'failed'].includes(attempt.status)) bad('Invalid parallel rendering attempt');
      if (attempt.status === 'completed' ? !prose(attempt.prose) || Object.hasOwn(attempt, 'error') : attempt.status === 'failed' ? !text(attempt.error) || Object.hasOwn(attempt, 'prose') : Object.hasOwn(attempt, 'prose') || Object.hasOwn(attempt, 'error')) bad('Invalid parallel rendering outcome');
      if (index < run.render.attempts.length - 1 && attempt.status !== 'failed') bad('Only a failed rendering can have a later attempt');
      requests.add(attempt.requestId); renderIds.add(attempt.id);
    }
    const expectedRender = run.render.attempts.at(-1)?.status ?? 'pending';
    if (run.render.status !== expectedRender) bad('Parallel render status differs from its journal');
  }
  if ([...byRun.keys()].some(id => !runIds.has(id)) || attempts.some(attempt => attempt.status === 'committed' && !runAttempts.has(attempt.id))) bad('Private scene journal has orphan material or a missing committed run');
}

function currentGrant(session: Readonly<StoredSession>, grant: ResolvedParallelScene) {
  json(grant, 'Resolved parallel grant');
  if (!record(grant) || !identity(grant.id) || !Array.isArray(grant.participantRoleIds) || !grant.participantRoleIds.every(identity) || !Array.isArray(grant.participants)) bad('Scene and role identities must support private observation references');
  const current = selectParallelScenes(session).scenes.find(scene => scene.id === grant.id);
  if (!current || current.generation !== grant.generation || current.location !== grant.location || current.locationKey !== grant.locationKey || current.goal !== grant.goal
    || current.title !== grant.title || !isDeepStrictEqual(current.participantRoleIds, grant.participantRoleIds)
    || !isDeepStrictEqual(current.participants.map(actor => [actor.roleId, actor.name]), grant.participants.map(actor => [actor.roleId, actor.name]))) bad('Parallel scene grant is stale, unselected or no longer ready');
}
export function prepareParallelAttempt(store: SessionStore, id: string, turnId: string, grant: ResolvedParallelScene): ParallelAttempt {
  const current = store.get(id); assertParallelJournal(current); currentGrant(current, grant);
  if (!identity(turnId) || current.turns.filter(turn => turn.id === turnId).length !== 1) bad('Parallel attempt requires its current host turn');
  if (current.parallelRuns?.some(run => run.turnId === turnId && run.sceneId === grant.id)) bad('This scene already committed in the host turn');
  const last = current.parallelAttempts?.findLast(attempt => attempt.sceneId === grant.id && attempt.grantGeneration === grant.generation);
  const epoch = !last ? 1 : last.status === 'committed' && last.rejectedCandidates === false ? last.epoch : increment(last.epoch);
  const attempt: ParallelAttempt = { id: randomUUID(), turnId, sceneId: grant.id, grantGeneration: grant.generation, epoch, status: 'prepared' };
  const next = clone(current); (next.parallelAttempts ??= []).push(attempt); assertParallelJournal(next); store.save(next); return clone(attempt);
}
export function abortParallelAttempts(store: SessionStore, id: string, turnId: string): void {
  const current = store.get(id); assertParallelJournal(current);
  if (!identity(turnId)) bad('Provide the aborted host turn identity');
  if (!current.parallelAttempts?.some(attempt => attempt.turnId === turnId && attempt.status === 'prepared')) return;
  const next = clone(current);
  for (const attempt of next.parallelAttempts!) if (attempt.turnId === turnId && attempt.status === 'prepared') attempt.status = 'aborted';
  assertParallelJournal(next); store.save(next);
}
/** Startup reconciliation never retries model work. Material and failed attempt
 * history stay intact; interrupted native contexts lose their prepared lease. */
export function reconcileParallelRestart(session: StoredSession): StoredSession {
  assertParallelJournal(session);
  const next = clone(session);
  for (const attempt of next.parallelAttempts ?? []) if (attempt.status === 'prepared') attempt.status = 'aborted';
  for (const run of next.parallelRuns ?? []) if (run.render.status === 'running') {
    const attempt = run.render.attempts.at(-1)!;
    attempt.status = 'failed'; attempt.error = 'The server stopped during parallel rendering; no model request was replayed.';
    run.render.status = 'failed';
  }
  assertParallelJournal(next); return next;
}
function validateBundle(bundle: ParallelDecisionBundle, grant: ResolvedParallelScene, attempt: ParallelAttempt) {
  json(bundle, 'Parallel decision bundle');
  if (!record(bundle) || !exact(bundle, ['sceneId', 'grantGeneration', 'attemptEpoch', 'scope', 'candidates', 'acceptedBehaviors', 'rawRejectedCount', 'rejectedRoleIds', 'summary', 'facts'])
    || bundle.sceneId !== grant.id || bundle.grantGeneration !== grant.generation || bundle.attemptEpoch !== attempt.epoch
    || !isDeepStrictEqual(bundle.scope, { kind: 'parallel', sceneId: grant.id, grantGeneration: grant.generation, participantRoleIds: grant.participantRoleIds, location: { key: grant.locationKey, value: grant.location } })
    || typeof bundle.summary !== 'string' || !Array.isArray(bundle.candidates) || !Array.isArray(bundle.acceptedBehaviors) || !Array.isArray(bundle.facts) || !Array.isArray(bundle.rejectedRoleIds)) bad('Parallel bundle identity or scope is invalid');
  const cast = new Set(grant.participantRoleIds), candidates = new Map<string, BehaviorCandidate>();
  for (const candidate of bundle.candidates) { if (!behavior(candidate, cast) || candidates.has(candidate.id)) bad('Invalid parallel behavior candidate'); candidates.set(candidate.id, candidate); }
  const approved = new Set<string>();
  for (const entry of bundle.acceptedBehaviors) {
    if (!behavior(entry, cast) || approved.has(entry.id) || !isDeepStrictEqual(entry, candidates.get(entry.id))) bad('Parallel approval does not match its exact current candidate');
    approved.add(entry.id);
  }
  const rejected = bundle.candidates.filter(candidate => !approved.has(candidate.id));
  if (bundle.rawRejectedCount !== rejected.length || !isDeepStrictEqual(bundle.rejectedRoleIds, [...new Set(rejected.map(candidate => candidate.roleId))])) bad('Parallel rejected-candidate summary is invalid');
  for (const value of bundle.facts) if (!fact(value, cast, approved)) bad('Parallel fact source or observer is not in its approved scene');
}
/** The caller atomically saves this detached result with the already incremented
 * main world draft. No persistence or declared-state/rule mutation occurs here. */
export function commitParallelMaterial(session: StoredSession, grant: ResolvedParallelScene, attempt: ParallelAttempt, bundle: ParallelDecisionBundle): { session: StoredSession; run: ParallelRun } {
  assertParallelJournal(session); currentGrant(session, grant); json(attempt, 'Parallel attempt reference');
  if (!record(attempt) || !identity(attempt.id)) bad('Invalid parallel attempt reference');
  const lease = session.parallelAttempts?.find(item => item.id === attempt.id);
  if (!lease || !isDeepStrictEqual(lease, attempt) || lease.status !== 'prepared' || session.parallelAttempts?.findLast(item => scopeKey(item) === scopeKey(lease))?.id !== lease.id) bad('Parallel attempt is not the latest prepared lease');
  if (session.parallelRuns?.some(run => run.turnId === attempt.turnId && run.sceneId === grant.id) || !integer(session.revision)) bad('Parallel scene already committed or has no committed world revision');
  validateBundle(bundle, grant, attempt);
  let next = clone(session);
  const run: ParallelRun = { schema: 'rp.parallel-run/0.1', id: randomUUID(), turnId: attempt.turnId, sceneId: grant.id, grantGeneration: grant.generation, attemptEpoch: attempt.epoch,
    title: grant.title, location: grant.location, time: text(session.world.time) ? session.world.time : null, cast: grant.participants.map(actor => ({ roleId: actor.roleId, name: actor.name })), worldRevision: session.revision,
    material: { acceptedBehaviors: clone(bundle.acceptedBehaviors), events: [] }, render: { status: 'pending', attempts: [] } };
  const observations: { roleId: string; eventId: string }[] = [];
  for (const behavior of bundle.acceptedBehaviors) {
    event(next, { kind: 'parallel-behavior', actor: behavior.roleId, turnId: run.turnId, audience: 'author', text: behavior.text,
      data: { sceneId: run.sceneId, runId: run.id, observerRoleIds: [behavior.roleId], behavior: clone(behavior) as unknown as Json } });
    observations.push({ roleId: behavior.roleId, eventId: next.events.at(-1)!.id });
  }
  for (const fact of bundle.facts) {
    event(next, { kind: 'parallel-world-event', actor: 'parallel-world', turnId: run.turnId, audience: 'author', text: fact.text,
      data: { sceneId: run.sceneId, runId: run.id, observerRoleIds: [...fact.observedBy], fact: clone(fact) as unknown as Json } });
    const retained = next.events.at(-1)!; run.material.events.push(clone(retained));
    for (const roleId of fact.observedBy) observations.push({ roleId, eventId: retained.id });
  }
  next.parallelAttempts!.find(item => item.id === attempt.id)!.status = 'committed';
  next.parallelAttempts!.find(item => item.id === attempt.id)!.rejectedCandidates = bundle.rawRejectedCount > 0;
  (next.parallelRuns ??= []).push(clone(run));
  for (const observation of observations) next = proposeKnowledgeObservation(next, observation.roleId, { sceneId: run.sceneId, eventId: observation.eventId });
  assertParallelJournal(next); return { session: next, run: clone(run) };
}
export function parallelOutputFor(session: Readonly<StoredSession>, materialTurnId: string | null): ParallelScenesOutput {
  assertParallelJournal(session);
  if (materialTurnId !== null && !identity(materialTurnId)) bad('Provide an exact parallel material turn identity');
  const runs = materialTurnId === null ? [] : (session.parallelRuns ?? []).filter(run => run.turnId === materialTurnId);
  const result: ParallelScenesOutput = { schema: 'rp.parallel-scenes/0.1', materialTurnId, worldRevision: runs[0]?.worldRevision ?? session.revision, scenes: runs.map(parallelSceneView) };
  if (!validParallelScenesOutput(result)) bad('Parallel output does not match its public presentation contract');
  return clone(result);
}
export function startParallelRender(store: SessionStore, id: string, runId: string, requestId: string): ParallelRenderAttempt {
  const current = store.get(id); assertParallelJournal(current);
  if (!identity(runId) || !identity(requestId)) bad('Provide exact parallel render run/request identities');
  const run = current.parallelRuns?.find(item => item.id === runId); if (!run) return bad('Parallel render run is unavailable');
  const previous = run.render.attempts.find(attempt => attempt.requestId === requestId); if (previous) return clone(previous);
  if (run.render.status === 'completed' || run.render.status === 'running') bad('Parallel run is already completed or rendering');
  const next = clone(current), target = next.parallelRuns!.find(item => item.id === runId)!;
  const attempt: ParallelRenderAttempt = { id: randomUUID(), requestId, status: 'running', at: now() };
  target.render.status = 'running'; target.render.attempts.push(attempt); assertParallelJournal(next); store.save(next); return clone(attempt);
}
export function finishParallelRender(store: SessionStore, id: string, runId: string, attemptId: string, outcome: { prose: ParallelProse } | { error: string }): ParallelRun {
  const current = store.get(id); assertParallelJournal(current); json(outcome, 'Parallel render outcome');
  const value: unknown = outcome;
  if (!identity(runId) || !identity(attemptId) || !record(value) || !(exact(value, ['prose']) && prose(value.prose) || exact(value, ['error']) && text(value.error))) bad('Invalid parallel render outcome or identity');
  const run = current.parallelRuns?.find(item => item.id === runId), attempt = run?.render.attempts.find(item => item.id === attemptId);
  if (!run || !attempt) return bad('Parallel render attempt is unavailable');
  const result = Object.hasOwn(outcome, 'prose') ? { status: 'completed' as const, prose: clone((outcome as { prose: ParallelProse }).prose) } : { status: 'failed' as const, error: (outcome as { error: string }).error };
  if (attempt.status !== 'running') {
    const previous = attempt.status === 'completed' ? { status: attempt.status, prose: attempt.prose } : { status: attempt.status, error: attempt.error };
    if (isDeepStrictEqual(previous, result)) return clone(run);
    return bad('Finished parallel render cannot be rewritten');
  }
  if (run.render.attempts.at(-1)?.id !== attemptId || run.render.status !== 'running') bad('Parallel rendering attempt is stale');
  const next = clone(current), target = next.parallelRuns!.find(item => item.id === runId)!, targetAttempt = target.render.attempts.find(item => item.id === attemptId)!;
  Object.assign(targetAttempt, result); target.render.status = result.status; assertParallelJournal(next); store.save(next); return clone(target);
}
