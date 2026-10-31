import { evaluateNativeCondition } from '../shared/native';
import { isRemoteInteraction } from '../shared/role-interaction';
import { validateStateJson, validateStateFieldDefinition, validateStateFieldValue } from '../shared/state-value-schema';
import type { Json } from '../shared/types';
import type { StateAuditEntry, StateChange, StateConditionView, StateEffect, StateRule, StateSnapshot, StateTransactionOptions, StateTransactionResult } from '../shared/state-rules';

export type StateTransactionErrorCode =
  | 'REVISION_CONFLICT' | 'STATE_CHANGE' | 'STATE_OWNER' | 'ROLE_UNKNOWN' | 'STATE_FIELD'
  | 'STATE_READONLY' | 'STATE_AUTHORITY' | 'STATE_TYPE' | 'STATE_RANGE' | 'STATE_JSON'
  | 'STATE_CAS_CONFLICT' | 'STATE_WRITE_CONFLICT' | 'STATE_RULE_VIOLATION'
  | 'STATE_RULE_CONDITION' | 'STATE_RULE_CYCLE' | 'STATE_RULE_LIMIT' | 'STATE_RULE_UNSUPPORTED';
export class StateTransactionError extends Error {
  constructor(public code: StateTransactionErrorCode, message: string, public ruleId?: string) {
    super(message);
    this.name = 'StateTransactionError';
  }
}
const fail = (code: StateTransactionErrorCode, message: string, ruleId?: string): never => { throw new StateTransactionError(code, message, ruleId); };
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_EFFECTS = 1024;

/** Reject values JSON serialization would silently erase or change, without invoking getters. */
export function assertStateJson(value: unknown): asserts value is Json {
  const error = validateStateJson(value)[0];
  if (error) fail('STATE_JSON', `${error.message}${error.path ? `: ${error.path}` : ''}`);
}
function equal(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => equal(value, b[i]));
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
const targetKey = (roleId: string, key: string) => JSON.stringify([roleId, key]);
/** Metadata is checked even for direct reducer consumers and persisted snapshots. */
function validatePresenceMirrors(snapshot: StateSnapshot, final: boolean) {
  for (const role of snapshot.roles) {
    const mirrors = role.stateMirrors;
    if (mirrors === undefined) continue;
    if (!mirrors || typeof mirrors !== 'object' || Array.isArray(mirrors) || Object.keys(mirrors).length !== 1
      || typeof mirrors.presence !== 'string' || !mirrors.presence.trim() || forbidden.has(mirrors.presence)) fail('STATE_FIELD', 'Invalid explicit presence mirror binding');
    const key = mirrors.presence, declarations = snapshot.fields.filter(field => field.key === key);
    if (declarations.length !== 1 || declarations[0].type !== 'boolean' || !Object.hasOwn(role.state, key)
      || typeof role.state[key] !== 'boolean') fail('STATE_FIELD', `Presence mirror requires a held declared boolean: ${role.id}.${key}`);
    if (final && role.state[key] !== (role.presence === 'present')) fail('STATE_RULE_VIOLATION', `Presence mirror disagrees with structural presence: ${role.id}.${key}`);
  }
}
function target(snapshot: StateSnapshot, roleId: string, key: string) {
  if (typeof roleId !== 'string' || typeof key !== 'string' || forbidden.has(roleId) || forbidden.has(key)) fail('STATE_CHANGE', 'Invalid state target');
  const state = roleId === 'world' ? snapshot.world.variables : snapshot.roles.find(role => role.id === roleId)?.state;
  if (!state) return fail('ROLE_UNKNOWN', `Unknown state owner: ${roleId}`);
  const field = snapshot.fields.find(candidate => candidate.key === key);
  if (!field || !Object.hasOwn(state, key)) return fail('STATE_FIELD', `Unknown state field: ${roleId}.${key}`);
  return { state, field };
}
function validateValue(snapshot: StateSnapshot, roleId: string, key: string, value: unknown) {
  const resolved = target(snapshot, roleId, key);
  const error = validateStateFieldValue(resolved.field, value)[0];
  if (error) fail(error.code === 'schema' ? 'STATE_FIELD' : error.code === 'json' ? 'STATE_JSON' : error.code === 'range' ? 'STATE_RANGE' : 'STATE_TYPE', `${error.message}: ${roleId}.${key}${error.path}`);
  return resolved;
}
function view(snapshot: StateSnapshot, trigger?: StateAuditEntry): StateConditionView {
  return { world: { location: snapshot.world.location, time: snapshot.world.time, variables: snapshot.world.variables },
    roles: Object.fromEntries(snapshot.roles.map(role => [role.id, { id: role.id, state: role.state, phase: role.phase, presence: role.presence }])),
    ...(trigger ? { trigger: { roleId: trigger.roleId, key: trigger.key, before: trigger.before, after: trigger.after } } : {}) };
}
function effectValue(snapshot: StateSnapshot, roleId: string, effect: StateEffect): Json {
  const { state } = target(snapshot, roleId, effect.key), previous = state[effect.key];
  switch (effect.type) {
    case 'set': return effect.value;
    case 'increment':
      if (typeof previous !== 'number' || typeof effect.amount !== 'number' || !Number.isFinite(effect.amount)) return fail('STATE_TYPE', 'Increment effects require finite numbers');
      return previous + effect.amount;
    case 'list-add': case 'list-remove':
      if (!Array.isArray(previous)) return fail('STATE_TYPE', 'List effects require a list field');
      assertStateJson(effect.value);
      return effect.type === 'list-add'
        ? previous.some(item => equal(item, effect.value)) ? previous : [...previous, effect.value]
        : previous.filter(item => !equal(item, effect.value));
    default: return fail('STATE_RULE_UNSUPPORTED', 'Unsupported state effect');
  }
}

