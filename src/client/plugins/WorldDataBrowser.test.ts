import { expect, it } from 'vitest';
import { catalogRows, catalogDisplayRows, WorldDataBrowser } from './WorldDataBrowser';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PanelContext } from './registry';

it('reads stories and source separators as data while ignoring remote image fields', () => {
  expect(catalogRows(JSON.stringify([{ title: 'Story', description: 'A public synopsis.', image: 'https://example.com/image' }, { separator: true, label: 'Next year' }])))
    .toEqual([{ kind: 'story', title: 'Story', description: 'A public synopsis.' }, { kind: 'separator', title: 'Next year' }]);
  expect(catalogRows('[{"code":"execute()"}]')).toBeUndefined();
  expect(catalogRows('not json')).toBeUndefined();
});




it('keeps row references and original separator context while searching/filtering years', () => {
  const rows = catalogRows(JSON.stringify([{ title: 'Before', description: 'First' }, { separator: true, label: '升学后' }, { title: 'After', description: 'Second' }]))!;
  const catalog = { schema: 'rp.catalog/0.1' as const, entries: [
    { rowIndex: 0, title: 'Before', year: 'initial' as const, candidatePointers: [], reason: 'unmatched-source-title' as const, available: false },
    { rowIndex: 2, title: 'After', year: 'advanced' as const, candidatePointers: [], reason: 'unmatched-source-title' as const, available: false },
  ] };
  const result = catalogDisplayRows(rows, catalog, 'Second', 'advanced');
  expect(result.map(entry => ({ rowIndex: entry.rowIndex, group: entry.group, year: entry.reference?.year })))
    .toEqual([{ rowIndex: 2, group: '升学后', year: 'advanced' }]);
  expect(catalogDisplayRows(rows, catalog, '升学后', '').map(entry => entry.rowIndex)).toEqual([2]);
  expect(catalogDisplayRows(rows, catalog, '', 'initial').map(entry => entry.rowIndex)).toEqual([0]);
});

it('does not mount the future-story catalog consumer in role perspective', () => {
  const html = renderToStaticMarkup(createElement(WorldDataBrowser, { session: { perspective: 'role-7' } } as PanelContext));
  expect(html).toBe('');
});
