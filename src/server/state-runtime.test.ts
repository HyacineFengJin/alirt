import { describe, expect, it } from 'vitest';
import type { Json, RoleDefinition } from '../shared/types';
import type { StateRule, StateSnapshot } from '../shared/state-rules';
import { applyStateTransaction, assertStateJson, StateTransactionError } from './state-runtime';

function fixture(): StateSnapshot {
  const role = (id: string, items: Json[]): RoleDefinition => ({ id, name: id, persona: '', goals: [], peers: [], phase: 'active', presence: 'present', state: { health: 5, items, flag: false, score: 0, author: '' }, knowledge: [] });
  return {
    revision: 7, world: { location: 'room', time: 'day', variables: { health: 5 } },
    roles: [role('player', ['key']), role('other', [])],
    fields: [
      { key: 'health', label: 'Health', type: 'number', min: 0, max: 10, audience: 'public', editable: true },
      { key: 'items', label: 'Items', type: 'list', audience: 'public', editable: true },
      { key: 'flag', label: 'Flag', type: 'boolean', audience: 'author', editable: true, writableBy: 'derived' },
      { key: 'score', label: 'Score', type: 'number', min: 0, max: 10, audience: ['player'], editable: false, writableBy: 'derived' },
      { key: 'author', label: 'Author', type: 'string', audience: 'author', editable: true, writableBy: 'author' },
    ],
  };
}
const unique: StateRule = { id: 'one-key', type: 'unique-item', field: 'items', item: 'key' };
function code(action: () => unknown, expected: string) {
  expect(action).toThrow(StateTransactionError);
  try { action(); } catch (error) { expect((error as StateTransactionError).code).toBe(expected); }
}

