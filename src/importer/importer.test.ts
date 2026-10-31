import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createImportService, publicImportDetail, convertSource, decodeSource, expandCommonMacros, safeFrontendPreview, selectImportedModules, verifyPreservation } from './index';
import { createNativeTemplate, expandNativeMacros, materializeNativeDocument, nativeModuleActive, validateNativeDocument } from '../shared/native';
import type { CharacterCard, Json, Preset } from '../shared/types';
import { SessionStore, project } from '../server/store';
import { TurnEngine, type ModelProvider } from '../server/engine';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = () => ({ spec: 'chara_card_v3', spec_version: '3.0', description: 'independent outer wording', outerUnknown: { custom: ['original value', false, 8] }, data: { name: 'Safe Ensemble', description: 'Original persona {{user}}.', first_mes: '<div class="panel"><style>.panel {color:red}</style>Original opening</div>', alternate_greetings: ['A second opening.'], character_book: { entries: [
  { comment: 'Always known', content: 'Original world wording.', enabled: true, constant: true, insertion_order: 20, unknown: { x: 1 } },
  { comment: 'River', content: 'Original conditional river wording.', enabled: true, constant: false, keys: ['river'], insertion_order: 5 },
  { comment: 'Inactive', content: 'Original inactive wording.', enabled: false, constant: true, insertion_order: 0 },
  { comment: 'Counter', content: 'Original {{incvar::counter}} macro.', enabled: true, constant: true },
] }, extensions: { regex_scripts: [{ scriptName: 'Panel', disabled: false, findRegex: '<Panel>', replaceString: '<div><style>div{color:blue}</style><script>globalThis.importRan = true</script>Hello</div>', markdownOnly: true }], tavern_helper: { scripts: [{ name: 'Original source', enabled: true, content: 'eventOn("tick", () => {});', data: { untouched: true } }] }, customUnknown: { opaque: 'unchanged extension' } } } });
const originalJson = (source: unknown): Json => decodeSource(Buffer.from(JSON.stringify(source)));
function convert(source: unknown) { return convertSource(originalJson(source), Buffer.from(JSON.stringify(source)), 'safe.json', '2026-01-01T00:00:00.000Z'); }

