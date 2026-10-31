import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TEXT_CARRIER_SERVICE_ID, type TextCarrierCommand, type TextCarrierCommandResult, type TextCarrierContent, type TextCarriersView, type TextCarrierTarget } from '../shared/text-carriers';
import type { PanelContext } from './plugins/registry';
import { api, ApiError, errorText } from './api';
import './TextCarriers.css';

export interface TextCarrierDraft { operation: 'create' | 'update'; carrierId?: string; expectedVersion?: number; expectedRevision?: number; content: TextCarrierContent; reason: string; pending?: TextCarrierCommand; applied?: boolean }
export const emptyTextCarrierDraft = (): TextCarrierDraft => ({ operation: 'create', content: { medium: 'paper', title: '', text: '', location: '', available: true }, reason: '' });
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, min = 1): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const identity = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.trim() === v && !['__proto__', 'prototype', 'constructor'].includes(v);
function contentShape(v: unknown): v is TextCarrierContent { return object(v) && Object.keys(v).sort().join(',') === 'available,location,medium,text,title' && ['paper', 'screen'].includes(String(v.medium)) && ['title', 'text', 'location'].every(k => typeof v[k] === 'string') && typeof v.available === 'boolean'; }
function commandShape(v: unknown): v is TextCarrierCommand {
  if (!object(v) || !identity(v.requestId) || !integer(v.expectedRevision, 0) || typeof v.reason !== 'string' || !v.reason.trim()) return false;
  const fields = v.operation === 'create' ? ['content'] : v.operation === 'update' ? ['carrierId', 'expectedVersion', 'content'] : v.operation === 'retire' ? ['carrierId', 'expectedVersion'] : undefined;
  return !!fields && Object.keys(v).sort().join(',') === ['requestId', 'expectedRevision', 'reason', 'operation', ...fields].sort().join(',')
    && (v.operation === 'create' || identity(v.carrierId) && integer(v.expectedVersion))
    && (v.operation === 'retire' || contentShape(v.content) && [v.content.title, v.content.text, v.content.location].every(s => s.trim()));
}
export function recoverTextCarrierDraft(raw: string): TextCarrierDraft {
  const d: unknown = JSON.parse(raw);
  if (!object(d) || Object.keys(d).some(k => !['operation', 'carrierId', 'expectedVersion', 'expectedRevision', 'content', 'reason', 'pending', 'applied'].includes(k)) || !['create', 'update'].includes(String(d.operation)) || !contentShape(d.content) || typeof d.reason !== 'string'
    || d.carrierId !== undefined && typeof d.carrierId !== 'string' || d.expectedVersion !== undefined && !integer(d.expectedVersion)
    || d.expectedRevision !== undefined && !integer(d.expectedRevision, 0) || d.applied !== undefined && typeof d.applied !== 'boolean' || d.pending !== undefined && !commandShape(d.pending)) throw new Error('本地载体草稿或未确认请求无效，提交已暂停，未自动覆盖。');
  return d as unknown as TextCarrierDraft;
}
export function textCarrierCommand(view: TextCarriersView, draft: TextCarrierDraft, requestId: string, retire = false): TextCarrierCommand {
  if (draft.pending || draft.applied || draft.expectedRevision !== view.revision) throw new Error('请明确同步版本并修改表单；先处理未确认请求。');
  const base = { requestId, expectedRevision: view.revision, reason: draft.reason };
  let command: TextCarrierCommand;
  if (retire || draft.operation === 'update') {
    const latest = view.carriers.find(c => c.id === draft.carrierId)?.versions.at(-1);
    if (!latest || latest.retired || latest.version !== draft.expectedVersion) throw new Error('载体版本已改变或已退役，请载入当前版本。');
    command = retire ? { ...base, operation: 'retire', carrierId: draft.carrierId!, expectedVersion: latest.version }
      : { ...base, operation: 'update', carrierId: draft.carrierId!, expectedVersion: latest.version, content: structuredClone(draft.content) };
  } else command = { ...base, operation: 'create', content: structuredClone(draft.content) };
  if (!commandShape(command)) throw new Error('请填写标题、原文、固定地点与修改理由。');
  return command;
}
export const sendTextCarrierCommand = (sessionId: string, command: TextCarrierCommand) => api.sessionServiceCommand<TextCarrierCommandResult>(sessionId, TEXT_CARRIER_SERVICE_ID, command);

