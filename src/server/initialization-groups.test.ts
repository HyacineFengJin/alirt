import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate, validateNativeDocument } from '../shared/native';
import type { CharacterCard, InitializationSelection, OpeningRoleSelectionGroup, Preset } from '../shared/types';
import { initializeStory, initializationContext } from './initialization-runtime';
import { clone, SessionStore } from './store';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function documents() {
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.fields = [
    { key: 'affinity', label: 'Affinity', type: 'number', min: 0, max: 1000, audience: 'public', editable: true },
    { key: 'onsite', label: 'Presence', type: 'boolean', audience: 'public', editable: true },
  ];
  card.roles[0].state = { affinity: 0, onsite: true }; card.roles[0].stateMirrors = { presence: 'onsite' };
  for (const [id, name] of [['a', 'Ada'], ['b', 'Bella'], ['c', 'Cora']]) card.roles.push({ id, name, persona: '', goals: [], peers: [],
    phase: 'active', presence: 'present', state: { affinity: 0, onsite: true }, stateMirrors: { presence: 'onsite' }, knowledge: [] });
  const lovers: OpeningRoleSelectionGroup = { kind: 'role-subset', id: 'lovers', title: 'Partners', roleIds: ['a', 'b', 'c'], min: 1, max: 3,
    nameToken: '[[lovers]]', complementNameToken: '[[friends]]', nameSeparator: '、', selectedState: [{ key: 'affinity', value: 1000 }], unselectedState: [{ key: 'affinity', value: 500 }] };
  const present: OpeningRoleSelectionGroup = { kind: 'role-subset', id: 'present', title: 'Attendees', roleIds: ['a', 'b', 'c'], min: 1, max: 3,
    nameToken: '[[attendees]]', nameSeparator: '、', subsetOf: 'lovers', selectWithParent: true,
    selected: { phase: 'active', presence: 'present' }, unselected: { phase: 'dormant', presence: 'absent' } };
  card.initialization = { schema: 'rp.initialization/0.1', openings: [{ id: 'winter', title: 'Winter', text: '',
    instruction: 'Partners [[lovers]]; friends [[friends]]; attendees [[attendees]].',
    delivery: { world: 'Partners [[lovers]], attendees [[attendees]].', prose: 'Friends [[friends]], attendees [[attendees]].' },
    cast: card.roles.map(role => ({ roleId: role.id, phase: role.id === 'player' ? 'active' : 'dormant', presence: role.id === 'player' ? 'present' : 'absent' })),
    roleGroups: [lovers, present] }], playerProfiles: [{ id: 'reader', title: 'Reader', name: 'Reader', persona: '' }],
    defaultOpeningId: 'winter', defaultPlayerProfileId: 'reader' };
  return { card, preset };
}
const selection = (): InitializationSelection => ({ selectedRoleGroups: { lovers: ['c', 'a'], present: ['c'] } });
async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'rp-initialization-groups-')); roots.push(root);
  return { root, store: new SessionStore(root), ...documents() };
}