describe('native import preservation', () => {
  it('imports worldbook structure uniformly without inventing NPCs or numeric fields from entry positions', () => {
    const entries = Array.from({ length: 3 }, (_, index) => ({ name: `Archive entry ${index}`, comment: `Reference ${index}`,
      content: index === 1 ? 'Name: The archivist\nA fictional town biography.' : `Town archive reference ${index}.`, enabled: true, constant: true }));
    const source = { name: 'Town Archive', character_book: { entries } }, before = structuredClone(source);
    const artifact = convert(source), card = artifact.detail.nativeCard!;
    expect(artifact.id).toMatch(/^generic-[a-f0-9]{12}$/); expect(artifact.sourceFormat).toBe('tavern');
    expect(card.roles.map(role => role.id)).toEqual(['player']); expect(card.fields.map(field => field.key)).toEqual(['presence', 'location']);
    expect(card.modules).toHaveLength(3); expect(card.modules.every(module => module.targets.length === 1 && module.targets[0] === 'world')).toBe(true);
    expect(card.world.variables).toEqual({ sourceImportId: artifact.id }); expect(artifact.conflicts).toEqual([]);
    expect(artifact.source).toEqual(before); expect(source).toEqual(before);
    expect(artifact.detail.preservation).toMatchObject({ exactPromptTexts: true, missingPointers: [], addedPromptCharacters: 0 });
  });

  it('retains exact whole texts, unknown fields, outer conflicts and original frontend sources', () => {
    const source = fixture(), result = convert(source);
    expect(result.source).toEqual(source);
    expect(result.container.retainedOuterFields).toContain('outerUnknown');
    expect(result.container.conflicts).toContain('description');
    expect(result.detail.preservation).toMatchObject({ exactPromptTexts: true, missingPointers: [], addedPromptCharacters: 0 });
    expect(result.detail.modules.find(module => module.title === 'Inactive')).toMatchObject({ content: 'Original inactive wording.', sourceEnabled: false });
    expect(result.frontend.find(asset => asset.kind === 'regex')?.source).toEqual(source.data.extensions.regex_scripts[0]);
    expect(result.frontend.some(asset => asset.kind === 'html')).toBe(true);
  });
  it('distinguishes unsupported execution from source disabled and keeps macros untouched', () => {
    const result = convert(fixture()), counter = result.detail.modules.find(module => module.title === 'Counter')!;
    expect(counter).toMatchObject({ content: 'Original {{incvar::counter}} macro.', sourceEnabled: true, disposition: 'needs-adapter' });
    expect(expandCommonMacros('{{user}}/{{char}}/{{getvar::x}}', { user: 'Player', char: 'River' })).toBe('Player/River/{{getvar::x}}');
  });
  it('selects native original text by source activation/order and excludes inactive or unsupported modules', () => {
    const result = convert(fixture());
    expect(selectImportedModules(result, { text: 'river', target: 'world' }).map(module => module.content)).toEqual(['Original conditional river wording.', 'Original world wording.']);
    expect(selectImportedModules(result, { text: 'mountain', target: 'world' }).map(module => module.content)).toEqual(['Original world wording.']);
  });
  it('detects loss, order changes and added executable prompt text independently', () => {
    const source = fixture(), result = convert(source);
    result.texts[0].text = 'changed';
    expect(verifyPreservation(originalJson(source), result).exactPromptTexts).toBe(false);
    const other = convert(source);
    other.detail.nativeCard!.modules[0].content = 'Invented content';
    expect(verifyPreservation(originalJson(source), other).addedPromptCharacters).toBeGreaterThan(0);
  });
  it('retains all preset definitions and order occurrences without automatically enabling unordered definitions', () => {
    const source = { prompts: [{ identifier: 'b', name: 'Second', content: 'Original second.' }, { identifier: 'a', name: 'First', content: 'Original first.' }, { identifier: 'marker', name: 'Marker', marker: true }, { identifier: 'unlisted', name: 'Unlisted', content: 'Unused prose guidance.', enabled: true }], prompt_order: [{ order: [{ identifier: 'a', enabled: false }, { identifier: 'b', enabled: true }] }], unknown: { original: 'retained' } };
    const result = convert(source);
    expect(result.detail.modules.filter(module => module.kind === 'prompt')).toHaveLength(4);
    expect(result.detail.modules.find(module => module.title === 'Unlisted')?.sourceEnabled).toBe(false);
    expect(result.source).toEqual(source);
    expect(selectImportedModules(result, { text: '', target: 'prose' }).map(module => module.content)).toEqual(['Original second.']);
  });
  it('decodes PNG card chunks without decoding image pixels or changing container fields', () => {
    const source = fixture(), value = Buffer.from('chara\0' + Buffer.from(JSON.stringify(source)).toString('base64'));
    const length = Buffer.alloc(4); length.writeUInt32BE(value.length);
    const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), length, Buffer.from('tEXt'), value, Buffer.alloc(4)]);
    expect(decodeSource(png)).toEqual(source);
  });
  it('persists private exact artifacts, exposes metadata, and reloads native catalog', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rp-import-test-')); roots.push(root);
    const service = createImportService({ root, metadataRoot: false }), source = fixture();
    const detail = await service.importBytes(Buffer.from(JSON.stringify(source)), '../../safe.json');
    expect(detail.sourceFile).toBe('safe.json');
    expect((await stat(path.join(root, detail.id, 'artifact.json'))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path.join(root, detail.id, 'source.json'), 'utf8'))).toEqual(source);
    const reloaded = createImportService({ root, metadataRoot: false });
    expect(await reloaded.list()).toHaveLength(1);
    expect((await reloaded.catalog()).cards[0].id).toBe(detail.id);
    expect(await reloaded.detail('../outside')).toBeUndefined();
    expect((await reloaded.frontendAssets(detail.id)).every(asset => asset.executable === false)).toBe(true);
  });
  it('stores generated summaries under the private import root by default', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'alirt-private-import-')); roots.push(root);
    const service = createImportService({ root });
    const detail = await service.importBytes(Buffer.from(JSON.stringify(fixture())), 'town-archive.json');
    const metadata = path.join(root, 'metadata', `${detail.id}.json`);
    expect((JSON.parse(await readFile(metadata, 'utf8')) as { id: string }).id).toBe(detail.id);
    expect((await stat(metadata)).mode & 0o777).toBe(0o600);
    expect((await service.list()).map(entry => entry.id)).toEqual([detail.id]);
    expect((await service.catalog()).cards.map(card => card.id)).toEqual([detail.id]);
  });
  it('creates a host avatar for generic cards and completes the real player projection/composition path', async () => {
    const result = convert(fixture()), card = result.detail.nativeCard!;
    expect(result.hostRoleIds).toEqual(['player']);
    expect(card.roles.find(role => role.id === card.playerRoleId)?.personaSourcePointer).toBeUndefined();
    expect(card.roles.find(role => role.id === card.playerRoleId)).toMatchObject({ name: '你', persona: '', goals: [], phase: 'active', presence: 'present' });
    expect(result.detail.preservation.addedPromptCharacters).toBe(0);
    const root = await mkdtemp(path.join(tmpdir(), 'rp-import-avatar-test-')); roots.push(root);
    const store = new SessionStore(root), preset: Preset = { schema: 'rp.preset/0.1', id: 'test-only', title: 'Test', description: '', modules: [], narration: { person: 'auto', pov: 'auto' } };
    const session = store.create(card, preset);
    expect(project(store.get(session.id), card.playerRoleId).roles.some(role => role.id === card.playerRoleId)).toBe(true);
    const provider: ModelProvider = { configured: () => true, async run(request): Promise<any> {
      if (request.kind === 'role') return { summary: 'Test action.', expression: '', proposals: [] };
      if (request.kind === 'world') return { summary: 'Test event.', changes: [], events: [] };
      return { title: 'Test', text: 'Safe test prose.', person: 'third', pov: 'limited' };
    } };
    const engine = new TurnEngine(store, provider);
    engine.submit(session.id, { requestId: 'import-avatar-test', expectedRevision: 0, action: 'Safe test action.', mode: 'action' });
    await engine.idle(session.id);
    expect(store.get(session.id).turns[0].status).toBe('completed');
    expect(store.get(session.id).prose[0].text).toBe('Safe test prose.');
    await engine.close();
  });
  it('unwraps only complete outer HTML fences and preserves inner fences and source strings', () => {
    const source = '```html\n<div>Original <pre>```text\nNested example\n```</pre></div>\n```';
    const preview = safeFrontendPreview(source);
    expect(preview).toContain('<div>Original <pre>```text\nNested example\n```</pre></div>');
    expect(preview).not.toContain('```html');
    expect(source).toContain('```html');
    const embedded = 'Leading prose\n```html\n<div>Original</div>\n```\nTrailing prose';
    expect(safeFrontendPreview(embedded)).toContain(embedded);
    const unlabeled = '```\n<div>Original</div>\n```';
    expect(safeFrontendPreview(unlabeled)).toContain(unlabeled);
  });
  it('preserves control classes/text as disabled static markup and removes navigation/submission hooks', () => {
    const original = '<form class="original-form" action="https://example.test/post" onsubmit="run()"><button class="original-button" onclick="run()" formaction="https://example.test/override">Original button</button><input class="original-input" value="Original value" autofocus><select class="original-select"><option>Original option</option></select><textarea>Original notes</textarea><a href="javascript:run()" target="_top" ping="https://example.test/ping">Original link</a><img src="https://example.test/pixel" onerror="run()"><iframe srcdoc="test"></iframe></form>';
    const preview = safeFrontendPreview(original);
    expect(preview).toContain('<form class="original-form" inert>');
    expect(preview).toContain('<button class="original-button" disabled>Original button</button>');
    expect(preview).toContain('<input class="original-input" value="Original value" disabled>');
    expect(preview).toContain('<select class="original-select" disabled><option disabled>Original option</option></select>');
    expect(preview).toContain('<textarea disabled>Original notes</textarea>');
    expect(preview).toContain('<a>Original link</a>');
    expect(preview).not.toMatch(/https?:|javascript:|onclick=|onsubmit=|onerror=|srcdoc=|autofocus|<iframe/i);
    expect(original).toContain('onclick="run()"');
  });
  it('upgrades old persisted keyword placeholders on read and forks edited text without touching the source IR', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rp-import-portable-test-')); roots.push(root);
    const service = createImportService({ root, metadataRoot: false });
    const detail = await service.importBytes(Buffer.from(JSON.stringify(fixture())), 'safe.json');
    const artifactPath = path.join(root, detail.id, 'artifact.json'), legacy = JSON.parse(await readFile(artifactPath, 'utf8'));
    const original = legacy.detail.nativeCard.modules.find((module: any) => module.title === 'River');
    delete original.activation; original.condition = { path: `importActivation.${original.id}`, equals: true };
    const owned = legacy.detail.nativeCard.modules.find((module: any) => module.title === 'Always known');
    owned.condition = { path: 'role.id', equals: 'player' }; owned.targets = ['role']; owned.phase = 'decide';
    await writeFile(artifactPath, JSON.stringify(legacy));
    const before = await readFile(artifactPath, 'utf8');
    const loaded = createImportService({ root, metadataRoot: false }), catalog = await loaded.catalog(), visible = (await loaded.detail(detail.id))!.nativeCard!;
    expect(visible.modules.find(module => module.title === 'River')!.activation).toEqual({ keys: ['river'] });
    expect(catalog.cards[0].modules).toEqual(visible.modules);
    const fork = materializeNativeDocument(visible) as CharacterCard;
    fork.modules.find(module => module.title === 'River')!.content = 'Edited conditional wording {{user}}.';
    expect(fork.modules.filter(module => module.targets.includes('world') && nativeModuleActive(module, { text: 'river' })).map(module => module.content)).toContain('Edited conditional wording {{user}}.');
    expect(fork.modules.filter(module => nativeModuleActive(module, { text: 'mountain' })).some(module => module.title === 'River')).toBe(false);
    const ownedFork = fork.modules.find(module => module.title === 'Always known')!;
    expect(nativeModuleActive(ownedFork, { roleId: 'player' })).toBe(true); expect(nativeModuleActive(ownedFork, { roleId: 'other' })).toBe(false);
    expect(fork.compatibility).toBeUndefined(); expect(validateNativeDocument('card', fork)).toEqual([]);
    expect(await readFile(artifactPath, 'utf8')).toBe(before);
    expect(verifyPreservation(originalJson(fixture()), legacy).exactPromptTexts).toBe(true);
    expect(publicImportDetail(legacy).nativeCard!.modules.find(module => module.title === 'River')!.content).toBe('Original conditional river wording.');
  });
  it('round-trips exported native cards and presets with exact unknown data, activation, ownership and edits', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rp-import-native-json-test-')); roots.push(root);
    const service = createImportService({ root, metadataRoot: false });
    for (const kind of ['card', 'preset'] as const) {
      const document = createNativeTemplate(kind) as ReturnType<typeof createNativeTemplate> & { custom?: unknown };
      document.id = 'existing-builtin-id'; document.title = 'Original native title'; document.custom = { original: [false, 9, 'exact wording'] };
      document.compatibility = { importId: 'old-source-id', status: 'original', warnings: ['Original warning'] };
      document.modules = [{ id: 'original-module', title: 'Original module', content: 'Original {{user}} text.', category: 'supplement', enabled: true, targets: ['role'], phase: 'decide', priority: 9, sourcePointer: '/original/source/content', activation: { keys: ['river'], secondaryKeys: ['night'], selective: true }, condition: { path: 'role.id', equals: 'player' } }, { id: 'disabled-module', title: 'Disabled', content: 'Original disabled text.', category: 'style', enabled: false, targets: ['prose'], phase: 'compose', priority: 1 }];
      if ('roles' in document) { document.roles[0].persona = 'Original whole persona.'; document.roles[0].personaSourcePointer = '/original/persona'; document.opening = '<div><button class="original" onclick="run()">Original opening</button></div>'; }
      const bytes = Buffer.from(JSON.stringify(document)), originalText = bytes.toString('utf8');
      const detail = await service.importBytes(bytes, `${kind}.json`), imported = (kind === 'card' ? detail.nativeCard : detail.nativePreset)!;
      expect(detail.kind).toBe(kind); expect(imported.id).toMatch(new RegExp(`^native${kind}-[a-f0-9]{12}$`)); expect(imported.id).not.toBe(document.id);
      expect(imported.modules).toEqual(document.modules); expect((imported as any).custom).toEqual(document.custom); expect(imported.compatibility).toBeUndefined();
      expect((imported as any).sourceCompatibility).toEqual(document.compatibility);
      if ('roles' in imported) { expect(imported.roles[0].persona).toBe('Original whole persona.'); expect(imported.opening).toBe((document as CharacterCard).opening); }
      const fork = materializeNativeDocument(imported); fork.modules[0].content = 'Edited {{user}} text.';
      expect(nativeModuleActive(fork.modules[0], { text: 'River at night', roleId: 'player' })).toBe(true);
      expect(nativeModuleActive(fork.modules[0], { text: 'River at night', roleId: 'other' })).toBe(false);
      expect(expandNativeMacros(fork.modules[0].content, { user: 'Player' })).toBe('Edited Player text.');
      expect(validateNativeDocument(kind, fork)).toEqual([]);
      expect((await service.catalog())[kind === 'card' ? 'cards' : 'presets'].some(item => item.id === imported.id && item.modules[0].content === 'Original {{user}} text.')).toBe(true);
      expect(detail.preservation).toMatchObject({ exactPromptTexts: true, missingPointers: [], addedPromptCharacters: 0 });
      expect(await readFile(path.join(root, detail.id, 'original.bin'), 'utf8')).toBe(originalText);
      expect(JSON.parse(await readFile(path.join(root, detail.id, 'source.json'), 'utf8'))).toEqual(document);
      expect((await service.selectModules(detail.id, { text: 'River at night', roleId: 'player', target: 'role', user: 'Player' }))[0].content).toBe('Original Player text.');
    }
  });
  it('rejects invalid native schemas/references instead of falling back to Tavern conversion', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rp-import-invalid-native-test-')); roots.push(root);
    const service = createImportService({ root, metadataRoot: false }), document = createNativeTemplate('card') as CharacterCard;
    document.playerRoleId = 'missing';
    await expect(service.importBytes(Buffer.from(JSON.stringify({ ...document, name: 'Must not become Tavern' })), 'invalid.json')).rejects.toThrow('Invalid native card');
    await expect(service.importBytes(Buffer.from(JSON.stringify({ ...document, schema: 'rp.card/9', name: 'Must not become Tavern' })), 'invalid-version.json')).rejects.toThrow('Invalid native card');
    const hostile = createNativeTemplate('card') as CharacterCard;
    hostile.roles[0].id = '../../escaped-role'; hostile.playerRoleId = '../../escaped-role';
    await expect(service.importBytes(Buffer.from(JSON.stringify(hostile)), 'hostile-role.json')).rejects.toThrow('Identifiers cannot contain path separators or control characters');
    expect(await service.list()).toEqual([]);
  });
  it('strips execution hooks from portable previews and installs a network-denying CSP', () => {
    const html = safeFrontendPreview('<div onclick="test()"><script>test()</script><iframe src="x"></iframe><style>div{color:red}</style>Original</div>');
    expect(html).toContain('default-src'); expect(html).toContain('Original'); expect(html).toContain('color:red');
    expect(html).not.toMatch(/<script|onclick=|<iframe/i);
  });
});
