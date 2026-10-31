import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowUpRight,
  Download,
  History,
  RefreshCw,
  Save,
  Upload,
} from "lucide-react";
import type {
  CreatorSession,
  DraftIssue,
  PublishedDocument,
  SubmitCreatorRun,
} from "../../shared/creator";
import { ApiError, errorText } from "../api";
import { storageRead, storageWrite } from "../layout";
import { creatorApi } from "./api";
import { DraftPreview } from "./DraftPreview";
import { RevisionReview } from "./RevisionReview";
import { StructuredEditor } from "./StructuredEditor";
import { ConversionReview } from "./ConversionReview";
import type { ConversionReport } from "../../server/compatibility";
import {
  creatorBusy,
  creatorRunPayload,
  exportDraft,
  parseDraft,
  runAcknowledged,
  runLabels,
} from "./state";
const pendingKey = (id: string) => `rp:creator:pending:${id}`;
function storedPending(id: string): SubmitCreatorRun | null {
  try {
    const value = JSON.parse(storageRead(pendingKey(id)) ?? "null");
    return value &&
      typeof value.requestId === "string" &&
      typeof value.expectedRevision === "number" &&
      typeof value.instruction === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}
class DraftBoundary extends Component<
  { children: ReactNode; session: CreatorSession },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <>
        <p className="notice">
          草稿结构尚不完整，暂时无法生成阅读预览。请查看诊断并在高级编辑中修正。
        </p>
        <pre className="source-text">
          {JSON.stringify(this.props.session.document, null, 2)}
        </pre>
      </>
    ) : (
      this.props.children
    );
  }
}
export function CreatorSessionEditor({
  session,
  configured,
  refresh,
  onPublished,
  onStartStory,
}: {
  session: CreatorSession;
  configured: boolean;
  refresh: () => Promise<CreatorSession>;
  onPublished: (published: PublishedDocument) => Promise<void>;
  onStartStory: (published: PublishedDocument) => void;
}) {
  const pending = useRef<SubmitCreatorRun | null>(storedPending(session.id));
  const [instruction, setInstruction] = useState(
    pending.current?.instruction ?? "",
  );
  const [uncertain, setUncertain] = useState(
    !!pending.current && !runAcknowledged(session, pending.current),
  );
  const [waitingRequest, setWaitingRequest] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [issues, setIssues] = useState<DraftIssue[]>([]);
  const [tab, setTab] = useState<"preview" | "history" | "json" | "edit">(
    "preview",
  );
  const [raw, setRaw] = useState(JSON.stringify(session.document, null, 2));
  const [baseRaw, setBaseRaw] = useState(
    JSON.stringify(session.document, null, 2),
  );
  const [editRevision, setEditRevision] = useState(session.revision);
  const [summary, setSummary] = useState("");
  const [lastPublished, setLastPublished] = useState<PublishedDocument>();
  const [conversion, setConversion] = useState<ConversionReport | null>();
  const [conversionError, setConversionError] = useState("");
  const [conversionAttempt, setConversionAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setConversion(undefined);
    setConversionError("");
    creatorApi.conversion(session.id).then(({ report }) => { if (active) setConversion(report); })
      .catch((e) => { if (active) setConversionError(errorText(e)); });
    return () => { active = false; };
  }, [session.id, session.revision, conversionAttempt]);
  const busy = creatorBusy(session);
  const lastRun = session.runs.at(-1);
  const dirty = raw !== baseRaw;
  const workingDocument = useMemo(() => {
    try {
      return parseDraft(raw, session.kind);
    } catch {
      return null;
    }
  }, [raw, session.kind]);
  const disabled =
    busy || submitting || mutating || uncertain || waitingRequest;
  function clearPending() {
    pending.current = null;
    storageWrite(pendingKey(session.id), "null");
    setUncertain(false);
    setWaitingRequest(false);
  }
  useEffect(() => {
    if (runAcknowledged(session, pending.current)) {
      clearPending();
      setInstruction("");
      setError("");
    }
  }, [session.runs]);
  useEffect(() => {
    if (!dirty) {
      const current = JSON.stringify(session.document, null, 2);
      setRaw(current);
      setBaseRaw(current);
      setEditRevision(session.revision);
    }
  }, [session.revision]);
  useEffect(() => {
    if (!uncertain && !waitingRequest) return;
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 2500);
    return () => clearInterval(timer);
  }, [uncertain, waitingRequest, refresh]);
  async function send(retry = false) {
    if (
      submitting ||
      waitingRequest ||
      busy ||
      mutating ||
      (!retry && (!instruction.trim() || uncertain || dirty))
    )
      return;
    const payload = creatorRunPayload(
      instruction,
      session.revision,
      retry ? "" : crypto.randomUUID(),
      retry ? pending.current : null,
    );
    if (!payload.requestId) return;
    pending.current = payload;
    storageWrite(pendingKey(session.id), JSON.stringify(payload));
    setSubmitting(true);
    setError("");
    setIssues([]);
    setNotice("");
    let acknowledged = false;
    try {
      await creatorApi.run(session.id, payload);
      acknowledged = true;
      setWaitingRequest(true);
      setUncertain(false);
      setInstruction("");
      await refresh();
    } catch (e) {
      if (acknowledged) {
        setError(`创作请求已接收，状态尚未同步：${errorText(e)}`);
        return;
      }
      const ambiguous = !(e instanceof ApiError) || e.status >= 500;
      setError(errorText(e));
      if (e instanceof ApiError) setIssues(e.issues);
      if (ambiguous) setUncertain(true);
      else clearPending();
      try {
        await refresh();
      } catch {
        /* Preserve ambiguous submission for an exact replay. */
      }
    } finally {
      setSubmitting(false);
    }
  }
  async function cancel() {
    setMutating(true);
    setError("");
    try {
      await creatorApi.cancel(session.id);
      await refresh();
      setNotice("中断请求已发送；已保存的草稿版本与历史仍保留。");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setMutating(false);
    }
  }
  async function save() {
    setMutating(true);
    setError("");
    setNotice("");
    setIssues([]);
    try {
      const document = parseDraft(raw, session.kind);
      const next = await creatorApi.save(session.id, {
        expectedRevision: editRevision,
        document,
        summary: summary.trim(),
      });
      await refresh();
      setRaw(JSON.stringify(next.document, null, 2));
      setBaseRaw(JSON.stringify(next.document, null, 2));
      setEditRevision(next.revision);
      setSummary("");
      setNotice(
        next.issues.length
          ? "草稿已保存，仍有诊断需要修正。"
          : `已保存为版本 ${next.revision}。`,
      );
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError) setIssues(e.issues);
    } finally {
      setMutating(false);
    }
  }
  async function restore(revision: number) {
    setMutating(true);
    setError("");
    setNotice("");
    setIssues([]);
    try {
      const next = await creatorApi.restore(session.id, {
        expectedRevision: session.revision,
        revision,
      });
      await refresh();
      setRaw(JSON.stringify(next.document, null, 2));
      setBaseRaw(JSON.stringify(next.document, null, 2));
      setEditRevision(next.revision);
      setNotice(`已将版本 ${revision} 的内容恢复为新版本 ${next.revision}。`);
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError) setIssues(e.issues);
    } finally {
      setMutating(false);
    }
  }
  async function publish() {
    setMutating(true);
    setError("");
    setNotice("");
    setIssues([]);
    let published: PublishedDocument | undefined;
    try {
      published = await creatorApi.publish(session.id, {
        expectedRevision: session.revision,
      });
      setLastPublished(published);
      await refresh();
      await onPublished(published);
      setNotice(
        `「${published.title}」已作为新素材加入目录。现有故事保持原版本。`,
      );
    } catch (e) {
      setError(
        `${published ? "素材已发布，后续同步未完成：" : ""}${errorText(e)}`,
      );
      if (e instanceof ApiError) setIssues(e.issues);
      try {
        await refresh();
      } catch {
        /* An explicit Sync action remains available. */
      }
    } finally {
      setMutating(false);
    }
  }
  const published = lastPublished ?? session.published.at(-1);
  const publishedCurrent =
    session.published.some((item) => item.revision === session.revision) ||
    lastPublished?.revision === session.revision;
  const diagnostics = [...session.issues, ...issues].filter(
    (issue, index, all) =>
      all.findIndex(
        (item) => item.path === issue.path && item.message === issue.message,
      ) === index,
  );
  return (
    <>
      <section className="creator-conversation" aria-label="创作会话">
        <header>
          <p className="eyebrow">
            {session.kind === "card" ? "角色卡" : "创作预设"} · 持续创作
          </p>
          <h2>{session.title}</h2>
          <p className="fine">
            会话与草稿保存在本地服务。切回阅读不会中断正在进行的创作。
          </p>
          {session.sourceId && (
            <p className="fine">独立草稿来源：{session.sourceId}</p>
          )}
        </header>
        <div className="creator-messages" aria-label="创作历史">
          {session.messages.length ? (
            session.messages.map((message) => (
              <article
                key={message.id}
                className={`creator-message creator-message-${message.role}`}
              >
                <div className="row">
                  <strong>
                    {message.role === "user" ? "你的要求" : "创作助手"}
                  </strong>
                  <time>{message.at}</time>
                </div>
                <p className="creator-full-text">{message.text}</p>
              </article>
            ))
          ) : (
            <p className="creator-empty">
              描述想写的世界、人物或叙事方式，也可以要求助手修改右侧草稿的某个部分。
            </p>
          )}
        </div>
        {lastRun && (
          <div
            className={`creator-run-state ${lastRun.status === "failed" || lastRun.status === "interrupted" ? "error" : ""}`}
            role="status"
          >
            <div className="row">
              <span>
                {runLabels[lastRun.status]} · {lastRun.phase}
              </span>
              {busy && (
                <button disabled={mutating} onClick={() => void cancel()}>
                  中断创作
                </button>
              )}
            </div>
            {lastRun.error && <p>{lastRun.error}</p>}
          </div>
        )}
        <form
          className="creator-instruction"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label htmlFor={`creator-instruction-${session.id}`}>
            给创作助手的要求
          </label>
          <textarea
            id={`creator-instruction-${session.id}`}
            value={instruction}
            disabled={submitting || uncertain || waitingRequest}
            onChange={(event) => setInstruction(event.target.value)}
            rows={4}
            placeholder={
              session.kind === "card"
                ? "例如：设定在山间邮局，增加两位互不了解秘密的角色，保留玩家自主行动。"
                : "例如：把文风调整为克制的第三人称，并把篇幅与角色行为约束拆成独立模块。"
            }
          />
          <div className="row">
            <span className="fine">
              基于草稿版本{" "}
              {pending.current?.expectedRevision ?? session.revision}
            </span>
            <button
              className="primary"
              type="submit"
              disabled={disabled || !instruction.trim() || !configured || dirty}
            >
              {submitting
                ? "提交中…"
                : waitingRequest
                  ? "等待状态同步"
                  : busy
                    ? "创作进行中"
                    : "发送要求"}
              <ArrowUpRight size={14} />
            </button>
          </div>
          {!configured && (
            <p className="notice">
              尚未配置模型 API。仍可手动编辑、检查版本与发布；AI
              创作需先在应用设置中配置。
            </p>
          )}
          {dirty && (
            <p className="notice">
              手动编辑中有未保存内容。请先保存，或重新载入当前草稿，再让助手继续修改。
            </p>
          )}
          {waitingRequest && (
            <p className="notice" role="status">
              创作请求已接收，正在同步运行状态。
            </p>
          )}
          {uncertain && (
            <div className="notice">
              <p>
                提交回执尚未确认。重试将复用同一请求
                ID、原版本与原要求，不会另发一份创作任务。
              </p>
              <button
                type="button"
                disabled={submitting || busy || mutating}
                onClick={() => void send(true)}
              >
                重试同一创作请求
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() =>
                  void refresh().catch((e) => setError(errorText(e)))
                }
              >
                检查服务器状态
              </button>
            </div>
          )}
        </form>
        <details className="creator-run-history">
          <summary>运行记录 · {session.runs.length}</summary>
          {[...session.runs].reverse().map((run) => (
            <div key={run.id}>
              <p>
                {runLabels[run.status]} · {run.phase}
              </p>
              <p className="creator-full-text fine">{run.instruction}</p>
              <p className="fine">{run.startedAt}</p>
              {run.error && <p className="error">{run.error}</p>}
            </div>
          ))}
        </details>
      </section>
      <section className="creator-document" aria-label="草稿与版本">
        <header className="creator-document-head">
          <div>
            <p className="eyebrow">
              版本 {session.revision} ·{" "}
              {busy
                ? "助手正在编辑"
                : dirty
                  ? "有未保存修改"
                  : "当前已保存草稿"}
            </p>
            <h2>审阅草稿</h2>
          </div>
          <div className="actions">
            <button
              onClick={() =>
                void refresh()
                  .then(() =>
                    setNotice("已同步最新草稿；未保存的手动编辑仍保留。"),
                  )
                  .catch((e) => setError(errorText(e)))
              }
            >
              <RefreshCw size={13} />
              同步
            </button>
            <button onClick={() => exportDraft(session.document)}>
              <Download size={13} />
              导出 JSON
            </button>
          </div>
        </header>
        <div className="creator-tabs" role="group" aria-label="草稿查看方式">
          <button
            aria-pressed={tab === "preview"}
            onClick={() => setTab("preview")}
          >
            阅读草稿
          </button>
          <button aria-pressed={tab === "edit"} onClick={() => setTab("edit")}>
            结构化编辑
          </button>
          <button
            aria-pressed={tab === "history"}
            onClick={() => setTab("history")}
          >
            <History size={13} />
            版本比较
          </button>
          <button
            aria-pressed={tab === "json"}
            onClick={() => {
              if (tab !== "json" && !dirty) {
                setRaw(JSON.stringify(session.document, null, 2));
                setBaseRaw(JSON.stringify(session.document, null, 2));
                setEditRevision(session.revision);
              }
              setTab("json");
            }}
          >
            高级编辑
          </button>
        </div>
        {error && (
          <p className="error creator-feedback" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice creator-feedback" role="status">
            {notice}
          </p>
        )}
        {diagnostics.length > 0 && (
          <section className="creator-diagnostics" aria-label="草稿诊断">
            <h3>需要修正 · {diagnostics.length}</h3>
            <ul>
              {diagnostics.map((issue) => (
                <li key={`${issue.path}:${issue.message}`}>
                  <code>{issue.path || "/"}</code>：{issue.message}
                </li>
              ))}
            </ul>
          </section>
        )}
        {conversionError && <div className="creator-feedback" role="alert"><p className="error">转换审阅状态未同步：{conversionError}</p><button onClick={() => setConversionAttempt((value) => value + 1)}>重读转换报告</button></div>}
        {conversion && <ConversionReview report={conversion} />}
        <div className="creator-document-body">
          {tab === "preview" ? (
            <DraftBoundary
              key={`${session.id}:${session.revision}`}
              session={session}
            >
              {dirty && (
                <p className="notice">
                  正在预览未保存修改，基于版本 {editRevision}
                  。保存后才会进入发布与 AI 上下文。
                </p>
              )}
              {workingDocument ? (
                <DraftPreview
                  document={dirty ? workingDocument : session.document}
                />
              ) : (
                <p className="notice">
                  手动 JSON 暂时无法解析，请在高级编辑中修正。
                </p>
              )}
            </DraftBoundary>
          ) : tab === "history" ? (
            <RevisionReview
              session={session}
              disabled={disabled || dirty}
              restore={restore}
            />
          ) : tab === "edit" ? (
            workingDocument ? (
              <DraftBoundary
                key={`edit:${session.id}:${session.revision}`}
                session={session}
              >
                <StructuredEditor
                  document={workingDocument}
                  disabled={disabled}
                  change={(document) =>
                    setRaw(JSON.stringify(document, null, 2))
                  }
                />
              </DraftBoundary>
            ) : (
              <p className="notice">
                JSON 结构暂时无法解析，请先打开高级编辑修正。
              </p>
            )
          ) : (
            <section className="creator-json-editor">
              <p className="fine">
                手动修改原生
                JSON，未知字段将随草稿保留。保存使用打开编辑时的版本校验。
                附加输出可在 outputs 中声明类型、生成要求、读取权限与正文后／侧栏／隐藏位置。
              </p>
              <label htmlFor={`creator-json-${session.id}`}>
                完整原生草稿 JSON
              </label>
              <textarea
                id={`creator-json-${session.id}`}
                spellCheck={false}
                value={raw}
                onChange={(event) => setRaw(event.target.value)}
                rows={24}
                disabled={disabled}
              />
            </section>
          )}
          {(tab === "edit" || tab === "json") && (
            <section className="creator-manual-save">
              {" "}
              <label>
                此次修改说明
                <input
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                  disabled={disabled}
                  placeholder="例如：补充角色目标，修正状态上限"
                />
              </label>
              <div className="row">
                <span className="fine">
                  编辑基于版本 {editRevision}
                  {editRevision !== session.revision
                    ? " · 当前草稿已有新版本，请先核对差异"
                    : ""}
                </span>
                <div className="actions">
                  <button
                    disabled={disabled}
                    onClick={() => {
                      setRaw(JSON.stringify(session.document, null, 2));
                      setBaseRaw(JSON.stringify(session.document, null, 2));
                      setEditRevision(session.revision);
                      setSummary("");
                    }}
                  >
                    重新载入当前草稿
                  </button>
                  <button
                    disabled={disabled || !dirty || !summary.trim()}
                    onClick={() => void save()}
                  >
                    <Save size={13} />
                    保存新版本
                  </button>
                </div>
              </div>
            </section>
          )}
        </div>
        <footer className="creator-publish">
          <div className="row">
            <div>
              <strong>发布到素材目录</strong>
              <p className="fine">
                显式发布后可用于新故事。不会自动改写正在阅读的故事。
              </p>
            </div>
            <button
              className="primary"
              disabled={
                disabled || dirty || !!diagnostics.length || publishedCurrent || conversion === undefined || !!conversion && (!conversion.readyForReview || conversion.revision !== session.revision)
              }
              onClick={() => void publish()}
            >
              <Upload size={13} />
              {mutating
                ? "处理中…"
                : publishedCurrent
                  ? "此版本已发布"
                  : "发布新素材"}
            </button>
          </div>
          {published && (
            <div className="creator-published">
              <p>
                已发布「{published.title}」· 草稿版本 {published.revision}
              </p>
              <p className="fine">
                {published.publishedAt} · {published.id}
              </p>
              <button onClick={() => onStartStory(published)}>
                用这份素材开始新故事
              </button>
            </div>
          )}
        </footer>
      </section>
    </>
  );
}
