import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { AuxiliaryOutput, ProseEntry, WorldEvent } from '../shared/types';
import type { ViewedCarriersOutput } from '../shared/text-carriers';
import { projectViewedCarrierOutput } from '../shared/text-carriers';
import { ViewedCarriers } from './ViewedCarriers';
import { ProseEntries } from './ProseEntries';
import { PendingHostOutputs, pendingViewedCarrierOutputs } from './PendingHostOutputs';

function output(): AuxiliaryOutput {
  const value: ViewedCarriersOutput = { schema: 'rp.viewed-carriers/0.1', materialTurnId: 'material', worldRevision: 8, views: [{ id: 'view-real', intentId: 'intent-real', materialTurnId: 'material', worldRevision: 8, carrierId: 'carrier', carrierVersion: 1, readerRoleId: 'player', readerName: '保存时玩家名', location: '站台', time: null, origin: { kind: 'player' }, carrier: { medium: 'paper', title: '原告示', text: '原文第一行\n<script>只是文字</script>', sourceEventId: 'carrier-event' }, observationEventId: 'observation-event' }] };
  return { key: 'preset:media', title: '载体界面', type: 'object', value: value as unknown as AuxiliaryOutput['value'], audience: 'public', placement: 'after-prose', display: { placement: 'after-prose', renderer: 'viewed-carriers' }, provenance: { kind: 'committed-carrier-views', materialTurnId: 'material', worldRevision: 8, viewIds: ['view-real'] } };
}
const event = (value: AuxiliaryOutput): WorldEvent => ({ id: 'host-output', kind: 'host-output', actor: 'host', turnId: 'writer-turn', at: 'host-time', text: 'host attachment', audience: 'public', data: { schema: 'rp.host-output/0.1', output: value as unknown as NonNullable<WorldEvent['data']> } });
it('renders exact committed carrier content and saved reader/time as inert paper/screen text', () => {
  const value = output(), before = JSON.stringify(value), html = renderToStaticMarkup(createElement(ViewedCarriers, { output: value }));
  expect(html).toContain('viewed-carrier-paper'); expect(html).toContain('保存时玩家名'); expect(html).toContain('世界时间：未知');
  expect(html).toContain('原文第一行\n&lt;script&gt;只是文字&lt;/script&gt;'); expect(html).toContain('不证明文字内容为真');
  for (const control of ['<script', '<iframe', '<button', '<a ', '<img', '<input']) expect(html).not.toContain(control);
  expect(JSON.stringify(value)).toBe(before);
  const screen = structuredClone(value); (screen.value as unknown as ViewedCarriersOutput).views[0].carrier.medium = 'screen';
  expect(renderToStaticMarkup(createElement(ViewedCarriers, { output: screen }))).toContain('viewed-carrier-screen');
});
it('suppresses valid empty host outputs but keeps invalid stamps visible as diagnostics', () => {
  const empty = output(); (empty.value as unknown as ViewedCarriersOutput).views = []; empty.provenance = { kind: 'committed-carrier-views', materialTurnId: 'material', worldRevision: 8, viewIds: [] };
  const entry: ProseEntry = { id: 'entry', title: '', text: '普通物理场景', worldRevision: 8, attachments: [empty] };
  const html = renderToStaticMarkup(createElement(ProseEntries, { entries: [entry] })); expect(html).not.toContain('载体界面'); expect(html).not.toContain('本段附加输出');
  const invalid = { ...output(), provenance: undefined };
  expect(renderToStaticMarkup(createElement(ViewedCarriers, { output: invalid }))).toContain('宿主来源不匹配');
  expect(renderToStaticMarkup(createElement(ViewedCarriers, { output: invalid }))).not.toContain('原文第一行');
});
it('shows committed views before failed prose and removes only already attached material without re-viewing', () => {
  const value = output(), saved = event(value), original = JSON.stringify(saved);
  expect(pendingViewedCarrierOutputs([saved], [])).toEqual([value]);
  const html = renderToStaticMarkup(createElement(PendingHostOutputs, { events: [saved], prose: [] })); expect(html).toContain('待成文的载体查看'); expect(html).toContain('原文第一行'); expect(html).not.toContain('<button');
  const entry: ProseEntry = { id: 'entry', title: '', text: '正文', worldRevision: 8, attachments: [{ ...value, title: '显示标题调整' }] };
  expect(pendingViewedCarrierOutputs([saved], [entry])).toEqual([]);
  const corrupted = { ...value, value: { invalid: true } };
  const diagnostic = renderToStaticMarkup(createElement(PendingHostOutputs, { events: [event(corrupted)], prose: [] })); expect(diagnostic).toContain('宿主来源不匹配'); expect(diagnostic).not.toContain('原文第一行');
  expect(JSON.stringify(saved)).toBe(original);
});
it('accepts a role-filtered host stamp while showing only that reader’s own saved receipt', () => {
  const value = output(), body = value.value as unknown as ViewedCarriersOutput;
  body.views.push({ ...structuredClone(body.views[0]), id: 'other-view', intentId: 'other-intent', observationEventId: 'other-observation', readerRoleId: 'other-role', readerName: '另一读者', carrier: { ...body.views[0].carrier, text: '另一读者的查看正文' } });
  value.provenance = { kind: 'committed-carrier-views', materialTurnId: 'material', worldRevision: 8, viewIds: ['view-real', 'other-view'] };
  const projected = projectViewedCarrierOutput(value, 'player')!;
  const html = renderToStaticMarkup(createElement(ViewedCarriers, { output: projected }));
  expect(html).toContain('原文第一行'); expect(html).not.toContain('另一读者'); expect(html).not.toContain('宿主来源不匹配');
  expect(projectViewedCarrierOutput(value, 'non-reader')).toBeUndefined();
});
