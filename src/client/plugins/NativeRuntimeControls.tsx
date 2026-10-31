import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OutputContract } from '../../shared/types';
import { api, errorText, type RuntimeConfiguration, type RuntimeConfigurationUpdate } from '../api';
import type { PanelContext } from './registry';
import { RuntimeFieldPolicies, changedFieldPolicies } from './RuntimeFieldPolicies';
import './RuntimeFieldPolicies.css';
import { StoryProgressEditor } from './StoryProgressEditor';
import { ParallelScenesEditor } from './ParallelScenesEditor';
import { AgentCapabilities } from './AgentCapabilities';
import { TextCarrierEditor } from '../TextCarriers';
import { VisualAssetsInline } from '../VisualAssets';
const placementLabels = { 'before-prose': '正文前', 'after-prose': '正文后', 'side-panel': '侧栏', hidden: '隐藏' };

export function runtimeConfigurationDirty(base: RuntimeConfiguration, draft: RuntimeConfiguration) {
  return JSON.stringify([draft.card.modules, draft.card.outputs, draft.card.fields, draft.card.visuals, draft.preset, draft.agentRuntime]) !== JSON.stringify([base.card.modules, base.card.outputs, base.card.fields, base.card.visuals, base.preset, base.agentRuntime]);
}
export function runtimeConfigurationUpdate(base: RuntimeConfiguration, draft: RuntimeConfiguration, reason: string): RuntimeConfigurationUpdate {
  return { expectedRevision: base.revision, reason: reason.trim(), cardModules: draft.card.modules,
    ...(draft.card.outputs ? { cardOutputs: draft.card.outputs } : {}), ...(draft.card.visuals ? { cardVisuals: draft.card.visuals } : {}), preset: draft.preset, agentRuntime: draft.agentRuntime,
    ...(changedFieldPolicies(base.card.fields, draft.card.fields).length ? { fieldPolicies: changedFieldPolicies(base.card.fields, draft.card.fields) } : {}) };
}
export function runtimeConfigurationCanSave({ base, draft, revision, loading, busy, readOnly, invalid, reason }: {
  base?: RuntimeConfiguration; draft?: RuntimeConfiguration; revision: number; loading: boolean; busy: boolean; readOnly: boolean; invalid: boolean; reason: string;
}) {
  return !!base && !!draft && !loading && !busy && !readOnly && !invalid && !!reason.trim()
    && base.revision === revision && runtimeConfigurationDirty(base, draft);
}

/** Toggle an output and its same-document protocol together. Disabling an output
 * leaves its module alone; it may serve another output or authored constraint. */
export function toggleRuntimeOutput(runtime: RuntimeConfiguration, source: 'card' | 'preset', id: string, enabled: boolean): RuntimeConfiguration {
  const next = structuredClone(runtime), document = next[source];
  const output = document.outputs?.find(item => item.id === id); if (!output) return next;
  output.enabled = enabled;
  if (enabled && output.module) {
    const [scope, moduleId] = /^(card|preset):/.test(output.module) ? output.module.split(/:(.*)/s) : [source, output.module];
    if (scope === source) {
      const module = document.modules.find(item => item.id === moduleId);
      if (module) module.enabled = true;
    }
  }
  return next;
}

export function NativeRuntimeControls({ launch, hideLauncher = false, ...context }: PanelContext & { launch?: { id: string }; hideLauncher?: boolean }) {
  const [open, setOpen] = useState(false);
  const lastLaunch = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (context.session.perspective !== 'author') { setOpen(false); return; }
    if (launch?.id && launch.id !== lastLaunch.current) { lastLaunch.current = launch.id; setOpen(true); }
  }, [launch?.id, context.session.perspective]);
  return context.session.perspective === 'author' ? <>
    {!hideLauncher && <button onClick={() => setOpen(true)}>运行设置 · 提示与附加输出</button>}
    {open && createPortal(<RuntimeDialog key={context.session.id} {...context} close={() => setOpen(false)} />, document.body)}
  </> : null;
}

