import type { Json } from './types';

/** A reference to trusted host data; clients never supply the evidence payload. */
export interface WorldInputSelection { serviceId: string; referenceId: string; parameters: Json }
export interface WorldInputEvidence {
  schema: 'rp.world-input/0.1'; id: string; serviceId: string; referenceId: string;
  kind: string; title: string; payload: Json;
}
/** Private turn-scoped evidence and retry binding, never an ordinary session projection. */
export interface WorldInputTurnRecord {
  turnId: string; reference: WorldInputSelection; evidence: WorldInputEvidence;
  requestFingerprint: string; committed: boolean;
}

const invalid = (message: string): never => { throw new Error(`World input ${message}`); };
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
/** Reject values serialization would erase/change, without evaluating accessors. */
function json(value: unknown): void {
  const ancestors = new Set<object>();
  function visit(node: unknown, depth: number): void {
    if (depth > 100) invalid('JSON exceeds the supported nesting depth');
    if (node === null || typeof node === 'string' || typeof node === 'boolean' || typeof node === 'number' && Number.isFinite(node)) return;
    if (!node || typeof node !== 'object') invalid('must contain only finite ordinary JSON data');
    const object = node as object, array = Array.isArray(object);
    if (ancestors.has(object)) invalid('JSON must not contain cycles');
    if (array ? Object.getPrototypeOf(object) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(object))) invalid('must contain only ordinary JSON objects');
    ancestors.add(object);
    const keys = Reflect.ownKeys(object);
    if (array && keys.length !== (object as unknown[]).length + 1) invalid('arrays must be dense JSON arrays');
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
      if (typeof key !== 'string' || forbidden.has(key) || !descriptor.enumerable || !('value' in descriptor)
        || array && !/^(0|[1-9][0-9]*)$/.test(key)) invalid('cannot contain symbols, prototype keys, hidden properties or accessors');
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(object);
  }
  visit(value, 0);
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  json(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('must be an object');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== keys.length || keys.some(key => !Object.hasOwn(raw, key))) invalid(`must contain exactly ${keys.join(', ')}`);
  return raw;
}
function nonempty(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) invalid('identifiers, kind and title must be nonempty strings');
  return value as string;
}
export function validateWorldInputSelection(value: unknown): WorldInputSelection {
  const raw = record(value, ['serviceId', 'referenceId', 'parameters']);
  return { serviceId: nonempty(raw.serviceId), referenceId: nonempty(raw.referenceId), parameters: structuredClone(raw.parameters) as Json };
}
export function validateWorldInputEvidence(value: unknown): WorldInputEvidence {
  const raw = record(value, ['schema', 'id', 'serviceId', 'referenceId', 'kind', 'title', 'payload']);
  if (raw.schema !== 'rp.world-input/0.1') invalid('evidence schema is unsupported');
  return { schema: 'rp.world-input/0.1', id: nonempty(raw.id), serviceId: nonempty(raw.serviceId), referenceId: nonempty(raw.referenceId),
    kind: nonempty(raw.kind), title: nonempty(raw.title), payload: structuredClone(raw.payload) as Json };
}
