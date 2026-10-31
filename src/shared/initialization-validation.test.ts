import { describe, expect, it } from 'vitest';
import { describeCreatorFormat } from '../server/creator-format';
import { createNativeTemplate, materializeNativeDocument, validateNativeDocument } from './native';
import type { CharacterCard, InitializationDefinition } from './types';

function card(): CharacterCard {
  const value = createNativeTemplate('card') as CharacterCard;
  value.fields = [
    { key: 'energy', label: 'Energy', type: 'number', min: 0, max: 100, audience: 'public', editable: false, writableBy: 'derived' },
    { key: 'label', label: 'Label', type: 'string', audience: 'public', editable: true },
    { key: 'ready', label: 'Ready', type: 'boolean', audience: 'public', editable: true },
    { key: 'items', label: 'Items', type: 'list', audience: 'public', editable: true },
  ];
  value.roles[0].state = { energy: null, label: '', ready: false, items: [] };
  value.roles.push({ ...structuredClone(value.roles[0]), id: 'npc', name: 'NPC' });
  value.world.variables = { energy: null, retainedMetadata: { untouched: true } };
  value.initialization = {
    schema: 'rp.initialization/0.1',
    openings: [{ id: 'arrival', title: 'Arrival', text: '', instruction: 'Begin here.', world: { location: 'Harbor', time: 'Evening' }, cast: [
      { roleId: 'player', phase: 'active', presence: 'present' },
      { roleId: 'npc', phase: 'dormant', presence: 'absent' },
    ], state: [{ roleId: 'player', key: 'energy', value: 90 }] }],
    playerProfiles: [{ id: 'visitor', title: 'Visitor', name: 'You', persona: '', state: [{ roleId: 'player', key: 'energy', value: 75 }, { roleId: 'world', key: 'energy', value: null }] }],
    defaultOpeningId: 'arrival', defaultPlayerProfileId: 'visitor',
  };
  return value;
}
const paths = (value: unknown) => validateNativeDocument('card', value).map(issue => issue.path);
const definition = (value: CharacterCard) => value.initialization!;

