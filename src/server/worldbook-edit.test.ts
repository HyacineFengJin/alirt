import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset, PromptModule } from '../shared/types';
import type { RoleStageTemplate } from '../shared/role-stage';
import { createImportService } from '../importer';
import { createApp } from './app';
import type { ModelProvider } from './engine';
import { SessionStore } from './store';
import { applyWorldbookEdit } from './worldbook-edit';

const roots: string[] = [], cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const moduleFor = (id: string, content = 'Harbor reference'): PromptModule => ({ id, title: id, content, enabled: true, targets: ['world'], phase: 'coordinate', category: 'supplement', priority: 0 });
async function fixture(customize?: (card: CharacterCard, preset: Preset) => void) {
  const root = await mkdtemp(join(tmpdir(), 'rp-worldbook-edit-')); roots.push(root);
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.modules = []; preset.modules = []; customize?.(card, preset);
  const store = new SessionStore(root), id = store.create(card, preset).id;
  const command = (patch: Record<string, unknown>) => applyWorldbookEdit(store, id, {
    expectedRevision: store.get(id).revision, reason: 'Author edits world material', source: 'card', ...patch,
  });
  return { store, id, root, card, preset, command, file: () => readFile(join(root, `session-${id}.json`), 'utf8') };
}

describe('manual worldbook edits', () => {
  it.each(['card', 'preset'] as const)('adds, edits, disables and deletes an entire %s entry while preserving the story and provenance', async source => {
    const f = await fixture(), story = structuredClone(f.store.get(f.id));
    const add = f.command({ source, operation: 'add', module: { title: 'Harbor', content: '  Old harbor.\n' }, binding: {
      source: { importId: 'original', sourceHash: 'a'.repeat(64), pointer: '/entries/0/content', entryId: 0 },
    } });
    const module = add[source].modules[0], binding = add[source].worldbook!.bindings[0];
    expect(module).toMatchObject({ targets: ['world'], phase: 'coordinate', enabled: true, category: 'supplement' });
    expect(binding).toMatchObject({ moduleId: module.id, purpose: 'reference', contentHash: digest(module.content) });
    const unknown = f.store.get(f.id)[source].worldbook!.bindings[0] as any;
    unknown.customEvidence = { untouched: ['source', 8] }; f.store.save(f.store.get(f.id));
    const edited = f.command({ source, operation: 'edit', bindingId: binding.id,
      module: { title: 'New harbor', content: '  Revised harbor.\n', audience: 'author', condition: { path: 'world.location', op: 'exists' } },
      binding: { when: { path: 'world.time', op: 'exists' }, audience: 'author' } });
    expect(edited[source].worldbook!.bindings[0]).toMatchObject({ source: binding.source, contentHash: digest('  Revised harbor.\n'), customEvidence: { untouched: ['source', 8] } });
    expect(f.command({ source, operation: 'set-enabled', moduleId: module.id, enabled: false })[source].modules[0].enabled).toBe(false);
    const after = f.store.get(f.id);
    expect(after.world).toEqual(story.world); expect(after.roles).toEqual(story.roles); expect(after.prose).toEqual(story.prose);
    expect(after.card.initialization).toEqual(story.card.initialization);
    expect(new SessionStore(f.root).get(f.id)[source]).toEqual(after[source]);
    const removed = f.command({ source, operation: 'delete', moduleId: module.id });
    expect(removed[source].modules).toEqual([]); expect(removed[source].worldbook!.bindings).toEqual([]);
    expect(f.card.modules).toEqual([]); expect(f.preset.modules).toEqual([]);
  });

  it('edits unbound source modules without automatic binding and can explicitly add or clear binding metadata', async () => {
    const f = await fixture(card => { card.modules = [{ ...moduleFor('existing'), sourcePointer: '/entries/0/content', activation: { keys: ['harbor'] } }]; });
    const edited = f.command({ operation: 'edit', moduleId: 'existing', module: { content: 'An edited harbor', activation: null } });
    expect(edited.card.worldbook).toBeUndefined(); expect(edited.card.modules[0].sourcePointer).toBe('/entries/0/content');
    expect(edited.card.modules[0].activation).toBeUndefined();
    expect(f.command({ operation: 'set-enabled', moduleId: 'existing', enabled: false }).card.modules[0].enabled).toBe(false);
    const bound = f.command({ operation: 'edit', moduleId: 'existing', binding: { purpose: 'reference', when: { path: 'world.location', op: 'exists' }, audience: 'author' } });
    expect(bound.card.worldbook!.bindings[0].moduleId).toBe('existing');
    const cleared = f.command({ operation: 'edit', moduleId: 'existing', binding: { when: null, audience: null } });
    expect(cleared.card.worldbook!.bindings[0]).not.toHaveProperty('when');
    expect(cleared.card.worldbook!.bindings[0]).not.toHaveProperty('audience');
    f.command({ operation: 'delete', moduleId: 'existing' });
    expect(f.store.get(f.id).card.modules).toEqual([]);
  });

  it('rejects invalid, stale and unchanged commands without writing any partial changes', async () => {
    const f = await fixture(card => { card.modules = [moduleFor('existing')]; });
    const before = structuredClone(f.store.get(f.id)), saved = await f.file();
    for (const patch of [
      { operation: 'edit', moduleId: 'existing', expectedRevision: 99, module: { content: 'Never saved' } },
      { operation: 'edit', moduleId: 'existing', reason: '', module: { content: 'Never saved' } },
      { operation: 'add', module: { title: 'Invalid phase', content: 'Never saved', phase: 'wrong' } },
      { operation: 'edit', moduleId: 'existing', module: { content: null } },
      { operation: 'edit', moduleId: 'existing', module: { id: 'replace-identity' } },
      { operation: 'edit', moduleId: 'existing', bindingId: 'missing', module: { content: 'Never saved' } },
      { operation: 'delete', moduleId: 'existing', binding: {} },
      { operation: 'set-enabled', moduleId: 'existing', enabled: true },
      { operation: 'edit', moduleId: 'existing', module: {} },
    ]) {
      expect(() => f.command(patch)).toThrow(); expect(f.store.get(f.id)).toEqual(before); expect(await f.file()).toBe(saved);
    }
  });

  it('rejects deletion of scenario and module dependencies without silently deleting their references', async () => {
    const f = await fixture(card => {
      card.modules = [moduleFor('chapter'), { ...moduleFor('dependent'), dependsOn: ['chapter'] }];
      card.worldbook = { schema: 'rp.worldbook/0.1', bindings: [{ id: 'chapter-binding', moduleId: 'chapter', purpose: 'scenario-plan', when: { path: 'scenario.currentChapterId', equals: 'one' } }] };
      card.scenario = { schema: 'rp.scenario/0.1', id: 'story', title: 'Story', chapters: [{ id: 'one', title: 'One', prerequisites: [], bindingIds: ['chapter-binding'] }] };
    });
    const saved = await f.file();
    expect(() => f.command({ operation: 'delete', bindingId: 'chapter-binding' })).toThrow(expect.objectContaining({ code: 'WORLDBOOK_EDIT_REFERENCED' }));
    expect(await f.file()).toBe(saved);
    const unbound = await fixture(card => { card.modules = [moduleFor('base'), { ...moduleFor('dependent'), dependsOn: ['card:base'] }]; });
    expect(() => unbound.command({ operation: 'delete', moduleId: 'base' })).toThrow(expect.objectContaining({ code: 'WORLDBOOK_EDIT_REFERENCED' }));
    expect(unbound.store.get(unbound.id).card.modules).toHaveLength(2);
  });

  it('requires reviewed stage spans for body edits and atomically synchronizes linked persona copies', async () => {
    const stage = (length: number): RoleStageTemplate => ({ schema: 'rp.role-stage/0.1', roleId: 'player', field: 'affinity', stages: [{ id: 'only' }], parts: [{ start: 0, end: length, stageId: 'only' }] });
    const f = await fixture(card => {
      card.fields = [{ key: 'affinity', label: 'Affinity', type: 'number', audience: 'author', editable: true }];
      card.roles[0].state = { affinity: 0 }; card.roles[0].persona = 'Original stage persona'; card.roles[0].personaSourcePointer = '/entries/4/content';
      card.modules = [{ ...moduleFor('profile', card.roles[0].persona), sourcePointer: '/entries/4/content', targets: ['role'], phase: 'decide' }];
      card.worldbook = { schema: 'rp.worldbook/0.1', bindings: [{ id: 'profile-binding', moduleId: 'profile', purpose: 'entity-profile', audience: ['player'], contentHash: digest(card.roles[0].persona), roleStage: stage(card.roles[0].persona.length) }] };
    });
    const saved = await f.file(), content = 'A newly reviewed stage persona.';
    expect(() => f.command({ operation: 'edit', moduleId: 'profile', module: { content } })).toThrow(expect.objectContaining({ code: 'WORLDBOOK_EDIT_STAGE' }));
    expect(() => f.command({ operation: 'edit', moduleId: 'profile', module: { content }, binding: { roleStage: stage(1) } })).toThrow();
    expect(await f.file()).toBe(saved);
    const edited = f.command({ operation: 'edit', moduleId: 'profile', module: { content }, binding: { roleStage: stage(content.length) } });
    expect(edited.card.roles[0].persona).toBe(content); expect(f.store.get(f.id).roles[0].persona).toBe(content);
    expect(edited.card.worldbook!.bindings[0]).toMatchObject({ contentHash: digest(content), roleStage: stage(content.length) });
    const disabled = f.command({ operation: 'set-enabled', moduleId: 'profile', enabled: false });
    expect(disabled.card.worldbook).toEqual(edited.card.worldbook);
    // Native stage authors may omit a source pointer. Removing their binding
    // must not turn the retained whole template into unconditional role text.
    const active = f.store.get(f.id);
    delete active.card.roles[0].personaSourcePointer; delete active.roles[0].personaSourcePointer;
    f.store.save(active);
    expect(() => f.command({ operation: 'delete', moduleId: 'profile' })).toThrow(expect.objectContaining({ code: 'WORLDBOOK_EDIT_LINKED' }));
    expect(() => f.command({ operation: 'edit', moduleId: 'profile', binding: { roleStage: null } })).toThrow(expect.objectContaining({ code: 'WORLDBOOK_EDIT_LINKED' }));
    const nextContent = content + ' Expanded.';
    const next = f.command({ operation: 'edit', moduleId: 'profile', module: { content: nextContent }, binding: { roleStage: stage(nextContent.length) } });
    expect(next.card.roles[0].persona).toBe(nextContent); expect(f.store.get(f.id).roles[0].persona).toBe(nextContent);
  });

  it('preserves the selected initialization profile when its live persona has replaced a linked base persona', async () => {
    const f = await fixture(card => {
      card.roles[0].persona = 'Original base persona'; card.roles[0].personaSourcePointer = '/base/player/persona';
      card.modules = [{ ...moduleFor('base-player', card.roles[0].persona), sourcePointer: '/base/player/persona', targets: ['role'], phase: 'decide' }];
      card.initialization = { schema: 'rp.initialization/0.1',
        openings: [{ id: 'quiet', title: 'Quiet opening', text: 'A quiet morning.', cast: [{ roleId: card.playerRoleId, phase: 'active', presence: 'present' }] }],
        playerProfiles: [{ id: 'selected', title: 'Selected profile', name: 'Traveler', persona: 'Chosen independent traveler persona' }],
      };
    });
    const before = structuredClone(f.store.get(f.id)), saved = await f.file();
    expect(before.roles[0].persona).toBe('Chosen independent traveler persona');
    expect(before.roles[0].personaSourcePointer).toBeUndefined();
    expect(() => f.command({ operation: 'edit', moduleId: 'base-player', module: { content: 'Edited base persona' } }))
      .toThrow(expect.objectContaining({ code: 'WORLDBOOK_EDIT_LINKED', message: expect.stringContaining('cannot overwrite') }));
    expect(f.store.get(f.id)).toEqual(before); expect(await f.file()).toBe(saved);
    f.command({ operation: 'edit', moduleId: 'base-player', module: { title: 'A renamed base entry' } });
    f.command({ operation: 'set-enabled', moduleId: 'base-player', enabled: false });
    expect(f.store.get(f.id).roles[0]).toEqual(before.roles[0]);
    expect(f.store.get(f.id).initialization).toEqual(before.initialization);
  });

  it('preserves private imported sources and uses current edited bodies through source hydration and UI-data reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-worldbook-edit-import-')); roots.push(root);
    const imports = createImportService({ root: join(root, 'imports'), metadataRoot: false });
    const source = { name: 'Harbor', description: 'A visitor.', character_book: { entries: [{ id: 1, name: 'Harbor', content: 'Original harbor source', enabled: true, keys: ['harbor'] }] } };
    const imported = await imports.importBytes(Buffer.from(JSON.stringify(source)), 'harbor.json');
    const card = imported.nativeCard!, preset = createNativeTemplate('preset') as Preset;
    const original = await readFile(join(root, 'imports', imported.id, 'artifact.json'), 'utf8');
    const module = card.modules.find(item => item.content === 'Original harbor source')!;
    const provider: ModelProvider = { configured: () => false, run: async () => { throw new Error('No model calls'); } };
    const service = await createApp({ dataRoot: join(root, 'data'), importService: imports, provider, catalog: async () => ({ cards: [card], presets: [preset] }) }); cleanups.push(service.close);
    const id = service.store.create(card, preset).id;
    const edited = applyWorldbookEdit(service.store, id, { expectedRevision: 0, reason: 'Review UI data', source: 'card', operation: 'edit', moduleId: module.id,
      module: { title: 'Edited harbor', content: 'Current author data', condition: null, activation: null }, binding: { purpose: 'ui-data' } });
    applyWorldbookEdit(service.store, id, { expectedRevision: edited.revision, reason: 'Disable prompt', source: 'card', operation: 'set-enabled', moduleId: module.id, enabled: false });
    expect(await service.engine.worldbookData(id)).toMatchObject({ valid: true, items: [{ moduleId: module.id, content: 'Current author data', promptEnabled: false }] });
    expect((await service.engine.preview(id, { target: 'world', text: 'harbor' })).modules.some(item => item.ref.moduleId === module.id)).toBe(false);
    expect(await readFile(join(root, 'imports', imported.id, 'artifact.json'), 'utf8')).toBe(original);
    expect((await imports.detail(imported.id))!.modules.find(item => item.content === 'Original harbor source')).toBeDefined();
  });

  it('freezes legacy keyword activation before a body-only HTTP edit and rechecks busy/CAS after hydration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-worldbook-edit-legacy-')); roots.push(root);
    const imports = createImportService({ root: join(root, 'imports'), metadataRoot: false });
    const imported = await imports.importBytes(Buffer.from(JSON.stringify({ name: 'Harbor', description: 'A visitor.',
      character_book: { entries: [{ id: 1, name: 'Harbor', content: 'Original harbor source', enabled: true, keys: ['harbor'] }] } })), 'harbor.json');
    const card = imported.nativeCard!, preset = createNativeTemplate('preset') as Preset;
    const module = card.modules.find(item => item.content === 'Original harbor source')!;
    delete module.activation; module.condition = { path: `importActivation.${module.id}`, equals: true };
    let afterHydration: (() => void) | undefined;
    const service = await createApp({ dataRoot: join(root, 'data'), catalog: async () => ({ cards: [card], presets: [preset] }),
      importService: { ...imports, runtimeModules: async (importId, modules) => { const result = await imports.runtimeModules(importId, modules); afterHydration?.(); return result; } },
      provider: { configured: () => false, run: async () => { throw new Error('No model calls'); } } }); cleanups.push(service.close);
    const id = service.store.create(card, preset).id, file = () => readFile(join(root, 'data', `session-${id}.json`), 'utf8');
    const original = await readFile(join(root, 'imports', imported.id, 'artifact.json'), 'utf8');
    expect((await service.engine.preview(id, { target: 'world', text: 'harbor' })).modules.some(item => item.ref.moduleId === module.id)).toBe(true);
    const server: Server = await new Promise(resolve => { const server = service.app.listen(0, '127.0.0.1', () => resolve(server)); });
    cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
    const address = server.address() as { port: number }, url = `http://127.0.0.1:${address.port}/api/sessions/${id}/runtime/worldbook/commands`;
    const post = (content: string, expectedRevision = service.store.get(id).revision) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision, reason: 'Edit old source reference', source: 'card', operation: 'edit', moduleId: module.id, module: { content } }) });
    const before = structuredClone(service.store.get(id)), saved = await file();
    afterHydration = () => { service.engine.busy = () => true; };
    const busy = await post('Never saved while busy'); expect(busy.status).toBe(409); expect((await busy.json()).error.code).toBe('TURN_BUSY');
    expect(service.store.get(id)).toEqual(before); expect(await file()).toBe(saved);
    service.engine.busy = () => false;
    afterHydration = () => { const changed = structuredClone(service.store.get(id)); ++changed.revision; service.store.save(changed); };
    const stale = await post('Never saved after revision change'); expect(stale.status).toBe(409); expect((await stale.json()).error.code).toBe('REVISION_CONFLICT');
    expect(service.store.get(id).card.modules).toEqual(before.card.modules);
    afterHydration = undefined;
    const response = await post('Edited harbor body only'); expect(response.status).toBe(200);
    const edited = (await response.json()).card.modules.find((item: PromptModule) => item.id === module.id);
    expect(edited).toMatchObject({ content: 'Edited harbor body only', activation: { keys: ['harbor'] }, sourcePointer: module.sourcePointer });
    expect(edited).not.toHaveProperty('condition');
    expect((await service.engine.preview(id, { target: 'world', text: 'harbor' })).modules.find(item => item.ref.moduleId === module.id)?.content).toBe('Edited harbor body only');
    expect((await service.engine.preview(id, { target: 'world', text: 'Unrelated keyword' })).modules.some(item => item.ref.moduleId === module.id)).toBe(false);
    expect(new SessionStore(join(root, 'data')).get(id).card.modules.find(item => item.id === module.id)).toEqual(edited);
    expect(await readFile(join(root, 'imports', imported.id, 'artifact.json'), 'utf8')).toBe(original);
  });

  it('fails closed for untranslated legacy activation without source evidence, while allowing explicit native condition edits', async () => {
    const f = await fixture(card => { card.modules = [{ ...moduleFor('old'), condition: { path: 'importActivation.old', equals: true } }]; });
    const before = structuredClone(f.store.get(f.id)), saved = await f.file();
    expect(() => f.command({ operation: 'edit', moduleId: 'old', module: { content: 'New body' } })).toThrow(expect.objectContaining({ code: 'WORLDBOOK_EDIT_ACTIVATION' }));
    expect(f.store.get(f.id)).toEqual(before); expect(await f.file()).toBe(saved);
    const edited = f.command({ operation: 'edit', moduleId: 'old', module: { content: 'New body', condition: null, activation: { keys: ['harbor'] } } });
    expect(edited.card.modules[0]).toMatchObject({ content: 'New body', activation: { keys: ['harbor'] } });
    expect(edited.card.modules[0]).not.toHaveProperty('condition');
  });

  it('exposes the author command API with CAS and a busy guard', async () => {
    const f = await fixture();
    const provider: ModelProvider = { configured: () => false, run: async () => { throw new Error('No model calls'); } };
    const service = await createApp({ dataRoot: f.root, provider, catalog: async () => ({ cards: [f.card], presets: [f.preset] }) }); cleanups.push(service.close);
    const server: Server = await new Promise(resolve => { const server = service.app.listen(0, '127.0.0.1', () => resolve(server)); });
    cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
    const address = server.address() as { port: number }, url = `http://127.0.0.1:${address.port}/api/sessions/${f.id}/runtime/worldbook/commands`;
    const command = { expectedRevision: 0, reason: 'Manual addition', source: 'card', operation: 'add', module: { title: 'Harbor', content: 'Harbor body' } };
    const post = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    expect((await post()).status).toBe(200);
    const stale = await post(); expect(stale.status).toBe(409); expect((await stale.json()).error.code).toBe('REVISION_CONFLICT');
    service.engine.busy = () => true;
    const busy = await post(); expect(busy.status).toBe(409); expect((await busy.json()).error.code).toBe('TURN_BUSY');
    expect(service.store.get(f.id).card.modules).toHaveLength(1);
  });
});
