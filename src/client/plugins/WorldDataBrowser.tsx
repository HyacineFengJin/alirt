import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError, errorText, type WorldbookData, type RuntimeConfiguration, type ScenarioView, type ScenarioCommand } from '../api';
import { turnBusy } from '../Reader';
import { catalogRows, type CatalogRow, type CatalogUnavailableReason, type AuthorCatalog } from '../../shared/catalog';
import { ScenarioChapters } from './Scenario';
import type { PanelContext } from './registry';
export { catalogRows } from '../../shared/catalog';
export type { CatalogRow } from '../../shared/catalog';

const unavailableLabels: Record<CatalogUnavailableReason, string> = {
  'unmatched-source-title': '未适配：未找到可确证的同标题源脚本，可能存在别译；不自动猜选',
  'ambiguous-source-match': '未适配：目录或来源对应存在歧义',
  'source-isolated': '未适配：有对应源脚本，但原文处于隔离状态',
  'source-disabled': '未适配：对应源脚本在来源中关闭',
  'missing-scenario-script': '未适配：缺少独立的原生剧情脚本；设定或推进规则不能替代剧情',
  'stale-reference': '映射已失效：当前故事的章节或资料已修改，请检查绑定',
};
const operationLabels = { start: '开始章节', complete: '确认完成', abandon: '退出章节' };
type Draft = Omit<ScenarioCommand, 'requestId'>;

