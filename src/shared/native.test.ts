import { describe, expect, it } from 'vitest';
import type { CharacterCard, OutputContract, PromptModule } from './types';
import { createNativeTemplate, evaluateNativeActivation, evaluateNativeCondition, expandNativeMacros, materializeNativeDocument, nativeModuleActive, validateNativeDocument } from './native';
const card = () => createNativeTemplate('card') as CharacterCard;
const module = (overrides: Partial<PromptModule> = {}): PromptModule => ({ id: 'original', title: 'Original', category: 'supplement', content: 'Original {{user}} wording.', enabled: true, targets: ['world'], phase: 'coordinate', priority: 0, ...overrides });
const output = (overrides: Partial<OutputContract> = {}): OutputContract => ({ id: 'brief', title: 'Scene brief', type: 'text', instruction: 'Summarize the visible scene in one sentence.', enabled: true, required: false, priority: 10, audience: 'public', display: { placement: 'after-prose' }, ...overrides });

describe('native documents and portable module semantics', () => {
  it('creates valid neutral templates without supplying creative prose or persona', () => {
    for (const kind of ['card', 'preset'] as const) expect(validateNativeDocument(kind, createNativeTemplate(kind))).toEqual([]);
    const result = card(); expect(result.opening).toBe(''); expect(result.roles[0].persona).toBe(''); expect(result.roles[0].goals).toEqual([]);
  });
  it('diagnoses required schemas and fields without coercion or mutation', () => {
    const value = { schema: 'wrong', id: 5, title: '', description: '', modules: [] }, original = JSON.stringify(value);
    const paths = validateNativeDocument('card', value).map(issue => issue.path);
    expect(paths).toEqual(expect.arrayContaining(['/schema', '/id', '/title', '/roles', '/world', '/playerRoleId', '/fields', '/panels', '/opening']));
    expect(JSON.stringify(value)).toBe(original);
    expect(validateNativeDocument('preset', { ...value, schema: 'rp.preset/0.1', id: 'safe', title: 'safe' }).some(issue => issue.path === '/narration')).toBe(true);
  });
  it('checks unique IDs, player, peers, knowledge audiences, conditions and all role-state fields', () => {
    const value = card();
    value.roles[0].peers = ['missing']; value.roles[0].state = { untyped: 1 };
    value.roles[0].knowledge = [{ id: 'k', text: 'Known text', status: 'known', audience: ['missing'] }];
    value.roles.push(structuredClone(value.roles[0])); value.playerRoleId = 'missing';
    value.fields = [{ key: 'energy', label: 'Energy', type: 'number', min: 10, max: 0, audience: 'public', editable: true }]; value.fields.push({ ...value.fields[0] });
    value.modules = [module({ targets: ['invalid'] as any, condition: { path: 'role.id', equals: 'missing' } }), module()];
    value.panels = [{ id: 'p', title: '', kind: 'invalid' as any, side: 'left' }, { id: 'p', title: '', kind: 'state', side: 'right' }];
    const paths = validateNativeDocument('card', value).map(issue => issue.path);
    expect(paths).toEqual(expect.arrayContaining(['/roles/1/id', '/playerRoleId', '/roles/0/peers/0', '/roles/0/knowledge/0/audience/0', '/roles/0/state/untyped', '/fields/0', '/fields/1/key', '/modules/0/targets/0', '/modules/0/condition/equals', '/modules/1/id', '/panels/0/kind', '/panels/1/id']));
  });
  it('validates preset target kinds, activation and nested conditions', () => {
    const value = createNativeTemplate('preset');
    value.modules = [module({ targets: ['host'] as any, activation: { keys: [5] as any, selective: 'true' as any }, condition: { all: [{ path: 'world.flag', equals: true }], any: [] } as any })];
    const paths = validateNativeDocument('preset', value).map(issue => issue.path);
    expect(paths).toEqual(expect.arrayContaining(['/modules/0/targets/0', '/modules/0/activation/keys/0', '/modules/0/activation/selective', '/modules/0/condition']));
  });
  it('checks state types/ranges while retaining untyped world metadata and intentional nulls', () => {
    const value = card();
    value.fields = [{ key: 'energy', label: 'Energy', type: 'number', min: 0, max: 10, audience: 'public', editable: true }];
    value.world.variables = { sourceImportId: 'source', custom: { original: ['metadata'] }, energy: null }; value.roles[0].state = { energy: null };
    expect(validateNativeDocument('card', value)).toEqual([]);
    value.roles[0].state.energy = 11; value.world.variables.energy = 'wrong';
    expect(validateNativeDocument('card', value).map(issue => issue.path)).toEqual(expect.arrayContaining(['/roles/0/state/energy', '/world/variables/energy']));
    value.fields[0].max = Infinity;
    expect(validateNativeDocument('card', value).some(issue => issue.path === '/fields/0/max')).toBe(true);
  });
  it('checks unique-item rule IDs, list references and initial unique-item ownership', () => {
    const value = card(); value.fields = [{ key: 'items', label: 'Items', type: 'list', audience: 'public', editable: true }];
    value.roles[0].state.items = ['letter', 'letter']; value.stateRules = [{ id: 'one', type: 'unique-item', field: 'items', item: 'letter' }];
    expect(validateNativeDocument('card', value).some(issue => issue.path === '/stateRules/0')).toBe(true);
    if (value.stateRules[0].type !== 'unique-item') throw new Error('Expected unique-item fixture');
    value.stateRules[0].field = 'missing';
    expect(validateNativeDocument('card', value).some(issue => issue.path === '/stateRules/0/field')).toBe(true);
  });
  it('rejects prototype traversal, polluted keys and getters without evaluating them', () => {
    const value = JSON.parse(JSON.stringify(card())); value.extra = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(validateNativeDocument('card', value).some(issue => issue.path === '/extra/__proto__')).toBe(true);
    expect(({} as any).polluted).toBeUndefined();
    const sparse = card(); sparse.modules = Array(1); expect(validateNativeDocument('card', sparse).some(issue => issue.path === '/modules/0')).toBe(true);
    const other = card(); other.modules = [module({ condition: { path: 'world.constructor.prototype.polluted', equals: true } })];
    expect(validateNativeDocument('card', other).some(issue => issue.path === '/modules/0/condition/path')).toBe(true);
    let invoked = false; Object.defineProperty(other, 'getter', { enumerable: true, get() { invoked = true; throw new Error('must not run'); } });
    expect(validateNativeDocument('card', other).some(issue => issue.path === '/getter')).toBe(true); expect(invoked).toBe(false);
  });
  it('materializes without active import bindings and preserves unknown/source metadata and original texts', () => {
    const value = card() as CharacterCard & { sourceCompatibility?: unknown; extension?: unknown };
    value.compatibility = { importId: 'source-id', status: 'source', warnings: ['Original warning'] }; value.sourceCompatibility = { existing: true }; value.extension = { original: [false, 2, 'wording'] };
    value.modules = [module({ activation: { keys: ['River'], secondaryKeys: ['Night'], selective: true }, condition: { path: 'role.id', equals: 'player' }, sourcePointer: '/data/original/content' })];
    const before = JSON.stringify(value), fork = materializeNativeDocument(value) as typeof value & { sourceCompatibility_1?: unknown };
    expect(fork.compatibility).toBeUndefined(); expect(fork.sourceCompatibility).toEqual({ existing: true }); expect(fork.sourceCompatibility_1).toEqual(value.compatibility);
    expect(fork.modules).toEqual(value.modules); expect(fork.extension).toEqual(value.extension); expect(JSON.stringify(value)).toBe(before);
    fork.modules[0].content = 'Edited whole wording.'; expect(value.modules[0].content).toBe('Original {{user}} wording.');
    expect(validateNativeDocument('card', fork)).toEqual([]);
  });
  it('combines portable keyword activation, secondary selection, role ownership and ordinary conditions', () => {
    const value = module({ activation: { keys: ['River'], secondaryKeys: ['Night'], selective: true }, condition: { all: [{ path: 'role.id', equals: 'player' }, { path: 'world.variables.ready', equals: true }] } });
    const context = { text: 'RIVER at night', roleId: 'player', snapshot: { world: { variables: { ready: true } } } };
    expect(nativeModuleActive(value, context)).toBe(true);
    expect(nativeModuleActive(value, { ...context, text: 'River at noon' })).toBe(false);
    expect(nativeModuleActive(value, { ...context, roleId: 'other' })).toBe(false);
    expect(nativeModuleActive(value, { ...context, snapshot: {} })).toBe(false);
    expect(nativeModuleActive({ ...value, enabled: false }, context)).toBe(false);
    expect(nativeModuleActive(module({ condition: { path: 'role.id', equals: 'player' } }), { snapshot: { role: { id: 'player' } } })).toBe(true);
  });
  it('diagnoses divergent linked persona copies without rewriting or deduplicating unrelated modules', () => {
    const value = card(); value.roles[0].persona = 'Original persona.'; value.roles[0].personaSourcePointer = '/source/persona';
    value.modules = [module({ content: 'Original persona.', sourcePointer: '/source/persona' }), module({ id: 'unrelated', content: 'Original persona.', sourcePointer: '/source/unrelated' })];
    expect(validateNativeDocument('card', value)).toEqual([]);
    value.modules[0].content = 'Edited persona.';
    const before = JSON.stringify(value), issues = validateNativeDocument('card', value);
    expect(issues).toHaveLength(1); expect(issues[0].path).toBe('/modules/0/content'); expect(issues[0].message).toContain('edit both linked copies atomically'); expect(JSON.stringify(value)).toBe(before);
    value.roles[0].persona = 'Edited persona.';
    expect(validateNativeDocument('card', value)).toEqual([]); expect(value.modules[1].content).toBe('Original persona.');
    value.modules[0].content = 'Intentionally separate instructions.'; delete value.roles[0].personaSourcePointer;
    expect(validateNativeDocument('card', value)).toEqual([]);
  });
  it('expands only bound user/char macros in edited standalone original wording', () => {
    expect(expandNativeMacros('Original {{USER}} / {{char}} / {{getvar::x}} / {{other}}.', { user: '你', char: '角色' })).toBe('Original 你 / 角色 / {{getvar::x}} / {{other}}.');
    expect(expandNativeMacros('{{user}} {{char}}', {})).toBe('{{user}} {{char}}');
  });
  it('preserves additive runtime fields and unknown extension metadata without changing 0.1 schemas', () => {
    const value = card();
    value.modules = [module({ audience: ['player'], inject: { slot: 'after-context', order: -5 }, dependsOn: ['preset:rules'], exclusiveGroup: 'weather', required: true,
      activation: { keys: ['Fog'], match: 'word', caseSensitive: true }, condition: { not: { path: 'world.variables.fog', op: 'exists' } } })];
    (value.modules[0] as PromptModule & { extension: unknown }).extension = { authorOriginal: ['untouched'] };
    const before = JSON.stringify(value);
    expect(validateNativeDocument('card', value)).toEqual([]);
    expect(JSON.stringify(value)).toBe(before);
    expect(materializeNativeDocument(value)).toEqual(value);
  });
  it('diagnoses invalid runtime fields and comparison shapes at their own JSON pointers', () => {
    const value = card();
    value.modules = [module({ audience: ['missing'], inject: { slot: 'depth' as any, order: 'first' as any }, dependsOn: ['original', 'preset:', 'original'], exclusiveGroup: '', required: 'yes' as any,
      activation: { keys: [], match: 'regex' as any, caseSensitive: 'true' as any }, condition: { all: [{ path: 'world.variables.x', op: 'in', value: 5 }, { path: 'world.variables.x', op: 'gt', value: '5' }, { path: 'world.variables.x', op: 'exists', value: 5 } as any, { path: 'world.variables.x', equals: 5, op: 'eq', value: 5 } as any] } })];
    expect(validateNativeDocument('card', value).map(issue => issue.path)).toEqual(expect.arrayContaining([
      '/modules/0/audience/0', '/modules/0/inject/slot', '/modules/0/inject/order', '/modules/0/dependsOn/0', '/modules/0/dependsOn/1', '/modules/0/dependsOn/2', '/modules/0/exclusiveGroup', '/modules/0/required', '/modules/0/activation/match', '/modules/0/activation/caseSensitive',
      '/modules/0/condition/all/0/value', '/modules/0/condition/all/1/value', '/modules/0/condition/all/2/value', '/modules/0/condition/all/3',
    ]));
  });
  it('preserves output contracts, lifetime settings and extension fields in both document kinds', () => {
    for (const kind of ['card', 'preset'] as const) {
      const value = createNativeTemplate(kind);
      value.modules = [module({ lifetime: { once: true, stickyTurns: 1, cooldownTurns: 0, delayTurns: 0, probability: 0, recursive: false } })];
      value.outputs = [output({ module: 'original' }), output({ id: 'notes', type: 'list', audience: ['player'], display: { placement: 'side-panel' }, module: 'preset:rules', condition: { path: 'role.id', equals: 'player' } }), output({ id: 'meta', type: 'object', enabled: false, display: { placement: 'hidden' }, module: 'card:context' })];
      (value.outputs[0] as OutputContract & { extension: unknown }).extension = { untouched: [1, 'wording'] };
      if (kind === 'card') (value as CharacterCard).panels = [{ id: 'briefs', title: 'Briefs', kind: 'outputs', side: 'right' }];
      const before = structuredClone(value);
      expect(validateNativeDocument(kind, value)).toEqual([]);
      expect(value).toEqual(before);
      expect(materializeNativeDocument(value)).toEqual(before);
      value.modules[0].lifetime!.probability = 1;
      expect(validateNativeDocument(kind, value)).toEqual([]);
    }
  });
  it('rejects invalid module lifetime values even on disabled modules', () => {
    const cases: [string, unknown][] = [
      ['once', 1], ['recursive', 'yes'], ['stickyTurns', 0], ['stickyTurns', 1.5],
      ['cooldownTurns', -1], ['cooldownTurns', 0.5], ['delayTurns', -1], ['delayTurns', '1'],
      ['stickyTurns', Number.MAX_SAFE_INTEGER + 1], ['cooldownTurns', Number.MAX_SAFE_INTEGER + 1], ['delayTurns', Number.MAX_SAFE_INTEGER + 1],
      ['probability', -0.01], ['probability', 1.01], ['probability', NaN], ['probability', Infinity],
    ];
    for (const [key, invalid] of cases) {
      const value = card(); value.modules = [module({ enabled: false, lifetime: { [key]: invalid } as any })];
      expect(validateNativeDocument('card', value).map(issue => issue.path), `${key}: ${String(invalid)}`).toContain(`/modules/0/lifetime/${key}`);
    }
    const value = card(); value.modules = [module({ lifetime: [] as any })];
    expect(validateNativeDocument('card', value).map(issue => issue.path)).toContain('/modules/0/lifetime');
  });
  it('validates disabled output shape, uniqueness, conditions and card audience references', () => {
    const value = card();
    value.outputs = [output({ enabled: false, title: 5 as any, instruction: ' ', type: 'json' as any, required: 'yes' as any, priority: 'high' as any, audience: ['missing', 'missing'], display: { placement: 'floating' as any }, module: '', condition: { path: 'role.id', equals: 'missing' } }), output({ id: 'brief', enabled: 'yes' as any })];
    const paths = validateNativeDocument('card', value).map(issue => issue.path);
    expect(paths).toEqual(expect.arrayContaining([
      '/outputs/0/title', '/outputs/0/instruction', '/outputs/0/type', '/outputs/0/required', '/outputs/0/priority', '/outputs/0/audience/0', '/outputs/0/audience/1',
      '/outputs/0/display/placement', '/outputs/0/module', '/outputs/0/condition/equals', '/outputs/1/id', '/outputs/1/enabled',
    ]));
    for (const invalid of [null, [], 'text']) {
      value.outputs = [invalid as any];
      expect(validateNativeDocument('card', value).map(issue => issue.path)).toContain('/outputs/0');
    }
    for (const moduleRef of [' ', 'card:', 'preset:  ', 1]) {
      value.outputs = [output({ module: moduleRef as any })];
      expect(validateNativeDocument('card', value).map(issue => issue.path)).toContain('/outputs/0/module');
    }
    value.outputs = [output({ display: undefined as any })];
    expect(validateNativeDocument('card', value).map(issue => issue.path)).toContain('/outputs/0/display');
  });
  it('defers preset output role references and module gate resolution to the bound runtime', () => {
    const value = createNativeTemplate('preset');
    value.outputs = [output({ audience: ['future-role'], condition: { path: 'role.id', equals: 'future-role' }, module: 'card:future-module' })];
    expect(validateNativeDocument('preset', value)).toEqual([]);
    value.outputs = [output({ audience: ['future-role', 'future-role'] })];
    expect(validateNativeDocument('preset', value).map(issue => issue.path)).toContain('/outputs/0/audience/1');
  });
  it('requires approved-message selectors, object type and messages rendering together even when disabled', () => {
    for (const kind of ['card', 'preset'] as const) {
      const value = createNativeTemplate(kind);
      const valid = output({ enabled: false, type: 'object', valueFrom: { kind: 'approved-messages' }, display: { placement: 'after-prose', renderer: 'messages' } });
      value.outputs = [valid];
      expect(validateNativeDocument(kind, value)).toEqual([]);
      expect(materializeNativeDocument(value).outputs).toEqual([valid]);
      for (const invalid of [
        { ...valid, type: 'text' },
        { ...valid, display: { placement: 'after-prose', renderer: 'plain' } },
        { ...valid, valueFrom: undefined },
        { ...valid, valueFrom: { kind: 'world-time' } },
        { ...valid, valueFrom: { kind: 'approved-messages', roleId: 'player' } },
      ]) {
        value.outputs = [invalid as OutputContract];
        expect(validateNativeDocument(kind, value).some(issue => issue.path.startsWith('/outputs/0'))).toBe(true);
      }
    }
  });
  it('evaluates missing or undisclosed comparisons as unknown, including negation', () => {
    const context = { snapshot: { world: { variables: { fog: null, count: 0 } } } };
    const missing = { path: 'world.variables.secret', equals: true } as const;
    expect(evaluateNativeCondition(missing, context).status).toBe('unknown');
    expect(evaluateNativeCondition({ not: missing }, context).status).toBe('unknown');
    expect(evaluateNativeCondition({ path: missing.path, op: 'exists' }, context).status).toBe('false');
    expect(evaluateNativeCondition({ not: { path: missing.path, op: 'exists' } }, context).status).toBe('true');
    expect(evaluateNativeCondition({ path: 'world.variables.fog', equals: null }, context).status).toBe('true');
    expect(evaluateNativeCondition({ path: 'world.variables.fog', op: 'exists' }, context).status).toBe('true');
    expect(evaluateNativeCondition({ all: [missing, { path: 'world.variables.count', equals: 1 }] }, context).status).toBe('false');
    expect(evaluateNativeCondition({ any: [missing, { path: 'world.variables.count', equals: 0 }] }, context).status).toBe('true');
    expect(evaluateNativeCondition({ all: [] }, context).status).toBe('true');
    expect(evaluateNativeCondition({ any: [] }, context).status).toBe('false');
    expect(nativeModuleActive(module({ condition: { not: missing } }), context)).toBe(false);
  });
  it('uses structural equality, strict numeric comparisons and explicit array/string membership', () => {
    const context = { snapshot: { value: { nested: [1, null] }, items: [{ x: 1 }, 'bell'], phrase: 'harbor fog', count: 4, textCount: '4' }, roleId: 'player' };
    expect(evaluateNativeCondition({ path: 'value', op: 'eq', value: { nested: [1, null] } }, context).status).toBe('true');
    expect(evaluateNativeCondition({ path: 'count', op: 'neq', value: '4' }, context).status).toBe('true');
    expect(evaluateNativeCondition({ path: 'count', op: 'in', value: [3, 4] }, context).status).toBe('true');
    expect(evaluateNativeCondition({ path: 'items', op: 'contains', value: { x: 1 } }, context).status).toBe('true');
    expect(evaluateNativeCondition({ path: 'phrase', op: 'contains', value: 'fog' }, context).status).toBe('true');
    for (const op of ['gte', 'lte'] as const) expect(evaluateNativeCondition({ path: 'count', op, value: 4 }, context).status).toBe('true');
    expect(evaluateNativeCondition({ path: 'count', op: 'gt', value: 3 }, context).status).toBe('true');
    expect(evaluateNativeCondition({ path: 'count', op: 'lt', value: 5 }, context).status).toBe('true');
    expect(evaluateNativeCondition({ path: 'textCount', op: 'gte', value: 4 }, context).status).toBe('unknown');
    expect(evaluateNativeCondition({ path: 'role.id', equals: 'player' }, context).status).toBe('true');
  });
  it('does not traverse condition accessors, inherited values or reserved prototype keys', () => {
    let called = false;
    const snapshot = Object.create({ inherited: true });
    Object.defineProperty(snapshot, 'secret', { get() { called = true; return true; } });
    for (const path of ['secret', 'inherited', 'constructor', '__proto__.polluted']) expect(evaluateNativeCondition({ path, equals: true }, { snapshot }).status).toBe('unknown');
    expect(called).toBe(false);
  });
  it('reports deterministic keyword semantics for empty, selective, case and word matching', () => {
    expect(evaluateNativeActivation(undefined, '').status).toBe('true');
    expect(evaluateNativeActivation({ keys: [] }, 'fog').status).toBe('false');
    expect(evaluateNativeActivation({ keys: [''] }, 'fog').status).toBe('false');
    expect(evaluateNativeActivation({ keys: ['Fog'] }, 'fog').status).toBe('true');
    expect(evaluateNativeActivation({ keys: ['Fog'], caseSensitive: true }, 'fog').status).toBe('false');
    expect(evaluateNativeActivation({ keys: ['fog'], selective: true, secondaryKeys: [] }, 'fog').status).toBe('true');
    expect(evaluateNativeActivation({ keys: ['fog'], selective: true, secondaryKeys: ['night'] }, 'fog at noon').status).toBe('false');
    expect(evaluateNativeActivation({ keys: ['fog'], match: 'word' }, 'foggy').status).toBe('false');
    expect(evaluateNativeActivation({ keys: ['fog'], match: 'word' }, 'a fog.').status).toBe('true');
    expect(evaluateNativeActivation({ keys: ['雾'], match: 'word' }, '浓雾').status).toBe('false');
    expect(evaluateNativeActivation({ keys: ['雾'], match: 'word' }, '雾，').status).toBe('true');
  });
});

it('validates optional trusted panel renderer IDs as identifiers without requiring installation', () => {
  const value = card();
  value.panels = [{ id: 'book', title: 'Book', kind: 'state', side: 'right', pluginId: 'notebook.status-book' }];
  expect(validateNativeDocument('card', value)).toEqual([]);
  value.panels[0].pluginId = 'uninstalled.renderer';
  expect(validateNativeDocument('card', value)).toEqual([]);
  value.panels[0].pluginId = '../source.js';
  expect(validateNativeDocument('card', value).some(issue => issue.path === '/panels/0/pluginId')).toBe(true);
  value.panels[0].pluginId = '';
  expect(validateNativeDocument('card', value).some(issue => issue.path === '/panels/0/pluginId')).toBe(true);
});
