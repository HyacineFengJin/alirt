/** Inert, finite state-value constraints. This is a deliberately small data schema,
 * without references, executable predicates, coercion, defaults or transformations. */
export type StateValueSchema =
  | { type: 'number'; min?: number; max?: number; integer?: boolean }
  | { type: 'string'; enum?: string[]; nonBlank?: boolean }
  | { type: 'boolean' }
  | { type: 'list'; items: StateValueSchema }
  | { type: 'object'; properties: Record<string, StateValueSchema>; required?: string[]; additionalProperties?: false };
export interface StateValueIssue { path: string; code: 'schema' | 'json' | 'type' | 'range'; message: string }
export interface StateFieldConstraints {
  type: 'number' | 'string' | 'boolean' | 'list'; min?: number; max?: number;
  nullable?: boolean; valueSchema?: StateValueSchema;
}
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const child = (path: string, key: string | number) => `${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
const problem = (path: string, code: StateValueIssue['code'], message: string): StateValueIssue[] => [{ path, code, message }];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Validates own descriptors before reading their values. Shared by document intake
 * and state writes; array subclasses, sparse arrays and hidden properties are rejected. */
export function validateStateJson(value: unknown): StateValueIssue[] {
  const ancestors = new Set<object>(); let nodes = 0;
  function visit(node: unknown, path: string, depth: number): StateValueIssue[] {
    if (++nodes > 100000 || depth > 100) return problem(path, 'json', 'State JSON exceeds the supported depth or size');
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return [];
    if (typeof node === 'number' && Number.isFinite(node)) return [];
    if (!node || typeof node !== 'object') return problem(path, 'json', 'State values must contain only finite JSON data');
    if (ancestors.has(node)) return problem(path, 'json', 'State JSON must not contain cycles');
    const array = Array.isArray(node), proto = Object.getPrototypeOf(node);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
      return problem(path, 'json', 'State JSON requires plain objects and arrays');
    const keys = Reflect.ownKeys(node);
    if (array && keys.length !== node.length + 1) return problem(path, 'json', 'State arrays must be dense JSON arrays');
    ancestors.add(node);
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(node, key)!;
      if (typeof key !== 'string' || forbidden.has(key) || !descriptor.enumerable || !('value' in descriptor)
        || array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= node.length))
        return problem(path, 'json', 'State JSON cannot contain prototype keys, symbols, accessors or hidden properties');
      const errors = visit(descriptor.value, child(path, key), depth + 1);
      if (errors.length) return errors;
    }
    ancestors.delete(node); return [];
  }
  return visit(value, '', 0);
}

export function validateStateValueSchema(value: unknown): StateValueIssue[] {
  const json = validateStateJson(value);
  if (json.length) return json.map(issue => ({ ...issue, code: 'schema' }));
  let nodes = 0;
  function visit(node: unknown, path: string, depth: number): StateValueIssue[] {
    if (++nodes > 512 || depth > 16) return problem(path, 'schema', 'State value schema exceeds 16 levels or 512 nodes');
    if (!record(node)) return problem(path, 'schema', 'Expected a state value schema object');
    const allowed: Record<string, string[]> = {
      number: ['type', 'min', 'max', 'integer'], string: ['type', 'enum', 'nonBlank'], boolean: ['type'],
      list: ['type', 'items'], object: ['type', 'properties', 'required', 'additionalProperties'],
    };
    const keys = Object.hasOwn(node, 'type') && typeof node.type === 'string' && Object.hasOwn(allowed, node.type) ? allowed[node.type] : undefined;
    if (!keys) return problem(child(path, 'type'), 'schema', 'Unsupported state value schema type');
    for (const key of Object.keys(node)) if (!keys.includes(key)) return problem(child(path, key), 'schema', 'Unknown state value schema property');
    if (node.type === 'number') {
      for (const key of ['min', 'max']) if (Object.hasOwn(node, key) && (typeof node[key] !== 'number' || !Number.isFinite(node[key])))
        return problem(child(path, key), 'schema', 'Schema bounds must be finite numbers');
      if (typeof node.min === 'number' && typeof node.max === 'number' && node.min > node.max) return problem(path, 'schema', 'Schema minimum exceeds maximum');
      if (Object.hasOwn(node, 'integer') && typeof node.integer !== 'boolean') return problem(child(path, 'integer'), 'schema', 'Expected boolean integer constraint');
    } else if (node.type === 'string') {
      if (Object.hasOwn(node, 'nonBlank') && typeof node.nonBlank !== 'boolean')
        return problem(child(path, 'nonBlank'), 'schema', 'Expected boolean nonBlank constraint');
      if (Object.hasOwn(node, 'enum') && (!Array.isArray(node.enum) || !node.enum.length || node.enum.length > 256
        || node.enum.some(item => typeof item !== 'string') || new Set(node.enum).size !== node.enum.length)
      ) return problem(child(path, 'enum'), 'schema', 'String enum requires 1–256 unique string values');
    } else if (node.type === 'list') return visit(node.items, child(path, 'items'), depth + 1);
    else if (node.type === 'object') {
      if (!record(node.properties) || Object.keys(node.properties).length > 256)
        return problem(child(path, 'properties'), 'schema', 'Object schema requires at most 256 declared properties');
      if (Object.hasOwn(node, 'additionalProperties') && node.additionalProperties !== false)
        return problem(child(path, 'additionalProperties'), 'schema', 'Object schemas always reject additional properties');
      if (Object.hasOwn(node, 'required') && (!Array.isArray(node.required) || node.required.some(key => typeof key !== 'string'
        || !Object.hasOwn(node.properties as object, key)) || new Set(node.required).size !== node.required.length))
        return problem(child(path, 'required'), 'schema', 'Required keys must uniquely identify declared properties');
      for (const [key, schema] of Object.entries(node.properties)) {
        if (!key || key.length > 256) return problem(child(path, 'properties'), 'schema', 'Schema property names require 1–256 characters');
        const errors = visit(schema, child(child(path, 'properties'), key), depth + 1); if (errors.length) return errors;
      }
    }
    return [];
  }
  return visit(value, '', 0);
}

/** Validate relevant metadata even when the initial held value is deliberately null. */
export function validateStateFieldDefinition(field: unknown): StateValueIssue[] {
  const json = validateStateJson(field); if (json.length) return json.map(issue => ({ ...issue, code: 'schema' }));
  if (!record(field)) return problem('', 'schema', 'Expected state field metadata');
  if (!Object.hasOwn(field, 'type') || !['number', 'string', 'boolean', 'list'].includes(field.type as string)) return problem('/type', 'schema', 'Unsupported state field type');
  if (Object.hasOwn(field, 'nullable') && typeof field.nullable !== 'boolean') return problem('/nullable', 'schema', 'Expected boolean nullable declaration');
  for (const key of ['min', 'max']) if (Object.hasOwn(field, key) && (field.type !== 'number' || typeof field[key] !== 'number' || !Number.isFinite(field[key])))
    return problem(child('', key), 'schema', 'Numeric bounds require a number field and finite numbers');
  if (typeof field.min === 'number' && typeof field.max === 'number' && field.min > field.max) return problem('', 'schema', 'Minimum exceeds maximum');
  if (Object.hasOwn(field, 'valueSchema')) {
    const errors = validateStateValueSchema(field.valueSchema).map(issue => ({ ...issue, path: `/valueSchema${issue.path}` }));
    if (errors.length) return errors;
    if ((field.valueSchema as StateValueSchema).type !== field.type) return problem('/valueSchema/type', 'schema', 'Value schema root type must match its state field');
  }
  return [];
}

export function validateStateFieldValue(field: unknown, value: unknown, options: { initial?: boolean } = {}): StateValueIssue[] {
  const metadata = validateStateFieldDefinition(field); if (metadata.length) return metadata;
  const json = validateStateJson(value); if (json.length) return json;
  const declared = field as StateFieldConstraints;
  if (value === null) return options.initial || declared.nullable === true ? [] : problem('', 'type', 'State null writes require nullable: true');
  if (declared.type === 'list' ? !Array.isArray(value) : typeof value !== declared.type) return problem('', 'type', 'State value has the wrong type');
  if (typeof value === 'number' && (declared.min !== undefined && value < declared.min || declared.max !== undefined && value > declared.max))
    return problem('', 'range', 'State value is outside its declared range');
  function visit(schema: StateValueSchema, node: unknown, path: string): StateValueIssue[] {
    if (schema.type === 'list') {
      if (!Array.isArray(node)) return problem(path, 'type', 'Expected a list');
      for (let i = 0; i < node.length; i++) { const errors = visit(schema.items, node[i], child(path, i)); if (errors.length) return errors; }
    } else if (schema.type === 'object') {
      if (!record(node)) return problem(path, 'type', 'Expected an object');
      for (const key of schema.required ?? []) if (!Object.hasOwn(node, key)) return problem(child(path, key), 'type', 'Required state property is missing');
      for (const [key, entry] of Object.entries(node)) {
        if (!Object.hasOwn(schema.properties, key)) return problem(child(path, key), 'type', 'Unexpected state property');
        const errors = visit(schema.properties[key], entry, child(path, key)); if (errors.length) return errors;
      }
    } else if (typeof node !== schema.type) return problem(path, 'type', `Expected ${schema.type}`);
    else if (schema.type === 'number') {
      if (schema.integer && !Number.isInteger(node)) return problem(path, 'type', 'Expected an integer');
      if (schema.min !== undefined && (node as number) < schema.min || schema.max !== undefined && (node as number) > schema.max)
        return problem(path, 'range', 'State number is outside its schema bounds');
    } else if (schema.type === 'string') {
      if (schema.nonBlank && !(node as string).trim()) return problem(path, 'type', 'State string must contain non-whitespace text');
      if (schema.enum && !schema.enum.includes(node as string)) return problem(path, 'type', 'State string is outside its declared enum');
    }
    return [];
  }
  return declared.valueSchema ? visit(declared.valueSchema, value, '') : [];
}
