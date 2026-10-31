import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate, materializeNativeDocument, validateNativeDocument } from './native';
import type { CharacterCard, Preset, PromptModule } from './types';
import { WORLDBOOK_PURPOSES, type Worldbook, type WorldbookBinding } from './worldbook';
import { project, SessionStore } from '../server/store';
import { readRuntimeConfiguration, updateRuntimeConfiguration } from '../server/runtime-config';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const module = (id = 'lore'): PromptModule => ({ id, title: 'Source lore', content: 'Exact source body.', category: 'supplement', enabled: true, targets: ['world'], phase: 'coordinate', priority: 0 });
const binding = (overrides: Partial<WorldbookBinding> = {}): WorldbookBinding => ({ id: 'lore-binding', moduleId: 'lore', purpose: 'reference', ...overrides });
const worldbook = (...bindings: WorldbookBinding[]): Worldbook => ({ schema: 'rp.worldbook/0.1', bindings });
const card = () => { const value = createNativeTemplate('card') as CharacterCard; value.modules = [module()]; return value; };
const paths = (value: unknown) => validateNativeDocument('card', value).map(issue => issue.path);

describe('native worldbook binding validation', () => {
  it('retains whole-module bindings and unknown JSON metadata in both document kinds', () => {
    for (const kind of ['card', 'preset'] as const) {
      const value = createNativeTemplate(kind);
      value.modules = WORLDBOOK_PURPOSES.map(purpose => module(purpose));
      value.worldbook = worldbook(...WORLDBOOK_PURPOSES.map(purpose => binding({ id: purpose, moduleId: purpose, purpose,
        ...(purpose === 'scenario-plan' ? { when: { path: 'world.variables.chapter', equals: 'one' } } : {}),
        audience: ['player'], contentHash: 'A'.repeat(64), source: { importId: 'original-import', sourceHash: 'b'.repeat(64), pointer: '/data/character_book/entries/0/content', entryId: 0 },
      })));
      (value.worldbook.bindings[0] as WorldbookBinding & { extension: unknown }).extension = { retained: ['exact', 1] };
      const before = structuredClone(value);
      expect(validateNativeDocument(kind, value)).toEqual([]);
      expect(value).toEqual(before);
      expect(materializeNativeDocument(value)).toEqual(before);
      // Hash shape is portable; body hash equality is enforced by server admission.
      expect(value.worldbook.bindings[0].contentHash).toBe('A'.repeat(64));
    }
  });

  it('rejects missing or malformed schema, bindings and recognized field values', () => {
    for (const [invalid, expected] of [
      [null, '/worldbook'],
      [{ schema: 'rp.worldbook/next', bindings: [] }, '/worldbook/schema'],
      [{ schema: 'rp.worldbook/0.1', bindings: {} }, '/worldbook/bindings'],
      [{ schema: 'rp.worldbook/0.1', bindings: [null] }, '/worldbook/bindings/0'],
      [worldbook(binding({ id: '' })), '/worldbook/bindings/0/id'],
      [worldbook(binding({ purpose: 'execute-script' as any })), '/worldbook/bindings/0/purpose'],
      [worldbook(binding({ moduleId: 4 as any })), '/worldbook/bindings/0/moduleId'],
      [worldbook(binding({ contentHash: 'z'.repeat(64) })), '/worldbook/bindings/0/contentHash'],
      [worldbook(binding({ contentHash: 'a'.repeat(63) })), '/worldbook/bindings/0/contentHash'],
    ] as const) expect(paths({ ...card(), worldbook: invalid })).toContain(expected);
  });

  it('requires local module ownership, unique binding IDs and explicit scenario conditions', () => {
    const value = card();
    value.worldbook = worldbook(binding({ purpose: 'scenario-plan' }), binding(), binding({ id: 'missing', moduleId: 'preset:lore' }));
    expect(paths(value)).toEqual(expect.arrayContaining([
      '/worldbook/bindings/0/when', '/worldbook/bindings/1/id', '/worldbook/bindings/1/moduleId', '/worldbook/bindings/2/moduleId',
    ]));
    value.worldbook = worldbook(binding({ purpose: 'scenario-plan', when: { all: [{ path: 'world.variables.chapter', equals: 'one' }, { not: { path: 'world.variables.ended', op: 'exists' } }] } }));
    expect(paths(value)).toEqual([]);
  });

  it('uses existing condition and role-audience validation without changing module permissions', () => {
    const value = card(); value.modules[0].audience = 'author';
    value.worldbook = worldbook(binding({ audience: 'public', when: { path: 'world.variables.chapter', equals: 'one' } }));
    expect(paths(value)).toEqual([]); expect(value.modules[0].audience).toBe('author');
    value.worldbook.bindings[0].audience = ['missing'];
    value.worldbook.bindings[0].when = { path: 'world.constructor.secret', equals: true };
    expect(paths(value)).toEqual(expect.arrayContaining(['/worldbook/bindings/0/audience/0', '/worldbook/bindings/0/when/path']));
    value.worldbook.bindings[0].when = { all: [], any: [] } as any;
    expect(paths(value)).toContain('/worldbook/bindings/0/when');
  });

  it('checks source evidence types, hash shape and JSON Pointer without treating evidence as authority', () => {
    const value = card();
    value.worldbook = worldbook(binding({ source: { importId: '', sourceHash: 'invalid', pointer: 'file:///tmp/source', entryId: true as any } }));
    expect(paths(value)).toEqual(expect.arrayContaining([
      '/worldbook/bindings/0/source/importId', '/worldbook/bindings/0/source/sourceHash',
      '/worldbook/bindings/0/source/pointer', '/worldbook/bindings/0/source/entryId',
    ]));
    value.worldbook.bindings[0].source = { importId: 'source', sourceHash: '0'.repeat(64), pointer: '/data/a~1b/~0', entryId: 'legacy/id' };
    expect(paths(value)).toEqual([]);
    value.worldbook.bindings[0].source.pointer = '/bad~2escape';
    expect(paths(value)).toContain('/worldbook/bindings/0/source/pointer');
    value.worldbook.bindings[0].source.pointer = '';
    value.worldbook.bindings[0].source.entryId = Infinity;
    expect(paths(value)).toContain('/worldbook/bindings/0/source/entryId');
  });
});