/** Keep source row indices and year/separator context through filtering. */
export function catalogDisplayRows(rows: CatalogRow[], catalog: AuthorCatalog | undefined, search: string, year: string) {
  let group = '';
  return rows.flatMap((row, rowIndex) => {
    if (row.kind === 'separator') { group = row.title; return []; }
    const reference = catalog?.entries.find(entry => entry.rowIndex === rowIndex);
    return (!search || `${group}\n${row.title}\n${row.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
      && (!year || reference?.year === year) ? [{ row, rowIndex, group, reference }] : [];
  });
}

/** Only authors mount consumers of future story plans. Opening the catalog or
 * a chapter operation does not change progress; a reasoned host command does. */
export function WorldDataBrowser({ launch, hideLauncher = false, ...context }: PanelContext & { launch?: { id: string }; hideLauncher?: boolean }) {
  const [open, setOpen] = useState(false);
  const lastLaunch = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (context.session.perspective !== 'author') { setOpen(false); return; }
    if (launch?.id && launch.id !== lastLaunch.current) { lastLaunch.current = launch.id; setOpen(true); }
  }, [launch?.id, context.session.perspective]);
  return context.session.perspective === 'author' ? <>
    {!hideLauncher && <button onClick={() => setOpen(true)}>浏览世界资料目录</button>}
    {open && createPortal(<DataDialog key={context.session.id} {...context} close={() => setOpen(false)} />, document.body)}
  </> : null;
}
function DataDialog({ session, readOnly, refresh, close }: PanelContext & { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), form = useRef<HTMLFormElement>(null);
  const inFlight = useRef(false), mounted = useRef(true);
  const [data, setData] = useState<WorldbookData>();
  const [runtime, setRuntime] = useState<RuntimeConfiguration>();
  const [view, setView] = useState<ScenarioView>();
  const [selected, setSelected] = useState('');
  const [selectedStory, setSelectedStory] = useState('');
  const [showOtherPlans, setShowOtherPlans] = useState(false);
  const [search, setSearch] = useState('');
  const [year, setYear] = useState('');
  const [error, setError] = useState('');
  const [commandError, setCommandError] = useState('');
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<Draft>();
  const [pending, setPending] = useState<ScenarioCommand>();
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => { mounted.current = true; dialog.current?.showModal(); return () => { mounted.current = false; dialog.current?.close(); }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setError(''); setLoading(true);
    Promise.all([api.worldbookData(session.id, controller.signal), api.runtime(session.id, controller.signal), api.scenario(session.id, controller.signal)])
      .then(([next, bound, scenario]) => { if (!controller.signal.aborted) {
        setData(next); setRuntime(bound); setView(current => current && current.revision > scenario.revision ? current : scenario);
        setSelected(current => next.items.some(item => `${item.source}:${item.bindingId}` === current) ? current : next.items[0] ? `${next.items[0].source}:${next.items[0].bindingId}` : '');
      } })
      .catch(e => { if (!controller.signal.aborted) setError(errorText(e)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [session.id, session.revision, session.updatedAt, attempt]);
  useEffect(() => { if (draft) form.current?.scrollIntoView?.({ block: 'nearest' }); }, [draft?.chapterId, draft?.operation]);
  const item = data?.items.find(item => `${item.source}:${item.bindingId}` === selected);
  const rows = item ? catalogRows(item.content) : undefined;
  const busy = readOnly || turnBusy(session);
  const synchronized = data?.revision === view?.revision && runtime?.revision === view?.revision;
  const stale = !!draft && draft.expectedRevision !== Math.max(session.revision, view?.revision ?? 0);
  const disabled = busy || loading || submitting || !!draft || !synchronized;
  const mappedChapterIds = new Set(data?.items.flatMap(entry => entry.catalog?.entries.filter(row => row.available).map(row => row.chapterId) ?? []));
  const otherChapters = view?.chapters.filter(chapter => !mappedChapterIds.has(chapter.id)) ?? [];
  function open(operation: Draft['operation'], chapterId: string) {
    if (!view || disabled) return;
    setDraft({ operation, chapterId, expectedRevision: view.revision, reason: '' }); setCommandError(''); setNotice('');
  }
  async function submit() {
    if (!draft || busy || inFlight.current || (!pending && (loading || stale || !synchronized || !draft.reason.trim()))) return;
    const payload = pending ?? { ...draft, reason: draft.reason.trim(), requestId: crypto.randomUUID() };
    setPending(payload); setSubmitting(true); inFlight.current = true; setCommandError('');
    let acknowledged = false;
    try {
      const next = await api.scenarioCommand(session.id, payload); acknowledged = true;
      if (!mounted.current) return;
      setView(next); setPending(undefined); setDraft(undefined);
      setNotice(`${operationLabels[payload.operation]}已记录${next.duplicate ? '（此前已接收）' : ''} · 故事版本 ${next.appliedRevision}。剧情参考不会自动成为已发生事实。`);
      await refresh();
      if (mounted.current) setAttempt(value => value + 1);
    } catch (e) {
      if (!mounted.current) return;
      setCommandError(acknowledged ? `章节操作已记录，故事状态尚未同步：${errorText(e)}` : errorText(e));
      if (!acknowledged && e instanceof ApiError && e.status < 500) setPending(undefined);
    } finally { inFlight.current = false; if (mounted.current) setSubmitting(false); }
  }
  return <dialog ref={dialog} className="modal wide-modal world-data-browser" onCancel={close}>
    <header className="modal-header"><h2>世界资料目录</h2><button disabled={submitting} onClick={close}>关闭</button></header>
    <div className="modal-body">
      <p className="fine">来源目录按作者数据读取；关闭的提示仍可浏览。阅读、筛选和打开操作不会开始剧情。只有填写理由并提交章节操作才会修改进度，不会提交源剧情事件或角色记忆。</p>
      {error && <p className="error" role="alert">{error}</p>}
      {commandError && <p className="error" role="alert">{commandError}</p>}
      {notice && <p className="success" role="status">{notice}</p>}
      {loading && <p className="muted">读取目录与章节状态中…</p>}
      {busy && <p className="notice">当前不可编辑，请等待回合结束后操作章节。</p>}
      {data && !data.valid && <p className="error">目录绑定无效，请先检查世界资料。</p>}
      {data && view && !synchronized && <p className="notice">目录与章节版本尚未同步，请重新读取。</p>}
      {data?.items.length ? <>
        <label>资料分类<select aria-label="世界资料分类" value={selected} onChange={event => { setSelected(event.target.value); setSearch(''); setYear(''); setSelectedStory(''); }}>{data.items.map(entry => <option key={`${entry.source}:${entry.bindingId}`} value={`${entry.source}:${entry.bindingId}`}>{runtime?.[entry.source].modules.find(module => module.id === entry.moduleId)?.title ?? entry.bindingId} · {entry.source}</option>)}</select></label>
        <label>搜索目录<input value={search} onChange={event => setSearch(event.target.value)} placeholder="标题、简介或原分组" /></label>
        {!!item?.catalog && <label>剧情学年<select aria-label="剧情学年" value={year} onChange={event => setYear(event.target.value)}><option value="">全部学年</option><option value="initial">升学前</option><option value="advanced">升学后</option><option value="unspecified">来源未标明学年</option></select></label>}
        {item && <p className="fine">故事版本 {data.revision} · 来源提示{item.promptEnabled ? '开启' : '关闭'} · {item.catalog ? `已核对 ${item.catalog.entries.filter(entry => entry.available).length} / ${item.catalog.entries.length} 项原生剧情引用` : '只读目录（无原生章节映射）'}</p>}
        {draft && <form ref={form} className="scenario-editor" onSubmit={event => { event.preventDefault(); void submit(); }}>
          <h3>{operationLabels[draft.operation]} · {view?.chapters.find(chapter => chapter.id === draft.chapterId)?.title ?? draft.chapterId}</h3>
          <p className="fine">基于故事版本 {draft.expectedRevision}{stale && !pending ? ' · 故事已有更新，请取消后重新选择。' : ''}</p>
          {draft.operation === 'abandon' && <p className="notice">退出会结束当前章节，不会将它标为已完成。</p>}
          <label>操作理由<textarea rows={2} required disabled={submitting || !!pending} value={draft.reason} onChange={event => setDraft({ ...draft, reason: event.target.value })} /></label>
          {pending && <p className="notice">上次结果尚未确认；重试保留同一请求、理由和原版本。</p>}
          <div className="actions"><button type="submit" disabled={busy || submitting || (!pending && (loading || stale || !synchronized || !draft.reason.trim()))}>{submitting ? '提交中…' : pending ? '重试同一请求' : operationLabels[draft.operation]}</button><button type="button" disabled={submitting} onClick={() => { setDraft(undefined); setPending(undefined); }}>取消操作</button></div>
        </form>}
        {rows ? <div className="world-data-cards">{catalogDisplayRows(rows, item?.catalog, search, year).map(({ row, rowIndex, group, reference }) => {
          const chapter = reference?.available && view?.chapters.find(chapter => chapter.id === reference.chapterId);
          const rowKey = `${selected}:${rowIndex}`;
          return <section key={rowKey}>
            {group && <p className="fine">原分组：{group}</p>}
            <h3>{row.title}</h3><p>{row.description}</p>
            {reference?.reason && <p className="notice">{unavailableLabels[reference.reason]} · 只读</p>}
            {reference?.available && !chapter && <p className="notice">当前章节已不可用，请重新读取。</p>}
            {chapter && <>
              <p className="fine">对应剧情：{chapter.title} · {reference?.year === 'initial' ? '升学前' : reference?.year === 'advanced' ? '升学后' : '学年未标明'}</p>
              <button disabled={loading || submitting} onClick={() => setSelectedStory(selectedStory === rowKey ? '' : rowKey)}>{selectedStory === rowKey ? '收起章节操作' : '打开章节操作'}</button>
              {selectedStory === rowKey && view && <ScenarioChapters view={{ ...view, chapters: [chapter] }} disabled={disabled} open={open} />}
            </>}
          </section>;
        })}</div> : item && <pre className="source-text">{item.content}</pre>}
      </> : data && <p className="muted">此故事尚无配置为作者目录的资料，可在世界资料编辑器中设置用途。</p>}
      {!!data?.items.some(item => item.catalog) && !!otherChapters.length && view && <section>
        <h3>未建立目录对应的原生剧情计划</h3>
        <p className="fine">当前故事另有 {otherChapters.length} 份原生计划；没有可确证的唯一目录引用。可按其原生标题显式操作；这不会为上方只读目录补造对应关系。</p>
        <button onClick={() => setShowOtherPlans(value => !value)}>{showOtherPlans ? '收起其他计划' : `查看其他计划（${otherChapters.length}）`}</button>
        {showOtherPlans && <ScenarioChapters view={{ ...view, chapters: otherChapters }} disabled={disabled} open={open} query={search} />}
      </section>}
      <button disabled={loading || submitting} onClick={() => setAttempt(value => value + 1)}>重新读取</button>
    </div>
  </dialog>;
}