function RuntimeDialog({ session, readOnly, refresh, close }: PanelContext & { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), saving = useRef(false);
  const [base, setBase] = useState<RuntimeConfiguration>();
  const [draft, setDraft] = useState<RuntimeConfiguration>();
  const [source, setSource] = useState<'card' | 'preset'>('preset');
  const [search, setSearch] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [agentError, setAgentError] = useState('代理模块目录尚未核验。');
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setRuntimeLoading(true);
    api.runtime(session.id, controller.signal).then(value => { if (!controller.signal.aborted) { setBase(value); setDraft(structuredClone(value)); setError(''); setFieldErrors({}); } })
      .catch(e => { if (!controller.signal.aborted) setError(errorText(e)); })
      .finally(() => { if (!controller.signal.aborted) setRuntimeLoading(false); });
    return () => controller.abort();
  }, [session.id, attempt]);
  const stale = !!base && base.revision !== session.revision;
  const dirty = !!draft && !!base && runtimeConfigurationDirty(base, draft);
  const invalidFields = Object.values(fieldErrors).some(Boolean);
  const invalidInputs = invalidFields || !!agentError;
  const canSave = runtimeConfigurationCanSave({ base, draft, revision: session.revision, loading: runtimeLoading, busy, readOnly, invalid: invalidInputs, reason });
  const document = draft?.[source];
  function toggleModule(id: string, enabled: boolean) {
    if (!draft) return;
    const next = structuredClone(draft), module = next[source].modules.find(item => item.id === id);
    if (module) module.enabled = enabled;
    setDraft(next);
  }
  function toggleOutput(output: OutputContract, enabled: boolean) {
    if (draft) setDraft(toggleRuntimeOutput(draft, source, output.id, enabled));
  }
  async function save() {
    if (!base || !draft || saving.current || !canSave) return;
    saving.current = true; setBusy(true); setError(''); setNotice('');
    let acknowledged = false;
    try {
      const result = await api.configureRuntime(session.id, runtimeConfigurationUpdate(base, draft, reason));
      acknowledged = true; setBase(result); setDraft(structuredClone(result)); setFieldErrors({}); setReason(''); setNotice('运行设置已保存，后续模型请求使用新配置。');
      await refresh();
    } catch (e) { setError(`${acknowledged ? '设置已保存，故事状态尚未同步：' : ''}${errorText(e)}`); }
    finally { saving.current = false; setBusy(false); }
  }
  function reload() {
    if (busy || runtimeLoading || ((dirty || invalidFields) && !window.confirm('放弃草稿并重新读取当前故事设置？'))) return;
    // Confirmation takes effect immediately, before either asynchronous GET can
    // finish. A fast catalog response cannot revive the discarded draft.
    setBase(undefined); setDraft(undefined); setFieldErrors({}); setError(''); setNotice(''); setReason('');
    setAgentError('代理模块目录尚未核验。'); setRuntimeLoading(true); setAttempt(value => value + 1);
  }
  const disabled = busy || runtimeLoading || readOnly || stale;
  return <dialog ref={dialog} className="modal wide-modal runtime-controls" onCancel={event => { event.preventDefault(); if (!busy && (!(dirty || invalidFields) || window.confirm('放弃未保存的运行设置？'))) close(); }}>
    <header className="modal-header"><h2>当前故事的运行设置</h2><button disabled={busy} onClick={() => { if (!(dirty || invalidFields) || window.confirm('放弃未保存的运行设置？')) close(); }}>关闭</button></header>
    <div className="modal-body">
      <p className="fine">只修改当前故事的副本。来源档案与旧正文保留；开关不会自动调用模型，也不会补执行原脚本。</p>
      {error && <p className="error" role="alert">{error}</p>}{notice && <p className="success" role="status">{notice}</p>}
      {stale && <p className="notice">故事版本已有更新；草稿仍保留。请核对后重新读取，不能覆盖更新。</p>}
      {runtimeLoading && <p className="muted" role="status">正在读取当前故事运行设置…</p>}
      {draft && <>
        <div className="row"><label>设置对象<select value={source} onChange={event => setSource(event.target.value as 'card' | 'preset')}><option value="card">角色卡 · {draft.card.title}</option><option value="preset">预设 · {draft.preset.title}</option></select></label>
          <label>搜索提示<input value={search} onChange={event => setSearch(event.target.value)} placeholder="标题 / 类型 / 代理" /></label></div>
        {document?.compatibility?.warnings.map((warning, index) => <details className="runtime-warning" key={index}><summary>适配说明 {index + 1}</summary><p className="fine">{warning}</p></details>)}
        <AgentCapabilities key={`${session.id}:${attempt}`} value={draft.agentRuntime} disabled={disabled}
          change={agentRuntime => setDraft(current => current ? { ...current, agentRuntime } : current)} invalid={setAgentError}/>
        <RuntimeFieldPolicies key={`${session.id}:${base?.revision}`} fields={draft.card.fields} roles={session.roles} disabled={disabled}
          change={fields => setDraft(current => current ? { ...current, card: { ...current.card, fields } } : current)}
          invalid={(key, message) => setFieldErrors(current => ({ ...current, [key]: message }))}/>
        <StoryProgressEditor session={session} readOnly={readOnly} refresh={refresh}/>
        <ParallelScenesEditor session={session} readOnly={readOnly} refresh={refresh}/>
        <TextCarrierEditor session={session} readOnly={readOnly} refresh={refresh}/>
        {source === 'card' && draft.card.visuals && <label><input type="checkbox" disabled={disabled} checked={draft.card.visuals.enabled} onChange={e => { const enabled = e.target.checked; setDraft(current => current?.card.visuals ? { ...current, card: { ...current.card, visuals: { ...current.card.visuals, enabled } } } : current); }}/>来源默认对白头像总开关<p className="fine">只影响后续新正文的来源默认；旧快照保留。当前来源默认图片未缓存或未映射时显示姓名占位，不联网补图。</p></label>}
        <VisualAssetsInline session={session} readOnly={readOnly} refresh={refresh}/>
        <h3>附加输出</h3><p className="fine">开启时一并开启其本文件的输出协议；关闭后保留历史输出。</p>
        <div className="runtime-output-list">{document?.outputs?.map(output => <label key={output.id}><input type="checkbox" disabled={disabled} checked={output.enabled} onChange={event => toggleOutput(output, event.target.checked)} /><span>{output.title}<small>{placementLabels[output.display.placement]} · {output.audience === 'author' ? '作者' : output.audience === 'public' ? '公开' : '指定角色'} · {output.valueFrom?.kind === 'approved-messages' ? '来自已确认消息' : output.valueFrom ? '宿主生成' : '模型生成'}{output.module && !document.modules.find(module => module.id === output.module || `${source}:${module.id}` === output.module)?.enabled ? ' · 协议当前关闭' : ''}</small></span></label>)}</div>
        {!document?.outputs?.length && <p className="muted">此文件没有已适配的附加输出。</p>}
        <h3>提示模块</h3><p className="fine">开启仍需满足资料条件、关键词、角色权限和章节门控。</p>
        <div className="runtime-module-list">{document?.modules.filter(module => !search || `${module.title} ${module.category} ${module.targets.join(' ')}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(module => <details key={module.id}>
          <summary><label onClick={event => event.stopPropagation()}><input type="checkbox" disabled={disabled} checked={module.enabled} onChange={event => toggleModule(module.id, event.target.checked)} />{module.title || module.id}<small>{module.targets.join(' / ')} · {module.category}</small></label></summary>
          <pre className="source-text">{module.content}</pre>
        </details>)}</div>
        <label>修改理由<input value={reason} disabled={busy} onChange={event => setReason(event.target.value)} placeholder="例如：开启摘要与事件记录" /></label>
        {invalidFields && <p className="error" role="alert">状态字段策略有未完成或无效的输入，请先修正后保存。</p>}
        {agentError && <p className="error" role="alert">代理模块装配尚不能保存：{agentError}</p>}
        <div className="actions"><button className="primary" disabled={!canSave} onClick={() => void save()}>{busy ? '保存中…' : '保存到当前故事'}</button><button disabled={busy || runtimeLoading} onClick={reload}>重新读取</button></div>
      </>}
      {!draft && error && <button disabled={runtimeLoading} onClick={reload}>重试读取</button>}
    </div>
  </dialog>;
}
