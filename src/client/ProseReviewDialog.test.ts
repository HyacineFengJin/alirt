import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProseReviewAttempt, ProseReviewsView } from '../shared/prose-review';
import type { SessionSnapshot } from '../shared/types';
import { ProseReviewContents, ProseReviewDialog, proseReviewAttemptLabel } from './ProseReviewDialog';
import { Reader, readerTurnRequest } from './Reader';
import { api } from './api';

const attempt = (): ProseReviewAttempt => ({ id: 'attempt', requestId: 'request', turnId: 'review-turn', status: 'completed', startedAt: 'saved-review-time', result: { summary: '需核对额外动作。', findings: [{ segmentId: 'segment-1', quote: '<b>原稿引用</b>', category: 'action', severity: 'concern', explanation: '<script>说明文字</script>', sourceRefs: ['fact-1'] }] } });
const view = (): ProseReviewsView => ({ revision: 7, installed: true, enabled: true, targets: [
  { target: { kind: 'main', entryId: 'entry-original' }, title: '主稿标题', worldRevision: 6, available: true },
  { target: { kind: 'parallel', runId: 'run-original', renderAttemptId: 'render-original' }, title: '场外标题', worldRevision: 5, available: false, reason: '没有已保存正文。' },
], reviews: [{ schema: 'rp.prose-review/0.1', id: 'review', target: { kind: 'main', entryId: 'entry-original' }, targetHash: 'target-fingerprint', materialHash: 'material-fingerprint', segments: [{ id: 'segment-1', kind: 'narration', text: '原始片段完整文本。' }], material: { references: [{ ref: 'fact-1', kind: 'world-fact', text: '仅记录公开通知。' }], limitations: ['没有额外行动素材。'] }, attempts: [attempt()] }] });
afterEach(() => vi.unstubAllGlobals());

