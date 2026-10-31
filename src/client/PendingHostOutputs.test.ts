import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AuxiliaryOutput, Json, ProseEntry, WorldEvent } from '../shared/types';
import { PendingHostOutputs, pendingMessageOutputs } from './PendingHostOutputs';

function output(materialTurnId = 'material-1', key = 'sms'): AuxiliaryOutput {
  return {
    key, title: '短信', audience: 'public', type: 'object', placement: 'after-prose',
    display: { placement: 'after-prose', renderer: 'messages' },
    value: { schema: 'rp.approved-messages/0.1', materialTurnId, worldRevision: 7, messages: [
      { behaviorId: `${materialTurnId}-a`, roleId: 'a', name: '顾岚', text: '第一条 <user>原文</user>\n下一行', channel: 'message' },
      { behaviorId: `${materialTurnId}-b`, roleId: 'b', name: '爽世', text: '第二条', channel: 'message' },
      { behaviorId: `${materialTurnId}-c`, roleId: 'a', name: '顾岚', text: '第三条', channel: 'message' },
    ] },
    provenance: { kind: 'committed-behaviors', materialTurnId, behaviorIds: [`${materialTurnId}-a`, `${materialTurnId}-b`, `${materialTurnId}-c`], worldRevision: 7 },
  };
}
function event(attachment = output(), id = 'attempt-1'): WorldEvent {
  return { id: `event-${id}`, at: '2026-10-30T00:00:00.000Z', kind: 'host-output', actor: 'host', turnId: id,
    audience: structuredClone(attachment.audience), text: attachment.title,
    data: JSON.parse(JSON.stringify({ schema: 'rp.host-output/0.1', output: attachment })) as Json };
}
function prose(attachment: AuxiliaryOutput): ProseEntry {
  return { id: 'prose-1', turnId: 'recovered-attempt', title: '', text: '正文没有短信标记。', worldRevision: 22, attachments: [attachment] };
}
function render(events: WorldEvent[], entries: ProseEntry[] = []) {
  return renderToStaticMarkup(createElement(PendingHostOutputs, { events, prose: entries }));
}

