import { expect, it } from 'vitest';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Json } from '../shared/types';
import type { ResolvedParallelScene } from '../shared/parallel-scenes';
import type { ParallelRun } from '../shared/parallel-output';
import type { AgentRequest, ModelProvider } from './engine';
import { renderParallelScene, runParallelSceneDecisions, type ParallelBind, type ParallelDecisionOptions, type ParallelRuntimeStep } from './parallel-runtime';

function fixture() {
  const card = createNativeTemplate('card') as CharacterCard;
  card.world.location = 'MAIN_LOCATION_CANARY'; card.world.time = 'Known afternoon';
  card.fields = [{ key: 'localPlace', label: 'Known location', type: 'string', audience: 'public', editable: true },
    { key: 'ownSecret', label: 'Own state', type: 'string', audience: ['a'], editable: true },
    { key: 'otherSecret', label: 'Other state', type: 'string', audience: ['b'], editable: true }];
  for (const roleId of ['a', 'b']) card.roles.push({ id: roleId, name: `Actor ${roleId}`, persona: 'Persona admitted only through callback.', goals: [], peers: ['player', 'a', 'b'], phase: 'active', presence: 'absent',
    state: { localPlace: 'Remote archive', ownSecret: roleId === 'a' ? 'OWN_STATE_ALLOWED' : 'OTHER_ROLE_STATE_CANARY', otherSecret: 'OTHER_PRIVATE_STATE_CANARY' },
    knowledge: [{ id: 'own', text: `OWN_KNOWLEDGE_${roleId}`, status: 'known', audience: [roleId] },
      { id: 'author', text: 'AUTHOR_KNOWLEDGE_CANARY', status: 'known', audience: 'author' },
      { id: 'withdrawn', text: 'WITHDRAWN_KNOWLEDGE_CANARY', status: 'known', audience: [roleId], lifecycle: 'withdrawn' }] });
  const grant: ResolvedParallelScene = { id: 'scene', title: 'Parallel archive', enabled: true, participantRoleIds: ['a', 'b'], locationKey: 'localPlace', goal: 'Compare the existing public labels without moving.', generation: 2, location: 'Remote archive',
    participants: ['a', 'b'].map(roleId => ({ roleId, name: `Actor ${roleId}`, phase: 'active', presence: 'absent', interaction: null, appearanceEvidence: [{ kind: 'approved-behavior', roleId, eventId: `seen-${roleId}`, turnId: 'old-turn', behaviorId: `old-${roleId}` }],
      heldStringKeys: ['localPlace'], readableStringFields: [{ key: 'localPlace', label: 'Known location', value: 'Remote archive', known: true }], ready: true, diagnostics: [], location: { key: 'localPlace', value: 'Remote archive', readable: true } })) };
  const session = { id: 'parent-story', revision: 7, playerRoleId: 'player', roles: card.roles, fields: card.fields, world: card.world,
    prose: [{ text: 'MAIN_PROSE_CANARY' }], events: [{ text: 'MAIN_EVENT_CANARY' }], action: 'MAIN_PLAYER_ACTION_CANARY' };
  const calls: AgentRequest[] = [], steps: ParallelRuntimeStep[] = [], bindings: { kind: string; logicalKey: string; base: string; fingerprint: unknown }[] = [];
  let worldHook: (request: AgentRequest) => any = request => {
    const candidates = (request.input as any).behaviorCandidates;
    return { summary: 'AUTHOR_WORLD_AUDIT_CANARY', acceptedBehaviorIds: [candidates[0].id], changes: [], facts: [
      { text: 'The first actor reads the existing label.', sources: [{ kind: 'behavior', id: candidates[0].id }], observedBy: ['a'] },
      { text: 'A reader-only local fact.', sources: [{ kind: 'world-development' }], observedBy: [] },
    ] };
  };
  let roleHook: (request: AgentRequest) => any = request => ({ public: { summary: 'PROVISIONAL_ROLE_SUMMARY_CANARY', speech: [`Scene speech by ${(request.input as any).actor.roleId}`], actions: [] }, proposals: [] });
  let proseHook: () => any = () => ({ title: 'Archive', text: 'The approved label is read.', person: 'third', pov: 'limited' });
  const provider: ModelProvider = { configured: () => true, async run(request) { calls.push(request); return request.kind === 'world' ? worldHook(request) : request.kind === 'role' ? roleHook(request) : proseHook(); } };
  const bind: ParallelBind = (kind, logicalKey, base, fingerprint) => { bindings.push({ kind, logicalKey, base, fingerprint }); return { sessionId: base + '-test-binding' }; };
  const options: ParallelDecisionOptions = { session, grant, attemptEpoch: 3, provider, signal: new AbortController().signal, bind,
    buildRolePrompt: ({ roleId, view }) => {
      expect(Object.isFrozen(view.actor.state)).toBe(true);
      return { system: `REVIEWED_PERSONA_${roleId}`, promptLayout: { beforeContext: [], afterContext: [], beforeAction: [] } };
    }, onStep: step => { steps.push(step); } };
  return { options, session, grant, calls, bindings, steps, setWorld: (hook: typeof worldHook) => { worldHook = hook; }, setRole: (hook: typeof roleHook) => { roleHook = hook; }, setProse: (hook: typeof proseHook) => { proseHook = hook; } };
}
function committedRun(): ParallelRun {
  return { schema: 'rp.parallel-run/0.1', id: 'committed-run', turnId: 'turn', sceneId: 'scene', grantGeneration: 2, attemptEpoch: 3,
    title: 'Local archive', location: 'Remote archive', time: 'Known afternoon', cast: [{ roleId: 'a', name: 'Actor a' }, { roleId: 'b', name: 'Actor b' }], worldRevision: 8,
    material: { acceptedBehaviors: [{ id: 'approved-local', roleId: 'a', kind: 'speech', text: 'Approved speech.' }], events: [{ id: 'local-event', at: '', turnId: 'turn', kind: 'parallel-world-event', actor: 'parallel-world', audience: 'author', text: 'An observed label.',
      data: { sceneId: 'scene', runId: 'committed-run', observerRoleIds: ['a'], fact: { text: 'An observed label.', sources: [{ kind: 'behavior', id: 'approved-local' }], observedBy: ['a'] } } }] },
    render: { status: 'failed', attempts: [{ id: 'old-render', requestId: 'old-render', status: 'failed', at: '', error: 'PRIVATE_RENDER_ERROR_CANARY' }] } };
}