export function TextCarrierForm({ view, draft, disabled, change, submit }: { view: TextCarriersView; draft: TextCarrierDraft; disabled: boolean; change: (d: TextCarrierDraft) => void; submit: (retire?: boolean) => void }) {
  const update = (patch: Partial<TextCarrierDraft>) => change({ ...draft, ...patch, applied: false });
  const content = (patch: Partial<TextCarrierContent>) => update({ content: { ...draft.content, ...patch } });
  const valid = (retire = false) => { try { textCarrierCommand(view, draft, 'form-check', retire); return true; } catch { return false; } };
  return <>
    <p className="notice">这里建立公开、固定主场的纸面或屏幕文字，是作者设定；保存不代表任何角色已查看或相信内容。退役保留旧版本与查看记录。</p>
    <div className="text-carrier-list">{view.carriers.map(carrier => { const latest = carrier.versions.at(-1); return latest && <section key={carrier.id}><strong>{latest.title} · 版本 {latest.version}</strong><p>{latest.medium === 'paper' ? '纸面' : '屏幕'} · {latest.location} · {latest.retired ? '已退役' : latest.available ? '可用' : '不可用'}</p>
      <button type="button" disabled={disabled || latest.retired} onClick={() => { if ((draft.content.title || draft.content.text) && !window.confirm('载入此版本会替换当前表单，确认继续？')) return; update({ operation: 'update', carrierId: carrier.id, expectedVersion: latest.version, content: { medium: latest.medium, title: latest.title, text: latest.text, location: latest.location, available: latest.available } }); }}>编辑当前版本</button>
      <details><summary>版本档案 · {carrier.versions.length}</summary>{carrier.versions.map(v => <section key={v.version}><p>版本 {v.version} · 世界版本 {v.revision} · {v.retired ? '已退役' : v.available ? '可用' : '不可用'} · {v.location}</p><strong>{v.title}</strong><p className="text-carrier-text">{v.text}</p><small>{carrier.id} · 来源事件 {v.sourceEventId}</small></section>)}</details>
    </section>; })}</div>
    <fieldset disabled={disabled}><legend>{draft.operation === 'create' ? '新建公开载体' : `编辑版本 ${draft.expectedVersion ?? '未载入'}`}</legend>
      <button type="button" onClick={() => { if ((draft.content.title || draft.content.text) && !window.confirm('新建会替换当前表单，确认继续？')) return; change({ ...emptyTextCarrierDraft(), expectedRevision: draft.expectedRevision }); }}>新建载体草稿</button>
      <label>载体形式<select value={draft.content.medium} onChange={e => content({ medium: e.target.value as TextCarrierContent['medium'] })}><option value="paper">纸面</option><option value="screen">屏幕</option></select></label>
      <label>标题<input value={draft.content.title} onChange={e => content({ title: e.target.value })}/></label>
      <label>公开原文<textarea rows={5} value={draft.content.text} onChange={e => content({ text: e.target.value })}/></label>
      <label>固定主场地点<input value={draft.content.location} onChange={e => content({ location: e.target.value })}/></label>
      <label className="text-carrier-check"><input type="checkbox" checked={draft.content.available} onChange={e => content({ available: e.target.checked })}/>当前可用</label>
      <label>修改理由<input value={draft.reason} onChange={e => update({ reason: e.target.value })}/></label>
      <div className="actions"><button type="button" disabled={!valid()} onClick={() => submit()}>保存作者设定</button><button type="button" disabled={draft.operation !== 'update' || !valid(true)} onClick={() => { if (window.confirm('明确退役此载体并保留全部历史版本与查看记录？')) submit(true); }}>退役（保留历史）</button></div>
    </fieldset>
    <details><summary>查看记录 · {view.views.length}</summary>{view.views.map(v => <p key={v.id}>{v.readerName} · 查看「{v.carrier.title}」版本 {v.carrierVersion} · 世界版本 {v.worldRevision}（记录查看发生，不证明文字内容为真）</p>)}</details>
  </>;
}

