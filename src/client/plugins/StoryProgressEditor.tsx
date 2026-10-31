import { useEffect, useRef, useState } from 'react';
import type { StoryTaskStatus } from '../../shared/story-progress';
import { STORY_PROGRESS_CONTROL_SERVICE_ID, validateStoryProgressControlCommand, type StoryProgressControlCommand, type StoryProgressControlResult, type StoryProgressControlView } from '../../shared/story-progress-control';
import { api, ApiError, errorText } from '../api';
import type { PanelContext } from './registry';
import './StoryProgressEditor.css';

export interface StoryProgressDraft {
  target: string; title: string; summary: string; status: StoryTaskStatus; eventIds: string[]; reason: string;
  expectedRevision?: number; pending?: StoryProgressControlCommand; applied?: boolean;
}
export const emptyStoryProgressDraft = (): StoryProgressDraft => ({ target: 'new-main', title: '', summary: '', status: 'active', eventIds: [], reason: '' });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonblank = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A recovered unknown request is never repaired or assigned a new identity. */
export function recoverStoryProgressDraft(raw: string): StoryProgressDraft {
  const value: unknown = JSON.parse(raw);
  if (!record(value) || Object.keys(value).some(key => !['target', 'title', 'summary', 'status', 'eventIds', 'reason', 'expectedRevision', 'pending', 'applied'].includes(key))
    || !nonblank(value.target) || !['title', 'summary', 'reason'].every(key => typeof value[key] === 'string')
    || !['active', 'completed', 'shelved'].includes(String(value.status)) || !Array.isArray(value.eventIds) || !value.eventIds.every(nonblank)
    || new Set(value.eventIds).size !== value.eventIds.length || value.expectedRevision !== undefined && !revision(value.expectedRevision)
    || value.applied !== undefined && typeof value.applied !== 'boolean') throw new Error('本地进度草稿格式无效，未自动覆盖。');
  if (value.pending !== undefined) {
    const command = value.pending;
    if (validateStoryProgressControlCommand(command).length || !(command as StoryProgressControlCommand).patch.operations.length) throw new Error('本地未确认请求格式无效，提交已暂停。');
  }
  return value as unknown as StoryProgressDraft;
}

export function buildStoryProgressCommand(view: StoryProgressControlView, draft: StoryProgressDraft, requestId: string): StoryProgressControlCommand {
  if (draft.pending || draft.applied || draft.expectedRevision !== view.revision || !nonblank(requestId) || !draft.reason.trim()) throw new Error('请先同步版本、修改表单并填写理由。');
  const eventIds = [...draft.eventIds];
  if (!eventIds.length || new Set(eventIds).size !== eventIds.length || eventIds.some(id => !view.publicEvents.some(event => event.id === id))) throw new Error('请选择当前列表中的公开世界证据。');
  const evidence = { factIndexes: [], eventIds };
  const task = view.progress?.tasks.find(item => item.id === draft.target);
  const operation = draft.target === 'new-main' || draft.target === 'new-side'
    ? { op: 'create' as const, kind: draft.target === 'new-main' ? 'main' as const : 'side' as const, title: draft.title, summary: draft.summary, status: draft.status as 'active' | 'shelved', evidence }
    : { op: 'update' as const, taskId: draft.target, title: draft.title, summary: draft.summary, status: draft.status, evidence };
  if (operation.op === 'update' && (!task || task.status === 'completed')) throw new Error('完成档案只读，或所选任务已不存在。');
  if (operation.op === 'create' && operation.kind === 'main' && view.progress?.tasks.some(item => item.kind === 'main' && item.status !== 'completed')) throw new Error('请先完成现有主线，再创建下一条主线。');
  const patch = { operations: [operation] };
  const command = { requestId, expectedRevision: view.revision, reason: draft.reason, patch };
  if (validateStoryProgressControlCommand(command).length) throw new Error('请填写有效的标题、摘要和状态。');
  return command;
}

export const sendStoryProgressCommand = (sessionId: string, command: StoryProgressControlCommand) => api.sessionServiceCommand<StoryProgressControlResult>(sessionId, STORY_PROGRESS_CONTROL_SERVICE_ID, command);
const statusNames = { active: '进行中', shelved: '暂缓', completed: '已完成' };

