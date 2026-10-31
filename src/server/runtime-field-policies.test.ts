import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset } from '../shared/types';
import type { StateValueSchema } from '../shared/state-value-schema';
import { applyStateTransaction } from './state-runtime';
import { readRuntimeConfiguration, updateRuntimeConfiguration } from './runtime-config';
import { clone, project, SessionStore } from './store';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rp-field-policy-')); roots.push(root);
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.fields = [
    { key: 'affinity', label: 'Unresolved source counter', type: 'number', editable: false, audience: 'author' },
    { key: 'skills', label: 'Existing structured skills', type: 'list', editable: true, audience: ['npc'], writableBy: 'model',
      valueSchema: { type: 'list', items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } } },
    { key: 'unknown', label: 'Unknown initial value', type: 'string', editable: true, audience: 'author' },
  ];
  card.world.variables = { affinity: 0, unknown: null };
  card.roles[0].state = { affinity: 1 };
  card.roles.push({ ...clone(card.roles[0]), id: 'npc', name: 'Witness', state: { affinity: 10, skills: [] } });
  const store = new SessionStore(root), id = store.create(card, preset).id;
  const held = clone(store.get(id)); held.world.variables.affinity = 55; held.roles[0].state.affinity = 2;
  held.roles[1].state.affinity = 73; held.roles[1].state.skills = [{ name: 'Canonical skill' }]; store.save(held);
  const patch = (fieldPolicies: unknown, extra: Record<string, unknown> = {}) => updateRuntimeConfiguration(store, id, {
    expectedRevision: store.get(id).revision, reason: 'Explicit author field policy decision', fieldPolicies, ...extra,
  });
  return { root, store, id, patch, filename: join(root, `session-${id}.json`) };
}

