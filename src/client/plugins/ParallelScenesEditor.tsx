import { useEffect, useRef, useState } from 'react';
import { PARALLEL_SCENES_SERVICE_ID, validateParallelScenesCommand, type ParallelSceneDefinition, type ParallelScenesCommand, type ParallelScenesResult, type ParallelScenesView } from '../../shared/parallel-scenes';
import { api, ApiError, errorText } from '../api';
import type { PanelContext } from './registry';
import './ParallelScenesEditor.css';

export interface ParallelScenesDraft {
  scene: ParallelSceneDefinition; selectedSceneIds?: string[]; reason: string; expectedRevision?: number;
  pending?: ParallelScenesCommand; applied?: boolean;
}
export const emptyParallelScenesDraft = (): ParallelScenesDraft => ({ scene: { id: '', title: '', enabled: false, participantRoleIds: [], locationKey: '', goal: '' }, reason: '' });
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every(id => typeof id === 'string' && !!id.trim()) && new Set(v).size === v.length;
export function recoverParallelScenesDraft(raw: string): ParallelScenesDraft {
  const d: unknown = JSON.parse(raw);
  if (!obj(d) || Object.keys(d).some(k => !['scene', 'selectedSceneIds', 'reason', 'expectedRevision', 'pending', 'applied'].includes(k)) || !obj(d.scene)
    || Object.keys(d.scene).sort().join(',') !== 'enabled,goal,id,locationKey,participantRoleIds,title' || !['id', 'title', 'locationKey', 'goal'].every(k => typeof (d.scene as Record<string, unknown>)[k] === 'string')
    || typeof d.scene.enabled !== 'boolean' || !ids(d.scene.participantRoleIds) || typeof d.reason !== 'string'
    || d.selectedSceneIds !== undefined && (!ids(d.selectedSceneIds) || d.selectedSceneIds.length > 2)
    || d.expectedRevision !== undefined && (!Number.isSafeInteger(d.expectedRevision) || (d.expectedRevision as number) < 0)
    || d.applied !== undefined && typeof d.applied !== 'boolean'
    || d.pending !== undefined && validateParallelScenesCommand(d.pending).length) throw new Error('本地场景草稿或未确认请求无效，未自动修复或覆盖。');
  return d as unknown as ParallelScenesDraft;
}
export function parallelScenesCommand(view: ParallelScenesView, draft: ParallelScenesDraft, operation: 'upsert' | 'select' | 'remove', requestId: string): ParallelScenesCommand {
  if (draft.pending || draft.applied || draft.expectedRevision !== view.revision) throw new Error('请明确同步版本并修改表单；未确认请求需先处理。');
  const base = { requestId, expectedRevision: view.revision, reason: draft.reason };
  const command: ParallelScenesCommand = operation === 'upsert' ? { ...base, operation, scene: structuredClone(draft.scene) }
    : operation === 'select' ? { ...base, operation, selectedSceneIds: [...(draft.selectedSceneIds ?? [])] } : { ...base, operation, sceneId: draft.scene.id };
  if (validateParallelScenesCommand(command).length) throw new Error('请填写完整场景、理由，选择数量不得超过两个。');
  if (command.operation === 'upsert' && command.scene.participantRoleIds.some(id => !view.roles.some(role => role.roleId === id))) throw new Error('请选择已存在的角色。');
  if (command.operation === 'remove' && !view.grants.some(scene => scene.id === command.sceneId)) throw new Error('所选授权已不存在。');
  if (command.operation === 'select') {
    const selected = command.selectedSceneIds.map(id => view.grants.find(scene => scene.id === id));
    if (selected.some(scene => !scene)) throw new Error('选择中包含已撤销场景，请明确取消它。');
    const roles = selected.flatMap(scene => scene!.participantRoleIds);
    if (new Set(roles).size !== roles.length) throw new Error('同一角色不能同时进入两个已选择场景。');
  }
  return command;
}
export const sendParallelScenesCommand = (sessionId: string, command: ParallelScenesCommand) => api.sessionServiceCommand<ParallelScenesResult>(sessionId, PARALLEL_SCENES_SERVICE_ID, command);