export function StoryProgressForm({ view, draft, disabled, change, submit }: { view: StoryProgressControlView; draft: StoryProgressDraft; disabled: boolean; change: (draft: StoryProgressDraft) => void; submit: () => void }) {
  const unfinished = view.progress?.tasks.filter(task => task.status !== 'completed') ?? [];
  const archived = view.progress?.tasks.filter(task => task.status === 'completed') ?? [];
  const update = (patch: Partial<StoryProgressDraft>) => change({ ...draft, ...patch, applied: false });
  let valid = true;
  try { buildStoryProgressCommand(view, draft, 'form-validation'); } catch { valid = false; }
  return <>
    <p className="fine">{view.progress ? `已提交 PG ${view.progress.sequence} · 进度世界版本 ${view.progress.worldRevision}` : '尚无已提交进度。'} PG 记录成功的进度事务（含作者修改），不是时钟。</p>
    <div className="story-progress-task-list">{unfinished.map(task => <section key={task.id}><strong>{task.id} · {task.title}</strong><p>{statusNames[task.status]} · {task.summary}</p><small>证据：{task.evidence.eventIds.join('、')}</small></section>)}</div>
    <details><summary>已完成档案 · {archived.length}（只读）</summary>{archived.map(task => <section key={task.id}><strong>{task.id} · {task.title}</strong><p>{statusNames[task.status]} · {task.summary}</p><p className="fine">完成 PG {task.completedAtSequence} · 证据 {task.evidence.eventIds.join('、')}</p></section>)}</details>
    <fieldset disabled={disabled}>
      <legend>编辑一项进度</legend>
      <label>操作对象<select value={draft.target} onChange={event => {
        const target = event.target.value, task = unfinished.find(item => item.id === target);
        if ((draft.title || draft.summary || draft.reason || draft.eventIds.length) && !window.confirm('切换对象会替换当前表单；确认继续？')) return;
        update({ target, title: task?.title ?? '', summary: task?.summary ?? '', status: task?.status ?? 'active', eventIds: [] });
      }}><option value="new-main">新建主线</option><option value="new-side">新建支线</option>{unfinished.map(task => <option value={task.id} key={task.id}>{task.id} · {task.title}</option>)}</select></label>
      {!draft.target.startsWith('new-') && !unfinished.some(task => task.id === draft.target) && <p className="notice">所选任务已完成或不存在，请明确改选未完成任务或新建。</p>}
      <label>标题<input value={draft.title} onChange={event => update({ title: event.target.value })}/></label>
      <label>摘要<textarea value={draft.summary} onChange={event => update({ summary: event.target.value })}/></label>
      <label>状态<select value={draft.status} onChange={event => update({ status: event.target.value as StoryTaskStatus })}><option value="active">进行中</option><option value="shelved">暂缓</option>{!draft.target.startsWith('new-') && <option value="completed">完成并归档</option>}</select></label>
      <fieldset className="story-progress-evidence"><legend>公开世界证据（至少一项）</legend>{view.publicEvents.length ? view.publicEvents.map(event => <label key={event.id}><input type="checkbox" checked={draft.eventIds.includes(event.id)} onChange={input => update({ eventIds: input.target.checked ? [...draft.eventIds, event.id] : draft.eventIds.filter(id => id !== event.id) })}/><span>{event.text}<small>{event.id}{event.turnId ? ` · 回合 ${event.turnId}` : ''}</small></span></label>) : <p className="muted">没有可选择的公开世界证据；不能提交进度修改。</p>}</fieldset>
      {draft.eventIds.some(id => !view.publicEvents.some(event => event.id === id)) && <p className="error">草稿引用的部分证据已不在当前列表，请重新核对。</p>}
      <label>修改理由<input value={draft.reason} onChange={event => update({ reason: event.target.value })}/></label>
      {draft.target === 'new-main' && unfinished.some(task => task.kind === 'main') && <p className="notice">已有未完成主线，请先完成它，再创建下一条主线。</p>}
      <button type="button" disabled={!valid || disabled} onClick={submit}>提交作者进度修改</button>
    </fieldset>
  </>;
}

type ProgressContext = Pick<PanelContext, 'session' | 'readOnly' | 'refresh'>;
export function StoryProgressEditor(context: ProgressContext) {
  const [opened, setOpened] = useState(false);
  if (context.session.perspective !== 'author' || context.readOnly) return null;
  return <details className="story-progress-editor" onToggle={event => { if (event.currentTarget.open) setOpened(true); }}><summary>故事进度 · 作者校准</summary>{opened && <ProgressWorkspace key={context.session.id} {...context}/>}</details>;
}

