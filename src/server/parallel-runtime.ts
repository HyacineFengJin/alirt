import { createHash, randomUUID } from 'node:crypto';
import type { BehaviorCandidate } from '../shared/behavior';
import type { ResolvedParallelScene } from '../shared/parallel-scenes';
import type { ParallelProse, ParallelRun } from '../shared/parallel-output';
import type { Json, Knowledge, StateField, WorldEvent } from '../shared/types';
import { validateStateJson } from '../shared/state-value-schema';
import { createBehaviorCandidates, parseBehaviorApproval } from './behavior-runtime';
import type { AgentRequest, ModelProvider, ModelTool } from './engine';
import type { PromptLayout } from './prompt-compiler';
import { projectKnowledgeEntries } from './knowledge-runtime';
import { compileResultValidator } from './result-schema.mjs';
import type { StoredSession } from './store';
import { validateEventLedger } from './event-ledger';

export type ParallelWorkerKind = 'role' | 'world' | 'prose';
export interface ParallelPrompt { system: string; promptLayout?: PromptLayout }
export type ParallelBind = (kind: ParallelWorkerKind, logicalKey: string, baseSessionId: string, fingerprintInput: unknown) => { sessionId: string } | Promise<{ sessionId: string }>;
export interface ParallelRuntimeStep {
  stage: 'request' | 'result' | 'error'; kind: ParallelWorkerKind; logicalKey: string; roleId?: string;
  request?: AgentRequest; result?: unknown; error?: string;
}
export interface ParallelScope {
  kind: 'parallel'; sceneId: string; grantGeneration: number; participantRoleIds: string[];
  location: { key: string; value: string };
}
export interface ParallelRoleView {
  scope: ParallelScope; time: string | null; goal: string;
  actor: { roleId: string; name: string; state: Record<string, Json>; knowledge: Knowledge[] };
  participants: { roleId: string; name: string }[]; fields: StateField[];
  knowledgeReferences?: { id: string; text: string; status: 'known' | 'uncertain' }[];
}
export interface ParallelFact {
  text: string; sources: ({ kind: 'behavior'; id: string } | { kind: 'world-development' })[];
  observedBy: string[];
}
export interface ParallelDecisionBundle {
  sceneId: string; grantGeneration: number; attemptEpoch: number; scope: ParallelScope;
  candidates: BehaviorCandidate[]; acceptedBehaviors: BehaviorCandidate[]; rawRejectedCount: number; rejectedRoleIds: string[];
  summary: string; facts: ParallelFact[];
}
interface CommonOptions {
  provider: ModelProvider; signal: AbortSignal; bind: ParallelBind;
  onStep?: (step: ParallelRuntimeStep) => void | Promise<void>;
}
export interface ParallelDecisionOptions extends CommonOptions {
  grant: ResolvedParallelScene;
  session: Pick<StoredSession, 'id' | 'revision' | 'playerRoleId' | 'roles' | 'fields' | 'world'>;
  attemptEpoch: number;
  /** Caller has checked the retained run's generation against this grant. */
  continuity?: readonly WorldEvent[];
  /** Root may bind only withdrawal/replacement metadata, while active knowledge
   * remains current delivery data. Omission conservatively binds all entries. */
  roleDisclosureBoundary?: (roleId: string) => unknown;
  buildRolePrompt: (input: { grant: Readonly<ResolvedParallelScene>; roleId: string; view: Readonly<ParallelRoleView> }) => ParallelPrompt | Promise<ParallelPrompt>;
  /** Only the host's private, world-commit-staged memory tool is eligible here. */
  buildRoleTools?: (input: { grant: Readonly<ResolvedParallelScene>; roleId: string; view: Readonly<ParallelRoleView> }) => {
    tools: ModelTool[]; knowledgeReferences: NonNullable<ParallelRoleView['knowledgeReferences']>;
  } | Promise<{ tools: ModelTool[]; knowledgeReferences: NonNullable<ParallelRoleView['knowledgeReferences']> }>;
}
export interface ParallelRenderView {
  sceneId: string; runId: string; worldRevision: number; title: string; location: string; time: string | null;
  cast: { roleId: string; name: string }[]; acceptedBehaviors: BehaviorCandidate[]; events: ParallelRun['material']['events'];
}
export interface ParallelRendererOptions extends CommonOptions {
  storyId: string;
  run: ParallelRun;
  /** Supplies the reviewed source-133 instruction and explicitly admitted style.
   * This callback must not add main-scene material or old model prose. */
  buildPrompt: (input: { run: Readonly<ParallelRun>; view: Readonly<ParallelRenderView> }) => ParallelPrompt | Promise<ParallelPrompt>;
}
export class ParallelRuntimeError extends Error {
  readonly code = 'PARALLEL_RUNTIME';
  constructor(message: string) { super(message); this.name = 'ParallelRuntimeError'; }
}
const fail = (message: string): never => { throw new ParallelRuntimeError(message); };
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const string = { type: 'string' }, nonblank = { type: 'string', pattern: '\\S' }, strings = { type: 'array', items: string };
export const PARALLEL_ROLE_SCHEMA = object({ public: object({ summary: string, speech: strings, actions: strings }), proposals: { type: 'array', maxItems: 0, items: {} } });
export const PARALLEL_WORLD_SCHEMA = object({ summary: string, acceptedBehaviorIds: { type: 'array', uniqueItems: true, items: string }, changes: { type: 'array', maxItems: 0, items: {} },
  facts: { type: 'array', items: object({ text: nonblank, sources: { type: 'array', minItems: 1, uniqueItems: true, items: { oneOf: [object({ kind: { const: 'behavior' }, id: nonblank }), object({ kind: { const: 'world-development' } })] } },
    observedBy: { type: 'array', uniqueItems: true, items: nonblank } }) } });