export function ParallelScenesForm({ view, draft, disabled, change, submit }: { view: ParallelScenesView; draft: ParallelScenesDraft; disabled: boolean; change: (draft: ParallelScenesDraft) => void; submit: (operation: 'upsert' | 'select' | 'remove') => void }) {
  const update = (patch: Partial<ParallelScenesDraft>) => change({ ...draft, ...patch, applied: false });
  const scene = (patch: Partial<ParallelSceneDefinition>) => update({ scene: { ...draft.scene, ...patch } });
  const valid = (op: 'upsert' | 'select' | 'remove') => { try { parallelScenesCommand(view, draft, op, 'validate'); return true; } catch { return false; } };
  const selection = draft.selectedSceneIds ?? [];
  const keys = [...new Set([...view.roles.filter(role => draft.scene.participantRoleIds.includes(role.roleId)).flatMap(role => role.heldStringKeys), ...(draft.scene.locationKey ? [draft.scene.locationKey] : [])])];
  return <>
    <p className="fine">场景授权与选择不改变角色生命周期、在场状态或短信渠道。普通回合仅在平行输出合约与模块开启、场景就绪时推进；这里不会启用来源或立即调用模型。</p>
    <div className="parallel-grants">{view.grants.map(grant => { const ready = view.sceneReadiness.find(item => item.sceneId === grant.id); return <section key={grant.id}>
      <strong>{grant.title} · {grant.id} · 档案版本 {grant.generation}</strong><p>{grant.enabled ? '授权开启' : '授权关闭'} · {view.selectedSceneIds.includes(grant.id) ? '已保存选择' : '未选择'} · {ready?.ready ? '参与条件已就绪' : '未就绪'}</p>
      <p>地点：{ready?.location ?? '未知'}</p>{ready?.diagnostics.map((item, index) => <p className="notice" key={index}>{item.roleId ? `${item.roleId} · ` : ''}{item.code}：{item.message}</p>)}
      {ready?.participants.map(role => <p className="fine" key={role.roleId}>{role.name} · {role.roleId} · {role.phase}/{role.presence} · {role.location.key}：{role.location.value ?? '未知'}</p>)}
      <button type="button" disabled={disabled} onClick={() => { if ((draft.scene.title || draft.scene.goal) && !window.confirm('载入此授权会替换当前场景表单，确认继续？')) return; const { generation: _, ...definition } = grant; update({ scene: structuredClone(definition) }); }}>编辑此授权</button>
    </section>; })}</div>
    {view.sceneReadiness.filter(item => !view.grants.some(grant => grant.id === item.sceneId)).map(item => <p className="notice" key={item.sceneId}>{item.sceneId}：{item.diagnostics.map(d => `${d.code} · ${d.message}`).join('；')}</p>)}
    <fieldset disabled={disabled}><legend>持久选择（0–2 个场景）</legend>{[...new Set([...view.grants.map(g => g.id), ...selection])].map(id => <label key={id} className="parallel-check"><input type="checkbox" checked={selection.includes(id)} disabled={!selection.includes(id) && selection.length >= 2} onChange={event => update({ selectedSceneIds: event.target.checked ? [...selection, id] : selection.filter(item => item !== id) })}/>{view.grants.find(g => g.id === id)?.title ?? '已撤销场景'} · {id}</label>)}
      <button type="button" disabled={!valid('select')} onClick={() => submit('select')}>保存场景选择</button></fieldset>
    <fieldset disabled={disabled}><legend>授权表单</legend>
      <button type="button" onClick={() => { if ((draft.scene.title || draft.scene.goal) && !window.confirm('新建会替换当前场景表单，确认继续？')) return; update({ scene: { ...emptyParallelScenesDraft().scene, id: crypto.randomUUID() } }); }}>新建独立场景草稿</button>
      <label>场景 ID<input value={draft.scene.id} onChange={event => scene({ id: event.target.value })}/></label>
      <label>标题<input value={draft.scene.title} onChange={event => scene({ title: event.target.value })}/></label>
      <label className="parallel-check"><input type="checkbox" checked={draft.scene.enabled} onChange={event => scene({ enabled: event.target.checked })}/>授权开启（关闭保留档案与已保存选择）</label>
      <fieldset className="parallel-role-list"><legend>已有角色（明确选择；未就绪不会自动唤醒）</legend>{view.roles.map(role => { const location = role.readableStringFields.find(field => field.key === draft.scene.locationKey); return <label key={role.roleId} className="parallel-check"><input type="checkbox" checked={draft.scene.participantRoleIds.includes(role.roleId)} onChange={event => scene({ participantRoleIds: event.target.checked ? [...draft.scene.participantRoleIds, role.roleId] : draft.scene.participantRoleIds.filter(id => id !== role.roleId) })}/><span>{role.name} · {role.roleId} · {role.phase}/{role.presence}<small>出场证据：{role.appearanceEvidence.length ? role.appearanceEvidence.map(item => item.kind).join('、') : '未证实'} · 地点：{location?.known ? location.value : '未知'}</small>{role.diagnostics.map((d, index) => <small key={index}>{d.code}：{d.message}</small>)}</span></label>; })}</fieldset>
      <label>角色地点字段<select value={draft.scene.locationKey} onChange={event => scene({ locationKey: event.target.value })}><option value="">明确选择实际持有的字符串字段</option>{keys.map(key => <option key={key} value={key}>{key}</option>)}</select></label>
      <p className="fine">地点取参与者实际持有且可读取的非空字符串；未知或不同地点会阻止推进，不用主场地点补齐。表单尚未保存时，以保存后服务诊断为准。</p>
      <label>场景目标（作者私有）<textarea value={draft.scene.goal} onChange={event => scene({ goal: event.target.value })}/></label>
      <button type="button" disabled={!valid('upsert')} onClick={() => submit('upsert')}>保存场景授权</button>
      <button type="button" disabled={!valid('remove')} onClick={() => { if (window.confirm('撤销当前授权并保留档案及原选择？旧选择会显示未就绪，直到明确修改。')) submit('remove'); }}>撤销此授权（保留档案）</button>
    </fieldset>
    <label>提交理由（作者私有）<input disabled={disabled} value={draft.reason} onChange={event => update({ reason: event.target.value })}/></label>
    <details><summary>保留的授权档案 · {view.archives.length}</summary>{view.archives.map(grant => <section key={`${grant.id}:${grant.generation}`}><strong>{grant.title} · {grant.id} · 档案版本 {grant.generation}</strong><p>{grant.participantRoleIds.join('、')} · 地点字段 {grant.locationKey}</p><p className="output-text">{grant.goal}</p></section>)}</details>
  </>;
}

