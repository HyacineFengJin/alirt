import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AuxiliaryOutput, Json, ProseEntry } from '../shared/types';
import { ApprovedMessages, approvedMessageTranscript } from './ApprovedMessages';
import { SidePanelOutputs } from './AuxiliaryOutputs';
import { ProseEntries } from './ProseEntries';

function transcript(): AuxiliaryOutput {
  return {
    key: 'messages', title: '短信', type: 'object', audience: 'public', placement: 'after-prose',
    display: { placement: 'after-prose', renderer: 'messages' },
    value: {
      schema: 'rp.approved-messages/0.1', materialTurnId: 'material-1', worldRevision: 7,
      messages: [
        { behaviorId: 'b1', roleId: 'a', name: '顾岚', text: '第一条：车站见。', channel: 'message' },
        { behaviorId: 'b2', roleId: 'b', name: '爽世', text: '第二条：稍等。', channel: 'message' },
        { behaviorId: 'b3', roleId: 'a', name: '顾岚', text: '第三条：我到了。', channel: 'message' },
      ],
    },
    provenance: { kind: 'committed-behaviors', materialTurnId: 'material-1', behaviorIds: ['b1', 'b2', 'b3'], worldRevision: 7 },
  };
}
function prose(id: string, attachments: AuxiliaryOutput[] = []): ProseEntry {
  return { id, title: '', text: '小说正文。', worldRevision: 7, attachments };
}
function render(output: AuxiliaryOutput) {
  return renderToStaticMarkup(createElement(ApprovedMessages, { output }));
}