describe('atomic native state transactions', () => {
  it('transfers a unique item in a multi-write final snapshot and retains the input', () => {
    const before = fixture(), original = structuredClone(before);
    const result = applyStateTransaction(before, [
      { roleId: 'other', key: 'items', value: ['key'] },
      { roleId: 'player', key: 'items', value: [] },
    ], { authority: 'model', rules: [unique], expectedRevision: 7 });
    expect(result.nextState.roles.map(role => role.state.items)).toEqual([[], ['key']]);
    expect(result.audit.map(entry => entry.origin)).toEqual(['proposal', 'proposal']);
    expect(before).toEqual(original);
    code(() => applyStateTransaction(before, [{ roleId: 'other', key: 'items', value: ['key'] }], { authority: 'model', rules: [unique] }), 'STATE_RULE_VIOLATION');
    expect(before).toEqual(original);
  });

  it('checks invariants even on no-op transactions; missing condition facts fail closed', () => {
    const before = fixture();
    const invariant: StateRule = { id: 'healthy', type: 'invariant', condition: { path: 'roles.player.state.health', op: 'gte', value: 3 }, message: 'Player must stay healthy' };
    code(() => applyStateTransaction(before, [{ roleId: 'player', key: 'health', value: 1 }], { authority: 'model', rules: [invariant] }), 'STATE_RULE_VIOLATION');
    expect(before.roles[0].state.health).toBe(5);
    code(() => applyStateTransaction(before, [], { authority: 'model', rules: [{ ...invariant, condition: { path: 'events.0', equals: true } }] }), 'STATE_RULE_VIOLATION');
    expect(applyStateTransaction(before, [], { authority: 'model', rules: [invariant] }).audit).toEqual([]);
  });

  it('runs declared derived chains with causal audit and validates final invariants', () => {
    const before = fixture();
    const rules: StateRule[] = [
      { id: 'flag', type: 'transition', trigger: { roleId: '*', key: 'health' }, when: { path: 'trigger.after', op: 'gte', value: 7 }, effects: [{ type: 'set', roleId: '$trigger', key: 'flag', value: true }] },
      { id: 'points', type: 'transition', trigger: { roleId: 'player', key: 'flag' }, effects: [{ type: 'increment', roleId: '$trigger', key: 'score', amount: 2 }] },
      { id: 'points-final', type: 'invariant', condition: { path: 'roles.player.state.score', equals: 2 }, message: 'Points must follow flag' },
    ];
    const result = applyStateTransaction(before, [{ roleId: 'player', key: 'health', value: 7 }], { authority: 'model', owner: 'player', rules });
    expect(result.nextState.roles[0].state).toMatchObject({ health: 7, flag: true, score: 2 });
    expect(result.audit.map(entry => [entry.key, entry.ruleId, entry.causeId, entry.audience])).toEqual([
      ['health', undefined, undefined, 'public'], ['flag', 'flag', 'change:1', 'author'], ['score', 'points', 'change:2', ['player']],
    ]);
    expect(result.audit[1].trigger).toEqual({ roleId: 'player', key: 'health', before: 5, after: 7 });
    expect(before.roles[0].state).toMatchObject({ health: 5, flag: false, score: 0 });
  });

  it('evaluates sibling conditions after all direct writes, independent of direct proposal order', () => {
    const rule: StateRule = { id: 'coherent-wave', type: 'transition', trigger: { roleId: 'player', key: 'health' }, when: { path: 'roles.other.state.health', equals: 8 }, effects: [{ type: 'set', roleId: 'player', key: 'flag', value: true }] };
    const changes = [{ roleId: 'player', key: 'health', value: 7 }, { roleId: 'other', key: 'health', value: 8 }];
    for (const ordered of [changes, [...changes].reverse()]) {
      expect(applyStateTransaction(fixture(), ordered, { authority: 'model', rules: [rule] }).nextState.roles[0].state.flag).toBe(true);
    }
  });

  it('skips false conditions and rejects unknown conditions without exposing session metadata', () => {
    const rule: StateRule = { id: 'guard', type: 'transition', trigger: { roleId: '*', key: 'health' }, when: { path: 'trigger.after', equals: 10 }, effects: [{ type: 'set', roleId: '$trigger', key: 'flag', value: true }] };
    const change = [{ roleId: 'player', key: 'health', value: 6 }];
    expect(applyStateTransaction(fixture(), change, { authority: 'model', rules: [rule] }).audit).toHaveLength(1);
    code(() => applyStateTransaction(fixture(), change, { authority: 'model', rules: [{ ...rule, when: { path: 'revision', equals: 7 } }] }), 'STATE_RULE_CONDITION');
  });

  it('exposes role state and lifecycle only to conditions', () => {
    const before = fixture();
    before.roles[0].persona = 'secret';
    before.roles[0].goals = ['secret'];
    before.roles[0].knowledge = [{ id: 'private', text: 'secret', audience: 'author', status: 'known' }];
    const rule: StateRule = { id: 'scope', type: 'transition', trigger: { roleId: 'player', key: 'health' }, effects: [{ type: 'set', roleId: 'player', key: 'flag', value: true }] };
    const changes = [{ roleId: 'player', key: 'health', value: 6 }];
    for (const key of ['name', 'persona', 'goals', 'knowledge']) {
      code(() => applyStateTransaction(before, changes, { authority: 'model', rules: [{ ...rule, when: { path: `roles.player.${key}`, op: 'eq', value: 'secret' } }] }), 'STATE_RULE_CONDITION');
    }
    expect(applyStateTransaction(before, changes, { authority: 'model', rules: [{ ...rule, when: { all: [{ path: 'roles.player.phase', equals: 'active' }, { path: 'roles.player.presence', equals: 'present' }, { path: 'roles.player.id', equals: 'player' }] } }] }).nextState.roles[0].state.flag).toBe(true);
  });

  it('rejects distinct derived consequences even when one is a no-op, in either declaration order', () => {
    const before = fixture(), original = structuredClone(before);
    const first: StateRule = { id: 'keep', type: 'transition', trigger: { roleId: 'player', key: 'health' }, effects: [{ type: 'set', roleId: 'player', key: 'flag', value: false }] };
    const second: StateRule = { ...first, id: 'change', effects: [{ type: 'set', roleId: 'player', key: 'flag', value: true }] };
    for (const rules of [[first, second], [second, first]]) {
      code(() => applyStateTransaction(before, [{ roleId: 'player', key: 'health', value: 6 }], { authority: 'model', rules }), 'STATE_WRITE_CONFLICT');
      expect(before).toEqual(original);
    }
  });

  it('fails cycles, conflicting effects and effect budget exhaustion atomically', () => {
    const before = fixture(), original = structuredClone(before);
    const rules: StateRule[] = [
      { id: 'a', type: 'transition', trigger: { roleId: 'player', key: 'health' }, effects: [{ type: 'set', roleId: 'player', key: 'flag', value: true }] },
      { id: 'b', type: 'transition', trigger: { roleId: 'player', key: 'flag' }, effects: [{ type: 'increment', roleId: 'player', key: 'health', amount: 1 }] },
    ];
    const changes = [{ roleId: 'player', key: 'health', value: 6 }];
    code(() => applyStateTransaction(before, changes, { authority: 'model', rules }), 'STATE_RULE_CYCLE');
    code(() => applyStateTransaction(before, changes, { authority: 'model', rules, maxEffects: 0 }), 'STATE_RULE_LIMIT');
    const conflict: StateRule = { id: 'conflict', type: 'transition', trigger: { roleId: 'player', key: 'health' }, effects: [{ type: 'set', roleId: 'player', key: 'health', value: 2 }] };
    code(() => applyStateTransaction(before, changes, { authority: 'model', rules: [conflict] }), 'STATE_RULE_CYCLE');
    const first: StateRule = { id: 'first', type: 'transition', trigger: { roleId: 'player', key: 'health' }, effects: [{ type: 'set', roleId: 'other', key: 'health', value: 2 }] };
    code(() => applyStateTransaction(before, changes, { authority: 'model', rules: [first, { ...first, id: 'second', effects: [{ type: 'set', roleId: 'other', key: 'health', value: 3 }] }] }), 'STATE_WRITE_CONFLICT');
    expect(before).toEqual(original);
  });

  it('rejects conflicting duplicate proposals and effects overriding explicit no-op proposals', () => {
    const before = fixture();
    code(() => applyStateTransaction(before, [{ roleId: 'player', key: 'health', value: 6 }, { roleId: 'player', key: 'health', value: 7 }], { authority: 'model' }), 'STATE_WRITE_CONFLICT');
    const rule: StateRule = { id: 'overwrite', type: 'transition', trigger: { roleId: 'player', key: 'health' }, effects: [{ type: 'set', roleId: 'other', key: 'health', value: 7 }] };
    code(() => applyStateTransaction(before, [{ roleId: 'player', key: 'health', value: 6 }, { roleId: 'other', key: 'health', value: 5 }], { authority: 'model', rules: [rule] }), 'STATE_WRITE_CONFLICT');
  });

  it('validates declared targets, min/max and types for derived effects as well as proposals', () => {
    const before = fixture();
    for (const value of [-1, 11]) code(() => applyStateTransaction(before, [{ roleId: 'player', key: 'health', value }], { authority: 'model' }), 'STATE_RANGE');
    code(() => applyStateTransaction(before, [{ roleId: 'player', key: 'health', value: '5' }], { authority: 'model' }), 'STATE_TYPE');
    const rule: StateRule = { id: 'invalid-effect', type: 'transition', trigger: { roleId: '*', key: 'health' }, effects: [{ type: 'increment', roleId: '$trigger', key: 'score', amount: 11 }] };
    code(() => applyStateTransaction(before, [{ roleId: 'player', key: 'health', value: 6 }], { authority: 'model', rules: [rule] }), 'STATE_RANGE');
    code(() => applyStateTransaction(before, [{ roleId: 'player', key: 'missing', value: 6 }], { authority: 'model' }), 'STATE_FIELD');
    code(() => applyStateTransaction(before, [{ roleId: 'missing', key: 'health', value: 6 }], { authority: 'model' }), 'ROLE_UNKNOWN');
  });

  it('enforces owner, model/author/derived authority and author editability', () => {
    const before = fixture();
    code(() => applyStateTransaction(before, [{ roleId: 'other', key: 'health', value: 6 }], { authority: 'model', owner: 'player' }), 'STATE_OWNER');
    for (const authority of ['model', 'author'] as const) code(() => applyStateTransaction(before, [{ roleId: 'player', key: 'flag', value: true }], { authority }), 'STATE_AUTHORITY');
    code(() => applyStateTransaction(before, [{ roleId: 'player', key: 'author', value: 'secret' }], { authority: 'model' }), 'STATE_AUTHORITY');
    expect(applyStateTransaction(before, [{ roleId: 'player', key: 'author', value: 'secret' }], { authority: 'author' }).nextState.roles[0].state.author).toBe('secret');
    before.fields.find(field => field.key === 'author')!.editable = false;
    code(() => applyStateTransaction(before, [{ roleId: 'player', key: 'author', value: 'secret' }], { authority: 'author' }), 'STATE_READONLY');
    before.fields.find(field => field.key === 'health')!.editable = false;
    expect(applyStateTransaction(before, [{ roleId: 'player', key: 'health', value: 6 }], { authority: 'model' }).nextState.roles[0].state.health).toBe(6);
    code(() => applyStateTransaction(before, [{ roleId: 'player', key: 'health', value: 6 }], { authority: 'author' }), 'STATE_READONLY');
  });

  it('supports revision and structural JSON CAS against the original snapshot', () => {
    const before = fixture();
    code(() => applyStateTransaction(before, [], { authority: 'model', expectedRevision: 6 }), 'REVISION_CONFLICT');
    code(() => applyStateTransaction(before, [{ roleId: 'player', key: 'health', value: 6, expectedValue: 4 }], { authority: 'model' }), 'STATE_CAS_CONFLICT');
    before.roles[0].state.items = [{ b: 2, a: 1 }];
    expect(applyStateTransaction(before, [{ roleId: 'player', key: 'items', value: [], expectedValue: [{ a: 1, b: 2 }] }], { authority: 'model' }).nextState.roles[0].state.items).toEqual([]);
  });

  it('handles world changes and set-like list effects with structural equality', () => {
    const rule: StateRule = { id: 'world-grant', type: 'transition', trigger: { roleId: 'world', key: 'health' }, effects: [{ type: 'list-add', roleId: 'player', key: 'items', value: { id: 'token' } }, { type: 'list-remove', roleId: 'other', key: 'items', value: 'key' }] };
    const before = fixture(); before.roles[1].state.items = ['key']; before.roles[0].state.items = [{ id: 'token' }];
    const result = applyStateTransaction(before, [{ roleId: 'world', key: 'health', value: 6 }], { authority: 'model', rules: [rule, unique] });
    expect(result.nextState.world.variables.health).toBe(6);
    expect(result.nextState.roles.map(role => role.state.items)).toEqual([[{ id: 'token' }], []]);
    expect(result.audit.map(entry => entry.roleId)).toEqual(['world', 'other']);
  });

  it('rejects non-JSON values, cycles, sparse arrays and accessors without evaluating getters', () => {
    const cycle: unknown[] = []; cycle.push(cycle);
    let reads = 0;
    const accessor = Object.defineProperty({}, 'x', { get() { reads++; return 1; }, enumerable: true });
    for (const value of [NaN, Infinity, undefined, new Date(), new Map(), [undefined], cycle, new Array(2), accessor, JSON.parse('{"__proto__":1}'), { nested: { constructor: 1 } }, { nested: { prototype: 1 } }, { x: 1n }, { x: () => 1 }]) {
      code(() => assertStateJson(value), 'STATE_JSON');
    }
    expect(reads).toBe(0);
    code(() => applyStateTransaction(fixture(), [{ roleId: 'player', key: 'items', value: [undefined] as unknown as Json }], { authority: 'model' }), 'STATE_JSON');
    expect(() => assertStateJson([null, true, { x: [1, 'ok'] }])).not.toThrow();
  });
});