describe('saved host messages awaiting prose', () => {
  it('shows confirmed messages after writer failure and removes them once the exact attachment is saved in prose', () => {
    const attachment = output(), saved = event(attachment);
    expect(pendingMessageOutputs([saved], [])).toEqual([attachment]);
    const html = render([saved]);
    expect(html).toContain('aria-label="待成文的远程消息"');
    expect(html).toContain('此处显示尚无对应正文的消息附件');
    expect(html).toContain('<details class="auxiliary-output approved-messages">');
    expect(html).toContain('第一条 &lt;user&gt;原文&lt;/user&gt;\n下一行');
    expect(html).not.toContain('<user>');
    expect(html.indexOf('第一条')).toBeLessThan(html.indexOf('第二条'));
    expect(html.indexOf('第二条')).toBeLessThan(html.indexOf('第三条'));
    expect(pendingMessageOutputs([saved], [prose(attachment)])).toEqual([]);
    expect(render([saved], [prose(attachment)])).toBe('');
  });

  it('deduplicates repeated recoveries by material identity and preserves the order of latest events', () => {
    const first = output('first'), second = output('second');
    const newestFirst = { ...first, title: '恢复后的短信标题' };
    const events = [event(first, 'failed-1'), event(second, 'failed-2'), event(newestFirst, 'recovery-1'), event(newestFirst, 'recovery-2')];
    expect(pendingMessageOutputs(events, []).map(item => [item.title, item.provenance?.kind === 'committed-behaviors' && item.provenance.materialTurnId]))
      .toEqual([['短信', 'second'], ['恢复后的短信标题', 'first']]);
    expect(pendingMessageOutputs(events, [prose(newestFirst)])).toEqual([second]);
  });

  it('matches whole attachments without depending on object key insertion order or compose attempt IDs', () => {
    const attachment = output();
    const reordered = { provenance: attachment.provenance, value: attachment.value, display: attachment.display, placement: attachment.placement,
      audience: attachment.audience, type: attachment.type, title: attachment.title, key: attachment.key };
    expect(pendingMessageOutputs([event(attachment, 'failed-attempt')], [prose(reordered)])).toEqual([]);
    expect(pendingMessageOutputs([event(attachment)], [prose({ ...attachment, title: '不同记录' })])).toEqual([attachment]);
  });

  it('retains older saved messages after a new material turn or later world revision', () => {
    const old = output('old'), current = output('current');
    const events = [event(old, 'old-attempt'), event(current, 'current-attempt')];
    expect(pendingMessageOutputs(events, [prose(current)])).toEqual([old]);
    expect(render(events, [prose(current)])).toContain('世界版本 7');
  });

  it('keeps separate output keys from the same material turn', () => {
    const one = output('material', 'one'), two = output('material', 'two');
    expect(pendingMessageOutputs([event(one), event(two)], [])).toEqual([one, two]);
  });

  it.each([
    ['wrong event kind', (saved: WorldEvent) => { saved.kind = 'role-behavior'; }],
    ['wrong actor', (saved: WorldEvent) => { saved.actor = 'role-a'; }],
    ['missing compose attempt', (saved: WorldEvent) => { delete saved.turnId; }],
    ['raw role reports', (saved: WorldEvent) => { saved.data = { roleReports: [{ messages: ['untrusted'] }] }; }],
    ['wrong host schema', (saved: WorldEvent) => { (saved.data as Record<string, Json>).schema = 'other'; }],
    ['extra host envelope fields', (saved: WorldEvent) => { (saved.data as Record<string, Json>).rawReports = ['untrusted']; }],
    ['private event/public attachment mismatch', (saved: WorldEvent) => { saved.audience = 'author'; }],
    ['public event/private attachment mismatch', (_saved: WorldEvent, attachment: AuxiliaryOutput) => { attachment.audience = ['role-a']; }],
    ['non-message renderer', (_saved: WorldEvent, attachment: AuxiliaryOutput) => { attachment.display!.renderer = 'plain'; }],
    ['hidden placement', (_saved: WorldEvent, attachment: AuxiliaryOutput) => { attachment.placement = attachment.display!.placement = 'hidden'; }],
    ['side-panel placement', (_saved: WorldEvent, attachment: AuxiliaryOutput) => { attachment.placement = attachment.display!.placement = 'side-panel'; }],
    ['inconsistent placement', (_saved: WorldEvent, attachment: AuxiliaryOutput) => { attachment.display!.placement = 'hidden'; }],
    ['history bound without an entry anchor', (_saved: WorldEvent, attachment: AuxiliaryOutput) => { attachment.display!.history = { maxEntriesAgo: 0 }; }],
  ])('omits %s without leaking message content', (_label, mutate) => {
    const attachment = output(), saved = event(attachment);
    mutate(saved, attachment);
    // Event-level mutations keep their envelope; attachment-level changes replace
    // only the original output so audience inconsistencies remain testable.
    if (saved.kind === 'host-output' && saved.actor === 'host' && saved.data && typeof saved.data === 'object'
      && !Array.isArray(saved.data) && saved.data.schema === 'rp.host-output/0.1') saved.data.output = JSON.parse(JSON.stringify(attachment));
    expect(pendingMessageOutputs([saved], [])).toEqual([]);
    expect(render([saved])).toBe('');
  });

  it('does not revive an older event when the latest output is hidden, and diagnoses the latest malformed record', () => {
    const old = output(), hidden = { ...old, placement: 'hidden' as const, display: { ...old.display!, placement: 'hidden' as const } };
    expect(pendingMessageOutputs([event(old, 'old'), event(hidden, 'latest')], [])).toEqual([]);
    const malformed = output();
    ((malformed.value as Record<string, Json>).messages as Record<string, Json>[])[0].text = null;
    expect(pendingMessageOutputs([event(old, 'old'), event(malformed, 'latest')], [])).toEqual([malformed]);
    const html = render([event(old, 'old'), event(malformed, 'latest')]);
    expect(html).toContain('消息记录暂不可用');
    expect(html).not.toContain('第一条');
  });

  it('trusts the active server projection for matching private audiences and does not infer missing private events', () => {
    const privateOutput = { ...output(), audience: ['role-a'] };
    expect(pendingMessageOutputs([event(privateOutput)], [])).toEqual([privateOutput]);
    expect(render([])).toBe('');
    expect(render([], [{ ...prose(privateOutput), attachments: [], text: JSON.stringify(event(privateOutput)) }])).toBe('');
  });

  it('omits valid empty transcripts from the pending-message notice', () => {
    const empty = output();
    (empty.value as Record<string, Json>).messages = [];
    if (empty.provenance?.kind === 'committed-behaviors') empty.provenance.behaviorIds = [];
    const saved = event(empty), original = JSON.stringify(saved);
    expect(pendingMessageOutputs([saved], [])).toEqual([]);
    expect(render([saved])).toBe('');
    expect(JSON.stringify(saved)).toBe(original);
  });

  it.each([
    ['missing provenance', (attachment: AuxiliaryOutput) => { delete attachment.provenance; }],
    ['null material for nonempty messages', (attachment: AuxiliaryOutput) => {
      (attachment.value as Record<string, Json>).materialTurnId = null;
      if (attachment.provenance?.kind === 'committed-behaviors') attachment.provenance.materialTurnId = null;
    }],
    ['malformed message', (attachment: AuxiliaryOutput) => { ((attachment.value as Record<string, Json>).messages as Record<string, Json>[])[1].channel = 'audio'; }],
    ['bad empty schema', (attachment: AuxiliaryOutput) => {
      (attachment.value as Record<string, Json>).schema = 'invalid';
      (attachment.value as Record<string, Json>).messages = [];
      if (attachment.provenance?.kind === 'committed-behaviors') attachment.provenance.behaviorIds = [];
    }],
  ])('keeps a diagnostic for %s without displaying invalid message bodies', (_label, mutate) => {
    const attachment = output(); mutate(attachment);
    const saved = event(attachment), html = render([saved]);
    expect(pendingMessageOutputs([saved], [])).toEqual([attachment]);
    expect(html).toContain('消息记录暂不可用');
    expect(html).not.toContain('第一条');
    expect(html).not.toContain('第二条');
  });
});
