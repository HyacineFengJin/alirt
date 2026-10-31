import { createHash } from 'node:crypto';
import { expandNativeMacros, materializeNativeDocument, nativeModuleActive, validateNativeDocument } from '../shared/native';
import type { NativeDocument } from '../shared/creator';
import type { CharacterCard, ImportDetail, ImportModule, Json, Preset, PromptModule, RoleDefinition, StateField } from '../shared/types';
import { atPointer, auditContainer, collectTexts, escapePointer, object } from './intake';
import type { FrontendAsset, ImportArtifact, NativeMapping, SourceControl } from './types';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sensitive = /(?:nsfw|色情|性癖|性爱|性交|性器|阴茎|阴道|乳交|口交|肛交|自慰|射精|发情|高潮|淫乱|肉棒|媚药|调教|强奸|幼女|萝莉|恋童|成人向|性爱|性描写)/i;
const bypass = /(?:jailbreak|越狱|绕过.{0,12}(?:限制|审查)|无视.{0,12}(?:安全|政策|限制)|ignore.{0,30}(?:safety|policy)|unrestricted.{0,15}(?:sexual|content)|不受.{0,12}(?:道德|伦理|限制)|chain.of.thought|思维链|<think>)/i;
const unsupported = /\{\{\s*(?!(?:user|char)\s*\}\})[^{}]+\}\}|<\/?(?:UpdateVariable|JSONPatch|analysis|thinking|think)>|_\.set\(/i;
const sensitiveSource = (text: string) => sensitive.test(text.replaceAll('角色情感', '角色·情感').replaceAll('白色情人节', '白色·情人节'));
export const isPublicSourceSafe = (text: string) => !sensitiveSource(text) && !bypass.test(text);
export { safeFrontendPreview } from '../shared/html-preview';
import { safeFrontendPreview } from '../shared/html-preview';

export function expandCommonMacros(text: string, context: { user?: string; char?: string }): string {
  return expandNativeMacros(text, context);
}
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return object(value) ? Object.values(value).flatMap(strings) : [];
}
function readControl(entry: Record<string, any>, index: number): SourceControl {
  return { enabled: typeof entry.enabled === 'boolean' ? entry.enabled : null, order: typeof entry.insertion_order === 'number' ? entry.insertion_order : index,
    ...(typeof entry.constant === 'boolean' ? { constant: entry.constant } : {}),
    ...(Array.isArray(entry.keys) ? { keys: entry.keys.filter((k: any) => typeof k === 'string') } : {}),
    ...(Array.isArray(entry.secondary_keys) ? { secondaryKeys: entry.secondary_keys.filter((k: any) => typeof k === 'string') } : {}),
    ...(typeof entry.selective === 'boolean' ? { selective: entry.selective } : {}),
    ...(typeof entry.selectiveLogic === 'number' ? { selectiveLogic: entry.selectiveLogic } : {}),
    ...(object(entry.extensions) ? { extensions: entry.extensions as Json } : {}) };
}
function classify(text: string, title: string, pointer: string, control: SourceControl): Pick<NativeMapping, 'admission' | 'reasons' | 'target'> {
  if (sensitiveSource(text + '\n' + title) || bypass.test(text)) return { admission: 'isolated', target: 'archive', reasons: ['Original retained privately; excluded from the SFW executable subset. Source enable switch is unchanged.'] };
  if (unsupported.test(text)) return { admission: 'adapter', target: 'archive', reasons: ['Source macro or text operation requires a runtime adapter; original text remains unchanged.'] };
  const ext = control.extensions as Record<string, Json> | undefined;
  if (ext && (ext.delay_until_recursion || ext.sticky || ext.cooldown || ext.delay || ext.probability !== undefined && ext.probability !== 100 || ext.selectiveLogic && ext.selectiveLogic !== 0 || ext.match_whole_words || ext.case_sensitive || control.keys?.some(key => /^\/.+\/[gimsuy]*$/.test(key)))) return { admission: 'adapter', target: 'archive', reasons: ['Recursion, timing or probability semantics require an adapter.'] };
  const target = /(?:文风|人称|镜头|叙事|描写|写作|选项|格式|视角)/.test(title) ? 'prose' : /character_book/.test(pointer) ? 'world' : 'prose';
  return { admission: 'admitted', target, reasons: [] };
}

