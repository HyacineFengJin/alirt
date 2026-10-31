import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { proseBodyText, type ProseBody as SavedProseBody } from '../shared/prose-body';
import type { ProseEntry } from '../shared/types';
import { ProseBody } from './ProseBody';
import { ProseEntries } from './ProseEntries';
import type { EntryVisuals, ResolvedRoleVisual } from '../shared/visual-assets';

const body = (): SavedProseBody => ({ schema: 'rp.prose-body/0.1', renderer: 'character-dialogue', materialTurnId: 'material-original', blocks: [
  { kind: 'narration', text: '第一段叙述。\n\n第二段叙述。' },
  { kind: 'speech', ref: 'behavior-npc', roleId: 'role-old', name: '保存时的名字', text: '第一句对白。\n第二句对白。', channel: 'local', speaker: 'npc' },
  { kind: 'narration', text: '中间叙述。' },
  { kind: 'speech', ref: 'player-dialogue-original', roleId: 'player-original', name: '保存时的玩家名', text: '玩家已提交的原话。', channel: 'local', speaker: 'player' },
  { kind: 'narration', text: '末尾叙述。' },
] });
function entry(saved = body()): ProseEntry { return { id: 'entry', title: '段落', text: proseBodyText(saved), body: saved, turnId: 'writer-later', worldRevision: 8 }; }
const render = (value: Pick<ProseEntry, 'text' | 'body' | 'visuals'>) => renderToStaticMarkup(createElement(ProseBody, { entry: value }));

it('renders narration and exact saved speech in their original order without a second text transcript', () => {
  const value = entry(), before = JSON.stringify(value), html = render(value);
  const positions = ['第一段叙述。', '第二段叙述。', '第一句对白。', '中间叙述。', '玩家已提交的原话。', '末尾叙述。'].map(text => html.indexOf(text));
  expect(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1]))).toBe(true);
  expect(html).toContain('<p>第一段叙述。</p><p>第二段叙述。</p>');
  expect(html).toContain('<p class="prose-dialogue-text">第一句对白。\n第二句对白。</p>');
  expect(html.match(/第一句对白。/g)).toHaveLength(1); expect(html.match(/玩家已提交的原话。/g)).toHaveLength(1);
  expect(html).toContain('prose-dialogue-npc'); expect(html).toContain('prose-dialogue-player');
  expect(html).toContain('角色 · 本地对白'); expect(html).toContain('玩家 · 本地对白');
  expect(html).not.toContain('已读'); expect(html).not.toContain('<button'); expect(html).not.toContain('<time');
  expect(JSON.stringify(value)).toBe(before);
});
it('keeps saved role IDs and names distinct even for unknown current roles with the same display name', () => {
  const saved = body();
  saved.blocks = [{ kind: 'speech', ref: 'one', roleId: 'speaker-one-archived', name: '同名角色', text: '第一人的原话。', channel: 'local', speaker: 'npc' },
    { kind: 'speech', ref: 'two', roleId: 'speaker-two-archived', name: '同名角色', text: '第二人的原话。', channel: 'local', speaker: 'npc' }];
  const html = render(entry(saved));
  expect(html).toContain('data-role-id="speaker-one-archived"'); expect(html).toContain('data-role-id="speaker-two-archived"');
  expect(html).toContain('data-speech-ref="one"'); expect(html).toContain('data-speech-ref="two"');
  expect(html.match(/<span>同名角色<\/span>/g)).toHaveLength(2);
  expect(html).toContain('第一人的原话。'); expect(html).toContain('第二人的原话。');
});
it('escapes narration, names, IDs and speech without interpreting HTML or source markers', () => {
  const saved = body(); saved.blocks = [{ kind: 'narration', text: '<img src="external" onerror="run()">' },
    { kind: 'speech', ref: 'ref" onclick="run()', roleId: 'role" data-other="fake', name: '<b>名字</b>', text: '<script>内容</script>\n（（原标记））A & B', channel: 'local', speaker: 'npc' }];
  const html = render(entry(saved));
  expect(html).toContain('&lt;img'); expect(html).toContain('&lt;b&gt;名字&lt;/b&gt;'); expect(html).toContain('&lt;script&gt;内容&lt;/script&gt;');
  expect(html).toContain('（（原标记））A &amp; B'); expect(html).toContain('&quot; onclick=');
  expect(html).not.toContain('<img'); expect(html).not.toContain('<script'); expect(html).not.toContain('<b>');
  expect(html).not.toContain(' onclick="run()"');
});
it('uses only saved plain text for legacy entries and mismatching structured snapshots', () => {
  const legacy = { text: '旧正文。\n\n另一段。\n<details>旧原文</details>' };
  const expected = '<p>旧正文。</p><p>另一段。</p><p>&lt;details&gt;旧原文&lt;/details&gt;</p>';
  expect(render(legacy)).toBe(expected);
  expect(render({ ...legacy, body: body() })).toBe(expected);
});
it('falls back for invalid schema, duplicate refs, remote speech and unrecognized fields without partial rendering', () => {
  const original = body(), duplicate = structuredClone(original), remote = structuredClone(original);
  duplicate.blocks.push({ ...duplicate.blocks[1] });
  (remote.blocks[1] as unknown as { channel: string }).channel = 'message';
  for (const invalid of [{ ...original, schema: 'unknown' }, { ...original, renderer: 'html' }, duplicate, remote, { ...original, extra: true }]) {
    const value = { text: '完整保存正文。\n第二段。', body: invalid as SavedProseBody };
    expect(render(value)).toBe('<p>完整保存正文。</p><p>第二段。</p>');
  }
});
it('preserves before/after auxiliary output placement and entry metadata around the structured body', () => {
  const value = entry(); value.attachments = [
    { key: 'time', title: '时间栏', value: '已知傍晚', audience: 'public', type: 'text', placement: 'before-prose' },
    { key: 'summary', title: '摘要栏', value: '附加摘要', audience: 'public', type: 'text', placement: 'after-prose' },
  ];
  const html = renderToStaticMarkup(createElement(ProseEntries, { entries: [value] }));
  expect(html.indexOf('已知傍晚')).toBeLessThan(html.indexOf('第一段叙述。'));
  expect(html.indexOf('末尾叙述。')).toBeLessThan(html.indexOf('附加摘要'));
  expect(html.indexOf('附加摘要')).toBeLessThan(html.indexOf('成文记录 1'));
  expect(html).toContain('世界版本 8'); expect(html).toContain('回合 writer-later');
  expect(html.match(/第一句对白。/g)).toHaveLength(1);
});