type Context = Pick<PanelContext, 'session' | 'readOnly' | 'refresh'>;
export function ParallelScenesEditor(context: Context) {
  const [opened, setOpened] = useState(false);
  if (context.readOnly || context.session.perspective !== 'author') return null;
  return <details className="parallel-scenes-editor" onToggle={event => { if (event.currentTarget.open) setOpened(true); }}><summary>场外平行场景 · 作者授权</summary>{opened && <Workspace key={context.session.id} {...context}/>}</details>;
}
function Workspace({ session, refresh }: Context) {
  const key = `rp:parallel-scenes:${session.id}`;
  const initial = useRef<{ draft: ParallelScenesDraft; error: string } | null>(null);
  if (!initial.current) { try { const raw = localStorage.getItem(key); initial.current = { draft: raw ? recoverParallelScenesDraft(raw) : emptyParallelScenesDraft(), error: '' }; } catch (e) { initial.current = { draft: emptyParallelScenesDraft(), error: errorText(e) }; } }
  const [draft, setDraft] = useState(initial.current.draft), [blocked, setBlocked] = useState(initial.current.error);
  const [view, setView] = useState<ParallelScenesView>(), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [missing, setMissing] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loadedAt, setLoadedAt] = useState<number>();
  const flight = useRef(false);
  function persist(next: ParallelScenesDraft) { setDraft(next); try { localStorage.setItem(key, JSON.stringify(next)); return true; } catch { setBlocked('无法保存本地草稿；为保留请求身份，提交已暂停。'); return false; } }
  async function load(sync: boolean, signal?: AbortSignal) {
    setLoading(true); setError('');
    try { const result = await api.sessionService<ParallelScenesView>(session.id, PARALLEL_SCENES_SERVICE_ID, signal); if (signal?.aborted) return;
      setView(result); setMissing(false); setLoadedAt(result.revision);
      if (!blocked) setDraft(current => { const next = { ...current, selectedSceneIds: current.selectedSceneIds ?? [...result.selectedSceneIds], expectedRevision: current.pending || !sync && current.expectedRevision !== undefined ? current.expectedRevision : result.revision }; try { localStorage.setItem(key, JSON.stringify(next)); } catch { setBlocked('无法保存本地草稿，提交已暂停。'); } return next; });
    } catch (e) { if (!signal?.aborted) { setMissing(e instanceof ApiError && e.status === 404); setError(errorText(e)); } } finally { if (!signal?.aborted) setLoading(false); }
  }
  useEffect(() => { const controller = new AbortController(); void load(false, controller.signal); return () => controller.abort(); }, [session.id]);
  const busy = session.turns.some(turn => ['queued', 'running', 'committed'].includes(turn.status));
  const synchronized = !!view && view.revision === session.revision && draft.expectedRevision === view.revision;
  const disabled = busy || loading || saving || missing || !!blocked || !!draft.pending || !synchronized;
  async function submit(operation?: 'upsert' | 'select' | 'remove') {
    if (!view || flight.current || busy || loading || missing || blocked || !draft.pending && (disabled || !operation)) return;
    let command: ParallelScenesCommand;
    try { command = draft.pending ?? parallelScenesCommand(view, draft, operation!, crypto.randomUUID()); } catch (e) { setError(errorText(e)); return; }
    if (!persist({ ...draft, pending: command })) return;
    flight.current = true; setSaving(true); setLoadedAt(undefined); setError(''); setNotice(''); let acknowledged = false;
    try { const result = await sendParallelScenesCommand(session.id, command); acknowledged = true; setView(result); setLoadedAt(result.revision);
      persist({ ...draft, pending: undefined, expectedRevision: result.revision, applied: true }); setNotice(`场景控制已保存${result.duplicate ? '（原请求已提交）' : ''}。没有调用模型或修改生命周期；表单保留，继续修改后可再次提交。`); await refresh();
    } catch (e) { setError(`${acknowledged ? '已保存，但故事未同步：' : '请求未确认或被拒绝，完整原请求已保留，未自动重试：'}${errorText(e)}`); } finally { flight.current = false; setSaving(false); }
  }
  return <div className="parallel-scenes-workspace">
    <p className="fine">授权、目标和场景附加正文仅供作者。表单与未确认请求保存在当前浏览器。</p>
    {missing && <p className="notice">此故事未安装平行场景控制服务，不会自动安装。</p>}{error && <p className="error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {blocked && <div className="notice"><p>{blocked}</p><button type="button" disabled={!view || saving || loading} onClick={() => { if (window.confirm('请先核对当前档案。明确放弃损坏草稿及可能未确认的请求？')) { setBlocked(''); persist({ ...emptyParallelScenesDraft(), expectedRevision: view!.revision, selectedSceneIds: [...view!.selectedSceneIds] }); } }}>放弃无法读取的本地草稿</button></div>}
    {view && !synchronized && <p className="notice">故事、读取结果或草稿版本不同，提交已暂停；请明确重新读取并同步版本，表单保留。</p>}
    {view && view.revision > session.revision && <button type="button" onClick={() => void refresh().catch(e => setError(errorText(e)))}>刷新故事版本</button>}
    {busy && <p className="notice">故事正在处理回合，提交已暂停。</p>}
    <button type="button" disabled={saving || loading} onClick={() => void load(true)}>{loading ? '读取中…' : '重新读取并同步版本（保留表单）'}</button>
    {draft.pending && <div className="notice"><p>未确认请求 {draft.pending.requestId} · 原版本 {draft.pending.expectedRevision}。表单锁定；重试保持原 ID、理由、CAS 与完整内容。</p><button type="button" disabled={saving || loading || busy || missing || !!blocked} onClick={() => void submit()}>重试原请求</button><button type="button" disabled={saving || loading || loadedAt !== session.revision} onClick={() => { if (window.confirm('核对新读取档案：原请求可能已经提交。确认放弃原请求身份并保留表单？')) { persist({ ...draft, pending: undefined, expectedRevision: view!.revision, applied: false }); setNotice('已明确放弃原请求身份，请核对表单后提交。'); } }}>核对后放弃原请求</button></div>}
    {view && <ParallelScenesForm view={view} draft={draft} disabled={disabled} change={persist} submit={operation => void submit(operation)}/>}
  </div>;
}
