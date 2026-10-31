import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProseReviewAttempt, ProseReviewsView, ProseReviewTarget } from '../shared/prose-review';
import { api, errorText } from './api';
import './ProseReviewDialog.css';

export function proseReviewTargetLabel(target: ProseReviewTarget): string {
  return target.kind === 'main' ? `主稿 ${target.entryId}` : `场外稿 ${target.runId} · 成文尝试 ${target.renderAttemptId}`;
}
export function proseReviewAttemptLabel(attempt: ProseReviewAttempt): string {
  if (attempt.status === 'running') return '审阅进行中';
  if (attempt.status === 'failed') return '审阅失败 · 无完成结论';
  if (attempt.status === 'interrupted') return '审阅中断 · 无完成结论';
  if (attempt.status !== 'completed' || !attempt.result || !Array.isArray(attempt.result.findings)) return '未取得审阅结果';
  return attempt.result.findings.length ? `发现疑点 · ${attempt.result.findings.length} 处` : '未检出疑点（仅本次审阅）';
}
const categoryLabels = { action: '行为', interiority: '内心与知情', time: '时间', 'message-duplication': '消息重复', speech: '对白', other: '其他' };
function sameTarget(a: ProseReviewTarget, b: ProseReviewTarget) {
  return a.kind === 'main' && b.kind === 'main' ? a.entryId === b.entryId
    : a.kind === 'parallel' && b.kind === 'parallel' && a.runId === b.runId && a.renderAttemptId === b.renderAttemptId;
}
function briefTarget(target: ProseReviewTarget) {
  const id = target.kind === 'main' ? target.entryId : target.runId;
  return `${target.kind === 'main' ? '主稿' : '场外稿'} ${id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id}`;
}