describe('ordered opening role selection groups', () => {
  it('composes canonical partners, complement names, attendee cast and independent state once at genesis', async () => {
    const f = await storeFixture(); expect(validateNativeDocument('card', f.card)).toEqual([]);
    const before = clone(f.card), created = f.store.create(f.card, f.preset, selection()), held = f.store.get(created.id);
    expect(held.initialization?.selectedRoleGroups).toEqual({ lovers: ['a', 'c'], present: ['c'] });
    expect(held.initialization).not.toHaveProperty('selectedRoleIds');
    const resolved = held.initialization!.resolvedOpening!;
    expect(resolved).not.toHaveProperty('roleGroups'); expect(resolved.instruction).toBe('Partners Ada、Cora; friends Bella; attendees Cora.');
    expect(resolved.delivery).toEqual({ world: 'Partners Ada、Cora, attendees Cora.', prose: 'Friends Bella, attendees Cora.' });
    expect(held.roles.map(role => [role.id, role.phase, role.presence, role.state.affinity, role.state.onsite])).toEqual([
      ['player', 'active', 'present', 0, true], ['a', 'dormant', 'absent', 1000, false],
      ['b', 'dormant', 'absent', 500, false], ['c', 'active', 'present', 1000, true],
    ]);
    expect(f.card).toEqual(before);
    const changed = clone(held); changed.roles.find(role => role.id === 'a')!.state.affinity = 700; f.store.save(changed);
    const reopened = new SessionStore(f.root).get(held.id);
    expect(initializationContext(reopened)?.opening).toEqual(resolved);
    expect(reopened.roles.find(role => role.id === 'a')!.state.affinity).toBe(700);
    expect(reopened.initialization).toEqual(held.initialization);
  });

  it('accepts empty generic groups with explicit/default empty labels and replaces names in one literal pass', () => {
    const { card } = documents(), groups = card.initialization!.openings[0].roleGroups!;
    groups.forEach(group => group.min = 0); groups[0].emptyName = 'Nobody';
    const empty = initializeStory(card, { selectedRoleGroups: { lovers: [], present: [] } });
    expect(empty.receipt?.resolvedOpening?.instruction).toBe('Partners Nobody; friends Ada、Bella、Cora; attendees 无.');
    card.roles.find(role => role.id === 'a')!.name = '[[attendees]]';
    const selected = initializeStory(card, { selectedRoleGroups: { lovers: ['a'], present: ['a'] } });
    expect(selected.receipt?.resolvedOpening?.instruction).toBe('Partners [[attendees]]; friends Bella、Cora; attendees [[attendees]].');
  });

  it('requires exact group selections, available unique IDs, parent membership and ordinary JSON before persistence', async () => {
    const f = await storeFixture();
    for (const selected of [
      {}, { lovers: ['a'] }, { lovers: ['a'], present: ['a'], extra: [] },
      { lovers: ['a', 'a'], present: ['a'] }, { lovers: ['a'], present: ['b'] },
      { lovers: ['unknown'], present: [] }, { lovers: ['player'], present: ['player'] },
      { lovers: ['a'], present: [] }, { lovers: 'a', present: ['a'] }, { lovers: ['a'], present: [1] },
    ]) expect(() => f.store.create(f.card, f.preset, { selectedRoleGroups: selected as any })).toThrow();
    expect(() => f.store.create(f.card, f.preset, { ...selection(), selectedRoleIds: ['a'] })).toThrow(/legacy/);
    let reads = 0; const accessor = Object.defineProperty({ lovers: ['a'] }, 'present', { enumerable: true, get() { reads++; return ['a']; } });
    expect(() => initializeStory(f.card, { selectedRoleGroups: accessor })).toThrow(/ordinary JSON/);
    const hidden = Object.defineProperty(selection(), 'extra', { value: true });
    expect(() => initializeStory(f.card, hidden)).toThrow(/ordinary JSON/);
    expect(() => initializeStory(f.card, { selectedRoleGroups: JSON.parse('{"__proto__":[],"lovers":["a"],"present":["a"]}') })).toThrow();
    expect(reads).toBe(0); expect(await readdir(f.root)).toEqual([]);
    const ordinary = documents(); delete ordinary.card.initialization!.openings[0].roleGroups;
    expect(() => initializeStory(ordinary.card, selection())).toThrow(/does not accept/);
  });

  it('rejects changed, noncanonical, malformed or mismatched receipts without replaying baseline state', async () => {
    const f = await storeFixture(), id = f.store.create(f.card, f.preset, selection()).id, held = clone(f.store.get(id));
    for (const mutate of [
      (session: typeof held) => { session.initialization!.selectedRoleGroups!.lovers = ['c', 'a']; },
      (session: typeof held) => { session.initialization!.selectedRoleGroups!.present = ['b']; },
      (session: typeof held) => { delete session.initialization!.selectedRoleGroups!.present; },
      (session: typeof held) => { session.initialization!.selectedRoleGroups!.extra = []; },
      (session: typeof held) => { session.initialization!.selectedRoleIds = ['a']; },
      (session: typeof held) => { session.initialization!.resolvedOpening!.cast[1].presence = 'present'; },
      (session: typeof held) => { session.card.initialization!.openings[0].roleGroups![0].nameSeparator = '/'; },
    ]) { const changed = clone(held); mutate(changed); expect(() => initializationContext(changed)).toThrow(); }
    const changed = clone(held); let reads = 0;
    Object.defineProperty(changed.initialization!.selectedRoleGroups!, 'present', { enumerable: true, get() { reads++; return ['c']; } });
    expect(() => initializationContext(changed)).toThrow(/ordinary JSON/); expect(reads).toBe(0);
    expect(f.store.get(id)).toEqual(held);
  });
});