it('dispatches isolated role/world tasks without state, mail or main-scene copies and returns detached observation-aware approval', async () => {
  const f = fixture(), before = JSON.stringify(f.session), bundle = await runParallelSceneDecisions(f.options);
  expect(f.calls.map(call => call.kind)).toEqual(['role', 'role', 'world']);
  expect(f.calls.every(call => call.tools.length === 0)).toBe(true);
  expect(JSON.stringify(f.calls.map(call => ({ input: call.input, system: call.system })))).not.toMatch(/MAIN_LOCATION_CANARY|MAIN_PLAYER_ACTION_CANARY|MAIN_EVENT_CANARY|MAIN_PROSE_CANARY|AUTHOR_KNOWLEDGE_CANARY|WITHDRAWN_KNOWLEDGE_CANARY/);
  expect(JSON.stringify(f.calls[0].input)).toContain('OWN_STATE_ALLOWED');
  expect(JSON.stringify(f.calls[0].input)).not.toContain('OTHER_PRIVATE_STATE_CANARY');
  expect((f.calls[0].input as any).actor.knowledge.map((knowledge: any) => knowledge.text)).toEqual(['OWN_KNOWLEDGE_a']);
  expect((f.calls[2].input as any).participants).toEqual([{ roleId: 'a', name: 'Actor a' }, { roleId: 'b', name: 'Actor b' }]);
  expect(JSON.stringify(f.calls[2].input)).not.toMatch(/PROVISIONAL_ROLE_SUMMARY_CANARY|OWN_STATE_ALLOWED|OWN_KNOWLEDGE_a/);
  expect(bundle).toMatchObject({ sceneId: 'scene', grantGeneration: 2, attemptEpoch: 3, rawRejectedCount: 1, rejectedRoleIds: ['b'] });
  expect(bundle.acceptedBehaviors.map(behavior => behavior.roleId)).toEqual(['a']);
  expect(bundle.facts.map(fact => fact.observedBy)).toEqual([['a'], []]);
  expect(bundle.candidates.every(candidate => !Object.hasOwn(candidate, 'summary'))).toBe(true);
  const rawWorld = f.steps.findLast(step => step.stage === 'result' && step.kind === 'world')!.result as any;
  rawWorld.facts[0].text = 'Mutated diagnostic';
  expect(bundle.facts[0].text).toBe('The first actor reads the existing label.');
  expect(JSON.stringify(f.session)).toBe(before);
  expect(f.steps.map(step => step.stage)).toEqual(['request', 'result', 'request', 'result', 'request', 'result']);
});

