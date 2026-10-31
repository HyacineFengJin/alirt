import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Json, Preset, SubmitTurn } from '../shared/types';
import type { ProseReviewResult, ProseReviewTarget } from '../shared/prose-review';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { ApiError, clone, project, SessionStore, type StoredSession } from './store';
import { updateRuntimeConfiguration } from './runtime-config';
import { compileResultValidator } from './result-schema.mjs';
import { applyParallelScenes, parallelScenesService } from './parallel-scenes';
import { SessionServiceRegistry } from './session-services';
import { AgentModuleRegistry } from './agent-modules';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const reviewCall = (request: AgentRequest) => request.kind === 'prose' && !!(request.input as any)?.draft;
const parallelCall = (request: AgentRequest) => (request.input as any)?.scope?.kind === 'parallel';
const parallelWriter = (request: AgentRequest) => request.kind === 'prose' && typeof (request.input as any)?.runId === 'string';
const mainWriter = (request: AgentRequest) => request.kind === 'prose' && !reviewCall(request) && !parallelWriter(request);
const protectedState = ({ revision, world, roles, prose, knowledgeRegistry }: StoredSession) => clone({ revision, world, roles, prose, knowledgeRegistry });
function reviewResult(request: AgentRequest): ProseReviewResult {
  const input = request.input as any, segment = input.draft.segments.find((segment: any) => segment.kind === 'narration' && segment.text.length) ?? input.draft.segments.find((segment: any) => segment.kind !== 'speech' && segment.text.length);
  return { summary: 'REVIEW_REPORT_PRIVATE_CANARY', findings: segment ? [{ segmentId: segment.id, quote: segment.text.slice(0, 8), category: 'other', severity: 'note',
    explanation: 'REVIEW_EXPLANATION_PRIVATE_CANARY', sourceRefs: input.material.references.slice(0, 1).map((reference: any) => reference.ref) }] : [] };
}
class OfflineProvider implements ModelProvider {
  calls: AgentRequest[] = [];
  onReview?: (request: AgentRequest) => void | Promise<void>;
  failure?: 'all-review' | 'parallel-review';
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request); let result: unknown;
    if (reviewCall(request)) {
      await this.onReview?.(request);
      if (this.failure === 'all-review' || this.failure === 'parallel-review' && JSON.stringify(request.input).includes('PRIVATE_PARALLEL_DRAFT')) throw new Error('Recorded independent reviewer failure');
      result = reviewResult(request);
    } else if (request.kind === 'role') result = { public: { summary: '', speech: [parallelCall(request) ? `PRIVATE_APPROVED_WORDS_${(request.input as any).actor.roleId}` : 'Approved local words.'], actions: [] }, proposals: [] };
    else if (request.kind === 'world') {
      const ids = (request.input as any).behaviorCandidates.map((candidate: any) => candidate.id);
      result = { summary: parallelCall(request) ? 'PRIVATE_WORLD_AUDIT' : 'MAIN_WORLD_AUDIT', changes: [], acceptedBehaviorIds: ids,
        facts: [{ text: parallelCall(request) ? 'PRIVATE_PARALLEL_FACT' : 'MAIN_PUBLIC_FACT', sources: [{ kind: 'world-development' }], ...(parallelCall(request) ? { observedBy: [] } : {}) }] };
    } else if (parallelWriter(request)) result = { title: 'Private draft', text: 'PRIVATE_PARALLEL_DRAFT stays in the archive.', person: 'third', pov: 'limited' };
    else if (mainWriter(request)) result = { title: 'Main draft', text: 'MAIN_SAVED_DRAFT: the quiet room remains unchanged.', person: 'third', pov: 'limited' };
    else throw new Error('Creator requests are outside this offline fixture');
    expect(compileResultValidator(request.resultSchema)(result)).toEqual([]); return result;
  }
}
async function fixture(parallel = false) {
  const root = await mkdtemp(join(tmpdir(), 'rp-prose-review-engine-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.opening = 'An author-declared quiet room.'; card.world = { location: 'MAIN_ROOM_CANARY', time: 'Known afternoon', variables: {} };
  card.fields = [{ key: 'secret', label: 'Private fact', type: 'string', audience: ['npc'], editable: true }];
  card.roles.push({ id: 'npc', name: 'Keeper', persona: 'ROLE_PERSONA_PRIVATE_CANARY', goals: [], peers: [], phase: 'active', presence: 'present', state: { secret: 'ROLE_STATE_PRIVATE_CANARY' },
    knowledge: [{ id: 'private-knowledge', text: 'ROLE_KNOWLEDGE_PRIVATE_CANARY', audience: ['npc'], status: 'known' }] });
  card.modules = [{ id: 'private-role-rule', title: 'Role rule', category: 'supplement', content: 'ROLE_SOURCE_PRIVATE_CANARY', enabled: true, targets: ['role'], phase: 'decide', priority: 1, audience: ['npc'] }];
  if (parallel) {
    card.fields.push({ key: 'location', label: 'Own location', type: 'string', audience: ['actor', 'partner'], editable: true });
    card.roles.push(...['actor', 'partner'].map(id => ({ id, name: id, persona: `Private ${id}.`, goals: [], peers: [], phase: 'active' as const, presence: 'present' as const,
      state: { location: 'PRIVATE_ARCHIVE_LOCATION' } as Record<string, Json>, knowledge: [] })));
    card.initialization = { schema: 'rp.initialization/0.1', defaultOpeningId: 'baseline', defaultPlayerProfileId: 'user',
      openings: [{ id: 'baseline', title: 'Declared cast', text: 'The cast has appeared.', cast: card.roles.map(role => ({ roleId: role.id, phase: 'active', presence: 'present' })) }],
      playerProfiles: [{ id: 'user', title: 'User', name: 'User', persona: '' }] };
    preset.modules = [{ id: 'parallel-source', title: 'Parallel source', category: 'supplement', content: 'Host renders only committed private scene material.', enabled: true, targets: ['prose'], phase: 'compose', priority: 1 }];
    preset.outputs = [{ id: 'parallel', title: 'Private parallel output', type: 'object', instruction: 'Host reads committed private scenes.', enabled: true, required: true, priority: 1, audience: 'author', module: 'parallel-source',
      valueFrom: { kind: 'parallel-scenes' }, display: { placement: 'after-prose', renderer: 'parallel-scenes' } }];
  }
  const store = new SessionStore(root), provider = new OfflineProvider(), id = store.create(card, preset).id;
  const engine = new TurnEngine(store, provider, undefined, { sessionServices: new SessionServiceRegistry([parallelScenesService]) }); cleanups.push(() => engine.close());
  if (parallel) {
    for (const roleId of ['actor', 'partner']) store.lifecycle(id, { expectedRevision: store.get(id).revision, roleId, phase: 'active', presence: 'absent', reason: 'The existing actor explicitly leaves the main scene.' });
    applyParallelScenes(store, id, { requestId: 'grant', expectedRevision: store.get(id).revision, reason: 'Explicit private scene grant.', operation: 'upsert',
      scene: { id: 'private-scene', title: 'Archive', enabled: true, participantRoleIds: ['actor', 'partner'], locationKey: 'location', goal: 'Inspect only the archive labels.' } });
    applyParallelScenes(store, id, { requestId: 'select', expectedRevision: store.get(id).revision, reason: 'Explicit selection.', operation: 'select', selectedSceneIds: ['private-scene'] });
  }
  let sequence = 0;
  const run = async (extra: Partial<SubmitTurn> = {}) => {
    const input: SubmitTurn = { requestId: `ordinary-${++sequence}`, expectedRevision: store.get(id).revision, mode: 'action', action: 'MAIN_PLAYER_ACTION_CANARY: inspect the room.', ...extra };
    const accepted = engine.submit(id, input); await engine.idle(id); return { input, accepted };
  };
  const enable = (enabled: boolean) => updateRuntimeConfiguration(store, id, { expectedRevision: store.get(id).revision, reason: 'Explicit review setting.',
    agentRuntime: { profile: 'full', modules: { 'rp.prose-review': enabled } } }, engine.modules);
  const latestTarget = (): ProseReviewTarget => ({ kind: 'main', entryId: store.get(id).prose.at(-1)!.id });
  return { root, store, id, provider, engine, run, enable, latestTarget };
}

describe('optional read-only prose review at real engine delivery boundaries', () => {
  it('defaults off without an extra delivery and rejects disabled manual reviews before queueing', async () => {
    const f = await fixture(); await f.run();
    expect(f.provider.calls.map(call => call.kind)).toEqual(['role', 'world', 'prose']);
    expect(f.provider.calls.some(reviewCall)).toBe(false); expect(f.engine.proseReviews(f.id)).toMatchObject({ installed: true, enabled: false, reviews: [] });
    const before = clone(f.store.get(f.id)), calls = f.provider.calls.length;
    expect(() => f.engine.submit(f.id, { requestId: 'disabled-review', expectedRevision: before.revision, action: 'Check this draft.', mode: 'author', proseReview: f.latestTarget() })).toThrowError(expect.objectContaining({ code: 'PROSE_REVIEW_DISABLED' }));
    expect(f.store.get(f.id)).toEqual(before); expect(f.provider.calls).toHaveLength(calls); expect(f.engine.busy(f.id)).toBe(false);
  });

  it('saves the first draft before one independent tool-free reviewer and keeps its report out of world, knowledge and reading projections', async () => {
    const f = await fixture(); f.enable(true); let saved: ReturnType<typeof protectedState> | undefined;
    f.provider.onReview = request => {
      const session = f.store.get(f.id); saved = protectedState(session);
      expect(session.prose.at(-1)?.text).toContain('MAIN_SAVED_DRAFT'); expect(session.turns.at(-1)?.status).toBe('committed');
      expect(session.proseReviews![0].attempts[0].status).toBe('running'); expect(request.tools).toEqual([]); expect(request.promptLayout).toBeUndefined();
      expect(JSON.stringify(request.input)).not.toMatch(/ROLE_PERSONA_PRIVATE_CANARY|ROLE_SOURCE_PRIVATE_CANARY|ROLE_STATE_PRIVATE_CANARY|ROLE_KNOWLEDGE_PRIVATE_CANARY|MAIN_WORLD_AUDIT/);
      expect(Object.keys(request.input as object).sort()).toEqual(['draft', 'material']);
    };
    await f.run(); const current = f.store.get(f.id), reviews = f.provider.calls.filter(reviewCall), writer = f.provider.calls.find(mainWriter)!;
    expect(reviews).toHaveLength(1); expect(f.provider.calls.indexOf(reviews[0])).toBeGreaterThan(f.provider.calls.indexOf(writer));
    expect(reviews[0].sessionId).not.toBe(writer.sessionId); expect(f.provider.calls.filter(call => call !== reviews[0]).every(call => call.sessionId !== reviews[0].sessionId)).toBe(true);
    expect(protectedState(current)).toEqual(saved); expect(current.turns.at(-1)?.status).toBe('completed');
    expect(f.engine.proseReviews(f.id).reviews[0].attempts[0]).toMatchObject({ status: 'completed', result: { summary: 'REVIEW_REPORT_PRIVATE_CANARY' }, nativeSessionId: reviews[0].sessionId });
    for (const perspective of ['author', 'npc', current.playerRoleId]) {
      const view = project(current, perspective); expect(view as any).not.toHaveProperty('proseReviews');
      expect(JSON.stringify(view)).not.toMatch(/REVIEW_REPORT_PRIVATE_CANARY|REVIEW_EXPLANATION_PRIVATE_CANARY/);
    }
    const count = f.provider.calls.length; await f.run(); const secondReview = f.provider.calls.slice(count).find(reviewCall)!;
    expect(secondReview.sessionId).not.toBe(reviews[0].sessionId); expect(JSON.stringify(secondReview.input)).not.toContain('REVIEW_REPORT_PRIVATE_CANARY');
  });

  it('retains a reviewer failure without failing, rewriting or regenerating the saved first draft', async () => {
    const f = await fixture(); f.enable(true); f.provider.failure = 'all-review'; let saved: ReturnType<typeof protectedState> | undefined;
    f.provider.onReview = () => { saved = protectedState(f.store.get(f.id)); };
    await f.run(); const current = f.store.get(f.id);
    expect(current.turns.at(-1)?.status).toBe('completed'); expect(protectedState(current)).toEqual(saved);
    expect(f.provider.calls.filter(mainWriter)).toHaveLength(1); expect(f.provider.calls.filter(reviewCall)).toHaveLength(1);
    expect(current.proseReviews![0].attempts[0]).toMatchObject({ status: 'failed', error: 'Recorded independent reviewer failure' });
    expect(current.events.some(event => event.kind === 'turn-failed')).toBe(false);
  });

  it('reviews a historical target alone, deduplicates exact requests and rejects changed focus or target under one request ID', async () => {
    const f = await fixture(); await f.run(); const firstTarget = f.latestTarget(); await f.run(); const secondTarget = f.latestTarget(); f.enable(true);
    const before = protectedState(f.store.get(f.id)), calls = f.provider.calls.length;
    const input: SubmitTurn = { requestId: 'historical-review', expectedRevision: f.store.get(f.id).revision, action: 'Check time references.', mode: 'author', proseReview: firstTarget };
    const accepted = f.engine.submit(f.id, input); await f.engine.idle(f.id);
    const deliveries = f.provider.calls.slice(calls); expect(deliveries).toHaveLength(1); expect(reviewCall(deliveries[0])).toBe(true);
    expect((deliveries[0].input as any).authorFocus).toBe('Check time references.'); expect(protectedState(f.store.get(f.id))).toEqual(before);
    expect(f.store.get(f.id).turns.at(-1)).toMatchObject({ id: accepted.turnId, status: 'completed', proseReview: { target: firstTarget } });
    expect(project(f.store.get(f.id), 'npc').turns.at(-1)).not.toHaveProperty('proseReview');
    expect(f.engine.submit(f.id, clone(input))).toMatchObject({ duplicate: true, turnId: accepted.turnId }); await f.engine.idle(f.id); expect(f.provider.calls).toHaveLength(calls + 1);
    expect(() => f.engine.submit(f.id, { ...input, action: 'Changed focus.' })).toThrowError(expect.objectContaining({ code: 'PROSE_REVIEW_REQUEST_CONFLICT' }));
    expect(() => f.engine.submit(f.id, { ...input, proseReview: secondTarget })).toThrowError(expect.objectContaining({ code: 'PROSE_REVIEW_REQUEST_CONFLICT' }));
    const prior = f.provider.calls.at(-1)!, next = { ...input, requestId: 'new-explicit-review', action: 'Check attribution.' };
    f.engine.submit(f.id, next); await f.engine.idle(f.id);
    expect(f.provider.calls).toHaveLength(calls + 2); expect(f.provider.calls.at(-1)!.sessionId).not.toBe(prior.sessionId);
    expect(f.store.get(f.id).proseReviews).toHaveLength(1); expect(f.store.get(f.id).proseReviews![0].attempts).toHaveLength(2);
    expect(protectedState(f.store.get(f.id))).toEqual(before);
    f.enable(false); const count = f.provider.calls.length; expect(f.engine.proseReviews(f.id)).toMatchObject({ enabled: false, reviews: [expect.anything()] });
    const uninstalled = new TurnEngine(f.store, f.provider, undefined, { modules: new AgentModuleRegistry() }); cleanups.push(() => uninstalled.close());
    expect(uninstalled.proseReviews(f.id)).toMatchObject({ installed: false, enabled: false, reviews: [expect.anything()] }); expect(f.provider.calls).toHaveLength(count);
  });

  it('keeps a completed private rendering intact after review failure and reviews only that run without main-scene evidence', async () => {
    const f = await fixture(true); f.enable(true); f.provider.failure = 'parallel-review'; let privateDraft: unknown;
    f.provider.onReview = request => {
      if (!JSON.stringify(request.input).includes('PRIVATE_PARALLEL_DRAFT')) return;
      const run = f.store.get(f.id).parallelRuns![0]; expect(run.render.status).toBe('completed'); privateDraft = clone(run.render.attempts[0].prose);
      expect(request.tools).toEqual([]); expect(JSON.stringify(request.input)).toContain('PRIVATE_ARCHIVE_LOCATION');
      expect(JSON.stringify(request.input)).toContain('PRIVATE_PARALLEL_FACT'); expect(JSON.stringify(request.input)).not.toMatch(/MAIN_ROOM_CANARY|MAIN_PLAYER_ACTION_CANARY|MAIN_PUBLIC_FACT|MAIN_SAVED_DRAFT|ROLE_KNOWLEDGE_PRIVATE_CANARY/);
    };
    await f.run(); const current = f.store.get(f.id), run = current.parallelRuns![0];
    expect(current.turns.at(-1)?.status).toBe('completed'); expect(run.render).toMatchObject({ status: 'completed', attempts: [{ status: 'completed', prose: privateDraft }] });
    expect(run.render.attempts).toHaveLength(1); expect(f.provider.calls.filter(parallelWriter)).toHaveLength(1); expect(f.provider.calls.filter(mainWriter)).toHaveLength(1);
    const privateReview = current.proseReviews!.find(review => review.target.kind === 'parallel')!;
    expect(privateReview.target).toEqual({ kind: 'parallel', runId: run.id, renderAttemptId: run.render.attempts[0].id });
    expect(privateReview.attempts[0]).toMatchObject({ status: 'failed', error: 'Recorded independent reviewer failure' });
    expect(current.proseReviews!.find(review => review.target.kind === 'main')!.attempts[0].status).toBe('completed');
    expect(current.prose.at(-1)?.text).not.toContain('PRIVATE_PARALLEL_DRAFT');
    expect(JSON.stringify(project(current, 'npc'))).not.toMatch(/PRIVATE_PARALLEL_DRAFT|PRIVATE_PARALLEL_FACT|REVIEW_REPORT_PRIVATE_CANARY/);
    expect(current.events.some(event => event.kind === 'turn-failed')).toBe(false);
  });
});
