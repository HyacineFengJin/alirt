import type { PromptModule } from '../../shared/types';
import type { WorldbookBinding, WorldbookBindingEdit, WorldbookEditCommand, WorldbookModuleEdit } from '../../shared/worldbook';
import type { RuntimeConfiguration } from '../api';

export type WorldbookSource = 'card' | 'preset';
export interface WorldbookEntry { key: string; source: WorldbookSource; module: PromptModule; binding?: WorldbookBinding; chapterTitles: string[]; }
export function worldbookEntries(runtime: RuntimeConfiguration): WorldbookEntry[] {
  return (['card', 'preset'] as const).flatMap(source => {
    const document = runtime[source];
    return document.modules.filter(module => document.worldbook?.bindings.some(binding => binding.moduleId === module.id) || module.targets.includes('world')).map(module => {
      const binding = document.worldbook?.bindings.find(item => item.moduleId === module.id);
      return { key: `${source}:${module.id}`, source, module, binding, chapterTitles: source === 'card' && binding ? runtime.card.scenario?.chapters.filter(chapter => chapter.bindingIds.includes(binding.id)).map(chapter => chapter.title) ?? [] : [] };
    });
  });
}
export const moduleMetadataKeys = ['category', 'condition', 'sourcePointer', 'lifetime', 'audience', 'inject', 'dependsOn', 'exclusiveGroup', 'required'] as const;
export const bindingMetadataKeys = ['audience', 'source'] as const;
const format = (value: unknown) => JSON.stringify(value, null, 2);
const metadata = (value: object, keys: readonly string[]) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, (value as Record<string, unknown>)[key]]));
export interface WorldbookDraft {
  entry?: WorldbookEntry;
  source: WorldbookSource;
  expectedRevision: number;
  title: string; content: string; enabled: boolean; targets: PromptModule['targets']; phase: PromptModule['phase']; priority: string;
  keywords: string; secondaryKeywords: string; selective: boolean; caseSensitive: boolean; match: 'substring' | 'word';
  purpose: WorldbookBinding['purpose']; when: string; moduleMetadata: string; bindingMetadata: string; roleStage: string; stageReviewed: boolean; reason: string;
}
export function createWorldbookDraft(revision: number, entry?: WorldbookEntry, source: WorldbookSource = 'card'): WorldbookDraft {
  const module = entry?.module, binding = entry?.binding;
  return { entry, source: entry?.source ?? source, expectedRevision: revision, title: module?.title ?? '', content: module?.content ?? '', enabled: module?.enabled ?? true, targets: [...(module?.targets ?? ['world'])], phase: module?.phase ?? 'coordinate', priority: String(module?.priority ?? 0), keywords: module?.activation?.keys.join('\n') ?? '', secondaryKeywords: module?.activation?.secondaryKeys?.join('\n') ?? '', selective: module?.activation?.selective ?? false, caseSensitive: module?.activation?.caseSensitive ?? false, match: module?.activation?.match ?? 'substring', purpose: binding?.purpose ?? 'reference', when: binding?.when ? format(binding.when) : '', moduleMetadata: format(module ? metadata(module, moduleMetadataKeys) : { category: 'supplement' }), bindingMetadata: format(binding ? metadata(binding, bindingMetadataKeys) : {}), roleStage: binding?.roleStage ? format(binding.roleStage) : '', stageReviewed: false, reason: '' };
}
export function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${label} 不是有效 JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象`);
  return value as Record<string, unknown>;
}
function editableMetadata(text: string, keys: readonly string[], label: string) {
  const value = parseJsonObject(text, label);
  const invalid = Object.keys(value).find(key => !keys.includes(key));
  if (invalid) throw new Error(`${label} 不支持字段 ${invalid}；基本字段请使用上方表单`);
  return value;
}
function changed(before: object, after: object, keys: readonly string[]) {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const a = (before as Record<string, unknown>)[key], b = (after as Record<string, unknown>)[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) result[key] = b === undefined ? null : b;
  }
  return result;
}
const lines = (text: string) => [...new Set(text.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
export function worldbookDraftCommand(draft: WorldbookDraft): WorldbookEditCommand {
  if (!draft.title.trim()) throw new Error('请填写资料标题');
  if (!draft.reason.trim()) throw new Error('请填写编辑原因');
  if (!draft.targets.length) throw new Error('至少选择一个投递目标');
  if (!draft.priority.trim() || !Number.isFinite(Number(draft.priority))) throw new Error('优先级必须是有效数字');
  const moduleMeta = editableMetadata(draft.moduleMetadata, moduleMetadataKeys, '模块元数据');
  const bindingMeta = editableMetadata(draft.bindingMetadata, bindingMetadataKeys, '绑定元数据');
  const module: Record<string, unknown> = { ...moduleMeta, title: draft.title, content: draft.content, enabled: draft.enabled, targets: draft.targets, phase: draft.phase, priority: Number(draft.priority) };
  const keys = lines(draft.keywords), secondaryKeys = lines(draft.secondaryKeywords);
  const original = draft.entry?.module;
  const originalDraft = draft.entry ? createWorldbookDraft(draft.expectedRevision, draft.entry) : undefined;
  const activationChanged = !originalDraft || ['keywords', 'secondaryKeywords', 'selective', 'caseSensitive', 'match'].some(key => draft[key as keyof WorldbookDraft] !== originalDraft[key as keyof WorldbookDraft]);
  if (original?.activation && !activationChanged) module.activation = original.activation;
  else if (keys.length) module.activation = { ...original?.activation, keys, secondaryKeys, selective: draft.selective, caseSensitive: draft.caseSensitive, match: draft.match };
  else if (secondaryKeys.length) throw new Error('使用辅助关键词时请先填写主关键词');
  const binding: Record<string, unknown> = { ...bindingMeta, purpose: draft.purpose };
  if (draft.when.trim()) binding.when = parseJsonObject(draft.when, '绑定条件');
  if (draft.roleStage.trim()) binding.roleStage = parseJsonObject(draft.roleStage, '角色阶段模板');
  if (draft.entry?.binding?.roleStage && original?.content !== draft.content) {
    if (!binding.roleStage || !draft.stageReviewed) throw new Error('修改角色阶段正文后，请同步新正文的 roleStage spans 并勾选已审阅');
  }
  const base = { source: draft.source, expectedRevision: draft.expectedRevision, reason: draft.reason.trim() };
  if (!draft.entry) return { ...base, operation: 'add', module: module as Extract<WorldbookEditCommand, { operation: 'add' }>['module'], binding: binding as WorldbookBindingEdit };
  const modulePatch = changed(original!, module, ['title', 'content', 'enabled', 'targets', 'phase', 'priority', 'activation', ...moduleMetadataKeys]);
  const bindingPatch = changed(draft.entry.binding ?? {}, binding, ['purpose', 'when', 'roleStage', ...bindingMetadataKeys]);
  // A reviewed role-stage replacement must accompany the changed exact body, even if its JSON happens to be identical.
  if (draft.entry.binding?.roleStage && original?.content !== draft.content) bindingPatch.roleStage = binding.roleStage;
  if (!Object.keys(modulePatch).length && !Object.keys(bindingPatch).length) throw new Error('尚未修改资料');
  return { ...base, operation: 'edit', moduleId: draft.entry.module.id, ...(draft.entry.binding ? { bindingId: draft.entry.binding.id } : {}), ...(Object.keys(modulePatch).length ? { module: modulePatch as WorldbookModuleEdit } : {}), ...(Object.keys(bindingPatch).length ? { binding: bindingPatch as WorldbookBindingEdit } : {}) };
}
