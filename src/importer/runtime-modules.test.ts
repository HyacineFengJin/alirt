import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { convertSource, createImportService, hydrateImportedModules, selectImportedModules } from './index';
import type { Json, PromptModule } from '../shared/types';

const source = { name: 'Runtime bridge', character_book: { entries: [
  { comment: 'River', content: 'Original river details.', enabled: true, constant: false, keys: ['river'], secondary_keys: ['night'], selective: true },
] } };
const bytes = Buffer.from(JSON.stringify(source));
function fixture() {
  const artifact = convertSource(source as Json, bytes, 'runtime.json');
  const original = artifact.detail.nativeCard!.modules[0];
  delete original.activation;
  original.condition = { path: `importActivation.${original.id}`, equals: true };
  return { artifact, original };
}
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('bound imported document runtime bridge', () => {
  it('translates a verified legacy placeholder without mutating snapshots or source artifacts', () => {
    const { artifact, original } = fixture(), snapshot = structuredClone([original]);
    const beforeArtifact = structuredClone(artifact), beforeSnapshot = structuredClone(snapshot);
    const result = hydrateImportedModules(artifact, snapshot);
    expect(result[0]).toEqual({ ...original, condition: undefined, activation: { keys: ['river'], secondaryKeys: ['night'], selective: true } });
    expect(result[0]).not.toHaveProperty('condition');
    expect(snapshot).toEqual(beforeSnapshot); expect(artifact).toEqual(beforeArtifact);
    result[0].activation!.keys.push('lake');
    expect(artifact.mappings[0].control.keys).toEqual(['river']);
  });

  it('preserves all snapshot controls, explicit activation, additions, ordering and edited text', () => {
    const { artifact, original } = fixture();
    const edited: PromptModule = { ...structuredClone(original), title: 'Owned title', category: 'constraint', enabled: false, priority: -30, targets: ['role', 'prose'], phase: 'compose', audience: 'author', inject: { slot: 'before-action', order: 7 }, dependsOn: ['owned'], exclusiveGroup: 'owned-group', required: true, activation: { keys: ['lake'], match: 'word', caseSensitive: true } };
    const owned: PromptModule = { ...structuredClone(original), id: 'owned', content: 'Owned text.', condition: { all: [{ path: 'role.id', op: 'eq', value: 'player' }] } };
    const result = hydrateImportedModules(artifact, [owned, edited]);
    const { condition: _legacy, ...expected } = edited;
    expect(result).toEqual([owned, expected]);
    const rewritten = { ...edited, content: 'Edited original source wording.' };
    expect(hydrateImportedModules(artifact, [rewritten])).toEqual([rewritten]);
  });

  it('leaves wrong pointers, mismatched raw content, unadmitted mappings and unresolved identities unchanged', () => {
    const { artifact, original } = fixture();
    const snapshots: PromptModule[] = [
      { ...original, sourcePointer: '/different/content' },
      { ...original, content: 'Edited wording.' },
      { ...original, id: 'unresolved', condition: { path: 'importActivation.unresolved', equals: true } },
    ];
    expect(hydrateImportedModules(artifact, snapshots)).toEqual(snapshots);
    artifact.mappings[0].admission = 'adapter';
    expect(hydrateImportedModules(artifact, [original])).toEqual([original]);
    artifact.mappings[0].admission = 'admitted';
    (artifact.source as typeof source).character_book.entries[0].content = 'Different raw source.';
    expect(hydrateImportedModules(artifact, [original])).toEqual([original]);
  });

  it('does not translate native imported documents or native comparison/logical conditions', () => {
    const { artifact, original } = fixture();
    const snapshots: PromptModule[] = [
      { ...original, condition: { path: `importActivation.${original.id}`, op: 'exists' } },
      { ...original, condition: { all: [{ path: 'role.id', equals: 'player' }] } },
    ];
    expect(hydrateImportedModules(artifact, snapshots)).toEqual(snapshots);
    artifact.sourceFormat = 'native';
    expect(hydrateImportedModules(artifact, [original])).toEqual([original]);
  });

  it('keeps selector phase filtering optional and handles portable comparison conditions', () => {
    const { artifact, original } = fixture();
    original.phase = 'compose'; original.condition = { path: 'role.id', op: 'eq', value: 'player' };
    const context = { text: 'river at night', target: 'world' as const, roleId: 'player' };
    expect(selectImportedModules(artifact, context)).toHaveLength(1);
    expect(selectImportedModules(artifact, { ...context, phase: 'coordinate' })).toEqual([]);
    expect(selectImportedModules(artifact, { ...context, phase: 'compose' })).toHaveLength(1);
  });

  it('loads runtime compatibility evidence without replacing snapshot modules, and clones on missing imports', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rp-runtime-bridge-')); roots.push(root);
    const service = createImportService({ root, metadataRoot: false });
    const detail = await service.importBytes(bytes, 'runtime.json');
    const filename = path.join(root, detail.id, 'artifact.json');
    const legacy = JSON.parse(await readFile(filename, 'utf8'));
    const original = legacy.detail.nativeCard.modules[0];
    delete original.activation; original.condition = { path: `importActivation.${original.id}`, equals: true };
    await writeFile(filename, JSON.stringify(legacy));
    const reloaded = createImportService({ root, metadataRoot: false });
    const snapshot: PromptModule[] = [{ ...original, enabled: false, priority: 100, targets: ['prose'], phase: 'compose' }];
    const runtime = await reloaded.runtimeModules(detail.id, snapshot);
    expect(runtime[0]).toMatchObject({ enabled: false, priority: 100, targets: ['prose'], phase: 'compose', content: original.content, activation: { keys: ['river'] } });
    expect(runtime).toHaveLength(1);
    const missing = await reloaded.runtimeModules('missing-000000000000', snapshot);
    expect(missing).toEqual(snapshot); expect(missing).not.toBe(snapshot); expect(missing[0]).not.toBe(snapshot[0]);
    expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual(legacy);
  });
});