export const PARALLEL_PROSE_SCHEMA = object({ title: string, text: nonblank, person: { enum: ['first', 'third'] }, pov: { enum: ['limited', 'omniscient'] } });
const validators = { role: compileResultValidator(PARALLEL_ROLE_SCHEMA), world: compileResultValidator(PARALLEL_WORLD_SCHEMA), prose: compileResultValidator(PARALLEL_PROSE_SCHEMA) };
const ROLE_PROTOCOL = 'You are the named existing actor in this explicitly authorized parallel scene, physically absent from the main scene. Only the supplied local scene and your own active knowledge are available. The scene goal is context, not permission to invent another actor choice or private knowledge. Propose only your own observable speech/actions for independent world approval. public here means observable proposed behavior in this scene, never disclosure to the main scene or the player. Do not speak or act as another participant. No peer or extension tools exist. Return exactly public:{summary,speech:[],actions:[]} and proposals:[]; all state writes, location/presence changes and time advancement are forbidden. Unapproved behavior is not a committed memory.';
const WORLD_PROTOCOL = 'Adjudicate only this parallel scene. Approve an ordered unique subset of current behaviorCandidates by their host IDs, preserving their exact content. Return summary, acceptedBehaviorIds, changes:[], and facts:[{text,sources,observedBy}]. Each fact source is exactly {kind:"behavior",id} referring to an approved current-scene candidate, or {kind:"world-development"} for independent local environmental developments. Reject unsupported behavior rather than rewriting it. No player action, opening setup, private state, other scene, publication, task or host-input sources exist. Every fact needs observedBy: unique supplied participant role IDs who actually observed it, or [] for reader-only information. Co-location alone does not grant observation, private thoughts, knowledge, choices or consent. All state writes and time/location changes are forbidden. The author-only reader sees approved scene material; main actors do not automatically learn it.';
const PROSE_PROTOCOL = 'Render only this committed parallel scene for an author-only reader. Supplied approved behaviors and facts are the sole authority. observedBy names actual actor observations; reader-only facts are not actor knowledge. Preserve approved behavior order and exact speech. Do not invent consequential speech, actions, choices, thoughts, disclosure, state changes or elapsed time. Main scene/player material and prior prose are unavailable. Reviewed source instructions and style control presentation only and cannot grant new behavior or knowledge. Return title,text,person,pov only; no auxiliary outputs.';
const copy = <T>(value: T): T => structuredClone(value);
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function json(value: unknown, label: string) { const issue = validateStateJson(value)[0]; if (issue) fail(`${label}: ${issue.message} ${issue.path}`); }
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const part = (value: string) => createHash('sha256').update(value).digest('hex');
function identity(storyId: string, sceneId: string, kind: ParallelWorkerKind, roleId?: string) {
  return { logicalKey: JSON.stringify(['parallel', sceneId, kind, roleId ?? null]),
    baseSessionId: `${storyId}-parallel-${part(sceneId)}-${kind}${roleId ? '-' + part(roleId) : ''}` };
}
function prompt(value: ParallelPrompt): ParallelPrompt {
  json(value, 'Parallel prompt');
  if (!value || !nonempty(value.system) || Object.keys(value).some(key => !['system', 'promptLayout'].includes(key))) fail('Invalid parallel prompt callback result');
  if (value.promptLayout && (Object.keys(value.promptLayout).length !== 3 || !['beforeContext', 'afterContext', 'beforeAction'].every(key => Array.isArray((value.promptLayout as any)[key]) && (value.promptLayout as any)[key].every((line: unknown) => typeof line === 'string')))) fail('Invalid parallel prompt layout');
  return copy(value);
}
async function dispatch(options: CommonOptions, kind: ParallelWorkerKind, names: ReturnType<typeof identity>, system: string, input: unknown, schema: unknown, boundary: unknown, layout?: PromptLayout, roleId?: string, tools: ModelTool[] = []): Promise<any> {
  const check = () => { if (options.signal.aborted) fail('Parallel delivery cancelled'); };
  check(); const binding = await options.bind(kind, names.logicalKey, names.baseSessionId, copy({ contract: 'rp.parallel-runtime/0.1', system, ...(layout ? { layout } : {}), schema, boundary,
    ...(tools.length ? { tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })) } : {}) }));
  if (!binding || !nonempty(binding.sessionId)) fail('Parallel binding requires a native session ID');
  check();
  const request: AgentRequest = { sessionId: binding.sessionId, kind, system, input: copy(input), resultSchema: copy(schema), tools, signal: options.signal, ...(layout ? { promptLayout: copy(layout) } : {}) };
  const observe = (stage: ParallelRuntimeStep['stage'], extra: Partial<ParallelRuntimeStep>) => options.onStep?.({ stage, kind, logicalKey: names.logicalKey, ...(roleId ? { roleId } : {}), ...extra });
  try {
    await observe('request', { request: { ...request, input: copy(request.input), resultSchema: copy(request.resultSchema), tools: tools.map(tool => ({ ...tool, parameters: copy(tool.parameters) })), ...(request.promptLayout ? { promptLayout: copy(request.promptLayout) } : {}) } });
    check(); const result = await options.provider.run(request); check();
    const errors = validators[kind](result); if (errors.length) fail(`Invalid parallel ${kind} result: ${errors.join('; ')}`);
    const detached = copy(result); await observe('result', { result: copy(detached) }); check(); return detached;
  } catch (error) { await observe('error', { error: error instanceof Error ? error.message : 'Parallel delivery failed' }); throw error; }
}