describe('bounded runtime metadata-only field policies', () => {
  it('makes an explicit freeze/author/model policy decision without inventing ranges or touching source values, with a single audited save', async () => {
    const f = await fixture(), before = clone(f.store.get(f.id)), save = vi.spyOn(f.store, 'save');
    const frozen = f.patch([{ key: 'affinity', writableBy: 'author' }]);
    expect(save).toHaveBeenCalledTimes(1); expect(frozen.card.fields[0]).toMatchObject({ type: 'number', editable: false, writableBy: 'author', audience: 'author' });
    expect(frozen.card.fields[0]).not.toHaveProperty('min'); expect(frozen.card.fields[0]).not.toHaveProperty('max');
    const held = f.store.get(f.id); expect(held.fields).toEqual(held.card.fields);
    expect(held.world).toEqual(before.world); expect(held.roles).toEqual(before.roles); expect(held.prose).toEqual(before.prose);
    expect(held.card.roles).toEqual(before.card.roles); expect(held.card.world).toEqual(before.card.world);
    expect(() => applyStateTransaction(held, [{ roleId: 'npc', key: 'affinity', value: 74 }], { authority: 'model' })).toThrow(/author/);
    expect(() => f.store.edit(f.id, { expectedRevision: held.revision, roleId: 'npc', key: 'affinity', value: 74, reason: 'Frozen' })).toThrow(/not editable/);
    const audit = held.events.at(-1)!;
    expect(audit).toMatchObject({ kind: 'runtime-configured', audience: 'author', data: { fieldPolicies: [{ key: 'affinity',
      previous: { audience: 'author', editable: false }, current: { audience: 'author', editable: false, writableBy: 'author' } }] } });
    f.patch([{ key: 'affinity', writableBy: 'model', editable: true, audience: ['npc'], min: 0, max: 100 }]);
    expect(project(f.store.get(f.id), 'player').roles[1].state).not.toHaveProperty('affinity');
    expect(applyStateTransaction(f.store.get(f.id), [{ roleId: 'npc', key: 'affinity', value: 74 }], { authority: 'model' }).nextState.roles[1].state.affinity).toBe(74);
    expect(readRuntimeConfiguration(new SessionStore(f.root), f.id)).toEqual(readRuntimeConfiguration(f.store, f.id));
  });

  it('validates all held world and role values rather than trusting valid card baseline values', async () => {
    const f = await fixture(), before = clone(f.store.get(f.id)), bytes = await readFile(f.filename, 'utf8');
    expect(() => f.patch([{ key: 'affinity', max: 50 }])).toThrow(/world.affinity/);
    expect(f.store.get(f.id)).toEqual(before); expect(await readFile(f.filename, 'utf8')).toBe(bytes);
    const changed = clone(before); changed.world.variables.affinity = 25; f.store.save(changed);
    const secondBytes = await readFile(f.filename, 'utf8');
    expect(() => f.patch([{ key: 'affinity', max: 50 }])).toThrow(/npc.affinity/);
    expect(await readFile(f.filename, 'utf8')).toBe(secondBytes);
    expect(() => f.patch([{ key: 'skills', valueSchema: { type: 'list', items: { type: 'object', properties: { name: { type: 'string', enum: ['Different'] } }, required: ['name'] } } }])).toThrow(/npc.skills/);
    expect(await readFile(f.filename, 'utf8')).toBe(secondBytes);
  });

  it('supports an explicit weak structured-profile schema upgrade, nullable policy and clearing optional bounds/schema', async () => {
    const f = await fixture();
    const schema: StateValueSchema = { type: 'list', items: { type: 'object', properties: { name: { type: 'string', nonBlank: true } }, required: ['name'], additionalProperties: false } };
    const before = clone(f.store.get(f.id));
    f.patch([{ key: 'skills', valueSchema: schema }, { key: 'unknown', nullable: false }, { key: 'affinity', min: 0, max: 100 }]);
    expect(f.store.get(f.id).roles).toEqual(before.roles); expect(f.store.get(f.id).world).toEqual(before.world);
    expect(() => f.store.edit(f.id, { expectedRevision: f.store.get(f.id).revision, roleId: 'npc', key: 'skills', value: [{ name: '  ' }], reason: 'Invalid blank' })).toThrow();
    expect(() => f.store.edit(f.id, { expectedRevision: f.store.get(f.id).revision, roleId: 'world', key: 'unknown', value: null, reason: 'Explicit null write' })).toThrow(/nullable/);
    schema.items = { type: 'string' }; expect(f.store.get(f.id).fields.find(field => field.key === 'skills')!.valueSchema).not.toEqual(schema);
    f.patch([{ key: 'skills', valueSchema: null }, { key: 'affinity', min: null, max: null }, { key: 'unknown', nullable: true }]);
    expect(f.store.get(f.id).fields[0]).not.toHaveProperty('min'); expect(f.store.get(f.id).fields[0]).not.toHaveProperty('max');
    expect(f.store.get(f.id).fields[1]).not.toHaveProperty('valueSchema');
    expect(f.store.get(f.id).fields).toEqual(f.store.get(f.id).card.fields);
  });

  it('rejects stale, duplicate, unknown, unsafe and non-JSON policy metadata atomically', async () => {
    const f = await fixture(), before = clone(f.store.get(f.id)), bytes = await readFile(f.filename, 'utf8');
    let reads = 0; const accessor = Object.defineProperty({ key: 'affinity' }, 'max', { enumerable: true, get() { reads++; return 100; } });
    for (const policies of [
      [], new Array(1), Array.from({ length: 257 }, () => ({ key: 'affinity', max: 100 })),
      [{ key: 'affinity', max: 100 }, { key: 'affinity', min: 0 }], [{ key: 'unknown-key', editable: true }],
      [{ key: 'affinity', type: 'string' }], [{ key: 'affinity', value: 0 }], [{ key: 'affinity', editable: null }],
      [{ key: 'affinity', nullable: null }], [{ key: 'affinity', writableBy: 'external' }], [{ key: 'affinity', max: NaN }],
      [{ key: 'affinity', audience: ['missing-role'] }], [{ key: 'skills', min: 0 }], [{ key: 'affinity', valueSchema: { type: 'string' } }],
      [{ key: 'affinity', valueSchema: { type: 'number', dynamic: 'untrusted' } }], [accessor],
    ]) { expect(() => f.patch(policies)).toThrow(); expect(f.store.get(f.id)).toEqual(before); expect(await readFile(f.filename, 'utf8')).toBe(bytes); }
    expect(reads).toBe(0); expect(() => f.patch([{ key: 'affinity', editable: true }], { expectedRevision: -1 })).toThrow(/State changed/);
    expect(() => f.patch([{ key: 'affinity', editable: true }], { reason: '  ' })).toThrow(/reason/);
  });

  it('checks state rules and active output/opening references against the final proposed policies', async () => {
    const f = await fixture(), held = clone(f.store.get(f.id));
    held.fields[0].audience = 'public'; held.card.fields[0].audience = 'public';
    held.card.outputs = [{ id: 'state-output', title: 'Counter', instruction: 'Read current counter', type: 'text', enabled: true, required: true, priority: 0,
      audience: 'public', display: { placement: 'side-panel' }, valueFrom: { kind: 'state', roleId: 'npc', key: 'affinity' } }];
    f.store.save(held); const before = await readFile(f.filename, 'utf8');
    expect(() => f.patch([{ key: 'affinity', audience: 'author' }])).toThrow(/output/); expect(await readFile(f.filename, 'utf8')).toBe(before);
    f.patch([{ key: 'affinity', audience: 'author' }], { cardOutputs: [{ ...held.card.outputs[0], enabled: false }] });
    const withRule = clone(f.store.get(f.id)); withRule.card.stateRules = [{ id: 'known-range', type: 'transition', trigger: { roleId: 'npc', key: 'affinity' }, effects: [{ type: 'set', roleId: 'player', key: 'affinity', value: 80 }] }]; f.store.save(withRule);
    expect(() => f.patch([{ key: 'affinity', max: 75 }])).toThrow(/effect|bounds|range/);
    const opening = clone(f.store.get(f.id)); delete opening.card.stateRules;
    opening.card.initialization = { schema: 'rp.initialization/0.1', openings: [{ id: 'source-opening', title: 'Source opening', text: '',
      cast: opening.card.roles.map(role => ({ roleId: role.id, phase: role.phase, presence: role.presence })), state: [{ roleId: 'npc', key: 'affinity', value: 90 }] }],
      playerProfiles: [{ id: 'profile', title: 'Reader', name: 'Reader', persona: '' }] };
    f.store.save(opening); const openingBytes = await readFile(f.filename, 'utf8');
    expect(() => f.patch([{ key: 'affinity', max: 80 }])).toThrow(/initialization\/openings.*range/); expect(await readFile(f.filename, 'utf8')).toBe(openingBytes);
  });
});
