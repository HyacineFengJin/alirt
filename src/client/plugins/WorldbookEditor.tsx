import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { WORLDBOOK_PURPOSES } from '../../shared/worldbook';
import { api, ApiError, errorText, type RuntimeConfiguration, type WorldbookEditCommand } from '../api';
import { turnBusy } from '../Reader';
import { WorldbookPreview } from './WorldbookPreview';
import type { PanelContext } from './registry';
import { createWorldbookDraft, worldbookDraftCommand, worldbookEntries, type WorldbookDraft, type WorldbookEntry, type WorldbookSource } from './worldbook-editor';

const sourceLabels = { card: '角色卡', preset: '预设' };
const purposeLabels = { reference: '背景参考', 'entity-profile': '实体档案', 'scenario-plan': '章节规划', 'state-rule': '状态规则', initialization: '故事初始化', 'output-contract': '输出约定', 'ui-data': '界面数据' };
const targetLabels = { world: '世界协调', prose: '正文成文', role: '角色决策' };
const phaseLabels = { coordinate: '协调', compose: '成文', decide: '决策' };

/** Author data is deliberately isolated from role perspectives. */
export function WorldbookEditor(context: PanelContext) {
  return context.session.perspective === 'author' ? <AuthorWorldbook key={context.session.id} {...context} /> : null;
}
function EditorDialog({ children, close }: { children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return createPortal(<dialog ref={ref} className="modal worldbook-dialog" aria-labelledby="worldbook-title" onCancel={event => { event.preventDefault(); close(); }}>
    <header className="modal-header"><div><p className="eyebrow">当前故事 · 作者工具</p><h2 id="worldbook-title">管理世界资料</h2></div><button type="button" onClick={close} aria-label="关闭世界资料管理">关闭</button></header>
    {children}
  </dialog>, document.body);
}
function AuthorWorldbook({ session, refresh, readOnly }: PanelContext) {
  const [open, setOpen] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeConfiguration>();
  const [draft, setDraft] = useState<WorldbookDraft>();
  const [deleting, setDeleting] = useState<WorldbookEntry>();
  const [deleteReason, setDeleteReason] = useState('');
  const [deleteRevision, setDeleteRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<'all' | WorldbookSource>('all');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [readError, setReadError] = useState('');
  const [commandError, setCommandError] = useState('');
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [conflict, setConflict] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setReadError('');
    api.runtime(session.id, controller.signal).then(result => {
      if (!controller.signal.aborted) setRuntime(current => current && current.revision > result.revision ? current : result);
    }).catch(error => { if (!controller.signal.aborted) setReadError(errorText(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, session.id, session.revision, session.updatedAt, attempt]);
  const busy = readOnly || turnBusy(session);
  const revision = Math.max(session.revision, runtime?.revision ?? 0);
  const stale = !!draft && (draft.expectedRevision !== revision || conflict);
  const deleteStale = !!deleting && (deleteRevision !== revision || conflict);
  const entries = runtime ? worldbookEntries(runtime) : [];
  const visible = entries.filter(entry => (source === 'all' || source === entry.source) && `${entry.module.title}\n${entry.module.content}\n${entry.module.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const blocked = busy || submitting || loading || !!readError;
  function begin(entry?: WorldbookEntry) {
    if (!runtime || blocked) return;
    setDraft(createWorldbookDraft(runtime.revision, entry, source === 'preset' ? 'preset' : 'card'));
    setDeleting(undefined); setCommandError(''); setConflict(false); setNotice('');
  }
  async function submit(command: WorldbookEditCommand) {
    if (inFlight.current || blocked) return;
    inFlight.current = true; setSubmitting(true); setCommandError(''); setNotice('');
    let acknowledged = false;
    try {
      const result = await api.worldbookCommand(session.id, command);
      acknowledged = true;
      if (!mounted.current) return;
      setRuntime(result); setDraft(undefined); setDeleting(undefined); setDeleteReason(''); setConflict(false);
      setNotice(`世界资料已${command.operation === 'delete' ? '删除' : command.operation === 'set-enabled' ? command.enabled ? '开启' : '关闭' : '保存'} · 故事版本 ${result.revision}`);
      await refresh();
    } catch (error) {
      if (!mounted.current) return;
      const detail = error instanceof ApiError && error.issues.length ? `\n${error.issues.map(issue => `${issue.path}：${issue.message}`).join('\n')}` : '';
      setCommandError(acknowledged ? `资料已保存，故事状态同步失败，请重新读取：${errorText(error)}` : `${errorText(error)}${detail}`);
      if (!acknowledged && error instanceof ApiError && error.status === 409) setConflict(true);
    } finally {
      inFlight.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }
  function save() {
    if (!draft || stale) return;
    try { void submit(worldbookDraftCommand(draft)); } catch (error) { setCommandError(errorText(error)); }
  }
  function toggle(entry: WorldbookEntry) {
    if (!runtime) return;
    void submit({ operation: 'set-enabled', source: entry.source, moduleId: entry.module.id, ...(entry.binding ? { bindingId: entry.binding.id } : {}), expectedRevision: runtime.revision, enabled: !entry.module.enabled, reason: `作者手动${entry.module.enabled ? '关闭' : '开启'}世界资料「${entry.module.title}」` });
  }
  function close() { if (!inFlight.current) setOpen(false); }
  function reload() { setAttempt(value => value + 1); }
  return <section className="worldbook-launcher" aria-label="作者世界资料">
    <button onClick={() => setOpen(true)}>管理世界资料</button>
    <p className="fine">手动增删、编辑与启停当前故事的资料。{draft ? '未提交草稿已保留。' : '导入原件保持不变。'}</p>
    {open && <EditorDialog close={close}>
      <div className="worldbook-toolbar"><p className="fine">角色卡与预设均为此故事绑定的副本。{runtime ? ` 故事版本 ${runtime.revision}` : ''}</p><button disabled={loading || submitting} onClick={reload}>{loading ? '读取中…' : '重新读取资料'}</button></div>
      <div className="worldbook-messages" aria-live="polite">
        {busy && <p className="notice">当前故事正在处理回合或处于只读状态，请稍后保存。</p>}
        {readError && <p className="error" role="alert">读取失败：{readError}。当前草稿已保留，可重新读取。</p>}
        {commandError && <p className="error worldbook-error" role="alert">{commandError}。{!notice && '未确认提交的草稿会保留；请先重新读取资料核对结果。'}</p>}
        {notice && <p className="success" role="status">{notice}</p>}
        {stale && <p className="notice" role="alert">故事已有更新，当前草稿仍基于版本 {draft?.expectedRevision}。请重新读取并核对；保存已暂停，草稿不会覆盖新版本。</p>}
      </div>
      <div className="worldbook-layout">
        <aside className="worldbook-sidebar" aria-label="世界资料列表">
          <div className="worldbook-list-tools"><label>搜索资料<input value={query} onChange={event => setQuery(event.target.value)} placeholder="标题、正文或模块 ID" /></label><label>资料来源<select value={source} onChange={event => setSource(event.target.value as typeof source)}><option value="all">全部来源</option><option value="card">角色卡</option><option value="preset">预设</option></select></label><button disabled={blocked || !runtime || !!draft || !!deleting} onClick={() => begin()}>手动新增资料</button></div>
          <p className="fine worldbook-count">{visible.length} 项{loading ? ' · 正在读取最新资料…' : ''}</p>
          <ul className="worldbook-entry-list">{visible.map(entry => <li key={entry.key} className={draft?.entry?.key === entry.key || deleting?.key === entry.key ? 'selected' : ''}>
            <button className="worldbook-entry-button" disabled={blocked || !!draft || !!deleting} onClick={() => begin(entry)}><strong>{entry.module.title}</strong><span>{sourceLabels[entry.source]} · {entry.binding ? purposeLabels[entry.binding.purpose] : '未绑定 world 模块'}</span><span>{entry.module.enabled ? '已开启' : '已关闭'} · {entry.module.targets.join(' / ')} · {entry.module.phase}</span><span className="worldbook-excerpt">{entry.module.content.slice(0, 100) || '（空正文）'}</span></button>
            <div className="worldbook-entry-actions"><button disabled={blocked || !!draft || !!deleting} onClick={() => toggle(entry)}>{entry.module.enabled ? '关闭' : '开启'}</button><button disabled={blocked || !!draft || !!deleting} onClick={() => { setDeleting(entry); setDeleteRevision(runtime!.revision); setDeleteReason(''); setCommandError(''); setConflict(false); }}>删除…</button></div>
          </li>)}</ul>
          {!visible.length && runtime && <p className="muted">{query ? '没有匹配的资料。' : '此来源尚无世界资料，可手动新增。'}</p>}
        </aside>
        <main className="worldbook-detail">
          {draft ? <WorldbookForm draft={draft} change={setDraft} disabled={submitting} writeDisabled={blocked || stale} save={save} cancel={() => { setDraft(undefined); setCommandError(''); setConflict(false); }} /> : deleting ? <section className="worldbook-delete" aria-label="确认删除世界资料">
            <p className="eyebrow">删除前核对</p><h3>{deleting.module.title}</h3><p>{sourceLabels[deleting.source]} · {deleting.binding ? purposeLabels[deleting.binding.purpose] : '未绑定 world 模块'} · {deleting.module.enabled ? '已开启' : '已关闭'}</p><pre className="source-text">{deleting.module.content}</pre>
            <p className="notice">将从当前故事删除此模块及其世界资料绑定。关联章节、模块或输出仍在引用时，服务器会拒绝删除。</p>
            {deleteStale && <p className="error">故事已有更新，请重新读取后取消并重新选择删除项。</p>}
            <label>删除原因（必填）<textarea rows={3} value={deleteReason} disabled={submitting} onChange={event => setDeleteReason(event.target.value)} /></label>
            <div className="actions"><button className="danger" disabled={blocked || deleteStale || !deleteReason.trim()} onClick={() => void submit({ operation: 'delete', source: deleting.source, expectedRevision: deleteRevision, moduleId: deleting.module.id, ...(deleting.binding ? { bindingId: deleting.binding.id } : {}), reason: deleteReason.trim() })}>{submitting ? '删除中…' : '确认删除此资料'}</button><button disabled={submitting} onClick={() => { setDeleting(undefined); setCommandError(''); setConflict(false); }}>取消删除</button></div>
          </section> : <div className="worldbook-empty"><h3>世界资料工作区</h3><p>选择一项资料开始编辑，或手动新增。关闭窗口会保留未提交的编辑草稿。</p><p className="fine">列表包含世界资料绑定项，以及尚未绑定的 world 投递模块。开启只代表允许参与，实际投递仍取决于目标、阶段、条件与关键词。</p></div>}
          {draft && stale && !loading && runtime && <button className="worldbook-reset" disabled={submitting || !!readError} onClick={() => {
            const latest = draft.entry ? entries.find(entry => entry.key === draft.entry!.key) : undefined;
            if (draft.entry && !latest) { setCommandError('此项已被删除。当前草稿保留，可取消后新增资料。'); return; }
            begin(latest);
          }}>丢弃当前草稿，按最新资料重新编辑</button>}
          {runtime && <WorldbookPreview sessionId={session.id} runtime={runtime} roles={session.roles} disabled={blocked} />}
        </main>
      </div>
    </EditorDialog>}
  </section>;
}
function WorldbookForm({ draft, change, disabled, writeDisabled, save, cancel }: { draft: WorldbookDraft; change: (draft: WorldbookDraft) => void; disabled: boolean; writeDisabled: boolean; save: () => void; cancel: () => void }) {
  function field<K extends keyof WorldbookDraft>(key: K, value: WorldbookDraft[K]) { change({ ...draft, [key]: value, ...(['content', 'roleStage'].includes(key) ? { stageReviewed: false } : {}) }); }
  const roleStageChanged = !!draft.entry?.binding?.roleStage && draft.content !== draft.entry.module.content;
  return <form className="worldbook-form" onSubmit={event => { event.preventDefault(); save(); }}>
    <div className="row"><h3>{draft.entry ? '编辑资料' : '手动新增资料'}</h3><span className="fine">基于故事版本 {draft.expectedRevision}</span></div>
    <fieldset disabled={disabled}>
      {draft.entry ? <p className="fine">{sourceLabels[draft.source]} · {draft.entry.module.id}{draft.entry.binding ? ` · 绑定 ${draft.entry.binding.id}` : ' · 未绑定 world 模块'}</p> : <label>添加到<select value={draft.source} onChange={event => field('source', event.target.value as WorldbookSource)}><option value="card">当前故事的角色卡</option><option value="preset">当前故事的预设</option></select></label>}
      <label>标题<input required value={draft.title} onChange={event => field('title', event.target.value)} /></label>
      <label>正文<textarea className="worldbook-body" rows={10} value={draft.content} onChange={event => field('content', event.target.value)} /></label>
      <label className="worldbook-check"><input type="checkbox" checked={draft.enabled} onChange={event => field('enabled', event.target.checked)} />开启此资料</label>
      <div className="worldbook-fields"><label>资料用途<select value={draft.purpose} onChange={event => field('purpose', event.target.value as WorldbookDraft['purpose'])}>{WORLDBOOK_PURPOSES.map(purpose => <option key={purpose} value={purpose}>{purposeLabels[purpose]}</option>)}</select></label><label>投递阶段<select value={draft.phase} onChange={event => field('phase', event.target.value as WorldbookDraft['phase'])}>{Object.entries(phaseLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>优先级<input type="number" step="any" required value={draft.priority} onChange={event => field('priority', event.target.value)} /></label></div>
      <fieldset className="worldbook-targets"><legend>投递目标（至少一项）</legend>{(['world', 'prose', 'role'] as const).map(target => <label className="worldbook-check" key={target}><input type="checkbox" checked={draft.targets.includes(target)} onChange={event => field('targets', event.target.checked ? [...draft.targets, target] : draft.targets.filter(value => value !== target))} />{targetLabels[target]}</label>)}</fieldset>
      <details className="worldbook-section"><summary>关键词触发</summary><p className="fine">每行一个关键词；主关键词留空表示不使用关键词触发。关键词选项保留既有扩展数据。</p><div className="worldbook-fields"><label>主关键词<textarea rows={3} value={draft.keywords} onChange={event => field('keywords', event.target.value)} /></label><label>辅助关键词<textarea rows={3} value={draft.secondaryKeywords} onChange={event => field('secondaryKeywords', event.target.value)} /></label></div><label className="worldbook-check"><input type="checkbox" checked={draft.selective} onChange={event => field('selective', event.target.checked)} />同时要求辅助关键词</label><label className="worldbook-check"><input type="checkbox" checked={draft.caseSensitive} onChange={event => field('caseSensitive', event.target.checked)} />区分大小写</label><label>匹配方式<select value={draft.match} onChange={event => field('match', event.target.value as WorldbookDraft['match'])}><option value="substring">子串匹配</option><option value="word">完整词匹配</option></select></label></details>
      <details className="worldbook-section" open={!!draft.when}><summary>绑定触发条件 · binding.when</summary><p className="fine">留空移除绑定条件。支持 path / equals、all、any、not 等条件；模块自己的 condition 在高级元数据中编辑。</p><label>条件 JSON<textarea className="worldbook-json" rows={5} value={draft.when} placeholder={'{ "path": "world.variables.ready", "equals": true }'} onChange={event => field('when', event.target.value)} spellCheck={false} /></label></details>
      <details className="worldbook-section" open={roleStageChanged}><summary>角色阶段模板 · roleStage</summary><p className="fine">角色阶段模板的 spans 必须对应当前正文。修改阶段正文后，需要重新核对完整模板；未同步的模板会被拒绝。</p><label>完整 roleStage JSON<textarea className="worldbook-json" rows={7} value={draft.roleStage} onChange={event => field('roleStage', event.target.value)} spellCheck={false} /></label>{roleStageChanged && <label className="worldbook-check"><input type="checkbox" checked={draft.stageReviewed} onChange={event => field('stageReviewed', event.target.checked)} />已同步并审阅新正文对应的完整 roleStage 模板</label>}</details>
      <details className="worldbook-section"><summary>高级模块与绑定元数据</summary><p className="fine">只编辑下列元数据。标题、正文、启用状态、投递、优先级、关键词和条件各有独立表单；未改动字段和源扩展数据会保留。删除可选键可移除该项。</p><label>模块元数据 JSON<textarea className="worldbook-json" rows={8} value={draft.moduleMetadata} onChange={event => field('moduleMetadata', event.target.value)} spellCheck={false} /></label><p className="fine">category、condition、sourcePointer、lifetime、audience、inject、dependsOn、exclusiveGroup、required</p><label>绑定元数据 JSON<textarea className="worldbook-json" rows={5} value={draft.bindingMetadata} onChange={event => field('bindingMetadata', event.target.value)} spellCheck={false} /></label><p className="fine">audience、source；模块与绑定的 ID、正文哈希由系统维护。</p></details>
      <label>编辑原因（必填）<textarea required rows={2} value={draft.reason} onChange={event => field('reason', event.target.value)} placeholder="说明此次新增或修订的原因" /></label>
    </fieldset>
    <div className="actions worldbook-form-actions"><button type="submit" className="primary" disabled={writeDisabled || !draft.reason.trim() || !draft.title.trim()}>{disabled ? '保存中…' : draft.entry ? '保存资料修改' : '添加资料'}</button><button type="button" disabled={disabled} onClick={cancel}>取消并丢弃草稿</button></div>
  </form>;
}
