import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate, validateNativeDocument } from '../shared/native';
import type { CharacterCard, Json, Preset, StateField } from '../shared/types';
import type { StateValueSchema } from '../shared/state-value-schema';
import { applyStateTransaction } from './state-runtime';
import { SessionStore, clone, validateChange } from './store';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const skillSchema: StateValueSchema = { type: 'list', items: { type: 'object', required: ['name', 'effect', 'value', 'ap'], properties: {
  name: { type: 'string' }, effect: { type: 'string', enum: ['score_gain', 'boost_self'] },
  value: { type: 'number', min: 0, max: 5 }, ap: { type: 'number', min: 0, max: 6 },
} } };
const skill = () => ({ name: 'Pulse', effect: 'score_gain', value: 1, ap: 1 });
function card(nullable = false) {
  const value = createNativeTemplate('card') as CharacterCard;
  value.fields = [
    { key: 'skills', label: 'Skills', type: 'list', editable: true, audience: 'author', valueSchema: skillSchema },
    { key: 'gr', label: 'GR', type: 'number', min: 1, editable: true, audience: 'author', ...(nullable ? { nullable: true } : {}) },
  ];
  value.roles[0].state = { skills: [skill()], gr: null };
  return value;
}
function fixture(nullable = false) {
  const root = mkdtempSync(join(tmpdir(), 'rp-typed-state-')); roots.push(root);
  const store = new SessionStore(root), value = store.create(card(nullable), createNativeTemplate('preset') as Preset);
  return { store, id: value.id, filename: join(root, `session-${value.id}.json`) };
}
const code = (action: () => unknown, expected: string) => {
  try { action(); throw new Error('Expected validation failure'); }
  catch (error) { expect(error).toHaveProperty('code', expected); }
};