it.each(['main-behavior', 'unapproved-behavior', 'player-source', 'private-state-source', 'outside-observer', 'duplicate-observer', 'missing-observer', 'state-write'] as const)('rejects %s rather than broadening a scene capability', async invalid => {
  const f = fixture();
  f.setWorld(request => {
    const candidates = (request.input as any).behaviorCandidates;
    const fact: any = { text: 'Scene fact.', sources: [{ kind: 'behavior', id: candidates[0].id }], observedBy: ['a'] };
    const result: any = { summary: '', acceptedBehaviorIds: [candidates[0].id], changes: [], facts: [fact] };
    if (invalid === 'main-behavior') result.acceptedBehaviorIds = ['main-scene-candidate'];
    if (invalid === 'unapproved-behavior') fact.sources[0].id = candidates[1].id;
    if (invalid === 'player-source') fact.sources = [{ kind: 'player-action' }];
    if (invalid === 'private-state-source') fact.sources = [{ kind: 'state', roleId: 'a', key: 'ownSecret' }];
    if (invalid === 'outside-observer') fact.observedBy = ['player'];
    if (invalid === 'duplicate-observer') fact.observedBy = ['a', 'a'];
    if (invalid === 'missing-observer') delete fact.observedBy;
    if (invalid === 'state-write') result.changes = [{ roleId: 'a', key: 'ownSecret', value: 'Forbidden' }];
    return result;
  });
  const before = JSON.stringify(f.session);
  await expect(runParallelSceneDecisions(f.options)).rejects.toThrow();
  expect(f.calls).toHaveLength(3); expect(JSON.stringify(f.session)).toBe(before);
});

it('rejects role writes and accessor results before creating any world task', async () => {
  for (const accessor of [false, true]) {
    const f = fixture(); let reads = 0;
    f.setRole(() => accessor ? Object.defineProperty({ proposals: [] }, 'public', { enumerable: true, get() { ++reads; return { summary: '', speech: [], actions: [] }; } })
      : { public: { summary: '', speech: [], actions: [] }, proposals: [{ roleId: 'a', key: 'ownSecret', value: 'Forbidden' }] });
    await expect(runParallelSceneDecisions(f.options)).rejects.toThrow('Invalid parallel role result');
    expect(f.calls.map(call => call.kind)).toEqual(['role']); expect(reads).toBe(0);
  }
});

it('separates native identities by scene/actor and binds epoch changes without adding model budgets', async () => {
  const f = fixture(); await runParallelSceneDecisions(f.options);
  const first = structuredClone(f.bindings); f.calls.length = 0; f.bindings.length = 0;
  await runParallelSceneDecisions(f.options);
  expect(f.bindings).toEqual(first);
  f.bindings.length = 0; await runParallelSceneDecisions({ ...f.options, attemptEpoch: 4 });
  expect(f.bindings.map(binding => binding.base)).toEqual(first.map(binding => binding.base));
  expect(f.bindings.map(binding => binding.fingerprint)).not.toEqual(first.map(binding => binding.fingerprint));
  const ids = new Set(first.map(binding => binding.base)); expect(ids.size).toBe(3);
  f.bindings.length = 0; await runParallelSceneDecisions({ ...f.options, grant: { ...f.grant, id: 'scene-role-a' } });
  expect(f.bindings.every(binding => !ids.has(binding.base))).toBe(true);
  expect(f.calls.every(call => !Object.hasOwn(call, 'maxTokens') && !Object.hasOwn(call, 'tokenBudget'))).toBe(true);
});

it('keeps current knowledge out of the cache identity when root supplies its disclosure boundary, while passing committed history only to world', async () => {
  const f = fixture(), history = committedRun().material.events;
  const options = { ...f.options, continuity: history, roleDisclosureBoundary: (roleId: string) => ({ roleId, withdrawn: [] as string[] }) };
  await runParallelSceneDecisions(options); const first = structuredClone(f.bindings);
  f.bindings.length = 0; f.calls.length = 0;
  f.session.roles.find(role => role.id === 'a')!.knowledge.push({ id: 'observed', text: 'NEW_OWN_OBSERVATION', audience: ['a'], status: 'known' });
  await runParallelSceneDecisions(options);
  expect(f.bindings).toEqual(first);
  expect(JSON.stringify(f.calls[0].input)).toContain('NEW_OWN_OBSERVATION');
  expect(f.calls.filter(call => call.kind === 'role').every(call => !Object.hasOwn(call.input as object, 'continuity'))).toBe(true);
  expect((f.calls.at(-1)!.input as any).continuity).toEqual(history);
  f.bindings.length = 0;
  await runParallelSceneDecisions({ ...options, roleDisclosureBoundary: roleId => ({ roleId, withdrawn: ['observed-source'] }) });
  expect(f.bindings[0].fingerprint).not.toEqual(first[0].fingerprint);
  f.calls.length = 0;
  await runParallelSceneDecisions({ ...options, attemptEpoch: 9 });
  expect((f.calls.at(-1)!.input as any).continuity).toEqual(history);
});