describe('native explicit new-story initialization', () => {
  it('accepts one-time derived baselines, cross-layer overrides, unknown values and preserves unknown JSON', () => {
    const value = card();
    (definition(value) as InitializationDefinition & { extension: unknown }).extension = { exact: ['Original metadata', 1] };
    (definition(value).openings[0] as any).extension = { original: true };
    definition(value).openings[0].state!.push({ roleId: 'player', key: 'items', value: [null, { custom: ['value'] }] });
    definition(value).openings[0].source = { importId: 'pack', sourceHash: 'a'.repeat(64), pointer: '/data/alternate_greetings/2', entryId: 2 };
    definition(value).playerProfiles[0].source = { importId: 'pack', sourceHash: 'b'.repeat(64), pointer: '', entryId: 'defaultuser' };
    const before = structuredClone(value);
    expect(validateNativeDocument('card', value)).toEqual([]);
    expect(value).toEqual(before); expect(materializeNativeDocument(value)).toEqual(before);
    delete value.initialization;
    expect(validateNativeDocument('card', value)).toEqual([]);
  });

  it('requires the schema, both nonempty collections, unique IDs and valid defaults', () => {
    const valid = card();
    for (const [initialization, expected] of [
      [null, '/initialization'],
      [{ ...definition(valid), schema: 'rp.initialization/next' }, '/initialization/schema'],
      [{ ...definition(valid), openings: [] }, '/initialization/openings'],
      [{ ...definition(valid), playerProfiles: [] }, '/initialization/playerProfiles'],
      [{ ...definition(valid), openings: [null] }, '/initialization/openings/0'],
      [{ ...definition(valid), playerProfiles: [null] }, '/initialization/playerProfiles/0'],
      [{ ...definition(valid), openings: [{ ...definition(valid).openings[0], id: '' }] }, '/initialization/openings/0/id'],
      [{ ...definition(valid), playerProfiles: [{ ...definition(valid).playerProfiles[0], id: 'constructor' }] }, '/initialization/playerProfiles/0/id'],
      [{ ...definition(valid), openings: [...definition(valid).openings, ...definition(valid).openings] }, '/initialization/openings/1/id'],
      [{ ...definition(valid), playerProfiles: [...definition(valid).playerProfiles, ...definition(valid).playerProfiles] }, '/initialization/playerProfiles/1/id'],
      [{ ...definition(valid), defaultOpeningId: 'missing' }, '/initialization/defaultOpeningId'],
      [{ ...definition(valid), defaultPlayerProfileId: 'missing' }, '/initialization/defaultPlayerProfileId'],
    ] as const) expect(paths({ ...valid, initialization })).toContain(expected);
    delete definition(valid).defaultOpeningId; delete definition(valid).defaultPlayerProfileId;
    definition(valid).openings.push({ ...structuredClone(definition(valid).openings[0]), id: 'another' });
    expect(paths(valid)).toEqual([]); // Resolution is a create-session concern.
  });

  it('validates all opening/profile text and optional world fields', () => {
    const value = card();
    const opening = definition(value).openings[0] as any, profile = definition(value).playerProfiles[0] as any;
    opening.title = ''; opening.text = 4; opening.instruction = null; opening.world = { location: 3, time: false };
    profile.title = ''; profile.name = ''; profile.persona = false;
    expect(paths(value)).toEqual(expect.arrayContaining([
      '/initialization/openings/0/title', '/initialization/openings/0/text', '/initialization/openings/0/instruction', '/initialization/openings/0/world/location', '/initialization/openings/0/world/time',
      '/initialization/playerProfiles/0/title', '/initialization/playerProfiles/0/name', '/initialization/playerProfiles/0/persona',
    ]));
  });

  it('validates explicit target instructions without inferring routes or rewriting original source', () => {
    const value = card(), opening = definition(value).openings[0];
    opening.instruction = 'ORIGINAL: mixed source text\nPreserve exactly.';
    for (const delivery of [{}, { world: '' }, { prose: 'Write the committed scene.' }, { world: 'Establish the arrival.', prose: 'Use restrained narration.' }]) {
      opening.delivery = delivery;
      const before = structuredClone(value);
      expect(paths(value)).toEqual([]);
      expect(materializeNativeDocument(value)).toEqual(before);
    }
    opening.delivery = null as any;
    expect(paths(value)).toContain('/initialization/openings/0/delivery');
    opening.delivery = { world: 4, prose: false } as any;
    expect(paths(value)).toEqual(expect.arrayContaining(['/initialization/openings/0/delivery/world', '/initialization/openings/0/delivery/prose']));
  });

  it('requires a complete explicit cast, rejects unknown/duplicate roles and invalid lifecycle values', () => {
    const value = card(), opening = definition(value).openings[0];
    opening.cast = [{ roleId: 'npc', phase: 'active', presence: 'present' }];
    expect(paths(value)).toContain('/initialization/openings/0/cast');
    opening.cast.push({ roleId: 'npc', phase: 'active', presence: 'present' }, { roleId: 'missing', phase: 'awake' as any, presence: 'nearby' as any });
    expect(paths(value)).toEqual(expect.arrayContaining(['/initialization/openings/0/cast/1/roleId', '/initialization/openings/0/cast/2/roleId', '/initialization/openings/0/cast/2/phase', '/initialization/openings/0/cast/2/presence']));
    delete (opening as any).cast;
    expect(paths(value)).toContain('/initialization/openings/0/cast');
  });

  it('requires each state target to exist, be declared and be initialized for its owner', () => {
    const value = card();
    delete value.roles[1].state.energy;
    definition(value).openings[0].state = [
      { roleId: 'missing', key: 'energy', value: 1 },
      { roleId: 'world', key: 'retainedMetadata', value: null },
      { roleId: 'npc', key: 'energy', value: 1 },
      { roleId: 'world', key: 'label', value: '' },
      { roleId: 'player', key: 'missing', value: null },
      { roleId: 'player', key: 'ready' } as any,
    ];
    expect(paths(value)).toEqual(expect.arrayContaining([
      '/initialization/openings/0/state/0/roleId', '/initialization/openings/0/state/1/key', '/initialization/openings/0/state/2/key',
      '/initialization/openings/0/state/3/key', '/initialization/openings/0/state/4/key', '/initialization/openings/0/state/5/value',
    ]));
  });

  it('checks types, numeric bounds and duplicate owner/field pairs independently in each layer', () => {
    const value = card();
    definition(value).openings[0].state = [
      { roleId: 'player', key: 'energy', value: -1 },
      { roleId: 'player', key: 'energy', value: 101 },
      { roleId: 'npc', key: 'energy', value: '90' },
      { roleId: 'player', key: 'ready', value: 'true' },
      { roleId: 'player', key: 'label', value: false },
      { roleId: 'player', key: 'items', value: {} },
    ];
    definition(value).playerProfiles[0].state!.push({ roleId: 'player', key: 'energy', value: null });
    expect(paths(value)).toEqual(expect.arrayContaining([
      ...Array.from({ length: 6 }, (_, i) => `/initialization/openings/0/state/${i}/value`),
      '/initialization/openings/0/state/1/key', '/initialization/playerProfiles/0/state/2/key',
    ]));
  });

  it('validates provenance as evidence using the worldbook source shape', () => {
    const value = card();
    definition(value).openings[0].source = { importId: '', sourceHash: 'invalid', pointer: 'not/a/pointer', entryId: false } as any;
    definition(value).playerProfiles[0].source = null as any;
    expect(paths(value)).toEqual(expect.arrayContaining([
      '/initialization/openings/0/source/importId', '/initialization/openings/0/source/sourceHash', '/initialization/openings/0/source/pointer', '/initialization/openings/0/source/entryId', '/initialization/playerProfiles/0/source',
    ]));
  });

  it('documents optional selection, one-time state precedence, full cast and source isolation', () => {
    const guide = describeCreatorFormat('card');
    if (!('card' in guide)) throw new Error('Missing card guide');
    expect(guide.card.initialization.schema).toBe('rp.initialization/0.1');
    expect(guide.card.initialization.selection).toContain('openingId and playerProfileId');
    expect(guide.card.initialization.application).toContain('profile state defaults first, then opening state overrides');
    expect(guide.card.initialization.cast).toContain('including the player');
    expect(guide.card.initialization.source).toContain('never read or executed');
    expect('card' in describeCreatorFormat('preset')).toBe(false);
  });
});