describe('one shared structured-state validator at intake and all mutation boundaries', () => {
  it('checks declared nested initial values and schema metadata even when initial values are null', () => {
    const value = card(); expect(validateNativeDocument('card', value)).toEqual([]);
    value.world.variables.skills = [{ ...skill(), value: 6 }];
    value.roles[0].state.skills = [{ ...skill(), unrecognized: true }];
    expect(validateNativeDocument('card', value).map(issue => issue.path)).toEqual(expect.arrayContaining([
      '/world/variables/skills/0/value', '/roles/0/state/skills/0/unrecognized',
    ]));
    value.world.variables.skills = null; value.roles[0].state.skills = null;
    value.fields[0].valueSchema = { type: 'list', items: { type: 'object', properties: {}, required: ['missing'] } };
    expect(validateNativeDocument('card', value).some(issue => issue.path === '/fields/0/valueSchema/items/required')).toBe(true);
    value.fields[0].valueSchema = { type: 'string' };
    expect(validateNativeDocument('card', value).some(issue => issue.path === '/fields/0/valueSchema/type')).toBe(true);
    value.fields[0].valueSchema = skillSchema; value.fields[1].nullable = 'true' as never;
    expect(validateNativeDocument('card', value).some(issue => issue.path === '/fields/1/nullable')).toBe(true);
  });

  it('retains old unresolved initial nulls but gates null writes on nullable for author and model', () => {
    const f = fixture(), session = f.store.get(f.id), original = clone(session);
    expect(session.roles[0].state.gr).toBeNull();
    for (const authority of ['author', 'model'] as const) {
      code(() => applyStateTransaction(session, [{ roleId: 'player', key: 'gr', value: null }], { authority }), 'STATE_TYPE');
    }
    code(() => validateChange(session, { roleId: 'player', key: 'gr', value: null }), 'STATE_TYPE');
    expect(session).toEqual(original);
    const g = fixture(true), current = g.store.get(g.id);
    for (const authority of ['author', 'model'] as const)
      expect(applyStateTransaction(current, [{ roleId: 'player', key: 'gr', value: null }], { authority }).nextState.roles[0].state.gr).toBeNull();
    expect(validateChange(current, { roleId: 'player', key: 'gr', value: null })).toBe(current.roles[0].state);
    const unknown = clone(current); unknown.roles[0].state.gr = 3;
    expect(applyStateTransaction(unknown, [{ roleId: 'player', key: 'gr', value: null }], { authority: 'author' }).audit[0].after).toBeNull();
  });

  it('blocks generic author edits and legacy validateChange without modifying memory, file, revision or events', () => {
    const f = fixture(), before = clone(f.store.get(f.id)), bytes = readFileSync(f.filename, 'utf8');
    for (const [value, error] of [
      [[{ ...skill(), effect: 'reward_all' }], 'STATE_TYPE'], [[{ ...skill(), ap: 7 }], 'STATE_RANGE'],
      [[{ ...skill(), secret: true }], 'STATE_TYPE'], [[{ name: 'Only a label' }], 'STATE_TYPE'],
    ] as [Json, string][]) {
      code(() => validateChange(f.store.get(f.id), { roleId: 'player', key: 'skills', value }, undefined, true), error);
      code(() => f.store.edit(f.id, { expectedRevision: before.revision, reason: 'Edit actual skill state', roleId: 'player', key: 'skills', value }), error);
      expect(f.store.get(f.id)).toEqual(before); expect(readFileSync(f.filename, 'utf8')).toBe(bytes);
    }
    f.store.edit(f.id, { expectedRevision: before.revision, reason: 'Change actual skill state', roleId: 'player', key: 'skills', value: [{ ...skill(), value: 2.5, ap: 0 }] });
    expect(f.store.get(f.id).roles[0].state.skills).toEqual([{ ...skill(), value: 2.5, ap: 0 }]);
    expect(f.store.get(f.id).revision).toBe(before.revision + 1);
    expect(f.store.get(f.id).events.some(event => event.kind === 'state-edit')).toBe(true);
  });

  it('validates model proposals and derived set/list-add effects atomically against the same nested schema', () => {
    const f = fixture(), before = clone(f.store.get(f.id)), bytes = readFileSync(f.filename, 'utf8');
    code(() => applyStateTransaction(before, [{ roleId: 'player', key: 'skills', value: [{ ...skill(), effect: 'unknown' }] }], { authority: 'model' }), 'STATE_TYPE');
    for (const effect of [
      { type: 'set' as const, roleId: 'player', key: 'skills', value: [{ ...skill(), value: -1 }] },
      { type: 'list-add' as const, roleId: 'player', key: 'skills', value: { ...skill(), ap: 7 } },
    ]) code(() => applyStateTransaction(before, [{ roleId: 'player', key: 'gr', value: 2 }], { authority: 'model', rules: [
      { id: 'derived-skills', type: 'transition', trigger: { roleId: 'player', key: 'gr' }, effects: [effect] },
    ] }), 'STATE_RANGE');
    const result = applyStateTransaction(before, [{ roleId: 'player', key: 'gr', value: 2 }], { authority: 'model', rules: [
      { id: 'derived-skills', type: 'transition', trigger: { roleId: 'player', key: 'gr' }, effects: [
        { type: 'list-add', roleId: 'player', key: 'skills', value: { name: 'Support', effect: 'boost_self', value: 0.3, ap: 1 } },
      ] },
    ] });
    expect(result.nextState.roles[0].state.skills).toHaveLength(2); expect(result.audit[1].origin).toBe('rule');
    expect(f.store.get(f.id)).toEqual(before); expect(readFileSync(f.filename, 'utf8')).toBe(bytes);
  });

  it('validates typed initial opening layers and declared rule literals before admitting the native card', () => {
    const value = card();
    value.initialization = { schema: 'rp.initialization/0.1', openings: [{ id: 'entry', title: 'Entry', text: '',
      world: { location: '', time: '' }, cast: [{ roleId: 'player', phase: 'active', presence: 'present' }],
      state: [{ roleId: 'player', key: 'skills', value: [{ ...skill(), effect: 'unknown' }] }],
    }], playerProfiles: [{ id: 'reader', title: 'Reader', name: 'Reader', persona: '' }] };
    expect(validateNativeDocument('card', value).some(issue => issue.path === '/initialization/openings/0/state/0/value/0/effect')).toBe(true);
    value.initialization.openings[0].state![0].value = null;
    expect(validateNativeDocument('card', value)).toEqual([]); // deliberate unknown genesis remains compatible
    value.stateRules = [{ id: 'after-gr', type: 'transition', trigger: { roleId: 'player', key: 'gr' }, effects: [
      { type: 'set', roleId: 'player', key: 'skills', value: [{ ...skill(), extra: true }] },
      { type: 'list-add', roleId: 'player', key: 'skills', value: { ...skill(), ap: 7 } },
      { type: 'set', roleId: 'player', key: 'gr', value: null },
    ] }];
    const paths = validateNativeDocument('card', value).map(issue => issue.path);
    expect(paths).toEqual(expect.arrayContaining(['/stateRules/0/effects/0/value/0/extra', '/stateRules/0/effects/1/value/ap', '/stateRules/0/effects/2/value']));
    value.fields[1].nullable = true;
    expect(validateNativeDocument('card', value).some(issue => issue.path === '/stateRules/0/effects/2/value')).toBe(false);
  });

  it('never reads value/schema accessors and cannot bypass schema checks using malformed persisted metadata', () => {
    const f = fixture(), before = clone(f.store.get(f.id)); let reads = 0;
    const skillValue = Object.defineProperty(skill(), 'value', { enumerable: true, get: () => { reads++; return 1; } });
    for (const action of [
      () => validateChange(before, { roleId: 'player', key: 'skills', value: [skillValue] }),
      () => applyStateTransaction(before, [{ roleId: 'player', key: 'skills', value: [skillValue] }], { authority: 'model' }),
    ]) code(action, 'STATE_JSON');
    const accessor = clone(before);
    Object.defineProperty(accessor.fields[0], 'valueSchema', { enumerable: true, get: () => { reads++; return skillSchema; } });
    code(() => validateChange(accessor, { roleId: 'player', key: 'skills', value: [] }), 'STATE_JSON');
    code(() => applyStateTransaction(accessor, [], { authority: 'model' }), 'STATE_JSON');
    const malformed = clone(before); (malformed.fields[0] as StateField).valueSchema = { type: 'list' } as StateValueSchema;
    code(() => validateChange(malformed, { roleId: 'player', key: 'skills', value: [] }), 'STATE_FIELD');
    code(() => applyStateTransaction(malformed, [], { authority: 'model' }), 'STATE_FIELD');
    expect(reads).toBe(0); expect(f.store.get(f.id)).toEqual(before);
  });
});