async function stored() {
  const root = await mkdtemp(join(tmpdir(), 'rp-worldbook-validation-')); roots.push(root);
  const store = new SessionStore(root), value = card(), preset = createNativeTemplate('preset') as Preset;
  const id = store.create(value, preset).id;
  return { root, store, id };
}

describe('bound worldbook configuration updates', () => {
  it('atomically sets and removes the card binding while retaining live state and private audit', async () => {
    const { store, id, root } = await stored(), before = structuredClone(store.get(id));
    const input = worldbook(binding({ purpose: 'scenario-plan', when: { path: 'world.variables.chapter', equals: 'one' } }));
    const result = updateRuntimeConfiguration(store, id, { expectedRevision: 0, reason: 'Bind chapter source', cardWorldbook: input });
    expect(result.revision).toBe(1); expect(result.card.worldbook).toEqual(input);
    expect(store.get(id).world).toEqual(before.world); expect(store.get(id).roles).toEqual(before.roles);
    input.bindings[0].moduleId = 'caller-mutated'; result.card.worldbook!.bindings[0].purpose = 'ui-data';
    expect(store.get(id).card.worldbook!.bindings[0]).toMatchObject({ moduleId: 'lore', purpose: 'scenario-plan' });
    expect(project(store.get(id), 'player')).not.toHaveProperty('worldbook');
    expect(project(store.get(id), 'player').events.some(event => event.kind === 'runtime-configured')).toBe(false);
    const audit = store.get(id).events.find(event => event.kind === 'runtime-configured')!;
    expect(audit.audience).toBe('author'); expect(JSON.stringify(audit)).not.toContain('lore-binding');
    expect(readRuntimeConfiguration(new SessionStore(root), id).card.worldbook).toEqual(store.get(id).card.worldbook);
    const removed = updateRuntimeConfiguration(store, id, { expectedRevision: 1, reason: 'Remove source binding', cardWorldbook: null });
    expect(removed.revision).toBe(2); expect(removed.card).not.toHaveProperty('worldbook');
    expect(store.get(id).world).toEqual(before.world);
  });

  it('rejects invalid or stale bindings without any memory or durable snapshot change', async () => {
    const { store, id, root } = await stored(), before = structuredClone(store.get(id));
    const filename = join(root, `session-${id}.json`), saved = await readFile(filename, 'utf8');
    for (const patch of [
      { cardWorldbook: worldbook(binding({ moduleId: 'missing' })) },
      { cardWorldbook: worldbook(binding({ purpose: 'scenario-plan' })) },
      { cardWorldbook: worldbook(binding()), cardModules: [] },
      { cardWorldbook: worldbook(binding()), expectedRevision: 8 },
      { cardWorldbook: null },
      { cardWorldbook: worldbook(binding()), world: { location: 'Forbidden' } },
      { cardWorldbook: worldbook(binding()), fields: [] },
    ]) {
      expect(() => updateRuntimeConfiguration(store, id, { expectedRevision: 0, reason: 'Invalid update', ...patch })).toThrow();
      expect(store.get(id)).toEqual(before); expect(await readFile(filename, 'utf8')).toBe(saved);
    }
  });

  it('validates complete preset snapshots and module-plus-binding card updates together', async () => {
    const { store, id } = await stored(), preset = structuredClone(store.get(id).preset);
    preset.modules = [module('preset-lore')]; preset.worldbook = worldbook(binding({ moduleId: 'preset-lore' }));
    const result = updateRuntimeConfiguration(store, id, { expectedRevision: 0, reason: 'Bind both sources',
      preset, cardModules: [module('new-lore')], cardWorldbook: worldbook(binding({ moduleId: 'new-lore' })) });
    expect(result.preset.worldbook).toEqual(preset.worldbook);
    expect(result.card.modules[0].id).toBe('new-lore'); expect(result.card.worldbook!.bindings[0].moduleId).toBe('new-lore');
    expect(() => updateRuntimeConfiguration(store, id, { expectedRevision: 1, reason: 'Unchanged', cardWorldbook: result.card.worldbook })).toThrow('actual change');
    const invalid = structuredClone(result.preset); invalid.worldbook!.bindings[0].moduleId = 'card:new-lore';
    expect(() => updateRuntimeConfiguration(store, id, { expectedRevision: 1, reason: 'Cross-document reference', preset: invalid })).toThrow('unknown module');
    expect(store.get(id).revision).toBe(1);
  });
});
