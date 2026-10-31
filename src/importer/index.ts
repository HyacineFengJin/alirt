import { mkdir, readFile, readdir, writeFile, rename, chmod } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Catalog, ImportDetail, ImportSummary, PromptModule } from '../shared/types';
import { convertSource, selectImportedModules, isPublicSourceSafe, portableNativeProjection, hydrateImportedModules } from './compiler';
import { decodeSource } from './intake';
import type { ImportArtifact } from './types';
export { convertSource, expandCommonMacros, safeFrontendPreview, selectImportedModules, hydrateImportedModules, verifyPreservation } from './compiler';
export { decodeSource, collectTexts, atPointer } from './intake';
export type { ImportArtifact, NativeMapping, FrontendAsset, ConversionConflict } from './types';

export interface ImportServiceOptions { root?: string; sourceFiles?: string[]; metadataRoot?: string | false; }
function summary(detail: ImportDetail): ImportSummary {
  const { modules: _modules, nativeCard: _card, nativePreset: _preset, preservation: _preservation, ...result } = detail;
  return result;
}
/** Public metadata is explicit about isolated contents; exact originals live in the private IR. */
export function publicImportDetail(artifact: ImportArtifact): ImportDetail {
  const { runtime: _runtime, ...detail } = artifact.detail;
  const card = detail.nativeCard ? portableNativeProjection(artifact, detail.nativeCard) : undefined;
  const preset = detail.nativePreset ? portableNativeProjection(artifact, detail.nativePreset) : undefined;
  return { ...detail, ...(card ? { nativeCard: card } : {}), ...(preset ? { nativePreset: preset } : {}), modules: detail.modules.map(module => ({ ...module,
    content: module.disposition === 'isolated' ? '[隔离原文：逐字保留在私有导入 IR；本 SFW 原生视图未加载。]' : /^(regex|javascript)$/.test(module.kind) ? '[原始前端完整保留；在前端资产查看器中以禁用源码查看，未执行。]' : module.content,
  })) };
}
export function createImportService(options: ImportServiceOptions = {}) {
  const root = options.root ?? process.env.RP_IMPORT_ROOT ?? path.resolve('.rp-data/imports');
  const metadataRoot = options.metadataRoot === undefined ? path.join(root, 'metadata') : options.metadataRoot;
  const cache = new Map<string, ImportArtifact>();
  const validId = (id: string) => /^[a-z]+-[a-f0-9]{12}$/.test(id);
  const ensure = async () => { await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700); };
  async function saveJson(filename: string, value: unknown) {
    const temp = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temp, filename);
  }
  async function artifact(id: string): Promise<ImportArtifact | undefined> {
    if (!validId(id)) return undefined;
    if (cache.has(id)) return cache.get(id);
    try { const value = JSON.parse(await readFile(path.join(root, id, 'artifact.json'), 'utf8')) as ImportArtifact; cache.set(id, value); return value; }
    catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
  }
  async function list(): Promise<ImportSummary[]> {
    await ensure(); const ids = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && validId(entry.name)).map(entry => entry.name);
    const results = await Promise.all(ids.map(async id => {
      try { return JSON.parse(await readFile(path.join(root, id, 'summary.json'), 'utf8')) as ImportSummary; }
      catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
    }));
    return results.filter((result): result is ImportSummary => !!result).sort((a, b) => a.title.localeCompare(b.title));
  }
  async function importBytes(bytes: Uint8Array, filename: string): Promise<ImportDetail> {
    await ensure(); const safeName = path.basename(filename.replaceAll('\\', '/')).slice(0, 240) || 'upload.json';
    const converted = convertSource(decodeSource(bytes), bytes, safeName), directory = path.join(root, converted.id);
    const previous = await artifact(converted.id); if (previous) converted.detail.importedAt = previous.detail.importedAt;
    await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
    await writeFile(path.join(directory, 'original.bin'), bytes, { mode: 0o600 });
    await saveJson(path.join(directory, 'source.json'), converted.source);
    await saveJson(path.join(directory, 'artifact.json'), converted);
    await saveJson(path.join(directory, 'summary.json'), summary(converted.detail));
    await saveJson(path.join(directory, 'verification.json'), { schema: 'rp.import-verification/0.1', id: converted.id, sourceHash: converted.sourceHash, preservation: converted.detail.preservation, stringLeaves: converted.texts.length, sourceModuleCount: converted.detail.modules.length, sourceRoleCount: converted.detail.nativeCard?.roles.filter(role => !converted.hostRoleIds.includes(role.id)).length ?? 0, hostRoleCount: converted.hostRoleIds.length, sourcePromptDefinitions: converted.detail.modules.filter(m => m.kind === 'prompt').length, mappedModules: converted.mappings.filter(m => m.admission === 'admitted').length, isolatedModules: converted.mappings.filter(m => m.admission === 'isolated').length, adapterModules: converted.mappings.filter(m => m.admission === 'adapter').length, roles: converted.detail.nativeCard?.roles.map(r => ({ id: r.id, name: r.name, phase: r.phase, ...(r.personaSourcePointer ? { personaSourcePointer: r.personaSourcePointer } : {}), origin: converted.hostRoleIds.includes(r.id) ? 'host' : 'source' })) ?? [], frontendAssets: converted.frontend.length, conflicts: converted.conflicts, limitations: ['Exact source strings retained as data; execution equivalence is not claimed.', 'No imported JavaScript or regex executed; no remote resource fetched.', 'Native conditions support simple source keyword activation only; timing, regex-key, recursive and mutation macro semantics require adapters.'] });
    if (metadataRoot) { await mkdir(metadataRoot, { recursive: true }); await saveJson(path.join(metadataRoot, `${converted.id}.json`), { ...summary(converted.detail), sourcePromptDefinitions: converted.detail.modules.filter(m => m.kind === 'prompt').length, preservation: converted.detail.preservation, roleCount: converted.detail.nativeCard?.roles.length ?? 0, sourceRoleCount: converted.detail.nativeCard?.roles.filter(role => !converted.hostRoleIds.includes(role.id)).length ?? 0, hostRoleCount: converted.hostRoleIds.length, nativeModuleCount: converted.mappings.filter(m => m.admission === 'admitted').length, isolatedModuleCount: converted.mappings.filter(m => m.admission === 'isolated').length, adapterModuleCount: converted.mappings.filter(m => m.admission === 'adapter').length, conflicts: converted.conflicts }); }
    cache.set(converted.id, converted); return publicImportDetail(converted);
  }
  async function importFile(filename: string) { return importBytes(await readFile(filename), path.basename(filename)); }
  async function detail(id: string) { const value = await artifact(id); return value ? publicImportDetail(value) : undefined; }
  async function catalog(): Promise<Catalog> {
    const entries = await Promise.all((await list()).map(item => artifact(item.id)));
    return { cards: entries.flatMap(item => item?.detail.nativeCard ? [portableNativeProjection(item, item.detail.nativeCard)] : []), presets: entries.flatMap(item => item?.detail.nativePreset ? [portableNativeProjection(item, item.detail.nativePreset)] : []) };
  }
  async function selectModules(id: string, context: Parameters<typeof selectImportedModules>[1]) {
    const value = await artifact(id); if (!value) return [];
    return selectImportedModules(value, context);
  }
  async function runtimeModules(id: string, snapshotModules: PromptModule[]): Promise<PromptModule[]> {
    const value = await artifact(id);
    return value ? hydrateImportedModules(value, snapshotModules) : structuredClone(snapshotModules);
  }
  async function frontendAssets(id: string) {
    const value = await artifact(id);
    // UI may render previewHtml only inside an iframe sandbox without allow-scripts or allow-same-origin.
    return value?.frontend.map(asset => {
      const sourceText = typeof asset.source === 'string' ? asset.source : JSON.stringify(asset.source, null, 2);
      const sourceAdmitted = isPublicSourceSafe(sourceText);
      return { pointer: asset.pointer, kind: asset.kind, executable: false as const, missingApis: asset.missingApis, remoteReferences: asset.remoteReferences, sourceText: sourceAdmitted ? sourceText : '[隔离原始前端：完整源码保留于私有导入 IR；未加载到 SFW 预览。]', sourceAdmitted, ...(asset.previewHtml ? { previewHtml: asset.previewHtml } : {} ) };
    }) ?? [];
  }
  async function initialize() { for (const filename of options.sourceFiles ?? []) await importFile(filename); }
  return { list, detail, importBytes, importFile, catalog, selectModules, runtimeModules, frontendAssets, initialize, artifact: async (id: string) => {
    const value = await artifact(id); return value ? structuredClone(value) : undefined;
  } };
}
