import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionSnapshot } from '../../shared/types';
import type { StoryProgressControlView } from '../../shared/story-progress-control';
import { buildStoryProgressCommand, emptyStoryProgressDraft, recoverStoryProgressDraft, sendStoryProgressCommand, StoryProgressEditor, StoryProgressForm, type StoryProgressDraft } from './StoryProgressEditor';

const view = (): StoryProgressControlView => ({ schema: 'rp.story-progress-control/0.1', revision: 7, progress: {
  schema: 'rp.story-progress/0.1', sequence: 2, nextMainIndex: 2, nextSideIndex: 2, worldRevision: 7,
  before: { time: '傍晚', location: '站台' }, after: { time: '傍晚', location: '站台' },
  tasks: [{ id: 'MQ.I', kind: 'main', ordinal: 1, title: '等候列车', summary: '公开通知尚未宣布到站。', status: 'active', createdAtSequence: 2, updatedAtSequence: 2, evidence: { eventIds: ['world-1'] } },
    { id: 'SQ.1', kind: 'side', ordinal: 1, title: '阅读通知', summary: '两人已查看公开通知。', status: 'completed', createdAtSequence: 1, updatedAtSequence: 2, completedAtSequence: 2, evidence: { eventIds: ['world-1'] } }],
}, publicEvents: [{ id: 'world-1', turnId: 'turn-public', text: '站台公布列车延迟通知。' }] });
const draft = (): StoryProgressDraft => ({ ...emptyStoryProgressDraft(), target: 'MQ.I', title: '等候下一班列车', summary: '据已公布通知调整任务。', status: 'shelved', eventIds: ['world-1'], reason: '依照公开通知校准进度', expectedRevision: 7 });
afterEach(() => vi.unstubAllGlobals());

describe('author story progress editing', () => {
  it('builds an explicit CAS update using actual task and public evidence IDs without assigning host counters', () => {
    const before = view(), form = draft(), original = JSON.stringify([before, form]);
    expect(buildStoryProgressCommand(before, form, 'request-stable')).toEqual({ requestId: 'request-stable', expectedRevision: 7, reason: form.reason,
      patch: { operations: [{ op: 'update', taskId: 'MQ.I', title: form.title, summary: form.summary, status: 'shelved', evidence: { factIndexes: [], eventIds: ['world-1'] } }] } });
    expect(JSON.stringify([before, form])).toBe(original);
  });
  it('supports explicit main/side creation and leaves task identities to the host', () => {
    const empty = { ...view(), progress: null };
    for (const kind of ['main', 'side']) {
      const command = buildStoryProgressCommand(empty, { ...draft(), target: `new-${kind}`, status: 'active' }, 'create');
      expect(command.patch.operations[0]).toMatchObject({ op: 'create', kind, evidence: { factIndexes: [], eventIds: ['world-1'] } });
      expect(command.patch.operations[0]).not.toHaveProperty('taskId');
    }
    expect(() => buildStoryProgressCommand(view(), { ...draft(), target: 'new-main', status: 'active' }, 'create')).toThrow('先完成现有主线');
  });
  it('blocks stale, absent/forged evidence, missing reason and completed task modifications', () => {
    for (const changes of [{ expectedRevision: 6 }, { eventIds: [] }, { eventIds: ['raw-role-report'] }, { eventIds: ['world-1', 'world-1'] }, { reason: ' ' }, { target: 'SQ.1' }, { target: 'missing' }, { title: '' }, { applied: true }]) {
      expect(() => buildStoryProgressCommand(view(), { ...draft(), ...changes }, 'request')).toThrow();
    }
  });
  it('preserves an exact pending request across reload and rejects invalid recovery instead of repairing it', () => {
    const command = buildStoryProgressCommand(view(), draft(), 'persisted-request');
    const saved = { ...draft(), pending: command };
    expect(recoverStoryProgressDraft(JSON.stringify(saved))).toEqual(saved);
    expect(() => buildStoryProgressCommand(view(), saved, 'new-id')).toThrow();
    for (const pending of [{ ...command, expectedRevision: -1 }, { ...command, requestId: '' }, { ...command, extra: true }, { ...command, reason: ' ' }, { ...command, patch: { operations: [] } },
      { ...command, patch: { operations: [{ ...command.patch.operations[0], evidence: { eventIds: ['world-1'], factIndexes: [0] } }] } }]) {
      expect(() => recoverStoryProgressDraft(JSON.stringify({ ...saved, pending }))).toThrow();
    }
    expect(() => recoverStoryProgressDraft('{bad json')).toThrow();
  });
  it('retries only the exact recovered request against the generic service endpoint', async () => {
    const command = buildStoryProgressCommand(view(), draft(), 'stable-retry');
    const pending = recoverStoryProgressDraft(JSON.stringify({ ...draft(), pending: command })).pending!;
    const fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: { message: '结果未知' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...view(), requestId: command.requestId, duplicate: true, appliedRevision: 7 }) });
    vi.stubGlobal('fetch', fetch);
    await expect(sendStoryProgressCommand('session/known', command)).rejects.toMatchObject({ status: 503 });
    await expect(sendStoryProgressCommand('session/known', pending)).resolves.toMatchObject({ duplicate: true });
    expect(fetch.mock.calls[0][0]).toBe('/api/sessions/session%2Fknown/services/rp.story-progress-control/commands');
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(command);
  });
  it('renders host IDs and immutable completion archives, with explicit evidence/reason controls', () => {
    const html = renderToStaticMarkup(createElement(StoryProgressForm, { view: view(), draft: draft(), disabled: false, change: () => {}, submit: () => { throw new Error('Rendering never commits'); } }));
    expect(html).toContain('MQ.I · 等候列车'); expect(html).toContain('SQ.1 · 阅读通知');
    expect(html).toContain('已完成档案 · 1（只读）'); expect(html).toContain('已提交 PG 2'); expect(html).toContain('不是时钟');
    expect(html).not.toContain('<option value="SQ.1"');
    expect(html).toContain('type="checkbox"'); expect(html).toContain('world-1'); expect(html).toContain('修改理由');
    expect(html).not.toContain('删除');
    const blocked = renderToStaticMarkup(createElement(StoryProgressForm, { view: view(), draft: { ...draft(), eventIds: [] }, disabled: false, change: () => {}, submit: () => {} }));
    expect(blocked).toContain('<button type="button" disabled="">提交作者进度修改</button>');
    const missing = renderToStaticMarkup(createElement(StoryProgressForm, { view: { ...view(), publicEvents: [] }, draft: draft(), disabled: false, change: () => {}, submit: () => {} }));
    expect(missing).toContain('没有可选择的公开世界证据'); expect(missing).toContain('部分证据已不在当前列表');
  });
  it('does not mount editor content in role/read-only views and starts the author inline surface closed', () => {
    const props = { session: { id: 'test', perspective: 'role-1' } as SessionSnapshot, readOnly: false, refresh: async () => {} };
    expect(renderToStaticMarkup(createElement(StoryProgressEditor, props))).toBe('');
    expect(renderToStaticMarkup(createElement(StoryProgressEditor, { ...props, session: { ...props.session, perspective: 'author' }, readOnly: true }))).toBe('');
    const html = renderToStaticMarkup(createElement(StoryProgressEditor, { ...props, session: { ...props.session, perspective: 'author' } }));
    expect(html).toContain('<details class="story-progress-editor">'); expect(html).not.toContain('<dialog'); expect(html).not.toContain('公开世界证据');
  });
});
