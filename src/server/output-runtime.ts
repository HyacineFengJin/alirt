import type { AuxiliaryOutput, CharacterCard, Json, OutputContract, OutputValueSource, Preset, WorldEvent } from '../shared/types';
import { publicWorldFact } from './world-facts-runtime';
import type { PublicWorldFact, ResolvedWorldPublication } from '../shared/world-facts';
import type { PromptPlan, RuntimeDiagnostic } from '../shared/prompt-runtime';
import { evaluateNativeCondition } from '../shared/native';
import { runtimeFingerprint } from './prompt-compiler';
import { clone, fail } from './store';
import type { BehaviorCandidate } from '../shared/behavior';
import { formatStoryProgress, validateStoryProgress, type StoryProgressState } from '../shared/story-progress';
import { validParallelScenesOutput, type ParallelScenesOutput } from '../shared/parallel-output';
import type { TextCarrierState, ViewedCarriersOutput } from '../shared/text-carriers';
import { readTextCarrierState } from './text-carriers';

export interface PlannedOutput extends OutputContract { key: string; source: 'card' | 'preset'; documentId: string; }
export interface OutputPlan {
  contracts: PlannedOutput[];
  /** Already resolved from public committed material, outside model schemas and context fingerprints. */
  hostOutputs?: AuxiliaryOutput[];
  decisions: { key: string; status: 'included' | 'excluded' | 'error'; reason: string }[];
  diagnostics: RuntimeDiagnostic[];
  valid: boolean;
}
/** Host-derived approval from the committed material turn, never model-returned output. */
export interface CommittedOutputMaterial {
  materialTurnId: string | null;
  acceptedBehaviors: readonly BehaviorCandidate[];
  storyProgress?: StoryProgressState;
  parallelScenes?: ParallelScenesOutput;
}
interface OutputSession {
  card: CharacterCard; preset: Preset; roles: { id: string; name?: string }[];
  revision?: number; events?: WorldEvent[]; textCarriers?: TextCarrierState;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function stateOutputValue(selector: OutputValueSource, snapshot: unknown): { value: Json; known: boolean; revision: number } | string {
  if (!record(snapshot) || !Number.isSafeInteger(snapshot.revision) || !record(snapshot.world)) return 'A committed permitted snapshot is required.';
  let value: unknown;
  if (selector.kind === 'world-time' || selector.kind === 'world-location') {
    value = snapshot.world[selector.kind === 'world-time' ? 'time' : 'location'];
    if (typeof value !== 'string') return 'The selected world label is unavailable.';
  } else if (selector.kind === 'state') {
    if (!Array.isArray(snapshot.fields)) return 'Declared public fields are unavailable.';
    const field = snapshot.fields.find(field => record(field) && field.key === selector.key && field.audience === 'public');
    if (!field) return 'The selected state field is not declared public.';
    const owner = selector.roleId === 'world' ? snapshot.world.variables
      : Array.isArray(snapshot.roles) ? snapshot.roles.find(role => record(role) && role.id === selector.roleId)?.state : undefined;
    if (!record(owner) || !Object.hasOwn(owner, selector.key)) return 'The selected state owner or value is unavailable.';
    value = owner[selector.key];
  } else return 'Unsupported state output selector.';
  if (!jsonValue(value)) return 'The selected state value is not valid JSON.';
  return { value: clone(value), known: value !== null && !(typeof value === 'string' && !value.trim()), revision: snapshot.revision as number };
}

function approvedMessagesAttachment(contract: PlannedOutput, snapshot: unknown, material: CommittedOutputMaterial | undefined): AuxiliaryOutput | string {
  if (contract.type !== 'object' || contract.display.renderer !== 'messages' || !record(contract.valueFrom)
    || Object.keys(contract.valueFrom).some(key => key !== 'kind')) return 'Approved messages require the host object contract, selector and messages renderer.';
  if (!record(snapshot) || !Number.isSafeInteger(snapshot.revision) || (snapshot.revision as number) < 0
    || !Array.isArray(snapshot.roles) || !Array.isArray(snapshot.events) || typeof snapshot.playerRoleId !== 'string') return 'A committed permitted snapshot is required for messages.';
  if (!material || !jsonValue(material) || !Array.isArray(material.acceptedBehaviors)
    || !(material.materialTurnId === null || typeof material.materialTurnId === 'string' && !!material.materialTurnId.trim())) return 'Committed message material is unavailable.';
  if (material.materialTurnId === null && material.acceptedBehaviors.length) return 'A material turn is required for approved behavior.';
  const publicRoles = new Map<string, string>();
  for (const role of snapshot.roles) {
    if (!record(role) || typeof role.id !== 'string' || !role.id.trim() || typeof role.name !== 'string' || !role.name.trim() || publicRoles.has(role.id)) return 'Permitted message sender identities are invalid.';
    publicRoles.set(role.id, role.name);
  }
  const records = material.materialTurnId === null ? [] : snapshot.events.filter(event => record(event)
    && event.turnId === material.materialTurnId && event.kind === 'role-behavior' && event.audience === 'public');
  if (records.length !== material.acceptedBehaviors.length) return 'Approved behavior does not match the committed public material turn.';
  const ids = new Set<string>();
  const messages: { behaviorId: string; roleId: string; name: string; text: string; channel: 'message' }[] = [];
  for (const [index, behavior] of material.acceptedBehaviors.entries()) {
    if (!record(behavior) || Object.keys(behavior).some(key => !['id', 'roleId', 'kind', 'text', 'interaction'].includes(key))
      || typeof behavior.id !== 'string' || !behavior.id.trim() || ids.has(behavior.id)
      || typeof behavior.roleId !== 'string' || !publicRoles.has(behavior.roleId) || behavior.roleId === snapshot.playerRoleId
      || !['speech', 'action'].includes(behavior.kind as string) || typeof behavior.text !== 'string') return 'Approved message behavior has an invalid identity or value.';
    ids.add(behavior.id);
    if (behavior.interaction !== undefined && (!record(behavior.interaction) || Object.keys(behavior.interaction).some(key => !['mode', 'channel'].includes(key))
      || behavior.interaction.mode !== 'remote' || !['message', 'screen', 'audio'].includes(behavior.interaction.channel as string) || behavior.kind !== 'speech')) return 'Approved remote behavior has an invalid channel or kind.';
    const event = records[index];
    if (!record(event) || !jsonValue(event) || event.actor !== behavior.roleId || event.text !== behavior.text || !record(event.data)
      || runtimeFingerprint(event.data) !== runtimeFingerprint(behavior)) return 'Approved behavior does not match its committed public record.';
    if (behavior.kind === 'speech' && behavior.interaction?.mode === 'remote' && behavior.interaction.channel === 'message')
      messages.push({ behaviorId: behavior.id, roleId: behavior.roleId, name: publicRoles.get(behavior.roleId)!, text: behavior.text, channel: 'message' });
  }
  const value = { schema: 'rp.approved-messages/0.1', materialTurnId: material.materialTurnId, worldRevision: snapshot.revision as number, messages };
  return { key: contract.key, title: contract.title, type: 'object', value, audience: clone(contract.audience), placement: contract.display.placement,
    display: clone(contract.display), provenance: { kind: 'committed-behaviors', materialTurnId: material.materialTurnId, behaviorIds: messages.map(message => message.behaviorId), worldRevision: snapshot.revision as number } };
}

/** Producer admission is fixed from the current public pre-adjudication view.
 * Module association is deliberately unsupported and rejected by native intake.
 */
export function worldPublicationsEnabled(session: { card: CharacterCard; preset: Preset }, snapshot: unknown): boolean {
  return [session.card, session.preset].some(document => (document.outputs ?? []).some(contract => contract.enabled
    && contract.valueFrom?.kind === 'world-publications' && contract.type === 'object' && contract.audience === 'public' && !Object.hasOwn(contract, 'module')
    && (!contract.condition || evaluateNativeCondition(contract.condition, { snapshot }).status === 'true')));
}

/** Producer admission is fixed before world adjudication. The later prose plan
 * still independently checks its own module and public condition. */
export function storyProgressEnabled(session: { card: CharacterCard; preset: Preset }, prompt: PromptPlan, snapshot: unknown): boolean {
  const admitted = new Set(prompt.modules.map(module => module.ref.key));
  return (['card', 'preset'] as const).some(source => (session[source].outputs ?? []).some(contract => {
    if (!contract.enabled || contract.type !== 'text' || contract.audience !== 'public' || contract.valueFrom?.kind !== 'story-progress') return false;
    if (contract.module) {
      const ref = /^(card|preset):/.test(contract.module) ? contract.module : `${source}:${contract.module}`;
      if (!admitted.has(ref)) return false;
    }
    return !contract.condition || evaluateNativeCondition(contract.condition, { snapshot }).status === 'true';
  }));
}

export function parallelScenesEnabled(session: { card: CharacterCard; preset: Preset }, prompt: PromptPlan, snapshot: unknown): boolean {
  const admitted = new Set(prompt.modules.map(module => module.ref.key));
  return (['card', 'preset'] as const).some(source => (session[source].outputs ?? []).some(contract => {
    if (!contract.enabled || contract.type !== 'object' || contract.audience !== 'author' || contract.valueFrom?.kind !== 'parallel-scenes') return false;
    if (contract.module && !admitted.has(/^(card|preset):/.test(contract.module) ? contract.module : `${source}:${contract.module}`)) return false;
    return !contract.condition || evaluateNativeCondition(contract.condition, { snapshot }).status === 'true';
  }));
}

function parallelScenesAttachment(contract: PlannedOutput, snapshot: unknown, material?: CommittedOutputMaterial): AuxiliaryOutput | string {
  if (contract.type !== 'object' || contract.audience !== 'author' || !record(snapshot) || !Number.isSafeInteger(snapshot.revision)) return 'Parallel scenes require an author-only host object contract.';
  const value = material?.parallelScenes ?? { schema: 'rp.parallel-scenes/0.1', materialTurnId: material?.materialTurnId ?? null, worldRevision: snapshot.revision, scenes: [] };
  if (!validParallelScenesOutput(value) || value.worldRevision > (snapshot.revision as number)) return 'The committed scene presentation is invalid.';
  return { key: contract.key, title: contract.title, type: 'object', audience: 'author', placement: contract.display.placement,
    display: clone(contract.display), value: clone(value) as unknown as Json,
    provenance: { kind: 'committed-parallel', materialTurnId: value.materialTurnId, sceneIds: value.scenes.map(scene => scene.sceneId), worldRevision: value.worldRevision } };
}

/** Only committed immutable view receipts enter this host artifact. Reading a
 * later live carrier version must never rewrite an earlier batch's output. */
function viewedCarriersAttachment(contract: PlannedOutput, session: OutputSession, snapshot: unknown, material?: CommittedOutputMaterial): AuxiliaryOutput | string {
  if (contract.type !== 'object' || contract.audience !== 'public' || contract.display.renderer !== 'viewed-carriers'
    || !record(contract.valueFrom) || Object.keys(contract.valueFrom).length !== 1) return 'Viewed carriers require a public host object contract and the viewed-carriers renderer.';
  if (!record(snapshot) || !Number.isSafeInteger(snapshot.revision) || (snapshot.revision as number) < 0
    || !material || !(material.materialTurnId === null || typeof material.materialTurnId === 'string' && !!material.materialTurnId.trim())) return 'Committed carrier-view material is unavailable.';
  let views: TextCarrierState['views'] = [];
  try {
    // Old minimal prompt fixtures and stories without this capability have no
    // carrier ledger. A retained ledger requires its real private audit corpus.
    if (Object.hasOwn(session, 'textCarriers') || session.events?.some(event => event.kind === 'text-carrier-view-observation' || event.kind === 'text-carrier-control')) {
      if (!Number.isSafeInteger(session.revision) || !Array.isArray(session.events) || session.roles.some(role => typeof role.name !== 'string')) return 'The canonical carrier-view audit is unavailable.';
      views = readTextCarrierState({ revision: session.revision!, roles: session.roles as { id: string; name: string }[], events: session.events, textCarriers: session.textCarriers }).views;
    }
  } catch { return 'The canonical carrier-view ledger or immutable receipts are invalid.'; }
  const selected = material.materialTurnId === null ? [] : views.filter(view => view.materialTurnId === material.materialTurnId);
  const originalRevision = selected[0]?.worldRevision ?? snapshot.revision as number;
  if (selected.some(view => view.worldRevision !== originalRevision) || originalRevision > (snapshot.revision as number)) return 'A carrier-view batch must keep its original committed world revision.';
  const value: ViewedCarriersOutput = { schema: 'rp.viewed-carriers/0.1', materialTurnId: material.materialTurnId, worldRevision: originalRevision, views: clone(selected) };
  return { key: contract.key, title: contract.title, type: 'object', audience: 'public', placement: contract.display.placement,
    display: clone(contract.display), value: value as unknown as Json,
    provenance: { kind: 'committed-carrier-views', materialTurnId: material.materialTurnId, viewIds: selected.map(view => view.id), worldRevision: originalRevision } };
}

function storyProgressAttachment(contract: PlannedOutput, snapshot: unknown, material?: CommittedOutputMaterial): AuxiliaryOutput | string {
  if (contract.type !== 'text' || contract.audience !== 'public') return 'Story progress requires a public text contract.';
  const progress = material?.storyProgress;
  if (progress !== undefined && (validateStoryProgress(progress).length || !record(snapshot) || progress.worldRevision > (snapshot.revision as number)))
    return 'The committed story progress registry is invalid.';
  return { key: contract.key, title: contract.title, type: 'text', audience: 'public', placement: contract.display.placement,
    display: clone(contract.display), value: progress ? formatStoryProgress(progress)
      : '任务进度\n主线：未记录\n支线：未记录\n尚无已裁定的进展记录；不补造任务、修订、日期或时长。',
    ...(progress ? { provenance: { kind: 'committed-progress' as const, sequence: progress.sequence, worldRevision: progress.worldRevision } } : {}) };
}
function worldPublicationsAttachment(contract: PlannedOutput, snapshot: unknown, material: CommittedOutputMaterial | undefined): AuxiliaryOutput | string {
  if (contract.type !== 'object' || contract.audience !== 'public' || Object.hasOwn(contract, 'module') || !record(contract.valueFrom)
    || Object.keys(contract.valueFrom).length !== 1) return 'World publications require a public host object contract without module association.';
  if (!record(snapshot) || !Number.isSafeInteger(snapshot.revision) || !Array.isArray(snapshot.events)) return 'A committed permitted snapshot is required for publications.';
  if (!material || !(material.materialTurnId === null || typeof material.materialTurnId === 'string' && !!material.materialTurnId.trim())) return 'Committed publication material is unavailable.';
  const publications: { factId: string; text: string; publication: ResolvedWorldPublication }[] = [], ids = new Set<string>();
  for (const event of snapshot.events) {
    if (!record(event) || event.kind !== 'world-event' || event.audience !== 'public' || event.turnId !== material.materialTurnId
      || !record(event.data) || !record(event.data.fact) || !Object.hasOwn(event.data.fact, 'publication')) continue;
    if (event.actor !== 'world' || typeof event.id !== 'string' || !event.id || ids.has(event.id)) return 'Publication requires a unique committed world fact event.';
    let fact: PublicWorldFact;
    try { fact = publicWorldFact(event.data.fact as unknown as PublicWorldFact); }
    catch { return 'Committed world publication metadata is invalid.'; }
    if (event.text !== fact.text || !fact.publication) return 'Publication differs from the committed world fact.';
    ids.add(event.id); publications.push({ factId: event.id, text: fact.text, publication: fact.publication });
  }
  const value = JSON.parse(JSON.stringify({ schema: 'rp.world-publications/0.1', materialTurnId: material.materialTurnId,
    worldRevision: snapshot.revision, publications })) as Json;
  return { key: contract.key, title: contract.title, type: 'object', value, audience: 'public', placement: contract.display.placement,
    display: clone(contract.display), provenance: { kind: 'committed-facts', materialTurnId: material.materialTurnId,
      factIds: publications.map(publication => publication.factId), worldRevision: snapshot.revision as number } };
}

function hostAttachment(contract: PlannedOutput, session: OutputSession, snapshot: unknown, material?: CommittedOutputMaterial): AuxiliaryOutput | string {
  const selector = contract.valueFrom!;
  if (selector.kind === 'approved-messages') return approvedMessagesAttachment(contract, snapshot, material);
  if (selector.kind === 'world-publications') return worldPublicationsAttachment(contract, snapshot, material);
  if (selector.kind === 'story-progress') return storyProgressAttachment(contract, snapshot, material);
  if (selector.kind === 'parallel-scenes') return parallelScenesAttachment(contract, snapshot, material);
  if (selector.kind === 'viewed-carriers') return viewedCarriersAttachment(contract, session, snapshot, material);
  const resolved = stateOutputValue(selector, snapshot);
  if (typeof resolved === 'string') return resolved;
  const value: Json = contract.type === 'text'
    ? !resolved.known ? '未设定' : typeof resolved.value === 'string' ? resolved.value : JSON.stringify(resolved.value)
    : resolved.value;
  if (contract.type === 'list' ? !Array.isArray(value) || value.some(item => typeof item !== 'string')
    : contract.type === 'object' ? !record(value) : typeof value !== 'string') return 'The selected state value does not match the output type; unknown lists/objects are not fabricated.';
  return { key: contract.key, title: contract.title, type: contract.type, value, audience: clone(contract.audience), placement: contract.display.placement,
    display: clone(contract.display), provenance: { kind: 'state', selector: clone(selector), known: resolved.known, worldRevision: resolved.revision } };
}

/** Explicit assembly pruning retains definitions and past attachments. Host
 * validation still rejects any newly returned, undeclared output. */
export function disabledOutputPlan(session: { card: CharacterCard; preset: Preset }): OutputPlan {
  return { contracts: [], diagnostics: [], valid: true, decisions: (['card', 'preset'] as const).flatMap(source =>
    (session[source].outputs ?? []).map(contract => ({ key: `${source}:${contract.id}`, status: 'excluded' as const, reason: 'agent-module-disabled' }))) };
}

/** Distribution permissions never widen the prose agent's input disclosure. */
export function compileOutputPlan(session: OutputSession, prompt: PromptPlan, snapshot: unknown, material?: CommittedOutputMaterial): OutputPlan {
  const plan: OutputPlan = { contracts: [], hostOutputs: [], decisions: [], diagnostics: [], valid: true };
  const admitted = new Set(prompt.modules.map(module => module.ref.key));
  const allModules = new Set([...session.card.modules.map(module => `card:${module.id}`), ...session.preset.modules.map(module => `preset:${module.id}`)]);
  for (const source of ['card', 'preset'] as const) {
    const document = session[source];
    for (const contract of document.outputs ?? []) {
      const key = `${source}:${contract.id}`;
      const exclude = (reason: string) => plan.decisions.push({ key, status: 'excluded', reason });
      const problem = (code: string, message: string) => {
        const severity = contract.required ? 'error' : 'warning';
        plan.diagnostics.push({ code, severity, message, path: `${source}.outputs.${contract.id}` });
        plan.decisions.push({ key, status: contract.required ? 'error' : 'excluded', reason: code });
      };
      if (!contract.enabled) { exclude('disabled'); continue; }
      if (Array.isArray(contract.audience) && contract.audience.some(id => !session.roles.some(role => role.id === id))) {
        problem('output-audience', `Output ${key} refers to an unknown role.`); continue;
      }
      if (contract.module) {
        const ref = /^(card|preset):/.test(contract.module) ? contract.module : `${source}:${contract.module}`;
        if (!allModules.has(ref)) { problem('output-module-missing', `Output ${key} refers to missing module ${ref}.`); continue; }
        if (!admitted.has(ref)) { exclude('module-inactive'); continue; }
      }
      if (contract.condition) {
        const condition = evaluateNativeCondition(contract.condition, { snapshot });
        if (condition.status === 'unknown') { problem('output-condition-unknown', `Output ${key}: ${condition.reasons.join('; ')}`); continue; }
        if (condition.status === 'false') { exclude('condition-false'); continue; }
      }
      const planned = { ...clone(contract), key, source, documentId: document.id };
      if (contract.valueFrom) {
        const attachment = hostAttachment(planned, session, snapshot, material);
        if (typeof attachment === 'string') { problem(contract.valueFrom.kind === 'approved-messages' ? 'output-material-unavailable' : 'output-state-unavailable', `Output ${key}: ${attachment}`); continue; }
        plan.hostOutputs!.push(attachment);
      }
      plan.contracts.push(planned);
      plan.decisions.push({ key, status: 'included', reason: 'eligible' });
    }
  }
  plan.contracts.sort((a, b) => a.priority - b.priority);
  plan.valid = !plan.diagnostics.some(diagnostic => diagnostic.severity === 'error');
  return plan;
}

export function outputInstructions(plan: OutputPlan): string {
  const model = plan.contracts.filter(contract => !contract.valueFrom);
  if (!model.length) return '';
  return '\n\nAuxiliary output contracts: return only these separately in submit_result.outputs, keyed exactly as specified. Other host-derived outputs are filled by the host and must not be returned or inferred. These are visible artifacts, not private chain-of-thought. They cannot mutate state, declare new canonical facts or perform suggested actions. Omit unavailable optional outputs; never fabricate facts to fill a required field. Audience and placement are host-controlled distribution metadata, not permission to access more world knowledge.\n'
    + JSON.stringify(model.map(({ key, title, type, instruction, required }) => ({ key, title, type, instruction, required })));
}

export function outputResultSchema(base: { properties: Record<string, unknown>; required: string[]; [key: string]: unknown }, plan: OutputPlan) {
  const model = plan.contracts.filter(contract => !contract.valueFrom);
  if (!model.length) return base;
  const properties = Object.fromEntries(model.map(contract => [contract.key,
    contract.type === 'text' ? { type: 'string', ...(contract.required ? { minLength: 1 } : {}) }
      : contract.type === 'list' ? { type: 'array', items: { type: 'string' } }
        : { type: 'object', additionalProperties: true }]));
  const required = model.filter(contract => contract.required).map(contract => contract.key);
  return { ...base, properties: { ...base.properties, outputs: { type: 'object', properties, required, additionalProperties: false } },
    required: [...base.required, ...(required.length ? ['outputs'] : [])] };
}

function jsonValue(value: unknown, seen = new Set<object>()): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  if (Array.isArray(value) && (Object.keys(value).length !== value.length || Array.from({ length: value.length }, (_, index) => index).some(index => !Object.hasOwn(value, index)))) return false;
  seen.add(value);
  if (Object.getOwnPropertySymbols(value).length) return false;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue;
    if (['__proto__', 'prototype', 'constructor'].includes(key) || !descriptor.enumerable || !('value' in descriptor) || !jsonValue(descriptor.value, seen)) return false;
  }
  seen.delete(value); return true;
}