type DeltaLimitRule = Extract<StateRule, { type: 'delta-limit' }>;
/** Validate here as well as in document intake: callers may use the reducer directly. */
function deltaLimitOwners(snapshot: StateSnapshot, rule: DeltaLimitRule): string[] {
  if (typeof rule.field !== 'string' || !rule.field.trim() || forbidden.has(rule.field)
    || snapshot.fields.find(field => field.key === rule.field)?.type !== 'number'
    || !['model', 'all'].includes(rule.authority)) fail('STATE_RULE_UNSUPPORTED', 'Invalid delta-limit field or authority', rule.id);
  const limits = ['maxIncrease', 'maxDecrease'] as const;
  if (!limits.some(key => Object.hasOwn(rule, key)) || limits.some(key => Object.hasOwn(rule, key)
    && (typeof rule[key] !== 'number' || !Number.isFinite(rule[key]) || rule[key]! < 0)))
    fail('STATE_RULE_UNSUPPORTED', 'Delta limits require finite nonnegative bounds', rule.id);
  const holders = [
    ...(Object.hasOwn(snapshot.world.variables, rule.field) ? ['world'] : []),
    ...snapshot.roles.filter(role => Object.hasOwn(role.state, rule.field)).map(role => role.id),
  ];
  if (!Object.hasOwn(rule, 'owners')) {
    if (!holders.length) fail('STATE_RULE_UNSUPPORTED', 'Delta-limit field has no state owners', rule.id);
    return holders;
  }
  if (!Array.isArray(rule.owners) || !rule.owners.length || new Set(rule.owners).size !== rule.owners.length
    || rule.owners.some(owner => typeof owner !== 'string' || !holders.includes(owner)))
    fail('STATE_RULE_UNSUPPORTED', 'Delta-limit owners must uniquely identify existing field holders', rule.id);
  return rule.owners!;
}

/** Pure and atomic: nothing in the supplied snapshot is mutated, including on failure.
 * Direct writes form wave zero. Rules read the completed previous wave and their effects
 * form the next wave in declaration order. A target may receive one distinct value per
 * transaction; competing values are rejected instead of depending on evaluation order.
 */