it.each(['main', 'other-scene', 'host-output', 'public', 'invalid-fact'] as const)('rejects unsafe world continuity before model dispatch: %s', async invalid => {
  const f = fixture(), continuity = committedRun().material.events;
  if (invalid === 'main') continuity[0].kind = 'world-event';
  if (invalid === 'other-scene') (continuity[0].data as any).sceneId = 'other';
  if (invalid === 'host-output') continuity[0].kind = 'host-output';
  if (invalid === 'public') continuity[0].audience = 'public';
  if (invalid === 'invalid-fact') (continuity[0].data as any).fact.sources = [{ kind: 'host-input', id: 'private' }];
  await expect(runParallelSceneDecisions({ ...f.options, continuity })).rejects.toThrow('Parallel continuity');
  expect(f.calls).toEqual([]);
});

it('renders only approved committed scene material through its reviewed source/style callback and preserves the parent story identity', async () => {
  const f = fixture(), run = committedRun(), before = JSON.stringify(run);
  const prose = await renderParallelScene({ ...f.options, storyId: f.session.id, run, buildPrompt: ({ view }) => {
    expect(Object.isFrozen(view.events)).toBe(true); return { system: 'REVIEWED_SOURCE_133\nREVIEWED_SAFE_STYLE' };
  } });
  expect(prose.text).toBe('The approved label is read.'); expect(f.calls.map(call => call.kind)).toEqual(['prose']);
  const request = f.calls[0]; expect(request.tools).toEqual([]); expect(request.system).toContain('REVIEWED_SOURCE_133');
  expect(JSON.stringify(request.input)).toContain('Approved speech.');
  expect(JSON.stringify(request.input)).not.toMatch(/PRIVATE_RENDER_ERROR_CANARY|MAIN_|PROVISIONAL_ROLE_SUMMARY_CANARY|AUTHOR_WORLD_AUDIT_CANARY/);
  expect((request.resultSchema as any).properties).not.toHaveProperty('outputs');
  expect(request.sessionId.startsWith(f.session.id + '-parallel-')).toBe(true);
  expect(JSON.stringify(run)).toBe(before);
});

it('binds distinct committed runs to different renderer material boundaries while retaining the parent story base identity', async () => {
  const f = fixture(), first = committedRun(), buildPrompt = () => ({ system: 'Reviewed source and safe style.' });
  await renderParallelScene({ ...f.options, storyId: f.session.id, run: first, buildPrompt });
  const binding = structuredClone(f.bindings[0]), next = committedRun(); next.id = 'next-run'; next.turnId = 'next-turn'; next.worldRevision = 9;
  for (const event of next.material.events) { event.turnId = next.turnId; (event.data as any).runId = next.id; }
  await renderParallelScene({ ...f.options, storyId: f.session.id, run: next, buildPrompt });
  expect(f.bindings[1].base).toBe(binding.base);
  expect(f.bindings[1].logicalKey).toBe(binding.logicalKey);
  expect(f.bindings[1].fingerprint).not.toEqual(binding.fingerprint);
  expect((f.calls[1].input as any).runId).toBe('next-run');
});

it.each(['wrong-run', 'wrong-scene', 'public-event', 'observer-mismatch', 'unapproved-source', 'host-payload', 'model-output'] as const)('rejects renderer material/result boundary: %s', async invalid => {
  const f = fixture(), run = committedRun(), data = run.material.events[0].data as Record<string, Json>;
  if (invalid === 'wrong-run') data.runId = 'other-run';
  if (invalid === 'wrong-scene') data.sceneId = 'main';
  if (invalid === 'public-event') run.material.events[0].audience = 'public';
  if (invalid === 'observer-mismatch') data.observerRoleIds = ['b'];
  if (invalid === 'unapproved-source') (data.fact as any).sources[0].id = 'rejected';
  if (invalid === 'host-payload') (data.fact as any).payload = 'HOST_PAYLOAD_CANARY';
  if (invalid === 'model-output') f.setProse(() => ({ title: 'Scene', text: 'Approved text.', person: 'third', pov: 'limited', outputs: { invented: 'No authority' } }));
  await expect(renderParallelScene({ ...f.options, storyId: f.session.id, run, buildPrompt: () => ({ system: 'Reviewed source.' }) })).rejects.toThrow();
  expect(f.calls).toHaveLength(invalid === 'model-output' ? 1 : 0);
});