type EditorProps = Pick<PanelContext, 'session' | 'readOnly' | 'refresh'>;
export function TextCarrierEditor(props: EditorProps) {
  const [opened, setOpened] = useState(false);
  return props.session.perspective === 'author' && !props.readOnly ? <details className="text-carrier-editor" onToggle={e => { if (e.currentTarget.open) setOpened(true); }}><summary>公开文字载体 · 作者设定</summary>{opened && <CarrierWorkspace key={props.session.id} {...props}/>}</details> : null;
}
function CarrierWorkspace({ session, refresh }: EditorProps) {
  const key = `rp:text-carriers:${session.id}`, initial = useRef<{ draft: TextCarrierDraft; error: string } | null>(null);
  if (!initial.current) { try { const raw = localStorage.getItem(key); initial.current = { draft: raw ? recoverTextCarrierDraft(raw) : emptyTextCarrierDraft(), error: '' }; } catch (e) { initial.current = { draft: emptyTextCarrierDraft(), error: errorText(e) }; } }
  const [draft, setDraft] = useState(initial.current.draft), [blocked, setBlocked] = useState(initial.current.error), [view, setView] = useState<TextCarriersView>();
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [missing, setMissing] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [loadedAt, setLoadedAt] = useState<number>();
  const flight = useRef(false);
  function persist(next: TextCarrierDraft) { setDraft(next); try { localStorage.setItem(key, JSON.stringify(next)); return true; } catch { setBlocked('无法保存本地草稿，为保留原请求身份已暂停提交。'); return false; } }
  async function load(sync = false, signal?: AbortSignal) {
    setLoading(true); setError('');
    try { const value = await api.sessionService<TextCarriersView>(session.id, TEXT_CARRIER_SERVICE_ID, signal); if (signal?.aborted) return; setView(value); setMissing(false); setLoadedAt(value.revision);
      if (!blocked) setDraft(current => { const next = current.pending || !sync && current.expectedRevision !== undefined ? current : { ...current, expectedRevision: value.revision }; try { localStorage.setItem(key, JSON.stringify(next)); } catch { setBlocked('无法保存本地草稿，提交已暂停。'); } return next; });
    } catch (e) { if (!signal?.aborted) { setMissing(e instanceof ApiError && e.status === 404); setError(errorText(e)); } } finally { if (!signal?.aborted) setLoading(false); }
  }
  useEffect(() => { const controller = new AbortController(); void load(false, controller.signal); return () => controller.abort(); }, [session.id]);
  const busy = session.turns.some(turn => ['queued', 'running', 'committed'].includes(turn.status));
  const synchronized = !!view && view.revision === session.revision && draft.expectedRevision === view.revision;
  const disabled = saving || loading || busy || missing || !!blocked || !!draft.pending || !synchronized;
  async function submit(retire = false) {
    if (!view || flight.current || busy || loading || missing || blocked || !draft.pending && disabled) return;
    let command: TextCarrierCommand;
    try { command = draft.pending ?? textCarrierCommand(view, draft, crypto.randomUUID(), retire); } catch (e) { setError(errorText(e)); return; }
    if (!persist({ ...draft, pending: command })) return;
    flight.current = true; setSaving(true); setLoadedAt(undefined); setError(''); setNotice(''); let acknowledged = false;
    try { const result = await sendTextCarrierCommand(session.id, command); acknowledged = true;
      persist({ ...draft, operation: 'update', carrierId: result.carrierId, expectedVersion: result.version, expectedRevision: result.revision, pending: undefined, applied: true });
      setNotice(`载体作者设定已保存${result.duplicate ? '（原请求已提交）' : ''}，没有执行查看或调用模型。表单保留。`); await load(); await refresh();
    } catch (e) { setError(`${acknowledged ? '设定已保存，尚未同步：' : '请求未确认或被拒绝，原请求保留且未自动重试：'}${errorText(e)}`); } finally { flight.current = false; setSaving(false); }
  }
  return <div className="text-carrier-workspace">
    {missing && <p className="notice">此故事未安装文字载体控制服务，不会自动安装。</p>}{error && <p className="error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {blocked && <div className="notice"><p>{blocked}</p><button disabled={!view || loading || saving} onClick={() => { if (window.confirm('请先核对已保存档案。明确放弃损坏草稿及可能未确认请求？')) { setBlocked(''); persist({ ...emptyTextCarrierDraft(), expectedRevision: view!.revision }); } }}>放弃无法读取的本地草稿</button></div>}
    {view && !synchronized && <p className="notice">故事、载体或草稿版本不同，提交已暂停。请明确重新读取并核对，草稿保留。</p>}
    {view && view.revision > session.revision && <button onClick={() => void refresh().catch(e => setError(errorText(e)))}>同步故事版本</button>}
    <button disabled={loading || saving} onClick={() => void load(true)}>{loading ? '读取中…' : '重新读取并同步版本（保留草稿）'}</button>
    {draft.pending && <div className="notice"><p>未确认请求已锁定；重试使用原 ID、版本、理由和完整内容。</p><button disabled={loading || saving || busy || missing || !!blocked} onClick={() => void submit()}>重试原请求</button><button disabled={loading || saving || loadedAt !== session.revision} onClick={() => { if (window.confirm('原请求可能已经提交。核对刚读取的档案后，明确放弃原请求身份？')) persist({ ...draft, pending: undefined, expectedRevision: view!.revision, applied: false }); }}>核对后放弃原请求</button></div>}
    {view && <TextCarrierForm view={view} draft={draft} disabled={disabled} change={persist} submit={retire => void submit(retire)}/>}
  </div>;
}

export function viewCarrierAction(target: TextCarrierTarget) { return `查看「${target.title}」`; }
export function TextCarrierTargets({ targets, disabled, prepare }: { targets: TextCarrierTarget[]; disabled: boolean; prepare: (target: TextCarrierTarget) => void }) {
  return <><p className="fine">这里只列玩家当前可物理查看的载体标题，不预读正文。选择后回到行动框，明确提交并由世界裁定才可能查看成功。</p>{!targets.length && <p className="muted">当前没有可供玩家选择的物理可读载体。</p>}{targets.map(target => <section key={`${target.carrierId}:${target.version}`}><strong>{target.title}</strong><p>{target.medium === 'paper' ? '纸面' : '屏幕'} · 版本 {target.version} · {target.location}</p><button type="button" disabled={disabled} onClick={() => prepare(structuredClone(target))}>准备查看此载体</button></section>)}</>;
}
interface PickerProps { sessionId: string; revision: number; updatedAt: string; author: boolean; disabled: boolean; close: () => void; prepare: (target: TextCarrierTarget) => void; refresh: () => Promise<void> }
export function TextCarrierPicker(props: PickerProps) { return props.author ? <Picker key={props.sessionId} {...props}/> : null; }
function Picker({ sessionId, revision, updatedAt, disabled, close, prepare, refresh }: PickerProps) {
  const dialog = useRef<HTMLDialogElement>(null), [bound, setBound] = useState<{ sessionId: string; updatedAt: string; revision: number; targets: TextCarrierTarget[] }>(), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => { const controller = new AbortController(); setBound(undefined); setError(''); api.textCarrierTargets(sessionId, controller.signal).then(value => { if (!controller.signal.aborted) setBound({ ...value, sessionId, updatedAt }); }).catch(e => { if (!controller.signal.aborted) setError(errorText(e)); }); return () => controller.abort(); }, [sessionId, revision, updatedAt, attempt]);
  const value = bound?.sessionId === sessionId && bound.updatedAt === updatedAt ? bound : undefined, stale = !!value && value.revision !== revision;
  return createPortal(<dialog ref={dialog} className="modal wide-modal text-carrier-picker" onCancel={e => { e.preventDefault(); close(); }}><header className="modal-header"><h2>查看载体</h2><button onClick={close}>关闭</button></header><div className="modal-body">
    {error && <p className="error" role="alert">{error}</p>}{!value && !error && <p>读取目标中…</p>}{stale && <p className="notice">目标列表与故事版本不同，暂不能选择。请同步后重读。</p>}{disabled && <p className="notice">当前回合忙碌、请求回执未确认或模型未配置，暂不能准备查看；仍可读取目标列表。</p>}
    <button onClick={() => setAttempt(v => v + 1)}>重新读取目标</button>{stale && <button onClick={() => void refresh().catch(e => setError(errorText(e)))}>同步故事</button>}
    {value && <TextCarrierTargets targets={value.targets} disabled={disabled || stale} prepare={prepare}/>}
  </div></dialog>, document.body);
}