export function applyStateTransaction<T extends StateSnapshot>(snapshot: T, changes: readonly StateChange[], options: StateTransactionOptions): StateTransactionResult<T> {
  if (options.authority !== 'model' && options.authority !== 'author') fail('STATE_AUTHORITY', 'Direct writes require model or author authority');
  if (options.expectedRevision !== undefined && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision !== snapshot.revision)) fail('REVISION_CONFLICT', 'State changed before this transaction');
  assertStateJson(snapshot.fields);
  for (const field of snapshot.fields) {
    const error = validateStateFieldDefinition(field)[0];
    if (error) fail('STATE_FIELD', `${error.message}: ${field.key}${error.path}`);
  }
  validatePresenceMirrors(snapshot, false);
  const limit = options.maxEffects ?? 256;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_EFFECTS || changes.length > MAX_EFFECTS) fail('STATE_RULE_LIMIT', `State transactions support at most ${MAX_EFFECTS} writes/effects`);
  const rules = options.rules ?? [];
  const ids = new Set<string>();
  for (const rule of rules) {
    if (!rule || !rule.id || ids.has(rule.id)) fail('STATE_RULE_UNSUPPORTED', 'State rule IDs must be unique and nonempty');
    ids.add(rule.id);
    if (!['unique-item', 'invariant', 'transition', 'delta-limit'].includes(rule.type)) fail('STATE_RULE_UNSUPPORTED', 'Unsupported state rule', rule.id);
    if (rule.type === 'delta-limit') deltaLimitOwners(snapshot, rule);
  }
  // Validate CAS and every direct proposal before allocating the candidate snapshot.
  for (const change of changes) {
    if (!change || typeof change !== 'object') fail('STATE_CHANGE', 'Invalid state change');
    if (options.owner && change.roleId !== options.owner) fail('STATE_OWNER', 'A role may propose changes only to its own state');
    const { state, field } = validateValue(snapshot, change.roleId, change.key, change.value);
    if (field.writableBy === 'derived') fail('STATE_AUTHORITY', 'Derived fields may only be written by declared rules');
    if (options.authority === 'model' && field.writableBy === 'author') fail('STATE_AUTHORITY', 'Only the author may directly write this field');
    if (options.authority === 'author' && !field.editable) fail('STATE_READONLY', 'This state field is not editable');
    if (Object.hasOwn(change, 'expectedValue')) {
      assertStateJson(change.expectedValue);
      if (!equal(state[change.key], change.expectedValue!)) fail('STATE_CAS_CONFLICT', `State comparison failed: ${change.roleId}.${change.key}`);
    }
  }
  const nextState = structuredClone(snapshot), audit: StateAuditEntry[] = [];
  const written = new Map<string, Json>();
  const ancestry = new Map<string, Set<string>>();
  function write(roleId: string, key: string, value: Json, authority: StateAuditEntry['authority'], ruleId?: string, cause?: StateAuditEntry): StateAuditEntry | undefined {
    const { state, field } = validateValue(nextState, roleId, key, value), identity = targetKey(roleId, key), before = state[key];
    const mirrorRole = nextState.roles.find(role => role.id === roleId && role.stateMirrors?.presence === key);
    const presenceBefore = mirrorRole?.presence, interactionBefore = structuredClone(mirrorRole?.interaction ?? null);
    const presenceAfter = value === true ? 'present' : 'absent';
    const parents = cause ? ancestry.get(cause.id)! : new Set<string>();
    if (!equal(before, value) && parents.has(identity)) fail('STATE_RULE_CYCLE', `State rule cycle writes ${roleId}.${key} again`, ruleId);
    const previous = written.get(identity);
    if (written.has(identity) && !equal(previous!, value)) fail('STATE_WRITE_CONFLICT', `Conflicting writes to ${roleId}.${key}`, ruleId);
    written.set(identity, structuredClone(value));
    if (equal(before, value) && (!mirrorRole || mirrorRole.presence === presenceAfter)) return;
    state[key] = structuredClone(value);
    if (mirrorRole) {
      mirrorRole.presence = presenceAfter;
      if (presenceAfter === 'present' && isRemoteInteraction(mirrorRole.interaction)) delete mirrorRole.interaction;
    }
    const entry: StateAuditEntry = { id: `change:${audit.length + 1}`, roleId, key, before: structuredClone(before), after: structuredClone(value), authority, origin: cause ? 'rule' : 'proposal', audience: structuredClone(field.audience), ...(ruleId ? { ruleId } : {}), ...(cause ? { causeId: cause.id, trigger: { roleId: cause.roleId, key: cause.key, before: structuredClone(cause.before), after: structuredClone(cause.after) } } : {}),
      ...(mirrorRole ? { presenceSync: { before: presenceBefore!, after: presenceAfter, interactionBefore, interactionAfter: structuredClone(mirrorRole.interaction ?? null) } } : {}) };
    ancestry.set(entry.id, new Set([...parents, identity]));
    audit.push(entry);
    return entry;
  }
  // Record even no-op proposals as reservations so effects cannot override a direct decision.
  for (const change of changes) {
    const identity = targetKey(change.roleId, change.key), previous = written.get(identity);
    if (written.has(identity) && !equal(previous!, change.value)) fail('STATE_WRITE_CONFLICT', `Conflicting proposals to ${change.roleId}.${change.key}`);
    write(change.roleId, change.key, change.value, options.authority);
    written.set(identity, structuredClone(change.value));
  }
  let wave = [...audit], effects = 0;
  while (wave.length) {
    const pending: { roleId: string; effect: StateEffect; value: Json; ruleId: string; cause: StateAuditEntry }[] = [];
    for (const cause of wave) {
      for (const rule of rules) {
        if (rule.type !== 'transition' || rule.trigger.key !== cause.key || rule.trigger.roleId !== '*' && rule.trigger.roleId !== cause.roleId) continue;
        if (rule.when) {
          const condition = evaluateNativeCondition(rule.when, { snapshot: view(nextState, cause), roleId: cause.roleId });
          if (condition.status === 'unknown') fail('STATE_RULE_CONDITION', `State rule ${rule.id} condition is unknown: ${condition.reasons.join('; ')}`, rule.id);
          if (condition.status === 'false') continue;
        }
        for (const effect of rule.effects) {
          if (++effects > limit) fail('STATE_RULE_LIMIT', `State rule effects exceeded limit ${limit}`, rule.id);
          const roleId = effect.roleId === '$trigger' ? cause.roleId : effect.roleId;
          pending.push({ roleId, effect, value: effectValue(nextState, roleId, effect), ruleId: rule.id, cause });
        }
      }
    }
    wave = [];
    for (const effect of pending) {
      const entry = write(effect.roleId, effect.effect.key, effect.value, 'rule', effect.ruleId, effect.cause);
      if (entry) wave.push(entry);
    }
  }
  for (const rule of rules) {
    if (rule.type === 'unique-item') {
      let occurrences = 0;
      for (const role of nextState.roles) {
        const items = role.state[rule.field];
        if (Array.isArray(items)) occurrences += items.filter(item => item === rule.item).length;
      }
      if (occurrences > 1) fail('STATE_RULE_VIOLATION', `State rule ${rule.id}: ${rule.item} may have only one holder`, rule.id);
    } else if (rule.type === 'delta-limit' && (rule.authority === 'all' || options.authority === 'model')) {
      for (const owner of deltaLimitOwners(snapshot, rule)) {
        const before = target(snapshot, owner, rule.field).state[rule.field];
        const after = target(nextState, owner, rule.field).state[rule.field];
        // Unchanged unknown values do not block unrelated transactions or genesis validation.
        if (equal(before, after)) continue;
        if (typeof before !== 'number' || !Number.isFinite(before) || typeof after !== 'number' || !Number.isFinite(after))
          return fail('STATE_RULE_VIOLATION', `State rule ${rule.id}: ${owner}.${rule.field} requires an explicit finite numeric baseline before a limited change`, rule.id);
        const delta = after - before;
        if (rule.maxIncrease !== undefined && delta > rule.maxIncrease || rule.maxDecrease !== undefined && -delta > rule.maxDecrease)
          fail('STATE_RULE_VIOLATION', `State rule ${rule.id}: ${owner}.${rule.field} exceeds its transaction delta limit`, rule.id);
      }
    } else if (rule.type === 'invariant') {
      const condition = evaluateNativeCondition(rule.condition, { snapshot: view(nextState) });
      if (condition.status !== 'true') fail('STATE_RULE_VIOLATION', rule.message, rule.id);
    }
  }
  validatePresenceMirrors(nextState, true);
  return { nextState, audit };
}
