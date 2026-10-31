import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_VISUAL_CROP, ROLE_VISUAL_SERVICE_ID, validVisualCrop, validVisualImageRef, visualCropStyle, visualImageUrl, type RoleVisualsView, type VisualCommand, type VisualCommandResult, type VisualCrop, type VisualImageAsset, type VisualImageRef } from '../shared/visual-assets';
import type { PanelContext } from './plugins/registry';
import { api, ApiError, errorText } from './api';
import './VisualAssets.css';

export const visualAssetRef = (asset: VisualImageAsset): VisualImageRef => ({ assetId: asset.assetId, sha256: asset.sha256, mimeType: asset.mimeType, width: asset.width, height: asset.height, bytes: asset.bytes });
/** Dragging moves the covered image, with focus measured over its overflow. */
export function dragVisualCrop(image: Pick<VisualImageRef, 'width' | 'height'>, crop: VisualCrop, dx: number, dy: number, size: number): VisualCrop {
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(dx) || !Number.isFinite(dy) || !validVisualCrop(crop) || image.width <= 0 || image.height <= 0) return crop;
  const ratio = image.width / image.height, overflowX = Math.max(1, ratio) * crop.zoom - 1, overflowY = Math.max(1, 1 / ratio) * crop.zoom - 1;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return { ...crop, x: overflowX > 0 ? clamp(crop.x - dx / size / overflowX) : crop.x, y: overflowY > 0 ? clamp(crop.y - dy / size / overflowY) : crop.y };
}
export function ViewImage({ image, crop = DEFAULT_VISUAL_CROP, name, diagnostic = false }: { image?: VisualImageRef; crop?: VisualCrop; name: string; diagnostic?: boolean }) {
  const [failed, setFailed] = useState<string>();
  const valid = !!image && validVisualImageRef(image) && validVisualCrop(crop), unavailable = !!image && (!valid || failed === image.assetId);
  return <span className="visual-image-frame">
    {valid && !unavailable ? <img src={visualImageUrl(image)} style={visualCropStyle(image, crop)} alt={`${name}对白头像`} draggable={false} onError={() => setFailed(image.assetId)}/> : <span className="visual-image-initial" aria-label={`${name}姓名占位`}>{Array.from(name.trim())[0] || '·'}</span>}
    {diagnostic && unavailable && <span className="visual-image-error">图片不可用</span>}
  </span>;
}
interface UploadTicket { requestId: string; title: string; fileName: string; mimeType: string; size: number; sha256: string }
export interface VisualDraft {
  roleId: string; assetId: string; crop: VisualCrop; reason: string; uploadTitle: string; expectedRevision?: number; expectedVersion?: number;
  pending?: VisualCommand; pendingUpload?: UploadTicket; applied?: boolean;
}
const fresh = (): VisualDraft => ({ roleId: '', assetId: '', crop: { ...DEFAULT_VISUAL_CROP }, reason: '', uploadTitle: '' });
const DRAFT_EVENT = 'rp:dialogue-visual-draft';
const DRAFT_CONFLICT = '另一处头像编辑器已保存草稿。当前编辑已暂停；请明确载入另一处草稿，未覆盖或重发请求。';
export function writeVisualDraft(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string, expected: string | null, next: VisualDraft): string {
  if (storage.getItem(key) !== expected) throw new Error(DRAFT_CONFLICT);
  const raw = JSON.stringify(next); storage.setItem(key, raw); return raw;
}
export function editVisualDraft(draft: VisualDraft, patch: Partial<Pick<VisualDraft, 'assetId' | 'crop' | 'reason'>>): VisualDraft {
  if (draft.pending || draft.pendingUpload) throw new Error('请先核对未确认请求；不能改写原目标或裁剪。');
  return { ...draft, ...patch, applied: false };
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const identity = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v === v.trim() && !['__proto__', 'prototype', 'constructor'].includes(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function validCommand(c: unknown): c is VisualCommand {
  if (!object(c) || !identity(c.requestId) || !integer(c.expectedRevision) || !integer(c.expectedVersion) || !identity(c.roleId) || c.slot !== 'dialogue-avatar' || typeof c.reason !== 'string' || !c.reason.trim()) return false;
  const fields = ['requestId', 'expectedRevision', 'expectedVersion', 'roleId', 'slot', 'reason', 'operation'];
  return c.operation === 'bind' ? Object.keys(c).sort().join() === [...fields, 'assetId', 'crop'].sort().join() && hash(c.assetId) && validVisualCrop(c.crop)
    : ['hide', 'reset'].includes(String(c.operation)) && Object.keys(c).sort().join() === fields.sort().join();
}
function validTicket(v: unknown): v is UploadTicket {
  return object(v) && Object.keys(v).sort().join() === ['requestId', 'title', 'fileName', 'mimeType', 'size', 'sha256'].sort().join()
    && identity(v.requestId) && typeof v.title === 'string' && !!v.title.trim() && typeof v.fileName === 'string' && ['image/png', 'image/jpeg', 'image/webp'].includes(String(v.mimeType)) && integer(v.size) && v.size > 0 && hash(v.sha256);
}
export function recoverVisualDraft(raw: string): VisualDraft {
  const d: unknown = JSON.parse(raw);
  if (!object(d) || Object.keys(d).some(k => !['roleId', 'assetId', 'crop', 'reason', 'uploadTitle', 'expectedRevision', 'expectedVersion', 'pending', 'pendingUpload', 'applied'].includes(k))
    || !['roleId', 'assetId', 'reason', 'uploadTitle'].every(k => typeof d[k] === 'string') || !validVisualCrop(d.crop)
    || d.expectedRevision !== undefined && !integer(d.expectedRevision) || d.expectedVersion !== undefined && !integer(d.expectedVersion)
    || d.applied !== undefined && typeof d.applied !== 'boolean' || d.pending !== undefined && !validCommand(d.pending) || d.pendingUpload !== undefined && !validTicket(d.pendingUpload)) throw new Error('本地头像草稿或未确认请求无效，未自动修复或覆盖。');
  if (d.pending && (d.pendingUpload || d.applied || d.pending.roleId !== d.roleId || d.pending.expectedRevision !== d.expectedRevision || d.pending.expectedVersion !== d.expectedVersion || d.pending.reason !== d.reason
    || d.pending.operation === 'bind' && (d.pending.assetId !== d.assetId || d.pending.crop.x !== d.crop.x || d.pending.crop.y !== d.crop.y || d.pending.crop.zoom !== d.crop.zoom))
    || d.pendingUpload && d.pendingUpload.title !== d.uploadTitle) throw new Error('本地未确认请求与草稿不一致，未自动修复或重发。');
  return d as unknown as VisualDraft;
}
export function visualCommand(view: RoleVisualsView, draft: VisualDraft, operation: VisualCommand['operation'], requestId: string): VisualCommand {
  if (draft.pending || draft.pendingUpload || draft.applied || draft.expectedRevision !== view.revision || !view.roles.some(role => role.id === draft.roleId)) throw new Error('请核对精确角色、版本及未确认请求。');
  const version = view.bindings.find(b => b.roleId === draft.roleId && b.slot === 'dialogue-avatar')?.versions.at(-1)?.version ?? 0;
  if (draft.expectedVersion !== version) throw new Error('头像绑定版本已改变，请载入当前角色设置。');
  const base = { requestId, expectedRevision: view.revision, reason: draft.reason, roleId: draft.roleId, slot: 'dialogue-avatar' as const, expectedVersion: version };
  const command: VisualCommand = operation === 'bind' ? { ...base, operation, assetId: draft.assetId, crop: { ...draft.crop } } : { ...base, operation };
  if (!validCommand(command) || operation === 'bind' && !view.assets.some(asset => asset.assetId === draft.assetId)) throw new Error('请选择本地图片、有效裁剪并填写理由。');
  return command;
}
export const saveVisualCommand = (sessionId: string, command: VisualCommand) => api.sessionServiceCommand<VisualCommandResult>(sessionId, ROLE_VISUAL_SERVICE_ID, command);
export async function visualFileFingerprint(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size) throw new Error('请选择非空 PNG、JPEG 或 WebP 本地图片。');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('');
}
export function uploadTicketMatches(ticket: UploadTicket, file: Pick<File, 'size' | 'type'>, sha256: string) { return ticket.size === file.size && ticket.mimeType === file.type && ticket.sha256 === sha256; }
export function roleDraft(view: RoleVisualsView, current: VisualDraft, roleId: string): VisualDraft {
  if (current.pending || current.pendingUpload) throw new Error('请先核对未确认请求；不能切换角色或取消其原草稿。');
  const visual = view.current.visuals.find(v => v.roleId === roleId && v.slot === 'dialogue-avatar');
  return { ...current, roleId, assetId: visual?.image.assetId ?? '', crop: { ...(visual?.crop ?? DEFAULT_VISUAL_CROP) }, expectedRevision: view.revision,
    expectedVersion: view.bindings.find(b => b.roleId === roleId && b.slot === 'dialogue-avatar')?.versions.at(-1)?.version ?? 0, reason: '', applied: false };
}

export function VisualAssetForm({ view, draft, disabled, change, submit }: { view: RoleVisualsView; draft: VisualDraft; disabled: boolean; change: (d: VisualDraft) => void; submit: (operation: VisualCommand['operation']) => void }) {
  const role = view.roles.find(role => role.id === draft.roleId), selected = view.assets.find(asset => asset.assetId === draft.assetId);
  const drag = useRef<{ pointerId: number; x: number; y: number; size: number; crop: VisualCrop } | undefined>(undefined);
  const update = (patch: Partial<Pick<VisualDraft, 'assetId' | 'crop' | 'reason'>>) => { if (!disabled && !draft.pending && !draft.pendingUpload) change(editVisualDraft(draft, patch)); };
  const valid = (op: VisualCommand['operation']) => { try { visualCommand(view, draft, op, 'form-validation'); return true; } catch { return false; } };
  return <fieldset disabled={disabled} className="visual-editor-form"><legend>对白头像 · 当前故事与角色 ID</legend>
    <p className="fine">按当前故事与精确角色 ID 保存对白头像。后续新正文保存头像快照；编辑不会回写旧对白。</p>
    <label>角色<select value={draft.roleId} onChange={e => { if ((draft.reason || draft.assetId) && !window.confirm('切换会载入所选角色当前设置，替换未保存的裁剪草稿。继续？')) return; change(roleDraft(view, draft, e.target.value)); }}><option value="">明确选择角色</option>{view.roles.map(role => <option key={role.id} value={role.id}>{role.name} · {role.id}</option>)}</select></label>
    {draft.roleId && !role && <p className="notice">此角色 ID 已不在当前故事，不能绑定其他同名角色。</p>}
    <div className="visual-editor-layout"><div className={`visual-preview${selected && !disabled ? ' visual-preview-draggable' : ''}`} aria-label="256方头像裁剪预览" aria-disabled={disabled || !selected}
      onPointerDown={e => { if (disabled || !selected || e.button !== 0 || draft.pending || draft.pendingUpload) return; e.preventDefault(); drag.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, size: e.currentTarget.getBoundingClientRect().width, crop: { ...draft.crop } }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={e => { const start = drag.current; if (!start || start.pointerId !== e.pointerId || disabled || !selected) return; update({ crop: dragVisualCrop(selected, start.crop, e.clientX - start.x, e.clientY - start.y, start.size) }); }}
      onPointerUp={e => { if (drag.current?.pointerId === e.pointerId) { drag.current = undefined; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); } }}
      onPointerCancel={() => { drag.current = undefined; }} onLostPointerCapture={() => { drag.current = undefined; }}><ViewImage image={selected ? visualAssetRef(selected) : undefined} crop={draft.crop} name={role?.name ?? '未选角色'} diagnostic/></div>
      <div><label>本地图片库<select value={draft.assetId} onChange={e => update({ assetId: e.target.value, crop: { ...DEFAULT_VISUAL_CROP } })}><option value="">选择已保存图片</option>{view.assets.map(asset => <option key={asset.assetId} value={asset.assetId}>{asset.title} · {asset.origin.kind === 'builtin' ? '来源默认' : '本地上传'} · {asset.assetId.slice(0, 8)}</option>)}</select></label>
        <label>缩放 {draft.crop.zoom.toFixed(2)}×<input type="range" min="1" max="4" step="0.05" value={draft.crop.zoom} onChange={e => update({ crop: { ...draft.crop, zoom: Number(e.target.value) } })}/></label>
        <label>横向焦点 {Math.round(draft.crop.x * 100)}%<input type="range" min="0" max="1" step="0.01" value={draft.crop.x} onChange={e => update({ crop: { ...draft.crop, x: Number(e.target.value) } })}/></label>
        <label>纵向焦点 {Math.round(draft.crop.y * 100)}%<input type="range" min="0" max="1" step="0.01" value={draft.crop.y} onChange={e => update({ crop: { ...draft.crop, y: Number(e.target.value) } })}/></label>
        <p className="fine">拖动预览图片调整裁剪，或使用滑杆与键盘。焦点按 cover 裁剪溢出范围定位；图库图片由宿主规范为 WebP。拖动与滑杆仅修改草稿，需填写理由并保存。</p>
      </div></div>
    <label>修改理由<input value={draft.reason} onChange={e => update({ reason: e.target.value })}/></label>
    <div className="actions"><button type="button" disabled={!valid('bind')} onClick={() => submit('bind')}>保存对白头像</button><button type="button" disabled={!valid('hide')} onClick={() => submit('hide')}>隐藏头像</button><button type="button" disabled={!valid('reset')} onClick={() => submit('reset')}>恢复来源默认</button><button type="button" disabled={!role} onClick={() => change(roleDraft(view, draft, draft.roleId))}>取消本次编辑</button></div>
    <p className="fine">恢复默认仅使用该角色已声明且开启的来源默认；来源图片未缓存或没有对应图片时仍显示姓名占位。取消编辑不删除已上传的图库图片。</p>
  </fieldset>;
}

type Context = Pick<PanelContext, 'session' | 'readOnly' | 'refresh'>;
export function VisualAssetsInline(props: Context) {
  const [opened, setOpened] = useState(false);
  return props.session.perspective === 'author' && !props.readOnly ? <details className="visual-assets-inline" onToggle={e => { if (e.currentTarget.open) setOpened(true); }}><summary>对白头像 · 本地图片库</summary>{opened && <VisualWorkspace key={props.session.id} {...props}/>}</details> : null;
}
export function VisualAssetsDialog(props: Context & { roleId?: string; close: () => void }) { return props.session.perspective === 'author' && !props.readOnly ? <VisualDialog key={props.session.id} {...props}/> : null; }
function VisualDialog(props: Context & { roleId?: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return createPortal(<dialog ref={dialog} className="modal wide-modal visual-assets-dialog" onCancel={e => { e.preventDefault(); props.close(); }}><header className="modal-header"><h2>对白头像与本地图片库</h2><button type="button" onClick={props.close}>关闭（保留本地草稿）</button></header><div className="modal-body"><VisualWorkspace {...props} initialRoleId={props.roleId}/></div></dialog>, document.body);
}
function VisualWorkspace({ session, refresh, initialRoleId }: Context & { initialRoleId?: string }) {
  const key = `rp:dialogue-visuals:${session.id}`, initial = useRef<{ draft: VisualDraft; raw: string | null; error: string } | null>(null);
  if (!initial.current) { let raw: string | null = null; try { raw = localStorage.getItem(key); initial.current = { draft: raw ? recoverVisualDraft(raw) : { ...fresh(), roleId: initialRoleId ?? '' }, raw, error: '' }; } catch (e) { initial.current = { draft: fresh(), raw, error: errorText(e) }; } }
  const [draft, setDraft] = useState(initial.current.draft), [blocked, setBlocked] = useState(initial.current.error), [view, setView] = useState<RoleVisualsView>();
  const journal = useRef(initial.current.raw), draftRef = useRef(initial.current.draft), [draftConflict, setDraftConflict] = useState(false);
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [missing, setMissing] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [loadedAt, setLoadedAt] = useState<number>();
  const [file, setFile] = useState<File>(), [fileHash, setFileHash] = useState(''), [readingFile, setReadingFile] = useState(false), flight = useRef(false), fileSequence = useRef(0);
  function storeDraft(next: VisualDraft) {
    try { journal.current = writeVisualDraft(localStorage, key, journal.current, next); window.dispatchEvent(new CustomEvent(DRAFT_EVENT, { detail: key })); return true; }
    catch (e) { const conflict = e instanceof Error && e.message === DRAFT_CONFLICT; setDraftConflict(conflict); setBlocked(conflict ? DRAFT_CONFLICT : '本地草稿无法保存，为保留请求身份已暂停操作。'); return false; }
  }
  function persist(next: VisualDraft) { if (!storeDraft(next)) return false; draftRef.current = next; setDraft(next); return true; }
  useEffect(() => {
    const check = (event: Event) => {
      if (event instanceof StorageEvent ? event.storageArea !== localStorage || event.key !== key && event.key !== null : (event as CustomEvent).detail !== key) return;
      try { if (localStorage.getItem(key) !== journal.current) { setDraftConflict(true); setBlocked(DRAFT_CONFLICT); fileSequence.current++; setFile(undefined); setFileHash(''); setReadingFile(false); } }
      catch { setBlocked('本地草稿无法读取，操作已暂停。'); }
    };
    window.addEventListener(DRAFT_EVENT, check); window.addEventListener('storage', check);
    return () => { window.removeEventListener(DRAFT_EVENT, check); window.removeEventListener('storage', check); };
  }, [key]);
  function adoptDraft() {
    try { const raw = localStorage.getItem(key), recovered = raw ? recoverVisualDraft(raw) : fresh(); journal.current = raw; draftRef.current = recovered; setDraft(recovered); setDraftConflict(false); setBlocked(''); setNotice('已载入另一处保存的完整草稿；未确认请求仍需明确核对后手动重试。'); }
    catch (e) { setDraftConflict(false); setBlocked(errorText(e)); }
  }
  async function load(sync = false, signal?: AbortSignal) {
    setLoading(true); setError('');
    try { const result = await api.sessionService<RoleVisualsView>(session.id, ROLE_VISUAL_SERVICE_ID, signal); if (signal?.aborted) return; setView(result); setMissing(false); setLoadedAt(result.revision);
      if (!blocked) {
        const current = draftRef.current;
        const next = { ...current };
        if (!current.pending && (sync || current.expectedRevision === undefined)) next.expectedRevision = result.revision;
        if (!current.pending && !current.pendingUpload && current.expectedVersion === undefined && current.roleId) Object.assign(next, roleDraft(result, next, current.roleId));
        persist(next);
      }
    } catch (e) { if (!signal?.aborted) { setMissing(e instanceof ApiError && e.status === 404); setError(errorText(e)); } } finally { if (!signal?.aborted) setLoading(false); }
  }
  useEffect(() => { const controller = new AbortController(); void load(false, controller.signal); return () => { controller.abort(); fileSequence.current++; }; }, [session.id]);
  const busy = session.turns.some(turn => ['queued', 'running', 'committed'].includes(turn.status));
  const synchronized = !!view && view.revision === session.revision && draft.expectedRevision === view.revision;
  const disabled = saving || loading || readingFile || busy || missing || !!blocked || !!draft.pending || !!draft.pendingUpload || !synchronized;
  async function chooseFile(next?: File) {
    if (!next) return;
    const sequence = ++fileSequence.current; setReadingFile(true); setError('');
    try { const fingerprint = await visualFileFingerprint(next); if (sequence !== fileSequence.current) return;
      if (draft.pendingUpload && !uploadTicketMatches(draft.pendingUpload, next, fingerprint)) throw new Error('上传回执未确认，请重新选择同一字节内容和格式的原文件；未替换原请求。');
      setFile(next); setFileHash(fingerprint); if (!draft.pendingUpload && !draft.uploadTitle) persist({ ...draft, uploadTitle: next.name });
    } catch (e) { if (sequence === fileSequence.current) { setFile(undefined); setFileHash(''); setError(errorText(e)); } } finally { if (sequence === fileSequence.current) setReadingFile(false); }
  }
  async function upload() {
    if (flight.current || saving || busy || loading || blocked || draft.pending || !file || !fileHash || readingFile || !draft.uploadTitle.trim()) return;
    const ticket = draft.pendingUpload ?? { requestId: crypto.randomUUID(), title: draft.uploadTitle, fileName: file.name, mimeType: file.type, size: file.size, sha256: fileHash };
    if (!uploadTicketMatches(ticket, file, fileHash) || !persist({ ...draft, pendingUpload: ticket })) return;
    flight.current = true; setSaving(true); setLoadedAt(undefined); setError('');
    try { const result = await api.visualUpload(ticket.requestId, file, ticket.title);
      persist({ ...draft, pendingUpload: undefined, assetId: result.asset.assetId, crop: { ...DEFAULT_VISUAL_CROP }, applied: false }); setFile(undefined); setFileHash('');
      setNotice('图片已进入本地图库；尚未绑定角色，填写理由并保存头像后才生效。'); await load();
    } catch (e) { setError(`上传未确认或被拒绝；原 ID、标题与文件指纹已保留，未自动重试：${errorText(e)}`); } finally { flight.current = false; setSaving(false); }
  }
  async function submit(operation?: VisualCommand['operation']) {
    if (!view || flight.current || saving || busy || loading || blocked || missing || draft.pendingUpload || !draft.pending && (disabled || !operation)) return;
    let command: VisualCommand;
    try { command = draft.pending ?? visualCommand(view, draft, operation!, crypto.randomUUID()); } catch (e) { setError(errorText(e)); return; }
    if (!persist({ ...draft, pending: command })) return;
    flight.current = true; setSaving(true); setLoadedAt(undefined); setError(''); let acknowledged = false;
    try { const result = await saveVisualCommand(session.id, command); acknowledged = true;
      persist({ ...draft, expectedRevision: result.revision, expectedVersion: result.version, pending: undefined, applied: true });
      setNotice('对白头像设置已保存，仅影响后续新正文快照；旧正文保持原样。'); await load(); await refresh();
    } catch (e) { setError(`${acknowledged ? '设置已保存，尚未同步：' : '请求未确认或被拒绝，完整原请求保留且未自动重试：'}${errorText(e)}`); } finally { flight.current = false; setSaving(false); }
  }
  return <div className="visual-workspace">
    {missing && <p className="notice">此故事未安装对白头像服务，不会自动安装。</p>}{error && <p className="error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {blocked && <div className="notice"><p>{blocked}</p>{draftConflict ? <button disabled={saving || loading} onClick={adoptDraft}>载入另一处保存的草稿</button> : <button disabled={!view || saving || loading} onClick={() => { if (window.confirm('请先核对已保存设置。明确放弃无法读取的草稿及可能未确认请求？') && persist({ ...fresh(), expectedRevision: view!.revision })) setBlocked(''); }}>放弃无法读取的本地草稿</button>}</div>}
    {view && !synchronized && <p className="notice">故事、头像读取结果或草稿版本不同，保存已暂停；请明确重新读取并核对草稿。</p>}
    {view && view.revision > session.revision && <button onClick={() => void refresh().catch(e => setError(errorText(e)))}>同步故事版本</button>}
    <button disabled={saving || loading} onClick={() => void load(true)}>重新读取设置与图库（保留草稿）</button>
    {initialRoleId && draft.roleId !== initialRoleId && <p className="notice">点击的对白角色为 {initialRoleId}，本地仍保留另一角色草稿。<button disabled={disabled || !view?.roles.some(role => role.id === initialRoleId)} onClick={() => { if (view && window.confirm('明确载入所点击角色，替换当前未保存裁剪？')) persist(roleDraft(view, draft, initialRoleId)); }}>载入所点击角色</button></p>}
    <fieldset disabled={saving || loading || busy || !!blocked || !!draft.pending || readingFile || missing}><legend>上传本地 PNG / JPEG / WebP</legend>
      <label>图片标题<input value={draft.uploadTitle} disabled={!!draft.pendingUpload} onChange={e => persist({ ...draft, uploadTitle: e.target.value })}/></label>
      <input type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" onChange={e => void chooseFile(e.target.files?.[0])}/>
      {draft.pendingUpload && <p className="notice">上次上传回执未确认。重开后请重新选择同一原文件，校验指纹后使用原 ID 重试；不能换文件继续此请求。</p>}
      <button type="button" disabled={!file || !fileHash || !draft.uploadTitle.trim()} onClick={() => void upload()}>{draft.pendingUpload ? '重试原上传请求' : '上传到本地图库'}</button>
    </fieldset>
    {(draft.pending || draft.pendingUpload) && <div className="notice"><p>未确认请求已保留，头像表单锁定，未自动重试。</p>{draft.pending && <button disabled={saving || loading || busy || !!blocked || missing} onClick={() => void submit()}>重试原头像请求</button>}<button disabled={saving || loading || loadedAt !== session.revision} onClick={() => { if (window.confirm('原请求可能已经提交。核对刚读取的设置/图库后，明确放弃原请求身份？')) persist({ ...draft, pending: undefined, pendingUpload: undefined, expectedRevision: view!.revision, applied: false }); }}>核对后放弃原请求</button></div>}
    {view && <VisualAssetForm view={view} draft={draft} disabled={disabled} change={persist} submit={operation => void submit(operation)}/>}
  </div>;
}
