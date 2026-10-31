import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset, PromptModule } from '../shared/types';
import { project, SessionStore } from './store';
import { readRuntimeConfiguration, updateRuntimeConfiguration } from './runtime-config';
import { proposeKnowledgeEdit } from './knowledge-runtime';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'rp-runtime-config-')); roots.push(root);
  const card = createNativeTemplate('card') as CharacterCard & { custom: unknown };
  card.id = 'bound-card'; card.custom = { exact: ['retain', 4] };
  card.roles.push({ id: 'npc', name: 'NPC', persona: 'PRIVATE ORIGINAL PERSONA', personaSourcePointer: '/entries/0/content', goals: ['Original goal'], peers: ['player'], phase: 'active', presence: 'present', state: { trust: 10 }, knowledge: [{ id: 'secret', text: 'Private knowledge', status: 'known', audience: 'author' }] });
  card.roles[0].peers = ['npc']; card.roles[0].state = { trust: 1 };
  card.fields = [{ key: 'trust', label: 'Trust', type: 'number', audience: 'author', editable: true }];
  const module: PromptModule = { id: 'persona-source', title: 'NPC persona', category: 'supplement', content: card.roles[1].persona, sourcePointer: '/entries/0/content', enabled: true, targets: ['role'], phase: 'decide', priority: 0 };
  card.modules = [module]; card.opening = 'Existing opening prose';
  const preset = createNativeTemplate('preset') as Preset;
  preset.id = 'bound-preset'; preset.modules = [{ ...module, id: 'preset-prose', sourcePointer: '/preset/content', content: 'PRIVATE PRESET CONTENT', targets: ['prose'], phase: 'compose' }];
  const store = new SessionStore(root), id = store.create(card, preset).id;
  const active = proposeKnowledgeEdit(store.get(id), { operation: 'upsert', roleId: 'npc', id: 'new-secret', text: 'Acquired since creation', audience: 'author', status: 'known' });
  active.world.location = 'Active location'; active.world.time = 'Night'; active.world.variables = { chapter: 9, custom: ['active', 2] };
  active.roles[1].state.trust = 73; active.roles[1].phase = 'dormant'; active.roles[1].presence = 'absent';
  active.narration = { person: 'first', pov: 'limited', focalRoleId: 'npc' };
  active.prose.push({ id: 'written-prose', title: 'Written', text: 'Published prose survives', worldRevision: 4 });
  active.revision = 4; store.save(active);
  return { store, id, root, card, preset };
}