function ProgressWorkspace({ session, refresh }: ProgressContext) {
  const key = `rp:story-progress-editor:${session.id}`;
  const initial = useRef<{ draft: StoryProgressDraft; error: string } | null>(null);
  if (!initial.current) {
    try { const saved = localStorage.getItem(key); initial.current = { draft: saved ? recoverStoryProgressDraft(saved) : emptyStoryProgressDraft(), error: '' }; }
    catch (error) { initial.current = { draft: emptyStoryProgressDraft(), error: errorText(error) }; }
  }
  const [draft, setDraft] = useState(initial.current.draft), [recoveryError, setRecoveryError] = useState(initial.current.error);
  const [view, setView] = useState<StoryProgressControlView>(), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [missing, setMissing] = useState(false), [loadedAt, setLoadedAt] = useState<number>();
  const flight = useRef(false);
  function persist(next: StoryProgressDraft) {
    setDraft(next);
    try { localStorage.setItem(key, JSON.stringify(next)); return true; }
    catch { setRecoveryError('无法保存本地草稿；为保留请求身份，提交已暂停。'); return false; }
  }
  async function load(synchronize: boolean, signal?: AbortSignal) {
    setLoading(true); setError('');
    try {
      const result = await api.sessionService<StoryProgressControlView>(session.id, STORY_PROGRESS_CONTROL_SERVICE_ID, signal);
      if (signal?.aborted) return;
      setView(result); setMissing(false); setLoadedAt(result.revision);
      if (!recoveryError) setDraft(current => {
        const next = current.pending || !synchronize && current.expectedRevision !== undefined ? current : { ...current, expectedRevision: result.revision };
        try { localStorage.setItem(key, JSON.stringify(next)); } catch { setRecoveryError('无法保存本地草稿，提交已暂停。'); }
        return next;
      });
    } catch (error) { if (!signal?.aborted) { setMissing(error instanceof ApiError && error.status === 404); setError(errorText(error)); } }
    finally { if (!signal?.aborted) setLoading(false); }
  }
  useEffect(() => { const controller = new AbortController(); void load(false, controller.signal); return () => controller.abort(); }, [session.id]);
  const busy = session.turns.some(turn => ['queued', 'running', 'committed'].includes(turn.status));
  const synchronized = !!view && view.revision === session.revision && draft.expectedRevision === view.revision;
  const disabled = busy || saving || loading || missing || !!recoveryError || !!draft.pending || !synchronized;
  async function submit() {
    if (!view || flight.current || busy || loading || recoveryError || missing || (!draft.pending && disabled)) return;
    let command: StoryProgressControlCommand;
    try { command = draft.pending ?? buildStoryProgressCommand(view, draft, crypto.randomUUID()); }
    catch (error) { setError(errorText(error)); return; }
    if (!persist({ ...draft, pending: command })) return;
    flight.current = true; setSaving(true); setLoadedAt(undefined); setError(''); setNotice('');
    let acknowledged = false;
    try {
      const result = await sendStoryProgressCommand(session.id, command);
      acknowledged = true; setView(result); setLoadedAt(result.revision);
      persist({ ...draft, pending: undefined, expectedRevision: result.revision, applied: true });
      setNotice(`进度已保存${result.duplicate ? '（原请求已提交）' : ''}。旧完成档案保留；表单继续保留，修改后可再次提交。`);
      await refresh();
    } catch (error) { setError(`${acknowledged ? '进度已保存，但故事未同步：' : '请求未确认或被拒绝；原请求保留，未自动重试：'}${errorText(error)}`); }
    finally { flight.current = false; setSaving(false); }
  }
  return <div className="story-progress-workspace">
    <p className="fine">直接修改宿主任务记录；不生成正文，不改时间、角色状态或来源开关。表单与未确认请求保存在此浏览器。</p>
    {missing && <p className="notice">此故事未安装进度控制服务；不会自动安装。</p>}
    {error && <p className="error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {recoveryError && <div className="notice"><p>{recoveryError}</p><button type="button" disabled={!view || saving || loading} onClick={() => { if (window.confirm('明确放弃无法读取的本地草稿及可能未确认的请求？请先核对当前已保存进度。')) { setRecoveryError(''); persist({ ...emptyStoryProgressDraft(), expectedRevision: view!.revision }); } }}>放弃损坏的本地草稿</button></div>}
    {view && !synchronized && <p className="notice">故事、读取结果或草稿版本不同；表单保留，不能覆盖更新。重新读取可同步草稿版本。</p>}
    {view && view.revision > session.revision && <button type="button" onClick={() => void refresh().catch(error => setError(errorText(error)))}>刷新故事版本</button>}
    {busy && <p className="notice">故事正在处理回合，提交已暂停。</p>}
    <button type="button" disabled={saving || loading} onClick={() => void load(true)}>{loading ? '读取中…' : '重新读取并同步版本（保留表单）'}</button>
    {draft.pending && <div className="notice"><p>未确认请求：{draft.pending.requestId} · 原版本 {draft.pending.expectedRevision}。表单已锁定；手动重试使用同一 ID 和完整原请求。</p><button type="button" disabled={saving || loading || busy || missing || !!recoveryError} onClick={() => void submit()}>重试原请求</button><button type="button" disabled={saving || loading || loadedAt !== session.revision} onClick={() => { if (window.confirm('请核对刚读取的进度：原请求可能已经提交。确认放弃原请求身份，保留表单并以当前版本继续？')) { persist({ ...draft, pending: undefined, expectedRevision: view!.revision, applied: false }); setNotice('已明确放弃原请求，请核对表单后再提交。'); } }}>核对后放弃原请求</button></div>}
    {view && <StoryProgressForm view={view} draft={draft} disabled={disabled} change={persist} submit={() => void submit()}/>}
  </div>;
}