function convertNativeSource(sourceValue: Json, bytes: Uint8Array, filename: string, importedAt: string): ImportArtifact {
  const source = sourceValue as Record<string, any>, kind = source.schema.startsWith('rp.card/') ? 'card' : 'preset';
  const issues = validateNativeDocument(kind, source);
  if (issues.length) throw new Error(`Invalid native ${kind}: ${issues.slice(0, 8).map(issue => `${issue.path}: ${issue.message}`).join('; ')}`);
  if ((source.worldbook?.bindings ?? []).some((binding: any) => binding.contentHash && binding.contentHash.toLowerCase() !== hash(source.modules.find((module: PromptModule) => module.id === binding.moduleId).content)))
    throw new Error('Invalid native worldbook: a body hash does not match its bound module text.');
  const sourceHash = hash(bytes), id = `${kind === 'card' ? 'nativecard' : 'nativepreset'}-${sourceHash.slice(0, 12)}`;
  const document = materializeNativeDocument(source as NativeDocument); document.id = id;
  const texts = collectTexts(sourceValue), mappings: NativeMapping[] = [], modules: ImportModule[] = [], frontend: FrontendAsset[] = [];
  source.modules.forEach((module: PromptModule, i: number) => {
    const pointer = `/modules/${i}/content`;
    mappings.push({ moduleId: module.id, pointer, target: module.targets[0], control: { enabled: module.enabled, order: module.priority }, admission: 'admitted', reasons: [] });
    modules.push({ id: module.id, title: module.title, kind: 'prompt', pointer, content: module.content, sourceEnabled: module.enabled, disposition: 'native', notes: [] });
  });
  for (const leaf of texts) {
    if (!/<(?:!doctype|html|div|style)\b/i.test(leaf.text)) continue;
    const remoteReferences = [...new Set(leaf.text.match(/https?:\/\/[^\s'"<>`]+/g) ?? [])];
    frontend.push({ pointer: leaf.pointer, kind: 'html', source: leaf.text, executable: false, missingApis: /<script\b|\bon[a-z]+=/i.test(leaf.text) ? ['embedded browser scripts (disabled)'] : [], remoteReferences, ...(isPublicSourceSafe(leaf.text) ? { previewHtml: safeFrontendPreview(leaf.text) } : {}) });
  }
  const warnings = ['Native schema imported as a standalone editable document; active source-import redirects are removed.', 'Original fields, module text, source enable switches and conditions are retained. Embedded frontend code is never executed.'];
  const detail: ImportDetail = { id, title: document.title, kind, importedAt, sourceFile: filename, promptCount: source.modules.length, frontendCount: frontend.length, status: 'native', warnings, modules, ...(kind === 'card' ? { nativeCard: document as CharacterCard } : { nativePreset: document as Preset }), preservation: { exactPromptTexts: true, inputPrompts: 0, retainedPrompts: 0, missingPointers: [], addedPromptCharacters: 0 } };
  const artifact: ImportArtifact = { schema: 'rp.import/0.1', sourceFormat: 'native', id, sourceHash, source: sourceValue, texts, hostRoleIds: [], detail, mappings, frontend, conflicts: [], container: { canonicalRoot: '', aliases: [], retainedOuterFields: [], conflicts: [] } };
  artifact.detail.preservation = verifyPreservation(sourceValue, artifact);
  return artifact;
}

export function convertSource(sourceValue: Json, bytes: Uint8Array, filename: string, importedAt = new Date().toISOString()): ImportArtifact {
  if (!object(sourceValue)) throw new Error('Expected object');
  const schema = (sourceValue as Record<string, Json>).schema;
  if (typeof schema === 'string' && /^rp\.(?:card|preset)\//.test(schema)) return convertNativeSource(sourceValue, bytes, filename, importedAt);
  const source = sourceValue as Record<string, any>, container = auditContainer(source), root = container.canonicalRoot;
  const core = root ? source.data : source, isPreset = Array.isArray(core.prompts);
  const sourceHash = hash(bytes), id = `generic-${sourceHash.slice(0, 12)}`;
  const modules: ImportModule[] = [], mappings: NativeMapping[] = [], frontend: FrontendAsset[] = [];
  const nativeModules: PromptModule[] = [], texts = collectTexts(sourceValue);
  const conflicts: ImportArtifact['conflicts'] = container.conflicts.map(key => ({ code: 'container-field-conflict', pointers: [`/${escapePointer(key)}`, `/data/${escapePointer(key)}`], resolution: 'unresolved', detail: 'Outer and canonical values differ; both remain in the source IR.' }));
  const add = (pointer: string, title: string, content: string, kind: string, control: SourceControl, override?: Partial<Pick<NativeMapping, 'admission' | 'target' | 'reasons'>>) => {
    const moduleId = `source-${hash(pointer).slice(0, 14)}`, classification = { ...classify(content, title, pointer, control), ...override };
    const mapping: NativeMapping = { pointer, moduleId, control, ...classification };
    mappings.push(mapping);
    modules.push({ id: moduleId, title, kind, pointer, content, sourceEnabled: control.enabled, disposition: classification.admission === 'admitted' ? 'native' : classification.admission === 'isolated' ? 'isolated' : 'needs-adapter', notes: classification.reasons });
    if (classification.admission === 'admitted') nativeModules.push({ id: moduleId, title, category: /规则|约束/.test(title) ? 'constraint' : /文风|写作/.test(title) ? 'style' : 'supplement', content, enabled: control.enabled !== false, targets: [classification.target as 'world' | 'prose' | 'role'], phase: classification.target === 'prose' ? 'compose' : classification.target === 'role' ? 'decide' : 'coordinate', priority: control.order, sourcePointer: pointer,
      ...(kind === 'lore' && !control.constant ? { activation: { keys: [...(control.keys ?? [])], ...(control.secondaryKeys ? { secondaryKeys: [...control.secondaryKeys] } : {}), ...(typeof control.selective === 'boolean' ? { selective: control.selective } : {}) } } : {}) });
  };
  if (isPreset) {
    const tables = Array.isArray(core.prompt_order) ? core.prompt_order : [];
    core.prompts.forEach((p: any, index: number) => {
      const occurrences = tables.flatMap((table: any, ti: number) => (table.order ?? []).flatMap((item: any, oi: number) => item.identifier === p.identifier ? [{ table: ti, order: oi, ...item }] : []));
      const current = occurrences.filter((o: any) => o.table === tables.length - 1);
      const enabled = current.length ? current.some((o: any) => o.enabled === true) : tables.length ? false : typeof p.enabled === 'boolean' ? p.enabled : null;
      const control: SourceControl = { enabled, order: current[0]?.order ?? index + 10000, orderEntries: occurrences, injection: { ...(p.injection_position !== undefined ? { position: p.injection_position } : {}), ...(p.injection_depth !== undefined ? { depth: p.injection_depth } : {}), ...(p.injection_order !== undefined ? { order: p.injection_order } : {}), ...(p.role !== undefined ? { role: p.role } : {}) } };
      // Multiple order tables remain intact; selecting one is a declared alpha limitation.
      add(`${root}/prompts/${index}/content`, String(p.name ?? p.identifier ?? `Prompt ${index}`), String(p.content ?? ''), 'prompt', control,
        p.injection_position === 1 ? { admission: 'adapter', target: 'archive', reasons: ['In-chat/depth injection semantics require a native conversation-position adapter; source position is preserved.'] } : p.marker === true ? { admission: 'adapter', target: 'archive', reasons: ['Source marker refers to a host insertion point; retained without inventing content.'] } : enabled === null ? { admission: 'adapter', target: 'archive', reasons: ['No active source order slot or explicit enable switch; retained without inventing activation.'] } : undefined);
    });
    if (tables.length > 1) conflicts.push({ code: 'multiple-order-tables', pointers: [`${root}/prompt_order`], resolution: 'unresolved', detail: 'All order tables retained; alpha projection uses the last table and records every source occurrence.' });
  } else {
    for (const key of ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions']) if (typeof core[key] === 'string') {
      const opening = key === 'first_mes';
      add(`${root}/${key}`, key, core[key], opening ? 'greeting' : 'card-field', { enabled: true, order: -100 }, opening ? { admission: 'adapter', target: 'archive', reasons: ['Opening retained; native opening is selected only after source safety and frontend adaptation.'] } : undefined);
    }
    for (const key of ['alternate_greetings', 'group_only_greetings']) (core[key] ?? []).forEach((text: string, i: number) => add(`${root}/${key}/${i}`, `${key} ${i + 1}`, text, 'greeting', { enabled: null, order: i }, { admission: 'adapter', target: 'archive', reasons: ['Alternative opening retained separately for user selection and adaptation.'] }));
    (core.character_book?.entries ?? []).forEach((entry: any, index: number) => add(`${root}/character_book/entries/${index}/content`, String(entry.comment ?? entry.name ?? `Lore ${index}`), String(entry.content ?? ''), 'lore', readControl(entry, index)));
  }
  // Every extension section is retained, including unknown fields, independent duplicate regex exports and switch values.
  const walkAssets = (value: any, pointer: string) => {
    if (!object(value) && !Array.isArray(value)) return;
    const asset = value as Record<string, any>;
    if (object(value) && (typeof asset.findRegex === 'string' || (typeof asset.content === 'string' && /\/scripts\/\d+$/.test(pointer)))) {
      const regex = typeof asset.findRegex === 'string', all = strings(asset).join('\n');
      const missingApis = [...new Set((all.match(/\b(?:getAllVariables|getVariables|replaceVariables|updateVariablesWith|eventOn|eventEmit|tavern_events|SillyTavern|TavernHelper|Mvu|jQuery|\$)\b/g) ?? []))];
      if (/import\s*\(?\s*['"]https?:/.test(all)) missingApis.push('remote ES module import (disabled)');
      const remoteReferences = [...new Set(all.match(/https?:\/\/[^\s'"<>`]+/g) ?? [])];
      const html = regex && typeof asset.replaceString === 'string' && /<(?:html|div|style|!doctype)/i.test(asset.replaceString) ? asset.replaceString : undefined;
      frontend.push({ pointer, kind: regex ? 'regex' : 'javascript', source: asset as Json, executable: false, missingApis, remoteReferences, ...(html && isPublicSourceSafe(html) ? { previewHtml: safeFrontendPreview(html) } : {}) });
      modules.push({ id: `asset-${hash(pointer).slice(0, 14)}`, title: String(asset.scriptName ?? asset.name ?? 'Frontend source'), kind: regex ? 'regex' : 'javascript', pointer, content: JSON.stringify(asset), sourceEnabled: typeof asset.disabled === 'boolean' ? !asset.disabled : typeof asset.enabled === 'boolean' ? asset.enabled : null, disposition: 'needs-adapter', notes: ['Exact original frontend source retained; arbitrary code, regex processing and remote dependencies do not execute.'] });
      return;
    }
    if (Array.isArray(value)) value.forEach((item, i) => walkAssets(item, `${pointer}/${i}`));
    else for (const [key, child] of Object.entries(value)) walkAssets(child, `${pointer}/${escapePointer(key)}`);
  };
  walkAssets(core.extensions, `${root}/extensions`);
  const regexGroups = new Map<string, FrontendAsset[]>();
  for (const asset of frontend.filter(asset => asset.kind === 'regex')) {
    const value = asset.source as Record<string, Json>;
    const key = JSON.stringify([value.findRegex, value.replaceString]);
    regexGroups.set(key, [...(regexGroups.get(key) ?? []), asset]);
  }
  for (const group of regexGroups.values()) if (group.length > 1 && new Set(group.map(asset => (asset.source as Record<string, Json>).disabled)).size > 1) conflicts.push({ code: 'duplicate-regex-activation-conflict', pointers: group.map(asset => asset.pointer), resolution: 'unresolved', detail: 'Duplicate frontend regex definitions disagree on disabled state. Both original objects are retained; neither is executed or silently merged.' });
  // HTML/CSS embedded in openings or otherwise unknown fields is a first-class retained frontend asset.
  for (const leaf of texts) {
    if (!/<(?:!doctype|html|div|style)\b/i.test(leaf.text) || frontend.some(asset => leaf.pointer.startsWith(asset.pointer + '/'))) continue;
    const remoteReferences = [...new Set(leaf.text.match(/https?:\/\/[^\s'"<>`]+/g) ?? [])];
    const admitted = isPublicSourceSafe(leaf.text);
    frontend.push({ pointer: leaf.pointer, kind: 'html', source: leaf.text, executable: false, missingApis: /<script\b|\bonclick=/i.test(leaf.text) ? ['embedded browser scripts (disabled)'] : [], remoteReferences, ...(admitted ? { previewHtml: safeFrontendPreview(leaf.text) } : {}) });
  }
  const fields: StateField[] = [
    { key: 'presence', label: '在场', type: 'boolean', audience: 'public', editable: true },
    { key: 'location', label: '地点', type: 'string', audience: 'public', editable: true },
  ];
  // A worldbook is a reference collection, not a declaration of distinct NPCs
  // or numeric state. Keep source material in modules; authoring/conversion can
  // explicitly assign roles and fields without guessing from entry positions.
  const roles: RoleDefinition[] = isPreset ? [] : [{ id: 'player', name: '你', persona: '', goals: [], peers: [],
    phase: 'active', presence: 'present', state: { presence: true, location: '' }, knowledge: [] }];
  const entries = core.character_book?.entries ?? [];
  const title = String(core.name ?? filename.replace(/\.[^.]+$/, ''));
  const warnings = ['Exact source text preservation does not imply runtime equivalence.', 'Source scripts and remote assets are retained but never executed or fetched.', 'This native projection admits a SFW subset; source enable switches and isolated originals are retained independently.', 'Role identities and numeric state are not inferred from worldbook positions. Use authoring or the reviewed conversion workflow to assign them explicitly.'];
  if (conflicts.length) warnings.push(`${conflicts.length} unresolved source/projection conflict(s).`);
  const executableModules = nativeModules.filter(m => mappings.find(n => n.moduleId === m.id)?.admission === 'admitted');
  const nativeCard: CharacterCard | undefined = isPreset ? undefined : {
    schema: 'rp.card/0.1', id, title, description: `结构导入 · ${entries.length} 条世界资料 · 角色与状态可在创作工作区显式映射`, opening: '', playerRoleId: 'player',
    world: { location: '', time: '', variables: { sourceImportId: id } }, roles, fields,
    modules: executableModules.filter(m => m.content.length > 0),
    panels: [{ id: 'scene', title: '场景', kind: 'scene', side: 'left' }, { id: 'roles', title: '角色子会话', kind: 'roles', side: 'left' }, { id: 'state', title: '分层状态', kind: 'state', side: 'right' }, { id: 'lore', title: '条件资料', kind: 'lore', side: 'right' }, { id: 'source', title: '原始面板与适配', kind: 'source', side: 'right' }],
    compatibility: { importId: id, status: 'native-sfw-alpha', warnings },
  };
  const nativePreset: Preset | undefined = isPreset ? { schema: 'rp.preset/0.1', id, title, description: '独立预设：原文模块按来源开关与顺序分配给成文层；未自动应用到任何角色卡。', modules: executableModules, narration: { person: 'auto', pov: 'auto' }, compatibility: { importId: id, status: 'native-sfw-alpha', warnings } } : undefined;
  const prompts = texts.filter(t => t.role === 'prompt'), missingPointers = prompts.filter(t => atPointer(sourceValue, t.pointer) !== t.text).map(t => t.pointer);
  const detail: ImportDetail = { id, title, kind: isPreset ? 'preset' : 'card', importedAt, sourceFile: filename, promptCount: prompts.length, frontendCount: frontend.length, status: 'native-sfw-alpha', warnings, modules, ...(nativeCard ? { nativeCard } : {}), ...(nativePreset ? { nativePreset } : {}), preservation: { exactPromptTexts: missingPointers.length === 0, inputPrompts: prompts.length, retainedPrompts: prompts.length - missingPointers.length, missingPointers, addedPromptCharacters: 0 } };
  const artifact: ImportArtifact = { schema: 'rp.import/0.1', sourceFormat: 'tavern', id, sourceHash, source: sourceValue, texts, hostRoleIds: isPreset ? [] : ['player'], detail, mappings, frontend, conflicts, container };
  artifact.detail.preservation = verifyPreservation(sourceValue, artifact);
  return artifact;
}

/** Upgrade only an unchanged source module's legacy activation placeholder.
 * Bound document snapshots own their content and controls; the private artifact is
 * used solely as evidence for this narrowly scoped compatibility translation.
 */
export function hydrateImportedModules(artifact: ImportArtifact, snapshotModules: PromptModule[]): PromptModule[] {
  const result = structuredClone(snapshotModules);
  if (artifact.sourceFormat === 'native') return result;
  const originalModules = (artifact.detail.nativeCard ?? artifact.detail.nativePreset)?.modules ?? [];
  for (const module of result) {
    const condition = module.condition;
    if (!condition || !('path' in condition) || !('equals' in condition)
      || condition.path !== `importActivation.${module.id}` || condition.equals !== true) continue;
    const mapping = artifact.mappings.find(mapping => mapping.moduleId === module.id && mapping.pointer === module.sourcePointer && mapping.admission === 'admitted');
    if (!mapping || atPointer(artifact.source, mapping.pointer) !== module.content) continue;
    const original = originalModules.find(original => original.id === module.id && original.sourcePointer === mapping.pointer && original.content === module.content);
    if (!original) continue;
    delete module.condition;
    // An explicit activation in the snapshot is a native edit and takes precedence.
    if (!module.activation) module.activation = { keys: [...(mapping.control.keys ?? [])], ...(mapping.control.secondaryKeys ? { secondaryKeys: [...mapping.control.secondaryKeys] } : {}), ...(typeof mapping.control.selective === 'boolean' ? { selective: mapping.control.selective } : {}) };
  }
  return result;
}

/** Upgrade cached legacy projections without changing their private source IR or module text. */
export function portableNativeProjection<T extends NativeDocument>(artifact: ImportArtifact, document: T): T {
  const result = structuredClone(document);
  result.modules = hydrateImportedModules(artifact, result.modules);
  return result;
}

/** Resolve supported source conditions with the same portable selector used by edited native forks. */
export function selectImportedModules(artifact: ImportArtifact, context: { text: string; target: 'role' | 'world' | 'prose'; phase?: PromptModule['phase']; roleId?: string; user?: string; char?: string; snapshot?: unknown }): PromptModule[] {
  const document = artifact.detail.nativeCard ?? artifact.detail.nativePreset;
  if (!document) return [];
  if (document.worldbook) throw new Error('Worldbook-bound documents require the host prompt compiler and its permitted snapshot. Use runtimeModules for host compilation.');
  return portableNativeProjection(artifact, document).modules.filter(module => {
    const mapping = artifact.mappings.find(mapping => mapping.moduleId === module.id);
    return mapping?.admission === 'admitted' && mapping.control.enabled !== false && module.targets.includes(context.target) && (!context.phase || module.phase === context.phase) && nativeModuleActive(module, context);
  }).sort((a, b) => a.priority - b.priority).map(module => ({ ...module, content: expandCommonMacros(module.content, context) }));
}

/** Verify content and pointer order, including disabled/isolated modules and duplicate outer fields. */
export function verifyPreservation(original: Json, artifact: ImportArtifact): ImportDetail['preservation'] {
  const input = collectTexts(original), promptTexts = input.filter(leaf => leaf.role === 'prompt' || artifact.sourceFormat === 'native' && (/^\/opening$|^\/roles\/\d+\/(?:persona|goals\/\d+|knowledge\/\d+\/text)$/.test(leaf.pointer)));
  const retained = new Map(artifact.texts.map(leaf => [leaf.pointer, leaf.text]));
  const missing = new Set<string>();
  for (const leaf of input) if (retained.get(leaf.pointer) !== leaf.text || atPointer(artifact.source, leaf.pointer) !== leaf.text) missing.add(leaf.pointer);
  if (input.some((leaf, i) => artifact.texts[i]?.pointer !== leaf.pointer) || input.length !== artifact.texts.length) missing.add('@source-text-order');
  for (const module of artifact.detail.modules) {
    if (['prompt', 'lore', 'card-field', 'greeting'].includes(module.kind)) {
      const value = atPointer(original, module.pointer);
      if (value !== undefined && module.content !== value) missing.add(module.pointer);
    }
  }
  let addedPromptCharacters = 0;
  for (const module of artifact.detail.nativeCard?.modules ?? artifact.detail.nativePreset?.modules ?? []) {
    const sourcePointer = artifact.sourceFormat === 'native' ? artifact.mappings.find(mapping => mapping.moduleId === module.id)?.pointer : module.sourcePointer;
    if (!sourcePointer || atPointer(original, sourcePointer) !== module.content) addedPromptCharacters += module.content.length;
  }
  for (const role of artifact.detail.nativeCard?.roles ?? []) {
    if (!input.some(leaf => leaf.text === role.persona)) addedPromptCharacters += role.persona.length;
  }
  const missingPointers = [...missing];
  return { exactPromptTexts: missingPointers.length === 0, inputPrompts: promptTexts.length, retainedPrompts: promptTexts.filter(leaf => !missing.has(leaf.pointer)).length, missingPointers, addedPromptCharacters };
}