describe('role group definition ownership and dependency validation', () => {
  it('rejects ambiguous targets, invalid dependencies/tokens/modes and unavailable identities', () => {
    const mutations: ((card: CharacterCard) => void)[] = [
      card => { card.initialization!.openings[0].roleGroups![1].subsetOf = 'missing'; },
      card => { card.initialization!.openings[0].roleGroups!.reverse(); },
      card => { card.initialization!.openings[0].roleGroups![0].roleIds = ['a', 'b']; card.initialization!.openings[0].roleGroups![0].max = 2; },
      card => { delete card.initialization!.openings[0].roleGroups![1].subsetOf; },
      card => { card.initialization!.openings[0].roleGroups![1].id = 'lovers'; },
      card => { card.initialization!.openings[0].roleGroups![1].nameToken = '[[lovers]]'; },
      card => { card.initialization!.openings[0].roleGroups![0].complementNameToken = '[[lovers]]'; },
      card => { delete card.initialization!.openings[0].roleGroups![1].unselected; },
      card => { card.initialization!.openings[0].roleGroups![1].selectedState = [{ key: 'affinity', value: 300 }]; },
      card => { card.initialization!.openings[0].state = [{ roleId: 'a', key: 'affinity', value: 0 }]; },
      card => { card.initialization!.openings[0].state = [{ roleId: 'a', key: 'onsite', value: false }]; },
      card => { card.initialization!.openings[0].roleGroups![1].selectedState = [{ key: 'onsite', value: true }]; },
      card => { card.initialization!.openings[0].roleGroups![0].selected = { phase: 'active', presence: 'present' }; card.initialization!.openings[0].roleGroups![0].unselected = { phase: 'dormant', presence: 'absent' }; },
      card => { card.initialization!.openings[0].roleGroups![0].unselectedState = [{ key: 'affinity', value: 'bad' }]; },
      card => { card.initialization!.openings[0].roleGroups![0].min = -1; },
      card => { card.initialization!.openings[0].roleGroups![0].roleIds.push('a'); },
      card => { card.roles.find(role => role.id === 'a')!.phase = 'retired'; },
      card => { card.initialization!.openings[0].roleGroups![0].roleIds[0] = 'player'; },
      card => { (card.initialization!.openings[0].roleGroups![0] as any).script = 'untrusted'; },
      card => { card.initialization!.openings[0].roleSelection = { kind: 'role-subset', roleIds: ['a'], min: 1, max: 1, nameToken: '[[lovers]]', nameSeparator: '', selected: { phase: 'active', presence: 'present' }, unselected: { phase: 'dormant', presence: 'absent' } }; },
    ];
    for (const mutate of mutations) {
      const { card } = documents(); mutate(card);
      expect(validateNativeDocument('card', card).length).toBeGreaterThan(0);
      expect(() => initializeStory(card, selection())).toThrow();
    }
  });
});