/** No peer delivery, state write or activated knowledge. An explicitly supplied
 * memory tool only stages drafts; the parent owns their atomic world commit. */
export async function runParallelSceneDecisions(options: ParallelDecisionOptions): Promise<ParallelDecisionBundle> {
  const { session, attemptEpoch } = options; json(options.grant, 'Parallel grant'); const grant = copy(options.grant);
  if (!grant.enabled || !nonempty(grant.id) || !nonempty(grant.location) || !nonempty(grant.locationKey) || !nonempty(grant.goal)
    || !Number.isSafeInteger(grant.generation) || grant.generation < 1 || !Number.isSafeInteger(attemptEpoch) || attemptEpoch < 1
    || !Array.isArray(grant.participantRoleIds) || !grant.participantRoleIds.length || new Set(grant.participantRoleIds).size !== grant.participantRoleIds.length) fail('Invalid resolved parallel scene');
  const roles = grant.participantRoleIds.map(roleId => {
    const matches = session.roles.filter(role => role.id === roleId), resolved = grant.participants.filter(role => role.roleId === roleId);
    if (matches.length !== 1 || resolved.length !== 1 || roleId === session.playerRoleId) return fail('Unavailable parallel participant');
    const role = matches[0], participant = resolved[0];
    const fields = session.fields.filter(field => field.key === grant.locationKey && (field.audience === 'public' || Array.isArray(field.audience) && field.audience.includes(roleId)));
    if (role.phase !== 'active' || role.presence !== 'absent' || role.interaction?.mode === 'remote' || !participant.ready || !participant.appearanceEvidence.length
      || participant.location.key !== grant.locationKey || !participant.location.readable || participant.location.value !== grant.location
      || fields.length !== 1 || fields[0].type !== 'string' || role.state[grant.locationKey] !== grant.location) return fail('Parallel participant is not ready at the bound held location');
    return role;
  });
  const scope: ParallelScope = { kind: 'parallel', sceneId: grant.id, grantGeneration: grant.generation, participantRoleIds: [...grant.participantRoleIds], location: { key: grant.locationKey, value: grant.location } };
  const continuity = options.continuity ?? [];
  if (validateEventLedger(continuity).length) fail('Invalid parallel continuity ledger');
  const participants = new Set(grant.participantRoleIds);
  for (const event of continuity) {
    const data = event.data, fact = data && !Array.isArray(data) && typeof data === 'object' ? data.fact as unknown as ParallelFact : undefined;
    if (event.kind !== 'parallel-world-event' || event.actor !== 'parallel-world' || event.audience !== 'author' || !data || Array.isArray(data) || typeof data !== 'object'
      || data.sceneId !== grant.id || !nonempty(data.runId) || Object.keys(data).length !== 4 || Object.keys(data).some(key => !['sceneId', 'runId', 'observerRoleIds', 'fact'].includes(key))
      || validators.world({ summary: '', acceptedBehaviorIds: [], changes: [], facts: [fact] }).length || fact!.text !== event.text
      || !Array.isArray(data.observerRoleIds) || JSON.stringify(data.observerRoleIds) !== JSON.stringify(fact!.observedBy)
      || fact!.observedBy.some(roleId => !participants.has(roleId))) fail('Parallel continuity must contain only canonical facts from this scene');
  }
  const cast = roles.map(role => ({ roleId: role.id, name: role.name })), reports: Parameters<typeof createBehaviorCandidates>[0][number][] = [];
  for (const role of roles) {
    const fields = session.fields.filter(field => field.audience === 'public' || Array.isArray(field.audience) && field.audience.includes(role.id));
    const keys = new Set(fields.map(field => field.key));
    const view: ParallelRoleView = { scope: copy(scope), time: session.world.time || null, goal: grant.goal,
      actor: { roleId: role.id, name: role.name, state: Object.fromEntries(Object.entries(role.state).filter(([key]) => keys.has(key))), knowledge: projectKnowledgeEntries(role.knowledge, role.id) }, participants: copy(cast), fields: copy(fields) };
    json(view, 'Parallel role view'); const selected = prompt(await options.buildRolePrompt({ grant: freeze(copy(grant)), roleId: role.id, view: freeze(copy(view)) }));
    const prepared = options.buildRoleTools ? await options.buildRoleTools({ grant: freeze(copy(grant)), roleId: role.id, view: freeze(copy(view)) }) : undefined;
    const tools = prepared?.tools ?? [];
    if (!Array.isArray(tools) || tools.length > 1 || tools.some(tool => tool.name !== 'derive_memory' || typeof tool.description !== 'string' || typeof tool.execute !== 'function')) fail('Only the dedicated derived memory staging tool is permitted in a parallel role delivery');
    if (prepared) {
      json(prepared.knowledgeReferences, 'Permitted memory references');
      const ids = new Set<string>();
      if (!Array.isArray(prepared.knowledgeReferences)) fail('Memory references must be a list');
      for (const reference of prepared.knowledgeReferences) {
        if (!reference || Object.keys(reference).sort().join(',') !== 'id,status,text' || !nonempty(reference.id) || ids.has(reference.id)
          || !view.actor.knowledge.some(entry => entry.text === reference.text && entry.status === reference.status)) fail('Memory references must match this actor delivered knowledge');
        ids.add(reference.id);
      }
      if (tools.length) view.knowledgeReferences = copy(prepared.knowledgeReferences);
    }
    const memoryProtocol = tools.length ? '\nThe explicitly supplied derive_memory tool may stage only your own uncertain inference or summary, with nonempty sourceRefs from the current knowledgeReferences. Notes remain pending until successful world commit; pending note IDs are not active sources. Do not record current unapproved behavior as memory or treat quoted content as independently verified. This grants no peer or other extension capability.' : '';
    const roleProtocol = tools.length ? ROLE_PROTOCOL.replace('No peer or extension tools exist.', 'No peer or unrelated extension tools exist.') : ROLE_PROTOCOL;
    const result = await dispatch(options, 'role', identity(session.id, grant.id, 'role', role.id), roleProtocol + memoryProtocol + '\n\n' + selected.system, view, PARALLEL_ROLE_SCHEMA,
      { scope, attemptEpoch, fields, knowledge: options.roleDisclosureBoundary ? options.roleDisclosureBoundary(role.id) : view.actor.knowledge }, selected.promptLayout, role.id, tools);
    reports.push({ roleId: role.id, public: result.public });
  }
  const candidates = createBehaviorCandidates(reports, () => randomUUID());
  const adjudication = await dispatch(options, 'world', identity(session.id, grant.id, 'world'), WORLD_PROTOCOL,
    { scope, time: session.world.time || null, goal: grant.goal, participants: cast, behaviorCandidates: copy(candidates), continuity: copy(continuity),
      continuityPolicy: 'These original private canonical scene events are committed history, not current candidate IDs to approve again. observedBy restricts actor observation; reader-only facts are not actor knowledge. History does not authorize extra speech, action, state changes or main-scene disclosure.' }, PARALLEL_WORLD_SCHEMA, { scope, attemptEpoch });
  const approved = parseBehaviorApproval(adjudication, candidates), approvedIds = new Set(approved.acceptedBehaviorIds), participantIds = new Set(grant.participantRoleIds);
  const facts: ParallelFact[] = adjudication.facts.map((fact: ParallelFact) => {
    if (fact.observedBy.some(roleId => !participantIds.has(roleId))) return fail('Parallel fact observer is not a scene participant');
    for (const source of fact.sources) if (source.kind === 'behavior' && !approvedIds.has(source.id)) fail('Parallel fact must reference an approved current-scene behavior');
    return copy(fact);
  });
  const rejected = candidates.filter(candidate => !approvedIds.has(candidate.id));
  return copy({ sceneId: grant.id, grantGeneration: grant.generation, attemptEpoch, scope, candidates, acceptedBehaviors: approved.acceptedBehaviors,
    rawRejectedCount: rejected.length, rejectedRoleIds: [...new Set(rejected.map(candidate => candidate.roleId))], summary: adjudication.summary, facts });
}