describe('approved remote message transcript', () => {
  it('starts folded and keeps interleaved senders in the exact approved order', () => {
    const html = render(transcript());
    expect(html).toContain('<details class="auxiliary-output approved-messages">');
    expect(html).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
    expect(html).toContain('远程消息');
    expect(html).toContain('3 条短信');
    expect(html).toContain('世界版本 7');
    expect(html.indexOf('第一条')).toBeLessThan(html.indexOf('第二条'));
    expect(html.indexOf('第二条')).toBeLessThan(html.indexOf('第三条'));
    expect((html.match(/class="approved-message-sender">顾岚/g) ?? [])).toHaveLength(2);
    expect(html).not.toMatch(/<(input|textarea|button|iframe|time)(?:\s|>)/);
    expect(html).not.toContain('已读');
    expect(html).not.toContain('正在输入');
  });

  it('escapes names and preserves message text including newlines, code and literal user tags', () => {
    const output = transcript();
    const value = output.value as { messages: { name: string; text: string }[] };
    const exact = '  <user>不是玩家输入</user>\n\n```js\nconst value = "<script>alert(1)</script>";\n```\n\\n结尾  ';
    value.messages[0].name = '<img src=x onerror=unsafe()>';
    value.messages[0].text = exact;
    const original = structuredClone(output);
    const html = render(output);
    expect(html).toContain('&lt;img src=x onerror=unsafe()&gt;');
    expect(html).toContain('  &lt;user&gt;不是玩家输入&lt;/user&gt;\n\n```js\nconst value = &quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;;\n```\n\\n结尾  ');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(approvedMessageTranscript(output)?.messages[0].text).toBe(exact);
    expect(output).toEqual(original);
  });

  it.each([
    ['unknown schema', (output: AuxiliaryOutput) => { (output.value as Record<string, Json>).schema = 'wrong'; }],
    ['raw source wrapper', (output: AuxiliaryOutput) => { output.value = '<message name="顾岚">不可信正文</message>'; }],
    ['unexpected envelope field', (output: AuxiliaryOutput) => { (output.value as Record<string, Json>).rawReports = '不可信正文'; }],
    ['invalid world revision', (output: AuxiliaryOutput) => { (output.value as Record<string, Json>).worldRevision = 7.5; }],
    ['null turn on nonempty transcript', (output: AuxiliaryOutput) => {
      (output.value as Record<string, Json>).materialTurnId = null;
      if (output.provenance?.kind === 'committed-behaviors') output.provenance.materialTurnId = null;
    }],
    ['blank material turn', (output: AuxiliaryOutput) => {
      (output.value as Record<string, Json>).materialTurnId = ' ';
      if (output.provenance?.kind === 'committed-behaviors') output.provenance.materialTurnId = ' ';
    }],
    ['wrong output type', (output: AuxiliaryOutput) => { output.type = 'text'; }],
    ['missing provenance', (output: AuxiliaryOutput) => { delete output.provenance; }],
    ['unexpected provenance field', (output: AuxiliaryOutput) => { output.provenance = { ...output.provenance!, known: true } as AuxiliaryOutput['provenance']; }],
    ['mismatched provenance revision', (output: AuxiliaryOutput) => { output.provenance!.worldRevision = 8; }],
    ['mismatched provenance turn', (output: AuxiliaryOutput) => { output.provenance = { kind: 'committed-behaviors', materialTurnId: null, behaviorIds: ['b1', 'b2', 'b3'], worldRevision: 7 }; }],
    ['wrong message channel', (output: AuxiliaryOutput) => { ((output.value as Record<string, Json>).messages as Record<string, Json>[])[1].channel = 'audio'; }],
    ['unexpected message field', (output: AuxiliaryOutput) => { ((output.value as Record<string, Json>).messages as Record<string, Json>[])[1].private = '不可信正文'; }],
    ['non-text message', (output: AuxiliaryOutput) => { ((output.value as Record<string, Json>).messages as Record<string, Json>[])[1].text = { raw: '不可信正文' }; }],
    ['duplicate behavior', (output: AuxiliaryOutput) => { ((output.value as Record<string, Json>).messages as Record<string, Json>[])[1].behaviorId = 'b1'; }],
    ['reordered behavior provenance', (output: AuxiliaryOutput) => { output.provenance = { kind: 'committed-behaviors', materialTurnId: 'material-1', behaviorIds: ['b2', 'b1', 'b3'], worldRevision: 7 }; }],
  ])('rejects the whole attachment for %s without rendering partial messages', (_label, mutate) => {
    const output = transcript();
    mutate(output);
    const html = render(output);
    expect(approvedMessageTranscript(output)).toBeNull();
    expect(html).toContain('消息记录暂不可用');
    expect(html).not.toContain('第一条');
    expect(html).not.toContain('第二条');
    expect(html).not.toContain('第三条');
    expect(html).not.toContain('不可信正文');
  });

  it('hides a valid empty host transcript without deleting its stored value or hiding ordinary empty outputs', () => {
    const output = transcript();
    output.value = { schema: 'rp.approved-messages/0.1', materialTurnId: null, worldRevision: 0, messages: [] };
    output.provenance = { kind: 'committed-behaviors', materialTurnId: null, behaviorIds: [], worldRevision: 0 };
    const original = JSON.stringify(output);
    expect(render(output)).toBe('');
    const physicalScene = renderToStaticMarkup(createElement(ProseEntries, { entries: [{ ...prose('1', [output]), text: '普通物理场景。' }] }));
    expect(physicalScene).toContain('普通物理场景。');
    expect(physicalScene).not.toContain('远程消息');
    expect(physicalScene).not.toContain('本段附加输出');
    expect(physicalScene).not.toContain('短信');
    expect(JSON.stringify(output)).toBe(original);
    const ordinaryList: AuxiliaryOutput = { key: 'ordinary-empty', title: '手动空列表', type: 'list', audience: 'public', placement: 'after-prose', value: [] };
    const listHtml = renderToStaticMarkup(createElement(ProseEntries, { entries: [prose('1', [ordinaryList])] }));
    expect(listHtml).toContain('手动空列表');
    expect(listHtml).toContain('暂无条目。');
  });

  it('uses the attachment renderer independently of prose formatting and makes no prose parser', () => {
    const output = transcript();
    const entry = { ...prose('1', [output]), text: '正文不含任何手机标签，也不转述短信。' };
    const html = renderToStaticMarkup(createElement(ProseEntries, { entries: [entry] }));
    expect(html).toContain('approved-message-text');
    expect(html.indexOf('正文不含')).toBeLessThan(html.indexOf('approved-messages-heading'));
    const proseOnly = renderToStaticMarkup(createElement(ProseEntries, { entries: [{ ...entry, attachments: [], text: '<message name="顾岚">第一条：车站见。</message>\n' + JSON.stringify(output.value) }] }));
    expect(proseOnly).not.toContain('class="approved-messages');
    expect(proseOnly).not.toContain('<message');
  });

  it('never exposes hidden or history-filtered transcript bodies in entry or side-panel HTML', () => {
    const hidden = { ...transcript(), placement: 'hidden' as const };
    const expired = transcript();
    expired.display!.history = { maxEntriesAgo: 0 };
    const html = renderToStaticMarkup(createElement(ProseEntries, { entries: [prose('1', [hidden, expired]), prose('2')] }));
    expect(html).not.toContain('第一条');
    expect(html).not.toContain('approved-messages-heading');
    expired.placement = 'side-panel';
    expired.display!.placement = 'side-panel';
    const sidebar = renderToStaticMarkup(createElement(SidePanelOutputs, { prose: [prose('1', [expired]), prose('2', [hidden])] }));
    expect(sidebar).not.toContain('第一条');
    expect(sidebar).not.toContain('approved-messages-heading');
  });
});