describe('bound runtime configuration', () => {
  it('returns detached bound documents and atomically applies linked persona, goals and peers', async () => {
    const { store, id } = await fixture(), before = structuredClone(store.get(id));
    const visible = readRuntimeConfiguration(store, id);
    visible.card.title = 'Caller mutation'; visible.preset.modules[0].content = 'Caller mutation';
    expect(store.get(id).card.title).toBe(before.card.title); expect(store.get(id).preset.modules[0].content).toBe(before.preset.modules[0].content);
    const modules = structuredClone(before.card.modules); modules[0].content = 'PRIVATE EDITED PERSONA';
    const result = updateRuntimeConfiguration(store, id, { expectedRevision: 4, reason: 'Adjust NPC intent', cardModules: modules, roles: [{ id: 'npc', persona: modules[0].content, goals: ['New goal'], peers: [] }] });
    expect(result.revision).toBe(5);
    for (const role of [result.card.roles[1], store.get(id).roles[1]]) expect(role).toMatchObject({ persona: 'PRIVATE EDITED PERSONA', goals: ['New goal'], peers: [] });
    const after = store.get(id);
    expect(after.world).toEqual(before.world); expect(after.prose).toEqual(before.prose); expect(after.narration).toEqual(before.narration);
    expect(after.roles[1]).toMatchObject({ state: before.roles[1].state, phase: 'dormant', presence: 'absent', knowledge: before.roles[1].knowledge });
    expect(after.card.roles[1].state).toEqual(before.card.roles[1].state); expect((after.card as any).custom).toEqual((before.card as any).custom);
    modules[0].content = 'Post-save mutation'; result.card.roles[1].goals.push('Post-read mutation');
    expect(store.get(id).card.modules[0].content).toBe('PRIVATE EDITED PERSONA'); expect(store.get(id).roles[1].goals).toEqual(['New goal']);
  });

  it('rejects either one-sided linked edit and invalid peers without changing memory or durable snapshots', async () => {
    const { store, id, root } = await fixture(), before = structuredClone(store.get(id));
    const filename = path.join(root, `session-${id}.json`), saved = await readFile(filename, 'utf8');
    const modules = structuredClone(before.card.modules); modules[0].content = 'Conflicting changed module';
    const invalid = [
      { roles: [{ id: 'npc', persona: 'Conflicting changed persona', goals: ['Must not save'] }] },
      { cardModules: modules, roles: [{ id: 'player', goals: ['Must not save'] }] },
      { roles: [{ id: 'npc', peers: ['missing'] }] },
      { preset: { ...before.preset, modules: [{ ...before.preset.modules[0], phase: 'invalid' }] }, roles: [{ id: 'player', goals: ['Must not save'] }] },
    ];
    for (const patch of invalid) {
      expect(() => updateRuntimeConfiguration(store, id, { expectedRevision: 4, reason: 'Invalid patch', ...patch })).toThrow();
      expect(store.get(id)).toEqual(before); expect(await readFile(filename, 'utf8')).toBe(saved);
    }
  });

  it('rebinds a complete explicit preset snapshot while preserving story narration and source independence', async () => {
    const { store, id, preset } = await fixture(), before = structuredClone(store.get(id));
    preset.title = 'Catalog mutated later'; preset.modules[0].content = 'Catalog changed later';
    expect(readRuntimeConfiguration(store, id).preset.title).toBe(before.preset.title);
    const replacement = { ...structuredClone(preset), id: 'explicit-replacement', narration: { person: 'third' as const, pov: 'omniscient' as const }, customPreset: { preserved: [1, 'unknown'] } };
    const result = updateRuntimeConfiguration(store, id, { expectedRevision: 4, reason: 'Select replacement preset', preset: replacement });
    expect(result.preset).toEqual(replacement); expect(store.get(id).presetId).toBe('explicit-replacement');
    expect(store.get(id).narration).toEqual(before.narration); expect(store.get(id).card).toEqual(before.card); expect(store.get(id).world).toEqual(before.world);
    replacement.modules[0].content = 'Later catalog mutation';
    expect(store.get(id).preset.modules[0].content).toBe('Catalog changed later');
  });

  it('requires CAS, a reason, exact patch keys and an actual change', async () => {
    const { store, id } = await fixture(), before = structuredClone(store.get(id));
    const invalid = [
      { expectedRevision: 3, reason: 'Stale', roles: [{ id: 'npc', goals: ['Update'] }] },
      { expectedRevision: 4, reason: '   ', roles: [{ id: 'npc', goals: ['Update'] }] },
      { expectedRevision: 4, reason: 'Unknown key', world: { location: 'Forbidden' } },
      { expectedRevision: 4, reason: 'State patch', roles: [{ id: 'npc', state: { trust: 0 } }] },
      { expectedRevision: 4, reason: 'Role lifecycle patch', roles: [{ id: 'npc', phase: 'active' }] },
      { expectedRevision: 4, reason: 'Duplicate patch', roles: [{ id: 'npc', goals: ['a'] }, { id: 'npc', goals: ['b'] }] },
      { expectedRevision: 4, reason: 'Empty role patch', roles: [{ id: 'npc' }] },
      { expectedRevision: 4, reason: 'Nothing to change' },
      { expectedRevision: 4, reason: 'Same content', cardModules: before.card.modules, preset: before.preset, roles: [{ id: 'npc', goals: before.roles[1].goals }] },
    ];
    for (const patch of invalid) {
      expect(() => updateRuntimeConfiguration(store, id, patch)).toThrow(); expect(store.get(id)).toEqual(before);
    }
    updateRuntimeConfiguration(store, id, { expectedRevision: 4, reason: 'Valid change', roles: [{ id: 'player', goals: ['New player goal'] }] });
    expect(() => updateRuntimeConfiguration(store, id, { expectedRevision: 4, reason: 'Now stale', roles: [{ id: 'player', goals: ['Another goal'] }] })).toThrow('State changed');
  });

  it('records only source IDs and hashes privately and persists configuration across reloads', async () => {
    const { store, id, root } = await fixture();
    updateRuntimeConfiguration(store, id, { expectedRevision: 4, reason: 'Update intent', roles: [{ id: 'npc', goals: ['PRIVATE NEW GOAL'] }] });
    const audit = store.get(id).events.find(event => event.kind === 'runtime-configured')!;
    expect(audit).toMatchObject({ audience: 'author', actor: 'author', text: 'Update intent', data: { previous: { cardId: 'bound-card', presetId: 'bound-preset' }, current: { cardId: 'bound-card', presetId: 'bound-preset' }, roleIds: ['npc'] } });
    const data = audit.data as any;
    expect(data.previous.cardHash).toMatch(/^[a-f0-9]{64}$/); expect(data.current.presetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(data.current.cardHash).not.toBe(data.previous.cardHash); expect(data.current.presetHash).toBe(data.previous.presetHash);
    expect(JSON.stringify(audit)).not.toMatch(/PRIVATE|Original goal|sourcePointer|content|persona/);
    expect(project(store.get(id), 'player').events.some(event => event.kind === 'runtime-configured')).toBe(false);
    const reloaded = new SessionStore(root);
    expect(readRuntimeConfiguration(reloaded, id)).toEqual(readRuntimeConfiguration(store, id));
    expect(reloaded.get(id).roles[1].goals).toEqual(['PRIVATE NEW GOAL']);
  });
});
