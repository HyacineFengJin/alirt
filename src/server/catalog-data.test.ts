import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readCatalogReferences } from './catalog-data';
import { validateCatalogMapping } from '../shared/catalog';
import type { PromptModule } from '../shared/types';
import type { WorldbookBinding } from '../shared/worldbook';
import type { ScenarioDefinition } from '../shared/scenario';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture() {
  const content = JSON.stringify([{ title: 'A plan', description: 'A possible story.' }]);
  const module: PromptModule = { id: 'plan', title: 'A plan', content: 'A possible development.', enabled: true, targets: ['world'], phase: 'coordinate', audience: 'author', category: 'supplement', priority: 0 };
  const source = { importId: 'test-import', sourceHash: 'a'.repeat(64), pointer: '/entries/1/content' };
  const script: WorldbookBinding = { id: 'script', moduleId: module.id, purpose: 'scenario-plan', audience: 'author', contentHash: hash(module.content), source,
    when: { path: 'scenario.currentChapterId', equals: 'chapter' } };
  const binding: WorldbookBinding = { id: 'catalog', moduleId: 'catalog-data', purpose: 'ui-data', audience: 'author', source: { ...source, pointer: '/entries/2/content' }, contentHash: hash(content),
    catalog: { schema: 'rp.catalog/0.1', entries: [{ rowIndex: 0, title: 'A plan', year: 'initial', chapterId: 'chapter', candidatePointers: [source.pointer], script: { bindingId: script.id, sourcePointer: source.pointer, contentHash: script.contentHash!, match: 'exact-source-title', matchPointer: '/entries/1/keys/0' } }] } };
  const scenario: ScenarioDefinition = { schema: 'rp.scenario/0.1', id: 'scenario', title: 'Plans', chapters: [{ id: 'chapter', title: 'Plan', prerequisites: [], bindingIds: [script.id] }] };
  return { content, binding, script, module, scenario, document: { source: 'card' as const, modules: [module], worldbook: { bindings: [binding, script] }, scenario } };
}
describe('author catalog references bind to current exact chapter scripts', () => {
  it('resolves only the declared script and fails closed after bound document changes', () => {
    const f = fixture(), before = structuredClone(f);
    expect(readCatalogReferences(f.binding, f.content, f.document)?.entries[0]).toMatchObject({ available: true, chapterId: 'chapter' });
    expect(f).toEqual(before);
    for (const mutate of [
      (x: ReturnType<typeof fixture>) => { x.module.enabled = false; },
      (x: ReturnType<typeof fixture>) => { x.module.content += ' Changed'; },
      (x: ReturnType<typeof fixture>) => { x.scenario.chapters = []; },
      (x: ReturnType<typeof fixture>) => { x.script.source!.sourceHash = 'b'.repeat(64); },
      (x: ReturnType<typeof fixture>) => { x.script.when = { path: 'scenario.currentChapterId', equals: 'another' }; },
      (x: ReturnType<typeof fixture>) => { x.script.audience = 'public'; },
    ]) {
      const changed = fixture(); mutate(changed);
      const row = readCatalogReferences(changed.binding, changed.content, changed.document)?.entries[0];
      expect(row).toMatchObject({ available: false, reason: 'stale-reference' });
      expect(row).not.toHaveProperty('chapterId');
    }
    expect(readCatalogReferences(f.binding, f.content, { ...f.document, source: 'preset' })).toBeUndefined();
  });
  it('rejects stale catalog bodies, invalid rows and unsupported unavailability claims', () => {
    const f = fixture();
    expect(validateCatalogMapping(f.binding.catalog, f.content)).toEqual([]);
    expect(readCatalogReferences(f.binding, f.content + ' ', f.document)).toBeUndefined();
    f.binding.catalog!.entries[0].title = 'Another row';
    expect(validateCatalogMapping(f.binding.catalog, f.content).map(issue => issue.path)).toContain('/entries/0/rowIndex');
    expect(readCatalogReferences(f.binding, f.content, f.document)).toBeUndefined();
    const missing = fixture(); missing.binding.catalog!.entries = [];
    expect(validateCatalogMapping(missing.binding.catalog, missing.content).map(issue => issue.path)).toContain('/entries');
  });
});
