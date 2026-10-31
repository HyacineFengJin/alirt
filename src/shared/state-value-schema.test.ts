import { describe, expect, it } from 'vitest';
import {
  validateStateFieldDefinition, validateStateFieldValue, validateStateJson, validateStateValueSchema,
  type StateFieldConstraints, type StateValueSchema,
} from './state-value-schema';

const schema: StateValueSchema = { type: 'list', items: { type: 'object', additionalProperties: false,
  required: ['name', 'effect', 'value', 'ap'], properties: {
    name: { type: 'string' }, effect: { type: 'string', enum: ['score_gain', 'boost_self'] },
    value: { type: 'number', min: 0, max: 5 }, ap: { type: 'number', min: 0, max: 6, integer: true },
  } } };
const field: StateFieldConstraints = { type: 'list', valueSchema: schema };
const entry = () => ({ name: 'Pulse', effect: 'score_gain', value: 1, ap: 1 });

describe('finite inert state-value schemas', () => {
  it('validates nested skill records with strict properties, enums, bounds and no coercion', () => {
    expect(validateStateValueSchema(schema)).toEqual([]);
    expect(validateStateFieldValue(field, [entry(), { ...entry(), ap: 0, value: 5 }])).toEqual([]);
    const cases: [unknown, string, string][] = [
      [{}, '', 'type'], [[{ name: 'Pulse' }], '/0/effect', 'type'],
      [[{ ...entry(), reward: 100 }], '/0/reward', 'type'], [[{ ...entry(), effect: 'unknown' }], '/0/effect', 'type'],
      [[{ ...entry(), value: '1' }], '/0/value', 'type'], [[{ ...entry(), ap: 0.5 }], '/0/ap', 'type'],
      [[{ ...entry(), value: 5.1 }], '/0/value', 'range'], [[{ ...entry(), ap: -1 }], '/0/ap', 'range'],
      [[{ ...entry(), value: NaN }], '/0/value', 'json'], [[{ ...entry(), ap: Infinity }], '/0/ap', 'json'],
      [[{ ...entry(), effect: null }], '/0/effect', 'type'],
    ];
    for (const [value, path, code] of cases) expect(validateStateFieldValue(field, value)[0]).toMatchObject({ path, code });
  });

  it('permits intentional initial null without permitting later undeclared null writes', () => {
    for (const type of ['number', 'string', 'boolean', 'list'] as const) {
      expect(validateStateFieldValue({ type }, null, { initial: true })).toEqual([]);
      expect(validateStateFieldValue({ type }, null)[0].code).toBe('type');
      expect(validateStateFieldValue({ type, nullable: true }, null)).toEqual([]);
      expect(validateStateFieldValue({ type, nullable: false }, null)[0].code).toBe('type');
    }
    expect(validateStateFieldValue({ type: 'list', valueSchema: { type: 'list' } }, null, { initial: true })[0].code).toBe('schema');
    expect(validateStateFieldValue({ type: 'number', nullable: 'yes' }, null, { initial: true })[0].path).toBe('/nullable');
  });

  it('enforces explicit nonblank strings without trimming or coercing state values', () => {
    const field = { type: 'string', valueSchema: { type: 'string', nonBlank: true } };
    expect(validateStateFieldValue(field, '')[0]).toMatchObject({ code: 'type' });
    expect(validateStateFieldValue(field, ' \t\n ')[0]).toMatchObject({ code: 'type' });
    const text = '  actual skill name  ';
    expect(validateStateFieldValue(field, text)).toEqual([]); expect(text).toBe('  actual skill name  ');
    expect(validateStateFieldValue({ type: 'string', valueSchema: { type: 'string', nonBlank: false } }, '')).toEqual([]);
    expect(validateStateValueSchema({ type: 'string', nonBlank: 'true' })[0].path).toBe('/nonBlank');
    expect(validateStateValueSchema({ type: 'number', nonBlank: true })[0].code).toBe('schema');
    expect(validateStateFieldValue({ type: 'list', valueSchema: { type: 'list', items: { type: 'object', properties: {
      name: { type: 'string', nonBlank: true },
    }, required: ['name'] } } }, [{ name: ' ' }])[0]).toMatchObject({ path: '/0/name', code: 'type' });
  });

  it('rejects malformed schema metadata, references, executables and incompatible roots', () => {
    for (const invalid of [
      null, [], { type: 'constructor' }, { type: 'null' }, { type: 'number', min: 2, max: 1 },
      { type: 'number', min: '0' }, { type: 'number', max: Infinity }, { type: 'number', integer: 1 },
      { type: 'string', enum: [] }, { type: 'string', enum: ['a', 'a'] }, { type: 'string', enum: [1] },
      { type: 'list' }, { type: 'list', items: { $ref: 'anything' } }, { type: 'boolean', predicate: () => true },
      { type: 'object', properties: {} as const, required: ['unknown'] },
      { type: 'object', properties: { name: { type: 'string' } }, required: ['name', 'name'] },
      { type: 'object', properties: {}, additionalProperties: true },
    ]) expect(validateStateValueSchema(invalid).length).toBeGreaterThan(0);
    expect(validateStateFieldDefinition({ type: 'list', valueSchema: { type: 'string' } })[0].path).toBe('/valueSchema/type');
    expect(validateStateFieldDefinition({ type: 'string', min: 0 })[0].path).toBe('/min');
    expect(validateStateFieldDefinition({ type: 'number', min: 2, max: 1 })[0].code).toBe('schema');
    expect(validateStateFieldValue({ type: 'number', min: 0, max: 5, valueSchema: { type: 'number', min: 1, max: 4 } }, 4.5)[0].code).toBe('range');
  });

  it('rejects accessors, custom prototypes, cycles, sparse arrays, hidden and symbol data without reading getters', () => {
    let reads = 0;
    const getter = Object.defineProperty({}, 'name', { enumerable: true, get: () => { reads++; return 'Pulse'; } });
    const hidden = Object.defineProperty({}, 'name', { value: 'Pulse' });
    const symbol = { [Symbol('hidden')]: true }, cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    class ForeignArray extends Array {}
    for (const value of [getter, hidden, symbol, cyclic, Object.create({ inherited: true }), new ForeignArray(1), [1, , 3], new Date(), undefined, 1n,
      JSON.parse('{"__proto__":{"polluted":true}}')]) expect(validateStateJson(value).length).toBeGreaterThan(0);
    expect(validateStateValueSchema(Object.defineProperty({}, 'type', { enumerable: true, get: () => { reads++; return 'number'; } })).length).toBeGreaterThan(0);
    expect(validateStateFieldValue(Object.defineProperty({}, 'type', { enumerable: true, get: () => { reads++; return 'number'; } }), 1).length).toBeGreaterThan(0);
    expect(reads).toBe(0);
    const plain = Object.assign(Object.create(null), { name: 'Pulse' }); expect(validateStateJson(plain)).toEqual([]);
  });

  it('bounds recursion, node counts and enum breadth while permitting finite optional objects', () => {
    let deep: unknown = { type: 'boolean' };
    for (let i = 0; i < 18; i++) deep = { type: 'list', items: deep };
    expect(validateStateValueSchema(deep)[0].code).toBe('schema');
    let value: unknown = true; for (let i = 0; i < 102; i++) value = [value];
    expect(validateStateJson(value)[0].code).toBe('json');
    expect(validateStateJson(Array.from({ length: 100001 }, () => 1))[0].code).toBe('json');
    expect(validateStateValueSchema({ type: 'string', enum: Array.from({ length: 257 }, (_, i) => String(i)) })[0].code).toBe('schema');
    const optional: StateValueSchema = { type: 'list', items: { type: 'object', properties: { 'label/a': { type: 'boolean' } } } };
    expect(validateStateFieldValue({ type: 'list', valueSchema: optional }, [{}])).toEqual([]);
    expect(validateStateFieldValue({ type: 'list', valueSchema: optional }, [{ 'label/a': 'wrong' }])[0].path).toBe('/0/label~1a');
  });
});