/** Validate all attachments before committing any prose. Provider schema enforcement alone is insufficient. */
export function acceptOutputs(value: unknown, plan: OutputPlan): AuxiliaryOutput[] {
  const model = plan.contracts.filter(contract => !contract.valueFrom);
  if (value === undefined) {
    if (model.some(contract => contract.required)) fail('PROSE_OUTPUT', 'Prose writer omitted required auxiliary outputs');
    return plan.contracts.filter(contract => contract.valueFrom).map(contract => {
      const host = plan.hostOutputs?.find(output => output.key === contract.key);
      if (!host) fail('PROSE_OUTPUT', `Host output was not resolved: ${contract.key}`);
      return clone(host);
    });
  }
  if (!value || Array.isArray(value) || typeof value !== 'object' || !jsonValue(value)) fail('PROSE_OUTPUT', 'Auxiliary outputs must be a plain JSON object');
  const entries = value as Record<string, Json>, contracts = new Map(model.map(contract => [contract.key, contract]));
  for (const key of Object.keys(entries)) if (!contracts.has(key)) fail('PROSE_OUTPUT', `Undeclared auxiliary output: ${key}`);
  const result: AuxiliaryOutput[] = [];
  for (const contract of plan.contracts) {
    if (contract.valueFrom) {
      const host = plan.hostOutputs?.find(output => output.key === contract.key);
      if (!host) fail('PROSE_OUTPUT', `Host output was not resolved: ${contract.key}`);
      result.push(clone(host)); continue;
    }
    if (!Object.hasOwn(entries, contract.key)) {
      if (contract.required) fail('PROSE_OUTPUT', `Missing required auxiliary output: ${contract.key}`);
      continue;
    }
    const item = entries[contract.key];
    const valid = contract.type === 'text' ? typeof item === 'string' && (!contract.required || !!item.trim())
      : contract.type === 'list' ? Array.isArray(item) && item.every(entry => typeof entry === 'string')
        : item !== null && typeof item === 'object' && !Array.isArray(item);
    if (!valid) fail('PROSE_OUTPUT', `Auxiliary output ${contract.key} does not match ${contract.type}`);
    result.push({ key: contract.key, title: contract.title, type: contract.type, value: clone(item), audience: clone(contract.audience), placement: contract.display.placement, display: clone(contract.display) });
  }
  return result;
}

export function outputPlanTrace(plan: OutputPlan): Json {
  return { decisions: plan.decisions, diagnostics: plan.diagnostics.map(diagnostic => ({ ...diagnostic })),
    contracts: plan.contracts.map(contract => ({ key: contract.key, documentId: contract.documentId, fingerprint: runtimeFingerprint(contract), required: contract.required,
      type: contract.type, audience: contract.audience, placement: contract.display.placement, ...(contract.valueFrom ? { valueFrom: clone(contract.valueFrom) } : {}) })), valid: plan.valid };
}
