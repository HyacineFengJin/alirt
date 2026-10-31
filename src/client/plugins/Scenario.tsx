import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorText, type ScenarioCommand, type ScenarioView } from "../api";
import { turnBusy } from "../Reader";
import type { PanelContext } from "./registry";

const statusLabels = { active: "进行中", completed: "已完成", available: "可开始", locked: "未解锁" };
const completionLabels = { true: "完成条件已满足", false: "完成条件未满足", unknown: "完成条件暂无法判定", manual: "由作者确认完成" };
const operationLabels = { start: "开始章节", complete: "确认完成", abandon: "退出章节" };
type Draft = { operation: ScenarioCommand["operation"]; chapterId: string; expectedRevision: number; reason: string };

/** Chapter state is author-only; role perspectives never mount the API consumer. */
export function Scenario(context: PanelContext) {
  return context.session.perspective === "author"
    ? <AuthorScenario key={context.session.id} {...context} />
    : <p className="muted">章节流程仅在作者视角中查看和操作。</p>;
}

export function ScenarioChapters({ view, disabled, open, query = '' }: {
  view: ScenarioView;
  disabled: boolean;
  open: (operation: ScenarioCommand["operation"], chapterId: string) => void;
  query?: string;
}) {
  const title = (id: string) => view.chapters.find((chapter) => chapter.id === id)?.title ?? id;
  return <ol className="scenario-chapters">{view.chapters.filter(chapter => !query || `${chapter.title} ${chapter.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((chapter) => <li key={chapter.id} className={`scenario-chapter scenario-${chapter.status}`}>
    <div className="row"><strong>{chapter.title}</strong><span className="fine">{statusLabels[chapter.status]}</span></div>
    <p className="fine">前置：{chapter.prerequisites.length ? chapter.prerequisites.map(title).join("、") : "无"}</p>
    {!!chapter.missingPrerequisites.length && <p className="fine">尚缺：{chapter.missingPrerequisites.map(title).join("、")}</p>}
    {!!chapter.bindingIds.length && <p className="fine">关联资料 {chapter.bindingIds.length} 项</p>}
    {chapter.status === "active" && <p className="fine">{completionLabels[chapter.completionStatus]}</p>}
    <div className="actions">
      {chapter.canStart && <button disabled={disabled} onClick={() => open("start", chapter.id)}>开始章节</button>}
      {chapter.status === "active" && <>
        <button disabled={disabled || !chapter.canComplete} onClick={() => open("complete", chapter.id)}>确认完成</button>
        <button disabled={disabled || !chapter.canAbandon} onClick={() => open("abandon", chapter.id)}>退出章节</button>
      </>}
    </div>
  </li>)}</ol>;
}

function AuthorScenario({ session, readOnly, refresh }: PanelContext) {
  const [view, setView] = useState<ScenarioView>();
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState("");
  const [commandError, setCommandError] = useState("");
  const [issues, setIssues] = useState<ApiError["issues"]>([]);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft>();
  const [pending, setPending] = useState<ScenarioCommand>();
  const [submitting, setSubmitting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setReadError("");
    api.scenario(session.id, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setView((current) => current && current.revision > next.revision ? current : next); })
      .catch((error) => { if (!controller.signal.aborted) setReadError(errorText(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [session.id, session.revision, session.updatedAt, attempt]);

  const busy = readOnly || turnBusy(session);
  const latestRevision = Math.max(session.revision, view?.revision ?? 0);
  const stale = !!draft && draft.expectedRevision !== latestRevision;
  const current = view?.chapters.find((chapter) => chapter.id === view.progress?.currentChapterId);
  function open(operation: Draft["operation"], chapterId: string) {
    if (!view || busy || submitting || pending) return;
    setDraft({ operation, chapterId, expectedRevision: view.revision, reason: "" });
    setCommandError("");
    setIssues([]);
    setNotice("");
  }
  async function submit() {
    if (!draft || busy || inFlight.current || (!pending && (stale || !draft.reason.trim()))) return;
    const payload = pending ?? { ...draft, reason: draft.reason.trim(), requestId: crypto.randomUUID() };
    // Keep the whole payload after an uncertain response, including its original CAS revision.
    setPending(payload);
    inFlight.current = true;
    setSubmitting(true);
    setCommandError("");
    setIssues([]);
    let acknowledged = false;
    try {
      const result = await api.scenarioCommand(session.id, payload);
      acknowledged = true;
      if (!mounted.current) return;
      setView(result);
      setPending(undefined);
      setDraft(undefined);
      setNotice(`${operationLabels[payload.operation]}已记录${result.duplicate ? "（此前已接收）" : ""} · 故事版本 ${result.appliedRevision}`);
      await refresh();
      if (!mounted.current) return;
      setAttempt((value) => value + 1);
    } catch (error) {
      if (!mounted.current) return;
      setCommandError(acknowledged ? `章节操作已记录，故事状态尚未同步：${errorText(error)}` : errorText(error));
      setIssues(error instanceof ApiError ? error.issues : []);
      if (!acknowledged && error instanceof ApiError && error.status < 500) setPending(undefined);
    } finally {
      inFlight.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }
  async function reload() {
    setAttempt((value) => value + 1);
    try { await refresh(); }
    catch (error) { if (mounted.current) setReadError(errorText(error)); }
  }
  return <section className="scenario-panel" aria-label="作者章节流程">
    <p className="eyebrow">作者控制 · 章节流程</p>
    {readError && <p className="error" role="alert">{readError}</p>}
    {commandError && <div role="alert"><p className="error">{commandError}</p>{issues.map((issue, index) => <p className="error" key={index}>{issue.path}：{issue.message}</p>)}</div>}
    {notice && <p className="success" role="status">{notice}</p>}
    {loading && <p className="muted">正在读取章节状态…</p>}
    {view && !view.definition && <p className="muted">此故事未配置章节流程。</p>}
    {view?.definition && <>
      <h3>{view.definition.title}</h3>
      <p className="scenario-current">当前章节：<strong>{current?.title ?? "暂无进行中的章节"}</strong></p>
      <p className="fine">故事版本 {view.revision} · 已完成 {view.progress?.completedChapterIds.length ?? 0} / {view.chapters.length}</p>
      {busy && <p className="notice">请等待当前回合结束后再操作章节。</p>}
      <label>查找章节<input value={query} onChange={event => setQuery(event.target.value)} placeholder="章节或剧情名称" /></label>
      <ScenarioChapters view={view} disabled={busy || submitting || loading || !!draft} open={open} query={query} />
    </>}
    {draft && <form className="scenario-editor" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <h3>{operationLabels[draft.operation]} · {view?.chapters.find((chapter) => chapter.id === draft.chapterId)?.title ?? draft.chapterId}</h3>
      {draft.operation === "abandon" && <p className="notice">退出会结束当前章节，不会将它标为已完成。</p>}
      <p className="fine">基于故事版本 {draft.expectedRevision}{stale && !pending ? " · 故事已有更新，请取消后重新选择操作。" : ""}</p>
      <label>操作理由<textarea value={draft.reason} rows={2} required disabled={submitting || !!pending} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} /></label>
      {pending && <p className="notice">上次提交结果尚未确认。重试会使用同一请求和理由；也可先重新读取状态。</p>}
      <div className="actions">
        <button type="submit" disabled={busy || submitting || (!pending && (loading || stale || !draft.reason.trim()))}>{submitting ? "提交中…" : pending ? "重试同一请求" : operationLabels[draft.operation]}</button>
        <button type="button" disabled={submitting} onClick={() => { setDraft(undefined); setPending(undefined); }}>取消操作</button>
      </div>
    </form>}
    <button className="text-button" disabled={loading || submitting} onClick={() => void reload()}>重新读取章节与故事</button>
  </section>;
}
