import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  BookOpen,
  PenLine,
  Check,
  LibraryBig,
  Maximize2,
  Moon,
  PanelsTopLeft,
  Plus,
  Settings2,
  Sun,
  X,
} from "lucide-react";
import type {
  AppStatus,
  Catalog,
  EditState,
  SessionSnapshot,
  SetLifecycle,
} from "../shared/types";
import { api, errorText } from "./api";
import {
  restoreLayout,
  storageRead,
  storageWrite,
  type Layout,
} from "./layout";
import { registry } from "./plugins/builtin";
import { PanelHost } from "./plugins/PanelHost";
import { MaterialWorkspace } from "./materials/MaterialWorkspace";
import { creatorApi } from "./creator/api";
import { Reader, turnBusy, currentReadingSnapshot, readingProjectionKey } from "./Reader";
import type { PanelContext } from './plugins/registry';
import { initialSession, recentSessions, sessionLabel } from "./sessions";
import { NewStoryInitialization } from "./NewStoryInitialization";
import { newStoryRequest, resolveNewStorySelection, type NewStorySelection } from "./new-story";
import type {
  CreatorSession,
  NativeDocument,
  PublishedDocument,
} from "../shared/creator";
import { CreatorWorkspace } from "./creator/CreatorWorkspace";
function Modal({
  title,
  close,
  children,
  wide = false,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={wide ? "modal wide-modal" : "modal"}
      onCancel={close}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <header className="modal-header">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="关闭对话框" onClick={close}>
          <X size={18} />
        </button>
      </header>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
export function readingPanelContext(author: SessionSnapshot, perspective: string, projection: SessionSnapshot | undefined, selectedRoleId: string, controls: Omit<PanelContext, 'session' | 'selectedRole'>): PanelContext | undefined {
  const snapshot = currentReadingSnapshot(author, perspective, projection);
  if (!snapshot) return;
  const readOnly = controls.readOnly || perspective !== 'author';
  const rejectEdit = async () => { throw new Error('当前阅读视角的面板只读，请切回作者视角后修改。'); };
  return { ...controls, session: snapshot, selectedRole: snapshot.roles.find(role => role.id === selectedRoleId), readOnly,
    ...(perspective !== 'author' ? { editState: rejectEdit, editKnowledge: rejectEdit, setLifecycle: rejectEdit, chooseAction: undefined } : {}) };
}
export function App() {
  const [workspace, setWorkspace] = useState<
    "reader" | "creator" | "materials"
  >("reader");
  const [creatorOpened, setCreatorOpened] = useState(false);
  const [incomingCreatorSession, setIncomingCreatorSession] =
    useState<CreatorSession>();
  const [newCreatorRequest, setNewCreatorRequest] = useState(0);
  const [status, setStatus] = useState<AppStatus>();
  const [catalog, setCatalog] = useState<Catalog>({ cards: [], presets: [] });
  const [sessions, setSessions] = useState<SessionSnapshot[]>([]);
  const [session, setSession] = useState<SessionSnapshot>();
  const [readingChoice, setReadingChoice] = useState<{ sessionId: string; perspective: string }>();
  const [readingResult, setReadingResult] = useState<{ key: string; projection?: SessionSnapshot; error?: string }>();
  const [readingAttempt, setReadingAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [modal, setModal] = useState<"new" | "settings" | null>(null);
  const [panelsOpen, setPanelsOpen] = useState(false);
  const [focus, setFocus] = useState(false);
  const [theme, setTheme] = useState(storageRead("rp:theme") ?? "light");
  const [layout, setLayout] = useState<Layout>({});
  const [selectedRole, setSelectedRole] = useState("");
  const [cardId, setCardId] = useState("");
  const [storySelection, setStorySelection] = useState<NewStorySelection>({ cardId: "" });
  const [presetId, setPresetId] = useState("");
  const [creating, setCreating] = useState(false);
  const [modalError, setModalError] = useState("");
  const createInFlight = useRef(false);
  const [apiKey, setApiKey] = useState("");
  const [configuring, setConfiguring] = useState(false);
  const [suggestion, setSuggestion] = useState<{ id: string; sessionId: string; text: string }>();
  const selectedSession = useRef<string | undefined>(undefined);
  const loadSequence = useRef(0);
  const latestSnapshot = useRef<SessionSnapshot | undefined>(undefined);
  useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  const layoutKey = (id: string) => `rp:layout:v1:${id}`;
  function applySession(next: SessionSnapshot) {
    const latest = latestSnapshot.current;
    if (
      latest?.id === next.id &&
      (next.revision < latest.revision ||
        (next.revision === latest.revision &&
          next.updatedAt < latest.updatedAt))
    )
      return;
    latestSnapshot.current = next;
    if (selectedSession.current !== next.id) {
      setReadingChoice({ sessionId: next.id, perspective: 'author' });
      setLayout(restoreLayout(next.panels, storageRead(layoutKey(next.id))));
      setSelectedRole(next.playerRoleId);
      setFocus(false);
      selectedSession.current = next.id;
      storageWrite("rp:last-session", next.id);
    } else
      setLayout((previous) =>
        restoreLayout(next.panels, JSON.stringify(previous)),
      );
    setSession(next);
    setSessions((previous) =>
      recentSessions([next, ...previous.filter((item) => item.id !== next.id)]),
    );
  }
  async function initialLoad() {
    setLoading(true);
    setError("");
    const results = await Promise.allSettled([
      api.status(),
      api.catalog(),
      api.sessions(),
    ]);
    const [statusResult, catalogResult, sessionsResult] = results;
    if (statusResult.status === "fulfilled") setStatus(statusResult.value);
    if (catalogResult.status === "fulfilled") {
      setCatalog(catalogResult.value);
      selectCard(catalogResult.value.cards[0]?.id ?? "");
      setPresetId(catalogResult.value.presets[0]?.id ?? "");
    }
    if (sessionsResult.status === "fulfilled") {
      setSessions(recentSessions(sessionsResult.value));
      const next = initialSession(
        sessionsResult.value,
        storageRead("rp:last-session"),
      );
      if (next) applySession(next);
    }
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") setError(errorText(failure.reason));
    setLoading(false);
  }
  useEffect(() => {
    void initialLoad();
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    storageWrite("rp:theme", theme);
  }, [theme]);
  async function selectSession(id: string) {
    const sequence = ++loadSequence.current;
    setError("");
    try {
      const next = await api.session(id);
      if (sequence === loadSequence.current) applySession(next);
    } catch (e) {
      if (sequence === loadSequence.current) setError(errorText(e));
    }
  }
  async function refresh() {
    const id = selectedSession.current;
    if (!id) return;
    const next = await api.session(id);
    if (selectedSession.current === id) applySession(next);
  }
  const readingPerspective = session && readingChoice?.sessionId === session.id ? readingChoice.perspective : 'author';
  const readingKey = session ? readingProjectionKey(session, readingPerspective) : '';
  const readingProjection = readingResult?.key === readingKey ? readingResult.projection : undefined;
  const readingError = readingResult?.key === readingKey ? readingResult.error ?? '' : '';
  const readingSnapshot = session ? currentReadingSnapshot(session, readingPerspective, readingProjection) : undefined;
  useEffect(() => {
    if (!session || readingPerspective === 'author') return;
    const controller = new AbortController(), expected = session, key = readingKey;
    api.session(expected.id, readingPerspective, controller.signal).then(next => {
      if (controller.signal.aborted) return;
      if (next.id !== expected.id || next.perspective !== readingPerspective) {
        setReadingResult({ key, error: '角色投影的故事或视角不匹配，未展示该响应。' }); return;
      }
      if (!currentReadingSnapshot(expected, readingPerspective, next)) {
        setReadingResult({ key, error: '角色投影版本与当前会话不一致，正在核对；不会显示旧作者面板。' });
        if (next.revision > expected.revision || next.revision === expected.revision && next.updatedAt > expected.updatedAt) {
          void refresh().catch(error => { if (!controller.signal.aborted) setReadingResult({ key, error: `投影同步失败：${errorText(error)}` }); });
        }
        return;
      }
      setReadingResult({ key, projection: next });
    }).catch(error => { if (!controller.signal.aborted) setReadingResult({ key, error: errorText(error) }); });
    return () => controller.abort();
  }, [session?.id, session?.revision, session?.updatedAt, readingPerspective, readingAttempt]);
  function changeReadingPerspective(perspective: string) {
    if (!session) return;
    setReadingChoice({ sessionId: session.id, perspective });
    setReadingResult(undefined);
    if (perspective !== 'author') setSelectedRole(perspective);
  }
  const busy = session ? turnBusy(session) : false;
  useEffect(() => {
    if (!session?.id || !busy) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const id = session.id;
    async function poll() {
      try {
        const next = await api.session(id);
        if (active && selectedSession.current === id) {
          applySession(next);
          setError("");
        }
      } catch (e) {
        if (active) setError(`回合状态暂未同步：${errorText(e)}`);
      }
      if (active) timer = setTimeout(() => void poll(), 1400);
    }
    timer = setTimeout(() => void poll(), 900);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [session?.id, busy]);
  function changePlacement(id: string, patch: Partial<Layout[string]>) {
    if (!session) return;
    setLayout((previous) => {
      const next = { ...previous, [id]: { ...previous[id], ...patch } };
      storageWrite(layoutKey(session.id), JSON.stringify(next));
      return next;
    });
  }
  function selectCard(id: string) {
    setCardId(id);
    setStorySelection({ cardId: id });
    setModalError("");
  }
  async function create() {
    const body = newStoryRequest(selectedCard, presetId, storySelection);
    if (!body || createInFlight.current) return;
    createInFlight.current = true;
    setCreating(true);
    setModalError("");
    try {
      const next = await api.createSession(body);
      applySession(next);
      setModal(null);
    } catch (e) {
      setModalError(errorText(e));
    } finally {
      createInFlight.current = false;
      setCreating(false);
    }
  }
  async function configure() {
    setConfiguring(true);
    setModalError("");
    try {
      setStatus(await api.configure(apiKey));
      setApiKey("");
    } catch (e) {
      setModalError(errorText(e));
    } finally {
      setConfiguring(false);
    }
  }
  async function editState(body: EditState) {
    if (!session) return;
    const id = session.id;
    await api.editState(id, body);
    if (selectedSession.current === id) await refresh();
  }
  async function setLifecycle(body: SetLifecycle) {
    if (!session) return;
    const id = session.id;
    await api.lifecycle(id, body);
    if (selectedSession.current === id) await refresh();
  }
  async function editKnowledge(body: import("./api").EditKnowledgeRequest) {
    if (!session) return;
    const id = session.id;
    const next = await api.editKnowledge(id, body);
    if (selectedSession.current === id) applySession(next);
  }
  function openModal(value: typeof modal) {
    setModalError("");
    setApiKey("");
    setModal(value);
  }
  async function refreshCatalog() {
    setCatalog(await api.catalog());
  }
  async function editMaterial(document: NativeDocument) {
    const next = await creatorApi.create({
      kind: document.schema === "rp.card/0.1" ? "card" : "preset",
      sourceId: document.id,
      title: `${document.title} · 编辑`,
    });
    openCreatorSession(next);
  }
  function openCreatorSession(next: CreatorSession) {
    setIncomingCreatorSession(next);
    setCreatorOpened(true);
    setWorkspace("creator");
  }
  function newMaterial() {
    setCreatorOpened(true);
    setNewCreatorRequest((value) => value + 1);
    setWorkspace("creator");
  }
  function startMaterialStory(document: NativeDocument) {
    if (document.schema === "rp.card/0.1") selectCard(document.id);
    else setPresetId(document.id);
    setWorkspace("reader");
    openModal("new");
  }
  async function creatorPublished(_published: PublishedDocument) {
    setCatalog(await api.catalog());
  }
  function startPublishedStory(published: PublishedDocument) {
    if (published.kind === "card") selectCard(published.id);
    else setPresetId(published.id);
    void api
      .catalog()
      .then(setCatalog)
      .catch((e) => setError(errorText(e)));
    setWorkspace("reader");
    openModal("new");
  }
  const context = session
    ? readingPanelContext(session, readingPerspective, readingProjection, selectedRole, {
        catalog,
        selectRole: setSelectedRole,
        editState,
        editKnowledge,
        setLifecycle,
        refresh,
        readOnly: busy,
        chooseAction: (text: string) => {
          if (!busy) setSuggestion({ id: crypto.randomUUID(), sessionId: session.id, text });
        },
      })
    : undefined;
  const leftPanels =
    session?.panels.filter(
      (panel) =>
        !focus && layout[panel.id]?.open && layout[panel.id]?.side === "left",
    ) ?? [];
  const rightPanels =
    session?.panels.filter(
      (panel) =>
        !focus && layout[panel.id]?.open && layout[panel.id]?.side === "right",
    ) ?? [];
  const selectedCard = catalog.cards.find((card) => card.id === cardId);
  const resolvedStorySelection = selectedCard
    ? resolveNewStorySelection(selectedCard, storySelection)
    : undefined;
  const selectedPreset = catalog.presets.find(
    (preset) => preset.id === presetId,
  );
  return (
    <div className="app-shell">
      <header className="appbar">
        <div className="brand">
          <BookOpen size={21} />
          <span>
            Alirt<small>故事从这里继续</small>
          </span>
        </div>
        <nav aria-label="工作区工具">
          <button
            aria-label="阅读工作区"
            aria-pressed={workspace === "reader"}
            onClick={() => setWorkspace("reader")}
          >
            <BookOpen size={15} />
            <span>阅读</span>
          </button>
          <button
            aria-label="创作工坊"
            aria-pressed={workspace === "creator"}
            onClick={() => {
              setCreatorOpened(true);
              setWorkspace(workspace === "creator" ? "reader" : "creator");
            }}
          >
            <PenLine size={15} />
            <span>创作工坊</span>
          </button>
          <button
            aria-label="素材工作区"
            aria-pressed={workspace === "materials"}
            onClick={() => setWorkspace("materials")}
          >
            <LibraryBig size={15} />
            <span>素材库</span>
          </button>
          <button
            onClick={() => {
              setWorkspace("reader");
              openModal("new");
            }}
          >
            <Plus size={15} />
            <span>新故事</span>
          </button>
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label={theme === "dark" ? "切换浅色主题" : "切换深色主题"}
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button
            onClick={() => openModal("settings")}
            aria-label="API 与应用设置"
          >
            <Settings2 size={17} />
          </button>
        </nav>
      </header>
      <div className="reading-surface" hidden={workspace !== "reader"}>
        <div className="contextbar">
          <div className="context-info">
            {session ? (
              <>
                <select
                  aria-label="当前故事"
                  value={session.id}
                  title={sessionLabel(session)}
                  onChange={(e) => void selectSession(e.target.value)}
                >
                  {sessions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {sessionLabel(item)}
                    </option>
                  ))}
                </select>
                <span className="context-location">
                  {readingSnapshot ? `${readingSnapshot.world.location || '未知位置'} · ${readingSnapshot.world.time || '未知时间'}` : readingError ? '角色投影读取失败，未显示作者场景值' : '正在读取当前视角的场景…'}
                </span>
              </>
            ) : (
              <span>写下行动，让世界回应。</span>
            )}
          </div>
          <div className="actions">
            <button aria-pressed={focus} onClick={() => setFocus(!focus)}>
              <Maximize2 size={13} />
              {focus ? "恢复面板" : "专注阅读"}
            </button>
            <button
              aria-expanded={panelsOpen}
              onClick={() => setPanelsOpen(!panelsOpen)}
            >
              <PanelsTopLeft size={14} />
              面板
            </button>
          </div>
        </div>
        {panelsOpen && (
          <section className="panel-manager" aria-label="面板布局">
            <div className="row">
              <h2>这个故事的面板</h2>
              <button onClick={() => setPanelsOpen(false)}>收起</button>
            </div>
            <p className="fine">关闭与换侧仅改变界面，不会停止角色 Agent。</p>
            <div className="panel-manager-grid">
              {session?.panels.map((panel) => (
                <div className="panel-choice" key={panel.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={layout[panel.id]?.open ?? true}
                      onChange={(e) => {
                        changePlacement(panel.id, { open: e.target.checked });
                        if (e.target.checked) setFocus(false);
                      }}
                    />
                    {panel.title}
                  </label>
                  <select
                    aria-label={`${panel.title}停靠位置`}
                    value={layout[panel.id]?.side ?? panel.side}
                    onChange={(e) =>
                      changePlacement(panel.id, {
                        side: e.target.value as "left" | "right",
                      })
                    }
                  >
                    <option value="left">左侧</option>
                    <option value="right">右侧</option>
                  </select>
                </div>
              ))}
            </div>
            {!session && <p className="muted">创建故事后即可调整面板。</p>}
          </section>
        )}
        {error && (
          <div className="global-error" role="alert">
            {error}
            <button
              onClick={() =>
                void (session
                  ? refresh().catch((e) => setError(errorText(e)))
                  : initialLoad())
              }
            >
              重试同步
            </button>
          </div>
        )}
        {loading ? (
          <div className="welcome">
            <BookOpen size={28} />
            <p>正在打开工作区…</p>
          </div>
        ) : session ? (
          <div
            className={`workspace ${leftPanels.length ? "has-left" : ""} ${rightPanels.length ? "has-right" : ""}`}
          >
            <aside className="dock dock-left" aria-label="左侧面板">
              {context ? leftPanels.map((panel) => (
                <PanelHost
                  key={`${panel.id}:${readingPerspective}`}
                  panel={panel}
                  plugin={registry.find(panel.kind, panel.pluginId)}
                  context={context}
                  move={() => changePlacement(panel.id, { side: "right" })}
                  close={() => changePlacement(panel.id, { open: false })}
                />
              )) : leftPanels.length > 0 && <p className={readingError ? 'error' : 'muted'} role={readingError ? 'alert' : 'status'}>{readingError || '正在读取当前视角的面板…'}</p>}
            </aside>
            <Reader
              key={session.id}
              session={session}
              status={status}
              refresh={refresh}
              suggestion={suggestion}
              reading={{ perspective: readingPerspective, projection: readingProjection, error: readingError, changePerspective: changeReadingPerspective, retry: () => setReadingAttempt(value => value + 1) }}
            />
            <aside className="dock dock-right" aria-label="右侧面板">
              {context ? rightPanels.map((panel) => (
                <PanelHost
                  key={`${panel.id}:${readingPerspective}`}
                  panel={panel}
                  plugin={registry.find(panel.kind, panel.pluginId)}
                  context={context}
                  move={() => changePlacement(panel.id, { side: "left" })}
                  close={() => changePlacement(panel.id, { open: false })}
                />
              )) : rightPanels.length > 0 && <p className={readingError ? 'error' : 'muted'} role={readingError ? 'alert' : 'status'}>{readingError || '正在读取当前视角的面板…'}</p>}
            </aside>
          </div>
        ) : (
          <main className="welcome">
            <p className="eyebrow">ALIRT · A LITTLE ROLEPLAY TEST</p>
            <h1>
              留一盏灯，
              <br />
              等故事发生。
            </h1>
            <p>
              选择一张角色卡与创作预设，
              <br />
              从一段开篇进入共同的世界。
            </p>
            <button className="primary" onClick={() => openModal("new")}>
              <Plus size={16} />
              开始新故事
            </button>
            <button
              className="text-button"
              onClick={() => setWorkspace("materials")}
            >
              查看导入素材与兼容诊断
            </button>
          </main>
        )}
      </div>
      {creatorOpened && (
        <CreatorWorkspace
          visible={workspace === "creator"}
          catalog={catalog}
          configured={!!status?.configured}
          onExit={() => setWorkspace("reader")}
          onPublished={creatorPublished}
          onStartStory={startPublishedStory}
          incomingSession={incomingCreatorSession}
          newSessionRequest={newCreatorRequest}
        />
      )}
      <MaterialWorkspace
        visible={workspace === "materials"}
        catalog={catalog}
        loading={loading}
        onExit={() => setWorkspace("reader")}
        onRefresh={refreshCatalog}
        onEdit={editMaterial}
        onNewCreator={newMaterial}
        onStartStory={startMaterialStory}
        onCreatorSession={openCreatorSession}
      />
      <footer className="app-footer">
        <span
          className={`provider-indicator ${status?.configured ? "ready" : ""}`}
        >
          <i />
          {status
            ? `${status.provider} · ${status.model} · ${status.configured ? "API 已配置" : "未配置 API"}`
            : "API 状态未连接"}
        </span>
        <span>
          {session ? `世界版本 ${session.revision}` : "RP alpha"} ·{" "}
          {status?.runtime ?? "等待连接"}
        </span>
      </footer>
      {modal === "new" && (
        <Modal title="开始一个新故事" close={() => setModal(null)}>
          <p className="muted">
            角色卡提供世界与人物，预设决定创作方式。这里只配置新故事，进入后再继续创作。
          </p>
          <label>
            角色卡
            <select value={cardId} disabled={creating} onChange={(e) => selectCard(e.target.value)}>
              {catalog.cards.map((card) => (
                <option key={card.id} value={card.id}>
                  {card.title}
                </option>
              ))}
            </select>
          </label>
          {selectedCard && (
            <div className="selection-note">
              <h3>{selectedCard.title}</h3>
              <p>{selectedCard.description}</p>
              {!selectedCard.initialization && <span className="fine">
                {selectedCard.roles.length} 位角色 · 玩家控制：
                {
                  selectedCard.roles.find(
                    (role) => role.id === selectedCard.playerRoleId,
                  )?.name
                }
              </span>}
              {selectedCard.compatibility && (
                <p className="notice">
                  导入卡：{selectedCard.compatibility.status}
                  。请先在素材库检查兼容诊断。
                </p>
              )}
            </div>
          )}
          {selectedCard && resolvedStorySelection && (
            <NewStoryInitialization
              card={selectedCard}
              selection={resolvedStorySelection}
              onChange={setStorySelection}
              disabled={creating}
            />
          )}
          <label>
            创作预设
            <select
              value={presetId}
              disabled={creating}
              onChange={(e) => setPresetId(e.target.value)}
            >
              {catalog.presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.title}
                </option>
              ))}
            </select>
          </label>
          {selectedPreset && (
            <div className="selection-note">
              <p>{selectedPreset.description}</p>
            </div>
          )}
          {(!catalog.cards.length || !catalog.presets.length) && (
            <p className="notice">
              可用卡片或预设为空。请检查服务连接或从素材库导入。
            </p>
          )}
          {modalError && (
            <p className="error" role="alert">
              {modalError}
            </p>
          )}
          <button
            className="primary"
            onClick={() => void create()}
            disabled={creating || !newStoryRequest(selectedCard, presetId, storySelection)}
          >
            {creating ? "正在创建…" : "进入故事"}
            <ArrowIcon />
          </button>
        </Modal>
      )}
      {modal === "settings" && (
        <Modal
          title="应用设置"
          close={() => {
            setApiKey("");
            setModal(null);
          }}
        >
          <p className="eyebrow">模型连接</p>
          <p>
            {status?.provider ?? "未连接"} · {status?.model ?? "未知模型"}
          </p>
          <p className="muted">
            API key
            仅保存在服务当前进程的内存中；服务重启后清除，不写入浏览器存储。此设置供本地服务使用。
          </p>
          <label>
            API key
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              placeholder="输入新的 API key"
            />
          </label>
          <button
            disabled={!apiKey.trim() || configuring}
            onClick={() => void configure()}
          >
            {configuring ? "配置中…" : "在当前服务中使用"}
          </button>
          {status?.configured && (
            <p className="success">
              <Check size={14} />
              已配置；连通性以实际生成结果为准。
            </p>
          )}
          {modalError && (
            <p className="error" role="alert">
              {modalError}
            </p>
          )}
          <hr />
          <label>
            工作区主题
            <select value={theme} onChange={(e) => setTheme(e.target.value)}>
              <option value="light">浅色 · 纸与绿</option>
              <option value="dark">深色 · 夜读</option>
            </select>
          </label>
          <p className="fine">宿主控制全局主题。卡片扩展只在独立面板内呈现。</p>
        </Modal>
      )}
    </div>
  );
}
function ArrowIcon() {
  return <span aria-hidden="true">↗</span>;
}