it('renders saved targets, attempts, original quotes and basis as text without authorizing or editing prose', () => {
  const data = view(), original = JSON.stringify(data);
  const html = renderToStaticMarkup(createElement(ProseReviewContents, { view: data, disabled: false, prepareReview: () => { throw new Error('Rendering must never prepare or submit'); } }));
  expect(html).toContain('主稿 entry-original'); expect(html).toContain('场外稿 run-original · 成文尝试 render-original');
  expect(html).toContain('发现疑点 · 1 处'); expect(html).toContain('&lt;b&gt;原稿引用&lt;/b&gt;'); expect(html).toContain('&lt;script&gt;说明文字&lt;/script&gt;');
  expect(html).toContain('依据 fact-1：仅记录公开通知。'); expect(html).toContain('原始片段完整文本。'); expect(html).toContain('没有额外行动素材。');
  expect(html).toContain('target-fingerprint'); expect(html).toContain('material-fingerprint');
  expect(html).toContain('暂不可审阅：没有已保存正文。'); expect(html).not.toContain('<script>'); expect(html).not.toContain('<b>');
  expect(JSON.stringify(data)).toBe(original);
});
it('prioritizes saved titles and findings while keeping full audit/attempt/basis data closed by default', () => {
  const data = view(), original = JSON.stringify(data);
  const html = renderToStaticMarkup(createElement(ProseReviewContents, { view: data, disabled: false, prepareReview: () => {} }));
  expect(html).toContain('<summary>主稿标题 · 主稿 · 世界版本 6 · 1 次尝试</summary>');
  expect(html).toContain('<details class="prose-review-meta"><summary>审计信息</summary><p class="fine">主稿 entry-original</p><p class="fine">记录 review · 稿件指纹 target-fingerprint · 素材指纹 material-fingerprint</p></details>');
  expect(html).toContain('<details class="prose-review-meta"><summary>尝试信息</summary><p class="fine">尝试 attempt · 请求 request · 回合 review-turn · 审阅开始 saved-review-time</p></details>');
  expect(html).toContain('<strong>疑点 · 行为</strong><blockquote');
  expect(html).toContain('<details class="prose-review-meta"><summary>引用依据 · 1 条</summary>');
  expect(html).not.toMatch(/<details[^>]*\bopen(?:\s|=|>)/);
  expect(html).toContain('审阅说明（模型意见）');
  expect(JSON.stringify(data)).toBe(original);
  data.targets = [];
  data.reviews[0].target = { kind: 'parallel', runId: 'long-run-identifier-original', renderAttemptId: 'original-render-attempt' };
  const fallback = renderToStaticMarkup(createElement(ProseReviewContents, { view: data, disabled: false, prepareReview: () => {} }));
  expect(fallback).toContain('<summary>场外稿 long-run…inal · 1 次尝试</summary>');
  expect(fallback).toContain('场外稿 long-run-identifier-original · 成文尝试 original-render-attempt');
});
it('distinguishes no findings from missing/failed/interrupted results without calling any a pass', () => {
  expect(proseReviewAttemptLabel({ ...attempt(), result: { summary: '', findings: [] } })).toBe('未检出疑点（仅本次审阅）');
  expect(proseReviewAttemptLabel({ ...attempt(), result: undefined })).toBe('未取得审阅结果');
  expect(proseReviewAttemptLabel({ ...attempt(), status: 'failed' })).toContain('无完成结论');
  expect(proseReviewAttemptLabel({ ...attempt(), status: 'interrupted' })).toContain('无完成结论');
  expect(proseReviewAttemptLabel({ ...attempt(), status: 'running' })).toBe('审阅进行中');
  expect(proseReviewAttemptLabel({ ...attempt(), status: 'unknown' as ProseReviewAttempt['status'], result: { summary: '', findings: [] } })).toBe('未取得审阅结果');
  const data = view(); data.reviews[0].attempts = [{ ...attempt(), result: undefined }];
  const html = renderToStaticMarkup(createElement(ProseReviewContents, { view: data, disabled: false, prepareReview: () => {} }));
  expect(html).toContain('未取得审阅结果'); expect(html).not.toContain('未检出疑点（仅本次审阅）');
});
it('keeps history readable with module missing/off while disabling every preparation button', () => {
  for (const capabilities of [{ installed: false, enabled: false }, { installed: true, enabled: false }]) {
    const html = renderToStaticMarkup(createElement(ProseReviewContents, { view: { ...view(), ...capabilities }, disabled: false, prepareReview: () => {} }));
    expect(html.match(/<button type="button" disabled="">审阅此稿<\/button>/g)).toHaveLength(2);
    expect(html).toContain('发现疑点 · 1 处');
    expect(html).toContain(capabilities.installed ? '代理模块装配' : '未安装成文审阅助手');
  }
});
it('uses a separate explicit review-only turn payload, preserving exact target and focus without narration or recovery', async () => {
  const args = { requestId: 'review-exact', revision: 7, action: '  核对主稿  ', narration: { person: 'first' as const, pov: 'limited' as const }, perspective: 'author', mode: 'author' as const, proseReview: { kind: 'main' as const, entryId: 'entry-original' } };
  const payload = readerTurnRequest(args);
  expect(payload).toEqual({ requestId: 'review-exact', expectedRevision: 7, action: '核对主稿', mode: 'author', proseReview: { kind: 'main', entryId: 'entry-original' } });
  expect(payload).not.toHaveProperty('narration'); expect(payload).not.toHaveProperty('worldInput'); expect(payload).not.toHaveProperty('parallelRecovery');
  for (const change of [{ mode: 'action' as const }, { perspective: 'role' }, { parallelRunId: 'other-run' }, { action: ' ' }]) expect(() => readerTurnRequest({ ...args, ...change })).toThrow();
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError('uncertain')).mockResolvedValueOnce({ ok: true, json: async () => ({ turnId: 'review-turn' }) }); vi.stubGlobal('fetch', fetch);
  await expect(api.turn('session/one', payload)).rejects.toThrow('uncertain');
  await expect(api.turn('session/one', payload)).resolves.toEqual({ turnId: 'review-turn' });
  expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body); expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(payload);
});
it('does not mount the author review dialog or its launcher in role reading mode', () => {
  const html = renderToStaticMarkup(createElement(ProseReviewDialog, { sessionId: 's', revision: 7, updatedAt: 'now', author: false, disabled: false, close: () => {}, prepareReview: () => {}, refresh: async () => {} }));
  expect(html).toBe('');
  const session = { id: 's', revision: 7, updatedAt: 'now', perspective: 'author', playerRoleId: 'player', world: { time: '', location: '', variables: {} }, narration: { person: 'auto', pov: 'auto' }, roles: [{ id: 'player', name: '玩家', knowledge: [] }], prose: [], turns: [], events: [] } as unknown as SessionSnapshot;
  const role = { ...session, perspective: 'player' };
  const reader = renderToStaticMarkup(createElement(Reader, { session, reading: { perspective: 'player', projection: role, error: '', changePerspective: () => {}, retry: () => {} }, refresh: async () => {} }));
  expect(reader).not.toContain('>成文审阅</button>'); expect(reader).not.toContain('<dialog');
});
