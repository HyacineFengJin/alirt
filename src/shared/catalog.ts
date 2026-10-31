/** Native author metadata kept beside, never inside, the unchanged source JSON. */
export type CatalogRow = { kind: 'story'; title: string; description: string } | { kind: 'separator'; title: string };
export function catalogRows(content: string): CatalogRow[] | undefined {
  try {
    const data: unknown = JSON.parse(content);
    if (!Array.isArray(data)) return;
    const rows: CatalogRow[] = [];
    for (const row of data) {
      if (!row || typeof row !== 'object') return;
      if (row.separator === true && typeof row.label === 'string') rows.push({ kind: 'separator', title: row.label });
      else if (typeof row.title === 'string' && typeof row.description === 'string') rows.push({ kind: 'story', title: row.title, description: row.description });
      else return;
    }
    return rows;
  } catch { return; }
}
export const CATALOG_UNAVAILABLE_REASONS = ['unmatched-source-title', 'ambiguous-source-match', 'source-isolated', 'source-disabled', 'missing-scenario-script', 'stale-reference'] as const;
export type CatalogUnavailableReason = typeof CATALOG_UNAVAILABLE_REASONS[number];
export interface CatalogEntryReference {
  rowIndex: number;
  title: string;
  year: 'initial' | 'advanced' | 'unspecified';
  reason?: CatalogUnavailableReason;
  /** Only an adapter-proven match names an executable native chapter. */
  chapterId?: string;
  script?: { bindingId: string; sourcePointer: string; contentHash: string; match: 'exact-source-title' | 'audited-mainline'; matchPointer: string };
  /** Source candidates remain evidence, never a fallback chapter selection. */
  candidatePointers: string[];
}
export interface CatalogMapping {
  schema: 'rp.catalog/0.1';
  entries: CatalogEntryReference[];
}
export interface AuthorCatalog extends CatalogMapping {
  entries: (CatalogEntryReference & { available: boolean })[];
}

export function validateCatalogMapping(value: unknown, content: string): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const bad = (path: string, message: string) => issues.push({ path, message });
  const object = (node: unknown): node is Record<string, unknown> => !!node && typeof node === 'object' && !Array.isArray(node);
  if (!object(value) || value.schema !== 'rp.catalog/0.1' || !Array.isArray(value.entries)) return [{ path: '', message: 'Expected a native catalog mapping' }];
  const rows = catalogRows(content), seen = new Set<number>();
  if (!rows) bad('', 'Catalog mapping requires a source story array');
  for (const [index, entry] of value.entries.entries()) {
    const path = `/entries/${index}`;
    if (!object(entry)) { bad(path, 'Expected a catalog reference'); continue; }
    const rowIndex = entry.rowIndex as number, row = rows?.[rowIndex];
    if (!Number.isSafeInteger(rowIndex) || rowIndex < 0 || seen.has(rowIndex) || row?.kind !== 'story' || row.title !== entry.title) bad(`${path}/rowIndex`, 'Reference must identify a unique unchanged source story row');
    seen.add(rowIndex);
    if (!['initial', 'advanced', 'unspecified'].includes(entry.year as string)) bad(`${path}/year`, 'Unknown catalog year');
    if (!Array.isArray(entry.candidatePointers) || entry.candidatePointers.some(pointer => typeof pointer !== 'string' || !pointer.startsWith('/'))) bad(`${path}/candidatePointers`, 'Expected source pointers');
    if (entry.reason !== undefined && !CATALOG_UNAVAILABLE_REASONS.includes(entry.reason as CatalogUnavailableReason)) bad(`${path}/reason`, 'Unknown unavailable reason');
    if (entry.chapterId !== undefined) {
      if (typeof entry.chapterId !== 'string' || !entry.chapterId || entry.reason !== undefined) bad(`${path}/chapterId`, 'Mapped chapters require a chapter ID and no unavailable reason');
      const script = entry.script;
      if (!object(script) || typeof script.bindingId !== 'string' || !script.bindingId || typeof script.sourcePointer !== 'string' || !script.sourcePointer.startsWith('/') || typeof script.matchPointer !== 'string' || !script.matchPointer.startsWith('/') || typeof script.contentHash !== 'string' || !/^[a-f0-9]{64}$/i.test(script.contentHash) || !['exact-source-title', 'audited-mainline'].includes(script.match as string)) bad(`${path}/script`, 'Mapped chapters require source script evidence');
    } else if (!entry.reason || entry.script !== undefined) bad(path, 'Unmapped stories require an explicit reason and no executable reference');
  }
  if (rows && rows.filter(row => row.kind === 'story').length !== seen.size) bad('/entries', 'Every source story must have a reference or an explicit unavailable reason');
  return issues;
}