/** Called only after the parent's durable world commit. No raw reports, main
 * prose, player action or auxiliary model outputs enter this rendering task. */
export async function renderParallelScene(options: ParallelRendererOptions): Promise<ParallelProse> {
  json(options.run, 'Committed parallel run'); const run = copy(options.run);
  if (run.schema !== 'rp.parallel-run/0.1' || !nonempty(run.id) || !nonempty(run.sceneId) || !nonempty(run.location) || !nonempty(run.turnId)
    || !Number.isSafeInteger(run.worldRevision) || run.worldRevision < 1 || !Number.isSafeInteger(run.attemptEpoch) || run.attemptEpoch < 1
    || !Number.isSafeInteger(run.grantGeneration) || run.grantGeneration < 1 || !run.cast.length || new Set(run.cast.map(role => role.roleId)).size !== run.cast.length) fail('Invalid committed parallel run');
  const actors = new Set(run.cast.map(role => role.roleId));
  const behaviorIds = new Set<string>();
  for (const behavior of run.material.acceptedBehaviors) {
    if (!actors.has(behavior.roleId) || !nonempty(behavior.id) || behaviorIds.has(behavior.id) || !['speech', 'action'].includes(behavior.kind)
      || typeof behavior.text !== 'string' || Object.keys(behavior).some(key => !['id', 'roleId', 'kind', 'text'].includes(key))) fail('Invalid committed parallel behavior');
    behaviorIds.add(behavior.id);
  }
  const eventIds = new Set<string>();
  const events: WorldEvent[] = run.material.events.map(event => {
    const data = event.data;
    if (event.kind !== 'parallel-world-event' || event.actor !== 'parallel-world' || event.audience !== 'author' || event.turnId !== run.turnId
      || !nonempty(event.id) || eventIds.has(event.id) || !data || Array.isArray(data) || typeof data !== 'object' || data.sceneId !== run.sceneId || data.runId !== run.id
      || Object.keys(data).length !== 4 || Object.keys(data).some(key => !['sceneId', 'runId', 'observerRoleIds', 'fact'].includes(key))) return fail('Parallel renderer material crosses its committed scene');
    const fact = data.fact as unknown as ParallelFact;
    if (validators.world({ summary: '', acceptedBehaviorIds: [...behaviorIds], changes: [], facts: [fact] }).length
      || fact.text !== event.text || !Array.isArray(data.observerRoleIds) || JSON.stringify(fact.observedBy) !== JSON.stringify(data.observerRoleIds)
      || fact.observedBy.some(roleId => !actors.has(roleId)) || fact.sources.some(source => source.kind === 'behavior' && !behaviorIds.has(source.id))) return fail('Invalid committed parallel fact or observation scope');
    eventIds.add(event.id);
    // Journal metadata is not rendering material. Keep the committed event's
    // identity and approved fact, without copying unrelated author audit fields.
    return { id: event.id, at: event.at, turnId: event.turnId, kind: event.kind, actor: event.actor, audience: event.audience,
      text: event.text, data: { sceneId: run.sceneId, runId: run.id, observerRoleIds: copy(fact.observedBy), fact: copy(fact) } as unknown as Json };
  });
  const view: ParallelRenderView = { sceneId: run.sceneId, runId: run.id, worldRevision: run.worldRevision, title: run.title, location: run.location, time: run.time,
    cast: copy(run.cast), acceptedBehaviors: copy(run.material.acceptedBehaviors), events };
  const selected = prompt(await options.buildPrompt({ run: freeze(copy(run)), view: freeze(copy(view)) }));
  if (!nonempty(options.storyId)) fail('Parallel renderer requires its parent story identity');
  return dispatch(options, 'prose', identity(options.storyId, run.sceneId, 'prose'), PROSE_PROTOCOL + '\n\n' + selected.system, view, PARALLEL_PROSE_SCHEMA,
    // A completed writer result is presentation, not new canonical material.
    // Never resume it as implicit history for a different committed run.
    { sceneId: run.sceneId, grantGeneration: run.grantGeneration, attemptEpoch: run.attemptEpoch, runId: run.id }, selected.promptLayout);
}
