import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Plus } from "lucide-react";
import type {
  CreativeKind,
  CreatorSession,
  PublishedDocument,
} from "../../shared/creator";
import type { Catalog } from "../../shared/types";
import { errorText } from "../api";
import { storageRead, storageWrite } from "../layout";
import { creatorApi } from "./api";
import { CreatorSessionEditor } from "./CreatorSessionEditor";
import {
  acceptsSnapshot,
  chooseCreatorSession,
  creatorBusy,
  newestCreatorSessions,
  runLabels,
} from "./state";
import "./creator.css";
export function CreatorWorkspace({
  visible,
  catalog,
  configured,
  onExit,
  onPublished,
  onStartStory,
  incomingSession,
  newSessionRequest = 0,
}: {
  incomingSession?: CreatorSession;
  newSessionRequest?: number;
  visible: boolean;
  catalog: Catalog;
  configured: boolean;
  onExit: () => void;
  onPublished: (published: PublishedDocument) => Promise<void>;
  onStartStory: (published: PublishedDocument) => void;
}) {
  const [sessions, setSessions] = useState<CreatorSession[]>([]);
  const [session, setSession] = useState<CreatorSession>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [kind, setKind] = useState<CreativeKind>("card");
  const [sourceId, setSourceId] = useState("");
  const [title, setTitle] = useState("");
  const [sessionQuery, setSessionQuery] = useState("");
  const incomingRef = useRef(incomingSession);
  const selected = useRef<string | undefined>(undefined);
  const latest = useRef<CreatorSession | undefined>(undefined);
  const switching = useRef(0);
  function accept(next: CreatorSession) {
    setSessions((previous) => {
      const existing = previous.find((item) => item.id === next.id);
      return newestCreatorSessions([
        acceptsSnapshot(existing, next) ? next : existing!,
        ...previous.filter((item) => item.id !== next.id),
      ]);
    });
    if (selected.current !== next.id || !acceptsSnapshot(latest.current, next))
      return;
    latest.current = next;
    setSession(next);
  }
  async function load() {
    setLoading(true);
    setError("");
    try {
      const items = await creatorApi.list();
      setSessions(newestCreatorSessions(items));
      const next =
        incomingRef.current ??
        chooseCreatorSession(items, storageRead("rp:creator:last-session"));
      if (next) {
        selected.current = next.id;
        latest.current = next;
        setSession(next);
        accept(next);
        storageWrite("rp:creator:last-session", next.id);
        incomingRef.current = undefined;
      } else setShowNew(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (!incomingSession) return;
    incomingRef.current = incomingSession;
    selected.current = incomingSession.id;
    latest.current = incomingSession;
    accept(incomingSession);
    setShowNew(false);
    storageWrite("rp:creator:last-session", incomingSession.id);
  }, [incomingSession?.id]);
  useEffect(() => {
    if (newSessionRequest) {
      incomingRef.current = undefined;
      setShowNew(true);
    }
  }, [newSessionRequest]);
  async function select(id: string) {
    incomingRef.current = undefined;
    const sequence = ++switching.current;
    setError("");
    try {
      const next = await creatorApi.get(id);
      if (sequence !== switching.current) return;
      selected.current = id;
      latest.current = next;
      setSession(next);
      accept(next);
      setShowNew(false);
      storageWrite("rp:creator:last-session", id);
    } catch (e) {
      if (sequence === switching.current) setError(errorText(e));
    }
  }
  async function refresh(id: string) {
    const next = await creatorApi.get(id);
    accept(next);
    return next;
  }
  const busy = creatorBusy(session);
  useEffect(() => {
    if (!session || !busy) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const id = session.id;
    async function poll() {
      try {
        const next = await creatorApi.get(id);
        if (active) {
          accept(next);
          setError("");
        }
      } catch (e) {
        if (active) setError(`创作状态暂未同步：${errorText(e)}`);
      }
      if (active) timer = setTimeout(() => void poll(), 1300);
    }
    timer = setTimeout(() => void poll(), 700);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [session?.id, busy]);
  async function create() {
    incomingRef.current = undefined;
    ++switching.current;
    setCreating(true);
    setError("");
    try {
      const next = await creatorApi.create({
        kind,
        ...(sourceId ? { sourceId } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      selected.current = next.id;
      latest.current = next;
      accept(next);
      setShowNew(false);
      setTitle("");
      storageWrite("rp:creator:last-session", next.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setCreating(false);
    }
  }
  const sources = kind === "card" ? catalog.cards : catalog.presets;
  const source = sources.find((item) => item.id === sourceId);
  return (
    <section
      className="creator-surface"
      hidden={!visible}
      aria-label="创作工坊"
    >
      <header className="creator-workspace-head">
        <div>
          <p className="eyebrow">CREATIVE WORKSPACE</p>
          <h1>创作工坊</h1>
          <p className="fine">
            把想法写成卡片与预设，持续修改，再决定何时发布。
          </p>
        </div>
        <button onClick={onExit}>
          <ArrowLeft size={14} />
          返回阅读
        </button>
      </header>
      <div className="creator-layout">
        <aside className="creator-session-rail" aria-label="创作会话列表">
          <div className="row">
            <h2>我的创作</h2>
            <button
              aria-label="新建创作会话"
              onClick={() => {
                setShowNew(true);
                setError("");
              }}
            >
              <Plus size={14} />
            </button>
          </div>
          <label>
            查找创作会话
            <input
              type="search"
              value={sessionQuery}
              onChange={(event) => setSessionQuery(event.target.value)}
              placeholder="名称、来源或会话 ID"
            />
          </label>
          {loading && <p className="muted">正在载入创作会话…</p>}
          {sessions
            .filter((item) =>
              `${item.title} ${item.sourceId ?? ""} ${item.id}`
                .toLocaleLowerCase()
                .includes(sessionQuery.toLocaleLowerCase()),
            )
            .map((item) => (
              <button
                key={item.id}
                className="creator-session-choice"
                aria-pressed={session?.id === item.id && !showNew}
                onClick={() => void select(item.id)}
              >
                <strong>{item.title}</strong>
                <small>
                  {item.kind === "card" ? "角色卡" : "预设"} · 版本{" "}
                  {item.revision} ·{" "}
                  {item.runs.at(-1)
                    ? runLabels[item.runs.at(-1)!.status]
                    : "尚未运行"}
                </small>
                <small>
                  {item.updatedAt.slice(0, 16).replace("T", " ")} ·{" "}
                  {item.id.slice(0, 6)}
                </small>
              </button>
            ))}
          {!loading && !sessions.length && (
            <p className="fine">
              还没有创作会话。新建一份，或从已有素材继续写。
            </p>
          )}
          <p className="creator-rail-note fine">
            创作会话与故事实例独立。历史要求、运行结果与草稿版本会保留。
          </p>
          <button className="text-button" onClick={() => void load()}>
            重新读取会话列表
          </button>
        </aside>
        {error && (
          <div className="creator-global-error" role="alert">
            <p className="error">{error}</p>
            <button
              onClick={() =>
                void (session
                  ? refresh(session.id).catch((e) => setError(errorText(e)))
                  : load())
              }
            >
              重试同步
            </button>
          </div>
        )}
        {showNew ? (
          <section className="creator-new-session">
            <p className="eyebrow">新的创作会话</p>
            <h2>从一个想法，或一份素材开始。</h2>
            <label>
              创作类型
              <select
                value={kind}
                disabled={creating}
                onChange={(event) => {
                  setKind(event.target.value as CreativeKind);
                  setSourceId("");
                }}
              >
                <option value="card">角色卡</option>
                <option value="preset">创作预设</option>
              </select>
            </label>
            <label>
              起点
              <select
                value={sourceId}
                disabled={creating}
                onChange={(event) => setSourceId(event.target.value)}
              >
                <option value="">新建空白草稿</option>
                {sources.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                    {item.compatibility ? " · 导入原生投影" : ""}
                  </option>
                ))}
              </select>
            </label>
            {source && (
              <div className="selection-note">
                <h3>{source.title}</h3>
                <p>{source.description}</p>
                {source.compatibility && (
                  <p className="notice">
                    将复制可支持的原生部分作为独立草稿；原始导入包、前端脚本与未适配模块继续保留在来源库。此操作不保证来源运行行为完全等价。
                  </p>
                )}
              </div>
            )}
            <label>
              会话名称（可选）
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                disabled={creating}
                placeholder="例如：山间邮局的人物设定"
              />
            </label>
            <div className="actions">
              <button
                className="primary"
                disabled={creating}
                onClick={() => void create()}
              >
                {creating ? "创建中…" : "建立创作会话"}
              </button>
              {session && (
                <button disabled={creating} onClick={() => setShowNew(false)}>
                  回到当前草稿
                </button>
              )}
            </div>
            <p className="fine">
              建立会话只生成本地起始草稿；发送要求后才调用创作助手。
            </p>
          </section>
        ) : session ? (
          <CreatorSessionEditor
            key={session.id}
            session={session}
            configured={configured}
            refresh={() => refresh(session.id)}
            onPublished={onPublished}
            onStartStory={onStartStory}
          />
        ) : (
          !loading && (
            <div className="creator-new-session">
              <p className="muted">暂时没有可打开的草稿。</p>
              <button onClick={() => setShowNew(true)}>新建创作会话</button>
            </div>
          )
        )}
      </div>
    </section>
  );
}