export function ProseReviewContents({ view, disabled, prepareReview }: { view: ProseReviewsView; disabled: boolean; prepareReview: (target: ProseReviewTarget, title: string) => void }) {
  return <>
    <p className="fine">选择稿件后会回到作者输入框，明确提交才调用审阅模型。审阅不修改原稿、世界或角色知识；未检出疑点不代表全部内容已获准。</p>
    {!view.installed ? <p className="notice">未安装成文审阅助手；已有审阅历史仍可读取。</p> : !view.enabled && <p className="notice">成文审阅助手当前关闭；已有审阅历史保留。可到兼容运行 → 运行设置 → 代理模块装配，明确启用 rp.prose-review。</p>}
    <h3>可审阅稿件</h3>
    {!view.targets.length && <p className="muted">暂无可选择的已保存稿件。</p>}
    <div className="prose-review-targets">{view.targets.map((item, index) => <section key={`${proseReviewTargetLabel(item.target)}:${index}`}>
      <strong>{item.title || '未命名稿件'}</strong><p className="fine">{item.target.kind === 'main' ? '主稿' : '场外稿'} · 世界版本 {item.worldRevision}</p>
      <details className="prose-review-meta"><summary>审计信息</summary><p className="fine">{proseReviewTargetLabel(item.target)}</p></details>
      {!item.available && <p className="notice">暂不可审阅：{item.reason || '缺少可审阅的已保存素材。'}</p>}
      <button type="button" disabled={disabled || !view.installed || !view.enabled || !item.available} onClick={() => prepareReview(structuredClone(item.target), item.title || '未命名稿件')}>审阅此稿</button>
    </section>)}</div>
    <h3>保留的审阅历史</h3>
    {!view.reviews.length && <p className="muted">尚无审阅历史；这不表示稿件已经检查。</p>}
    {[...view.reviews].reverse().map(review => {
      const target = view.targets.find(item => sameTarget(item.target, review.target));
      return <details className="prose-review-record" key={review.id}>
      <summary>{target ? `${target.title || '未命名稿件'} · ${target.target.kind === 'main' ? '主稿' : '场外稿'} · 世界版本 ${target.worldRevision}` : briefTarget(review.target)} · {review.attempts.length} 次尝试</summary>
      <details className="prose-review-meta"><summary>审计信息</summary><p className="fine">{proseReviewTargetLabel(review.target)}</p><p className="fine">记录 {review.id} · 稿件指纹 {review.targetHash} · 素材指纹 {review.materialHash}</p></details>
      <details><summary>保存的原稿片段与依据</summary>
        {review.segments.map(segment => <section key={segment.id}><strong>{segment.id} · {segment.kind}</strong><p className="prose-review-text">{segment.text}</p></section>)}
        <h4>审阅依据</h4>{review.material.references.map(reference => <section key={reference.ref}><strong>{reference.ref} · {reference.kind}</strong><p className="prose-review-text">{reference.text}</p></section>)}
        {!!review.material.limitations.length && <><h4>素材限制</h4><ul>{review.material.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></>}
      </details>
      {[...review.attempts].reverse().map(attempt => <section className="prose-review-attempt" key={attempt.id}>
        <h4>{proseReviewAttemptLabel(attempt)}</h4><details className="prose-review-meta"><summary>尝试信息</summary><p className="fine">尝试 {attempt.id} · 请求 {attempt.requestId} · 回合 {attempt.turnId} · 审阅开始 {attempt.startedAt}</p></details>
        {attempt.error && <p className="error prose-review-text">{attempt.error}</p>}
        {attempt.result && Array.isArray(attempt.result.findings) && <>
          <p className="prose-review-text">审阅说明（模型意见）：{attempt.result.summary}</p>
          {attempt.status !== 'completed' && <p className="notice">此次尝试未完成，以下内容仅供核对。</p>}
          {attempt.result.findings.map((finding, index) => <section className="prose-review-finding" key={index}>
            <strong>{finding.severity === 'concern' ? '疑点' : '提示'} · {categoryLabels[finding.category]}</strong>
            <blockquote className="prose-review-text">{finding.quote}</blockquote><p className="prose-review-text">{finding.explanation}</p>
            <details className="prose-review-meta"><summary>引用依据 · {finding.sourceRefs.length} 条</summary><p className="fine">原稿片段：{finding.segmentId}</p>
              {!finding.sourceRefs.length && <p className="fine">未列出直接依据，请对照保存素材与限制核对。</p>}
              {finding.sourceRefs.map(ref => { const basis = review.material.references.find(item => item.ref === ref); return <p className="fine prose-review-text" key={ref}>依据 {ref}：{basis ? basis.text : '保存素材中未找到此引用，请核对。'}</p>; })}
            </details>
          </section>)}
        </>}
      </section>)}
    </details>; })}
  </>;
}

interface Props {
  sessionId: string; revision: number; updatedAt: string; author: boolean; disabled: boolean;
  close: () => void; prepareReview: (target: ProseReviewTarget, title: string) => void; refresh: () => Promise<void>;
}
export function ProseReviewDialog(props: Props) {
  return props.author ? <ReviewDialog key={props.sessionId} {...props}/> : null;
}
function ReviewDialog({ sessionId, revision, updatedAt, disabled, close, prepareReview, refresh }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [bound, setBound] = useState<{ sessionId: string; updatedAt: string; view: ProseReviewsView }>();
  const [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => {
    const controller = new AbortController(); setBound(undefined); setError('');
    api.proseReviews(sessionId, controller.signal).then(view => { if (!controller.signal.aborted) setBound({ sessionId, updatedAt, view }); })
      .catch(error => { if (!controller.signal.aborted) setError(errorText(error)); });
    return () => controller.abort();
  }, [sessionId, revision, updatedAt, attempt]);
  const view = bound?.sessionId === sessionId && bound.updatedAt === updatedAt ? bound.view : undefined;
  const stale = !!view && view.revision !== revision;
  return createPortal(<dialog ref={dialog} className="modal wide-modal prose-review-dialog" onCancel={event => { event.preventDefault(); close(); }}>
    <header className="modal-header"><h2>成文审阅</h2><button type="button" onClick={close}>关闭</button></header>
    <div className="modal-body">
      {error && <p className="error" role="alert">{error}</p>}
      {!view && !error && <p className="muted">正在读取作者审阅记录…</p>}
      {stale && <p className="notice">审阅列表与当前故事版本不同，暂不能准备新请求。请同步当前故事后重新读取。</p>}
      {disabled && <p className="notice">当前有请求进行中、回执未确认或模型未配置；仍可读取历史，暂不能准备新审阅。</p>}
      <div className="actions"><button type="button" onClick={() => setAttempt(value => value + 1)}>重新读取审阅记录</button>{stale && <button type="button" onClick={() => void refresh().catch(error => setError(errorText(error)))}>同步当前故事</button>}</div>
      {view && <ProseReviewContents view={view} disabled={disabled || stale} prepareReview={prepareReview}/>}
    </div>
  </dialog>, document.body);
}
