import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertSource, selectImportedModules } from '../importer/compiler';
import type { CreativeKind, NativeDocument } from '../shared/creator';
import { createNativeTemplate } from '../shared/native';
import type { Json, PromptModule } from '../shared/types';
import { CreatorStore } from './creator';
import { validateRuntimeDocument } from './worldbook-runtime';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const body = '  Harbor reference: 海风轻拂。\nKeep {{user}} and the original spacing.\n';
function documentFor(kind: CreativeKind): NativeDocument {
  const document = createNativeTemplate(kind);
  const module: PromptModule = {
    id: 'harbor-reference', title: 'Harbor', category: 'supplement', content: body,
    enabled: true, targets: ['world'], phase: 'coordinate', priority: 0,
  };
  document.modules = [Object.assign(module, { authorNotes: { exact: ['retain', false, 7] } })];
  document.worldbook = {
    schema: 'rp.worldbook/0.1', bindings: [Object.assign({
      id: 'harbor-binding', moduleId: module.id, purpose: 'reference' as const,
      contentHash: digest(body),
      source: { importId: 'original-harbor', sourceHash: 'a'.repeat(64), pointer: '/entries/0/content', entryId: 0 },
    }, { authorNotes: 'Keep the original binding metadata.' })],
  };
  return Object.assign(document, { customWorldbookMetadata: { original: [false, 9, 'unchanged'] } });
}
const convert = (document: NativeDocument) => convertSource(document as unknown as Json, Buffer.from(JSON.stringify(document)), 'harbor.json', '2026-01-01T00:00:00.000Z');

describe('worldbook authoring integrity', () => {
  it.each(['card', 'preset'] as const)('retains an edited %s draft, reports its current body hash, and only publishes after explicit hash repair', async kind => {
    const root = await mkdtemp(join(tmpdir(), 'rp-worldbook-authoring-')); roots.push(root);
    const store = new CreatorStore(root), original = documentFor(kind);
    const created = store.create({ kind }, original);
    expect(created.issues).toEqual([]);
    const editedBody = body + 'An author adds a quiet lighthouse.\n';
    store.patch(created.id, 'local-authoring-test', {
      key: 'edit-reference', expectedRevision: 0, summary: 'Preserve the author edit pending binding review',
      operations: [{ op: 'replace', path: '/modules/0/content', value: editedBody }],
    });
    const draft = store.read(created.id), expectedIssue = {
      path: '/worldbook/bindings/0/contentHash', message: expect.stringContaining(digest(editedBody)),
    };
    expect(draft.revision).toBe(1);
    expect(draft.document.modules[0].content).toBe(editedBody);
    expect(draft.document.worldbook).toEqual(original.worldbook);
    expect(draft.issues).toEqual([expectedIssue]);
    expect(validateRuntimeDocument(kind, draft.document)).toEqual([expectedIssue]);
    expect(new CreatorStore(root).read(created.id)).toEqual(draft);
    const filename = join(root, `creator-${created.id}.json`), saved = await readFile(filename, 'utf8');
    expect(() => store.publish(created.id, { expectedRevision: 1 })).toThrow(expect.objectContaining({
      code: 'CREATOR_INVALID_DRAFT', issues: [expectedIssue],
    }));
    expect(store.read(created.id)).toEqual(draft);
    expect(await readFile(filename, 'utf8')).toBe(saved);
    expect(store.catalog()).toEqual({ cards: [], presets: [] });

    store.patch(created.id, 'local-authoring-test', {
      key: 'review-binding', expectedRevision: 1, summary: 'Bind the reviewed current body without rewriting it',
      operations: [{ op: 'replace', path: '/worldbook/bindings/0/contentHash', value: digest(editedBody) }],
    });
    const repaired = store.read(created.id);
    expect(repaired.issues).toEqual([]);
    expect(repaired.document.modules).toEqual(draft.document.modules);
    expect(repaired.revisions[1].document.modules[0].content).toBe(editedBody);
    const publication = store.publish(created.id, { expectedRevision: 2 });
    const published = (kind === 'card' ? store.catalog().cards : store.catalog().presets)[0];
    expect(published).toEqual({ ...repaired.document, id: publication.id });
    expect(published.modules[0].content).toBe(editedBody);
    expect(new CreatorStore(root).catalog()).toEqual(store.catalog());
  });

  it.each(['card', 'preset'] as const)('imports a valid native %s with exact bound text and unknown fields, and rejects stale hashes', kind => {
    const document = documentFor(kind), artifact = convert(document);
    const imported = (kind === 'card' ? artifact.detail.nativeCard : artifact.detail.nativePreset)!;
    expect(artifact.sourceFormat).toBe('native');
    expect(artifact.source).toEqual(document);
    expect(imported).toEqual({ ...document, id: artifact.id });
    expect(imported.modules[0].content).toBe(body);
    expect(artifact.detail.preservation).toMatchObject({ exactPromptTexts: true, missingPointers: [], addedPromptCharacters: 0 });
    const invalid = structuredClone(document);
    invalid.modules[0].content += 'A newly edited harbor description.';
    expect(() => convert(invalid)).toThrow(/worldbook.*hash/i);
    expect(invalid.modules[0].content).toBe(body + 'A newly edited harbor description.');
    expect(invalid.worldbook).toEqual(document.worldbook);
  });

  it('requires host compilation for native and legacy imported documents carrying worldbook bindings', () => {
    const native = convert(documentFor('card'));
    const legacySource: Json = { name: 'Quiet harbor', description: body };
    const legacy = convertSource(legacySource, Buffer.from(JSON.stringify(legacySource)), 'legacy-harbor.json');
    const legacyDocument = legacy.detail.nativeCard!;
    expect(selectImportedModules(legacy, { text: '', target: 'prose' }).map(module => module.content)).toContain(body);
    legacyDocument.worldbook = {
      schema: 'rp.worldbook/0.1', bindings: [{ id: 'legacy-binding', moduleId: legacyDocument.modules[0].id, purpose: 'ui-data' }],
    };
    for (const artifact of [native, legacy]) for (const target of ['role', 'world', 'prose'] as const) {
      expect(() => selectImportedModules(artifact, { text: 'harbor', target, roleId: 'player', snapshot: {} }))
        .toThrow(/host prompt compiler/);
    }
  });
});
