import { createHash } from 'node:crypto';
import type { BehaviorCandidate } from '../shared/behavior';
import type { Json, RoleDefinition, StateField, WorldEvent } from '../shared/types';
import type { PublicWorldFact, PublicWorldFactSource, ResolvedWorldFact, ResolvedWorldFactSource, WorldFactsCompilation, WorldInputEvidenceReference } from '../shared/world-facts';
import { PUBLICATION_KINDS, type ResolvedWorldPublication, type WorldPublication } from '../shared/world-facts';
import { assertStateJson } from './state-runtime';
import { validateWorldInputEvidence, type WorldInputEvidence } from '../shared/world-input';

export interface WorldFactsContext {
  /** Only the approved candidates from this delivery/turn, supplied by the host. */
  acceptedBehaviors: readonly BehaviorCandidate[];
  /** Only host evidence selected and bound to this turn, never historical evidence. */
  worldInputs?: readonly WorldInputEvidence[];
  allowPublications?: boolean;
  /** The final transaction snapshot, after proposal and rule effects. */
  finalState: {
    revision?: number;
    world: { variables: Readonly<Record<string, Json>>; time?: string };
    roles: readonly Pick<RoleDefinition, 'id' | 'state'>[];
    fields: readonly StateField[];
  };
  hasOpeningSetup: boolean;
  hasPlayerAction: boolean;
}

export class WorldFactsContractError extends Error {
  readonly code = 'WORLD_FACTS';
  constructor(message: string) {
    super(message);
    this.name = 'WorldFactsContractError';
  }
}

const fail = (message: string): never => { throw new WorldFactsContractError(message); };
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

