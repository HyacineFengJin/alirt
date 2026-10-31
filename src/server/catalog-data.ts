import { createHash } from 'node:crypto';
import { validateCatalogMapping, type AuthorCatalog } from '../shared/catalog';
import { scenarioRequiresCurrentChapter, type ScenarioDefinition } from '../shared/scenario';
import type { PromptModule } from '../shared/types';
import type { WorldbookBinding } from '../shared/worldbook';

/** Resolve metadata against the current bound card, not import files or a title
 * search. Edits that remove/change a script fail closed to an author read-only row. */
export function readCatalogReferences(binding: WorldbookBinding, content: string, document: { source: 'card' | 'preset'; modules: PromptModule[]; worldbook?: { bindings: WorldbookBinding[] }; scenario?: ScenarioDefinition }): AuthorCatalog | undefined {
  if (!binding.catalog || !binding.source?.sourceHash || !binding.source.importId || !binding.contentHash
    || createHash('sha256').update(content).digest('hex') !== binding.contentHash || document.source !== 'card' || binding.purpose !== 'ui-data' || binding.audience !== 'author' || validateCatalogMapping(binding.catalog, content).length) return;
  return { schema: 'rp.catalog/0.1', entries: binding.catalog.entries.map(entry => {
    if (!entry.chapterId || !entry.script) return { ...structuredClone(entry), available: false };
    const script = document.worldbook?.bindings.find(item => item.id === entry.script!.bindingId);
    const module = document.modules.find(item => item.id === script?.moduleId);
    const chapter = document.scenario?.chapters.find(item => item.id === entry.chapterId);
    const available = !!chapter && chapter.bindingIds.includes(entry.script.bindingId)
      && script?.purpose === 'scenario-plan' && script.audience === 'author' && module?.enabled === true
      && script.source?.pointer === entry.script.sourcePointer && script.source?.sourceHash === binding.source?.sourceHash
      && script.source?.importId === binding.source?.importId
      && script.contentHash === entry.script.contentHash
      && createHash('sha256').update(module.content).digest('hex') === entry.script.contentHash
      && scenarioRequiresCurrentChapter(script.when, chapter.id);
    return available ? { ...structuredClone(entry), available: true }
      : { rowIndex: entry.rowIndex, title: entry.title, year: entry.year, candidatePointers: [...entry.candidatePointers], reason: 'stale-reference' as const, available: false };
  }) };
}