const savedVisual = (roleId = 'role-old'): ResolvedRoleVisual => ({ roleId, slot: 'dialogue-avatar', image: { assetId: 'a'.repeat(64), sha256: 'a'.repeat(64), mimeType: 'image/webp', width: 256, height: 256, bytes: 120 }, crop: { x: .25, y: .75, zoom: 2 }, provenance: { kind: 'author', version: 1, revision: 7, sourceEventId: 'historical-binding' } });
it('uses only matching historical speech snapshots and exposes edit controls only when an author callback is provided', () => {
  const value = entry(); value.visuals = { schema: 'rp.entry-visuals/0.1', speakers: [{ ref: 'behavior-npc', visual: savedVisual() }] };
  const before = JSON.stringify(value), html = render(value);
  expect(html).toContain(`/api/visual-assets/images/${'a'.repeat(64)}`); expect(html).toContain('width:200%'); expect(html).toContain('left:-25%');
  expect(html).toContain('保存时的玩家名姓名占位'); expect(html).not.toContain('<button');
  expect(html.indexOf('第二段叙述。')).toBeLessThan(html.indexOf('保存时的名字对白头像')); expect(html.indexOf('保存时的名字对白头像')).toBeLessThan(html.indexOf('第一句对白。'));
  expect(html.match(/第一句对白。/g)).toHaveLength(1);
  const editable = renderToStaticMarkup(createElement(ProseBody, { entry: value, onEditVisual: () => { throw new Error('Rendering must not open or save'); } }));
  expect(editable).toContain('aria-label="编辑保存时的名字对白头像"'); expect(editable).toContain('data-role-id="role-old"');
  expect(JSON.stringify(value)).toBe(before);
});
it('preserves the old layout without a snapshot and uses initials for explicitly empty or invalid snapshots without losing prose', () => {
  const value = entry(); expect(render(value)).not.toContain('prose-dialogue-avatar');
  value.visuals = { schema: 'rp.entry-visuals/0.1', speakers: [] };
  expect(render(value)).toContain('保存时的名字姓名占位'); expect(render(value)).not.toContain('<img');
  for (const invalid of [
    { schema: 'rp.entry-visuals/0.1', speakers: [{ ref: 'unknown-ref', visual: savedVisual() }] },
    { schema: 'rp.entry-visuals/0.1', speakers: [{ ref: 'behavior-npc', visual: savedVisual('different-role') }] },
    { schema: 'rp.entry-visuals/0.1', speakers: [{ ref: 'behavior-npc', visual: savedVisual() }, { ref: 'behavior-npc', visual: savedVisual() }] },
  ]) {
    value.visuals = invalid as EntryVisuals; const html = render(value);
    expect(html).not.toContain('<img'); expect(html).toContain('头像快照不可用'); expect(html).toContain('第一句对白。'); expect(html).toContain('玩家已提交的原话。');
  }
});
it('does not transfer an image to another same-named speaker or resolve missing snapshots by display name', () => {
  const saved = body(); saved.blocks = [{ kind: 'speech', ref: 'one', roleId: 'unknown-one', name: '同名', text: '第一人的原话。', channel: 'local', speaker: 'npc' }, { kind: 'speech', ref: 'two', roleId: 'unknown-two', name: '同名', text: '第二人的原话。', channel: 'local', speaker: 'npc' }];
  const value = entry(saved); value.visuals = { schema: 'rp.entry-visuals/0.1', speakers: [{ ref: 'one', visual: savedVisual('unknown-one') }] };
  const html = render(value);
  expect(html.match(/<img /g)).toHaveLength(1); expect(html).toContain('同名姓名占位');
  expect(html.indexOf('<img ')).toBeLessThan(html.indexOf('第一人的原话。')); expect(html.indexOf('同名姓名占位')).toBeGreaterThan(html.indexOf('第一人的原话。'));
});