/** Check properties without invoking model-supplied accessors. */
function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail(`${path} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || forbidden.has(key) || !descriptor.enumerable || !('value' in descriptor)) return fail(`${path} must contain only ordinary JSON properties`);
  }
  return value as Record<string, unknown>;
}

function shape(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(`${path} must contain exactly ${keys.join(', ')}`);
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail(`${path} must be an array`);
  if (Reflect.ownKeys(value).length !== value.length + 1) return fail(`${path} must be a dense JSON array`);
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return fail(`${path} must be a dense JSON array`);
  }
  return value;
}

function nonempty(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) return fail(`${path} must be a nonempty string`);
  return value;
}

function ordinaryJson(value: unknown, path: string): void {
  try { assertStateJson(value); }
  catch { fail(`${path} must contain only ordinary JSON data`); }
}
function publication(value: unknown, resolved: boolean): WorldPublication | ResolvedWorldPublication {
  const raw = record(value, 'World publication');
  shape(raw, resolved ? ['kind', 'sourceLabel', 'worldTime', 'worldRevision'] : ['kind', 'sourceLabel'], 'World publication');
  if (!PUBLICATION_KINDS.includes(raw.kind as WorldPublication['kind'])) return fail('Unknown world publication kind');
  const base = { kind: raw.kind as WorldPublication['kind'], sourceLabel: nonempty(raw.sourceLabel, 'World publication sourceLabel') };
  if (!resolved) return base;
  if (raw.worldTime !== null && (typeof raw.worldTime !== 'string' || !raw.worldTime.trim())
    || !Number.isSafeInteger(raw.worldRevision) || (raw.worldRevision as number) < 1) return fail('World publication requires valid host time/revision stamps');
  return { ...base, worldTime: raw.worldTime as string | null, worldRevision: raw.worldRevision as number };
}
function independentPublication(sources: { kind: string }[]) {
  if (sources.length !== 1 || sources[0].kind !== 'world-development') return fail('World publication requires only an independent world-development source');
  shape(record(sources[0], 'World publication source'), ['kind'], 'World publication source');
}
function publicFact(value: unknown): PublicWorldFact {
  ordinaryJson(value, 'Public world fact');
  const fact = record(value, 'Public world fact');
  shape(fact, ['text', 'sources', ...(Object.hasOwn(fact, 'publication') ? ['publication'] : [])], 'Public world fact');
  if (typeof fact.text !== 'string') return fail('Public world fact text must be a string');
  const sources: PublicWorldFactSource[] = array(fact.sources, 'Public world fact sources').map((value, index) => {
    const path = `Public world fact sources[${index}]`, source = record(value, path);
    if (source.kind !== 'host-input') return structuredClone(source) as unknown as PublicWorldFactSource;
    const id = nonempty(source.id, `${path}.id`);
    let evidenceRef: WorldInputEvidenceReference;
    if (Object.hasOwn(source, 'evidence')) {
      shape(source, ['kind', 'id', 'evidence'], path);
      let evidence: WorldInputEvidence;
      try { evidence = validateWorldInputEvidence(source.evidence); }
      catch { return fail(`${path} contains invalid host input evidence`); }
      if (evidence.id !== id) return fail(`${path} host input evidence ID does not match its source`);
      evidenceRef = { schema: 'rp.world-input-reference/0.1', serviceId: evidence.serviceId, referenceId: evidence.referenceId,
        kind: evidence.kind, title: evidence.title, payloadSha256: createHash('sha256').update(JSON.stringify(evidence.payload)).digest('hex') };
    } else {
      shape(source, ['kind', 'id', 'evidenceRef'], path);
      const ref = record(source.evidenceRef, `${path}.evidenceRef`);
      shape(ref, ['schema', 'serviceId', 'referenceId', 'kind', 'title', 'payloadSha256'], `${path}.evidenceRef`);
      if (ref.schema !== 'rp.world-input-reference/0.1' || typeof ref.payloadSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.payloadSha256))
        return fail(`${path} contains an invalid host input evidence reference`);
      evidenceRef = { schema: 'rp.world-input-reference/0.1', serviceId: nonempty(ref.serviceId, path), referenceId: nonempty(ref.referenceId, path),
        kind: nonempty(ref.kind, path), title: nonempty(ref.title, path), payloadSha256: ref.payloadSha256 };
    }
    return { kind: 'host-input', id, evidenceRef };
  });
  const published = Object.hasOwn(fact, 'publication') ? publication(fact.publication, true) as ResolvedWorldPublication : undefined;
  if (published) independentPublication(sources);
  return { text: fact.text, sources, ...(published ? { publication: published } : {}) };
}

/** Public facts disclose the adjudicated text and provenance, never the full host corpus. */
export function publicWorldFact(fact: ResolvedWorldFact | PublicWorldFact): PublicWorldFact { return publicFact(fact); }

/** Migrate disclosure at read time without rewriting the immutable historical author audit. */
export function publicFactEvent(event: WorldEvent): WorldEvent {
  ordinaryJson(event, 'World fact event');
  const output = structuredClone(event);
  if (output.kind !== 'world-event' || !output.data || Array.isArray(output.data) || typeof output.data !== 'object'
    || !Object.hasOwn(output.data, 'fact')) return output;
  output.data.fact = publicFact(output.data.fact) as unknown as Json;
  return output;
}

function stateValue(context: WorldFactsContext, roleId: string, key: string): Json {
  if (forbidden.has(roleId) || forbidden.has(key)) return fail('Invalid state source target');
  const fields = context.finalState.fields.filter(field => field.key === key);
  if (fields.length !== 1) return fail(`State source requires one declared field: ${roleId}.${key}`);
  const field = fields[0];
  if (field.audience !== 'public') return fail(`State source must reference a public field: ${roleId}.${key}`);
  const roles = context.finalState.roles.filter(role => role.id === roleId);
  const state = roleId === 'world' ? context.finalState.world.variables : roles.length === 1 ? roles[0].state : undefined;
  if (!state || !Object.hasOwn(state, key)) return fail(`Unknown final state source: ${roleId}.${key}`);
  const descriptor = Object.getOwnPropertyDescriptor(state, key)!;
  if (!('value' in descriptor)) return fail(`State source must be a stored JSON value: ${roleId}.${key}`);
  try { assertStateJson(descriptor.value); }
  catch { return fail(`State source must contain valid JSON: ${roleId}.${key}`); }
  return structuredClone(descriptor.value);
}

/** Validates references and projects only the public fact contract. It cannot
 * prove that a fact's prose is semantically entailed by the declared sources.
 * Any present invalid facts field fails closed; legacy events never rescue it.
 * Summary is author audit material and is never used as a public fact. */
export function compileWorldFacts(worldResult: unknown, context: WorldFactsContext): WorldFactsCompilation {
  const world = record(worldResult, 'World result');
  if (!Object.hasOwn(world, 'facts')) {
    const events = array(Object.hasOwn(world, 'events') ? world.events : [], 'Legacy world events');
    if (events.some(event => typeof event !== 'string')) return fail('Legacy world events must be an array of strings');
    return {
      mode: 'legacy', facts: (events as string[]).map(text => ({ text, sources: [] })),
      diagnostics: [{ code: 'world-facts-legacy', severity: 'warning', path: 'facts',
        message: 'World result omitted facts; legacy events have no verified public sources.' }],
    };
  }
  const inputs = array(world.facts, 'World facts');
  const approved = new Set<string>();
  for (const behavior of context.acceptedBehaviors) {
    const id = nonempty(behavior.id, 'Approved behavior id');
    if (approved.has(id)) return fail(`Duplicate approved behavior id: ${id}`);
    approved.add(id);
  }
  const hostInputs = new Map<string, WorldInputEvidence>();
  for (const raw of array(context.worldInputs === undefined ? [] : context.worldInputs, 'Current host inputs')) {
    let evidence: WorldInputEvidence;
    try { evidence = validateWorldInputEvidence(raw); }
    catch { return fail('Current host input must be valid trusted JSON evidence'); }
    if (hostInputs.has(evidence.id)) return fail(`Duplicate current host input id: ${evidence.id}`);
    hostInputs.set(evidence.id, evidence);
  }
  const facts: ResolvedWorldFact[] = inputs.map((input, index) => {
    const path = `facts[${index}]`, fact = record(input, path);
    const publishes = Object.hasOwn(fact, 'publication');
    if (publishes && !context.allowPublications) return fail('World publication production is not enabled for this delivery');
    shape(fact, ['text', 'sources', ...(publishes ? ['publication'] : [])], path);
    const text = nonempty(fact.text, `${path}.text`);
    const inputSources = array(fact.sources, `${path}.sources`);
    if (!inputSources.length) return fail(`${path}.sources must be a nonempty array`);
    const seen = new Set<string>();
    const sources: ResolvedWorldFactSource[] = inputSources.map((inputSource, sourceIndex) => {
      const sourcePath = `${path}.sources[${sourceIndex}]`, source = record(inputSource, sourcePath);
      let resolved: ResolvedWorldFactSource;
      switch (source.kind) {
        case 'host-input': {
          shape(source, ['kind', 'id'], sourcePath);
          const id = nonempty(source.id, `${sourcePath}.id`), evidence = hostInputs.get(id);
          if (!evidence) return fail(`Unknown current-turn host input source: ${id}`);
          resolved = { kind: 'host-input', id, evidence: structuredClone(evidence) };
          break;
        }
        case 'behavior': {
          shape(source, ['kind', 'id'], sourcePath);
          const id = nonempty(source.id, `${sourcePath}.id`);
          if (!approved.has(id)) return fail(`Unknown approved current-turn behavior source: ${id}`);
          resolved = { kind: 'behavior', id };
          break;
        }
        case 'state': {
          shape(source, ['kind', 'roleId', 'key'], sourcePath);
          const roleId = nonempty(source.roleId, `${sourcePath}.roleId`), key = nonempty(source.key, `${sourcePath}.key`);
          resolved = { kind: 'state', roleId, key, value: stateValue(context, roleId, key) };
          break;
        }
        case 'player-action':
          shape(source, ['kind'], sourcePath);
          if (!context.hasPlayerAction) return fail('Player-action source requires a current player action');
          resolved = { kind: 'player-action' };
          break;
        case 'opening-setup':
          shape(source, ['kind'], sourcePath);
          if (!context.hasOpeningSetup) return fail('Opening-setup source requires a valid setup supplied this turn');
          resolved = { kind: 'opening-setup' };
          break;
        case 'world-development':
          shape(source, ['kind'], sourcePath);
          resolved = { kind: 'world-development' };
          break;
        default: return fail('Unknown world fact source kind');
      }
      const identity = JSON.stringify(resolved);
      if (seen.has(identity)) return fail(`Duplicate world fact source at ${sourcePath}`);
      seen.add(identity);
      return resolved;
    });
    let published: ResolvedWorldPublication | undefined;
    if (publishes) {
      independentPublication(sources);
      const raw = publication(fact.publication, false), revision = context.finalState.revision;
      if (!Number.isSafeInteger(revision) || revision! < 0 || !Number.isSafeInteger(revision! + 1)) return fail('World publication requires a valid pending host revision');
      const time = context.finalState.world.time;
      published = { ...raw, worldTime: typeof time === 'string' && time.trim() ? time : null, worldRevision: revision! + 1 };
    }
    return { text, sources, ...(published ? { publication: published } : {}) };
  });
  return { mode: 'sourced', facts, diagnostics: [] };
}
