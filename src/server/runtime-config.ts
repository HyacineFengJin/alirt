import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CharacterCard, OutputContract, Preset, PromptModule, StateField } from '../shared/types';
import type { StateRule } from '../shared/state-rules';
import type { AgentRuntimeConfig } from '../shared/agent-runtime';
import type { Worldbook } from '../shared/worldbook';
import { validateStateFieldValue, validateStateJson } from '../shared/state-value-schema';
export type { RuntimeFieldPolicyPatch, RuntimeRolePatch, RuntimeConfigurationUpdate } from '../shared/runtime-config';
import { AgentModuleRegistry } from './agent-modules';
import { validateRuntimeDocument as validateNativeDocument } from './worldbook-runtime';
import { assertRevision, clone, event, fail, validateWorldRules, type SessionStore, type StoredSession } from './store';

export interface RuntimeConfiguration { revision: number; card: CharacterCard; preset: Preset; agentRuntime: AgentRuntimeConfig; }

function exactObject(value: unknown, allowed: string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('RUNTIME_CONFIG_INPUT', `${path} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length) fail('RUNTIME_CONFIG_INPUT', `${path} contains unsupported keys`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!allowed.includes(key) || !descriptor.enumerable || !('value' in descriptor)) fail('RUNTIME_CONFIG_INPUT', `${path} contains unsupported field: ${key}`);
  }
  return value as Record<string, unknown>;
}

/** The bound documents are independent snapshots; callers cannot edit the store through this result. */
export function readRuntimeConfiguration(store: SessionStore, id: string): RuntimeConfiguration {
  const session = store.get(id);
  return clone({ revision: session.revision, card: session.card, preset: session.preset, agentRuntime: session.agentRuntime ?? { profile: 'full' } });
}

const hash = (document: unknown) => createHash('sha256').update(JSON.stringify(document)).digest('hex');
function sourceIdentity(session: StoredSession) {
  return { cardId: session.card.id, presetId: session.preset.id, cardHash: hash(session.card), presetHash: hash(session.preset) };
}

const policyKeys = ['audience', 'editable', 'writableBy', 'min', 'max', 'nullable', 'valueSchema'] as const;
function fieldPolicy(field: StateField) {
  return Object.fromEntries(policyKeys.filter(key => Object.hasOwn(field, key)).map(key => [key, clone(field[key])]));
}
function applyFieldPolicies(next: StoredSession, input: unknown) {
  if (validateStateJson(input).length || !Array.isArray(input) || !input.length || input.length > 256)
    fail('RUNTIME_CONFIG_INPUT', 'fieldPolicies must contain 1–256 ordinary JSON field policy patches');
  const seen = new Set<string>(), audit: { key: string; previous: ReturnType<typeof fieldPolicy>; current: ReturnType<typeof fieldPolicy> }[] = [];
  for (const value of input) {
    const patch = exactObject(value, ['key', ...policyKeys], 'Field policy patch');
    if (typeof patch.key !== 'string' || !patch.key.trim() || seen.has(patch.key)) fail('RUNTIME_CONFIG_INPUT', 'Field policy keys must uniquely identify existing declarations');
    seen.add(patch.key);
    const fields = next.fields.filter(field => field.key === patch.key), bound = next.card.fields.filter(field => field.key === patch.key);
    if (fields.length !== 1 || bound.length !== 1 || fields[0].type !== bound[0].type) fail('RUNTIME_CONFIG_INPUT', 'Field policy requires one matching existing session and card declaration');
    const previous = fieldPolicy(fields[0]);
    for (const field of [fields[0], bound[0]]) for (const key of policyKeys) if (Object.hasOwn(patch, key)) {
      if (patch[key] === null) {
        if (key === 'min' || key === 'max' || key === 'valueSchema') delete field[key];
        else fail('RUNTIME_CONFIG_INPUT', 'Only optional field bounds and valueSchema can be cleared with null');
      } else Object.defineProperty(field, key, { value: clone(patch[key]), writable: true, enumerable: true, configurable: true });
    }
    const current = fieldPolicy(fields[0]);
    if (!isDeepStrictEqual(previous, current)) audit.push({ key: patch.key, previous, current });
  }
  return audit;
}
function validateHeldFieldValues(session: StoredSession) {
  for (const owner of [{ id: 'world', state: session.world.variables }, ...session.roles]) {
    if (validateStateJson(owner.state).length) fail('RUNTIME_CONFIG_INVALID', `Held state ${owner.id} must contain ordinary JSON data`);
    for (const [key, value] of Object.entries(owner.state)) {
      const field = session.fields.find(field => field.key === key);
      // Existing importer metadata is not converted into declared state by this patch.
      if (!field) continue;
      const issues = validateStateFieldValue(field, value, { initial: true });
      if (issues.length) fail('RUNTIME_CONFIG_INVALID', `Field policy rejects held state ${owner.id}.${key}: ${issues[0].message}`);
    }
  }
  for (const output of [...(session.card.outputs ?? []), ...(session.preset.outputs ?? [])]) {
    const source = output.valueFrom;
    if (!output.enabled || source?.kind !== 'state') continue;
    const field = session.fields.find(field => field.key === source.key), owner = source.roleId === 'world' ? session.world.variables : session.roles.find(role => role.id === source.roleId)?.state;
    if (!field || !owner || !Object.hasOwn(owner, source.key) || field.audience !== 'public')
      fail('RUNTIME_CONFIG_INVALID', 'An enabled state output must retain an available public field reference');
  }
}

/** Validate a complete proposed configuration before a single durable snapshot replacement. */
export function updateRuntimeConfiguration(store: SessionStore, id: string, input: unknown, modules = new AgentModuleRegistry()): RuntimeConfiguration {
  const patch = exactObject(input, ['expectedRevision', 'reason', 'cardModules', 'cardOutputs', 'cardWorldbook', 'cardVisuals', 'stateRules', 'preset', 'roles', 'agentRuntime', 'fieldPolicies'], 'Runtime configuration');
  if (Object.hasOwn(patch, 'fieldPolicies') && validateStateJson(input).length) fail('RUNTIME_CONFIG_INPUT', 'Field policy configuration must contain ordinary JSON data');
  const current = store.get(id);
  assertRevision(current, patch.expectedRevision as number);
  if (typeof patch.reason !== 'string' || !patch.reason.trim()) fail('RUNTIME_CONFIG_REASON', 'A nonempty runtime configuration reason is required');
  const next = clone(current);
  const fieldPolicies = Object.hasOwn(patch, 'fieldPolicies') ? applyFieldPolicies(next, patch.fieldPolicies) : undefined;
  if (Object.hasOwn(patch, 'agentRuntime')) {
    // resolve validates dependencies as well as the shape. Configuration cannot
    // silently turn on additional paid actors to satisfy an extension.
    const plan = modules.resolve(patch.agentRuntime);
    next.agentRuntime = clone(plan.config);
  }
  if (Object.hasOwn(patch, 'cardModules')) next.card.modules = patch.cardModules as PromptModule[];
  if (Object.hasOwn(patch, 'cardOutputs')) next.card.outputs = patch.cardOutputs as OutputContract[];
  if (Object.hasOwn(patch, 'cardVisuals')) {
    if (patch.cardVisuals === null) delete next.card.visuals;
    else next.card.visuals = patch.cardVisuals as CharacterCard['visuals'];
  }
  if (Object.hasOwn(patch, 'cardWorldbook')) {
    if (patch.cardWorldbook === null) delete next.card.worldbook;
    else next.card.worldbook = patch.cardWorldbook as Worldbook;
  }
  if (Object.hasOwn(patch, 'stateRules')) next.card.stateRules = patch.stateRules as StateRule[];
  if (Object.hasOwn(patch, 'preset')) next.preset = patch.preset as Preset;
  const changedRoleIds: string[] = [];
  if (Object.hasOwn(patch, 'roles')) {
    if (!Array.isArray(patch.roles)) fail('RUNTIME_CONFIG_INPUT', 'roles must be an array of role patches');
    const seen = new Set<string>();
    for (const value of patch.roles) {
      const rolePatch = exactObject(value, ['id', 'persona', 'goals', 'peers'], 'Role patch');
      if (typeof rolePatch.id !== 'string' || seen.has(rolePatch.id)) fail('RUNTIME_CONFIG_INPUT', 'Role patches require unique existing role IDs');
      seen.add(rolePatch.id);
      const role = next.roles.find(role => role.id === rolePatch.id), boundRole = next.card.roles.find(role => role.id === rolePatch.id);
      if (!role || !boundRole) fail('ROLE_UNKNOWN', 'Unknown runtime configuration role');
      if (!['persona', 'goals', 'peers'].some(key => Object.hasOwn(rolePatch, key))) fail('RUNTIME_CONFIG_INPUT', 'A role patch must contain persona, goals or peers');
      const before = clone({ persona: role.persona, goals: role.goals, peers: role.peers });
      for (const key of ['persona', 'goals', 'peers'] as const) {
        if (Object.hasOwn(rolePatch, key)) {
          // Input remains unmodified. Native validation below checks its exact JSON shape.
          Object.defineProperty(role, key, { value: rolePatch[key], writable: true, enumerable: true, configurable: true });
          Object.defineProperty(boundRole, key, { value: rolePatch[key], writable: true, enumerable: true, configurable: true });
        }
      }
      if (!isDeepStrictEqual(before, { persona: role.persona, goals: role.goals, peers: role.peers })) changedRoleIds.push(role.id);
    }
  }
  for (const [kind, document] of [['card', next.card], ['preset', next.preset]] as const) {
    const issues = validateNativeDocument(kind, document);
    if (issues.length) fail('RUNTIME_CONFIG_INVALID', `Invalid runtime ${kind}: ${issues.slice(0, 8).map(issue => `${issue.path}: ${issue.message}`).join('; ')}`);
  }
  if (fieldPolicies) validateHeldFieldValues(next);
  const cardChanged = !isDeepStrictEqual(current.card, next.card), presetChanged = !isDeepStrictEqual(current.preset, next.preset);
  const agentRuntimeChanged = !isDeepStrictEqual(current.agentRuntime ?? { profile: 'full' }, next.agentRuntime ?? { profile: 'full' });
  if (!cardChanged && !presetChanged && !changedRoleIds.length && !agentRuntimeChanged) fail('RUNTIME_CONFIG_UNCHANGED', 'Runtime configuration must contain an actual change');
  // Clone validated input before retaining it, including unknown native document fields.
  const committed = clone(next);
  validateWorldRules(committed);
  committed.presetId = committed.preset.id;
  ++committed.revision;
  event(committed, { kind: 'runtime-configured', actor: 'author', text: patch.reason, audience: 'author', data: {
    previous: sourceIdentity(current), current: sourceIdentity(committed),
    cardChanged, presetChanged, roleIds: changedRoleIds,
    ...(fieldPolicies?.length ? { fieldPolicies: JSON.parse(JSON.stringify(fieldPolicies)) } : {}),
    ...(agentRuntimeChanged ? { agentRuntime: { previous: current.agentRuntime ?? { profile: 'full' }, current: committed.agentRuntime! } } : {}),
  } });
  store.save(committed);
  return readRuntimeConfiguration(store, id);
}
