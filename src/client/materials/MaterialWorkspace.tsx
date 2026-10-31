import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Download,
  FilePenLine,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { CreativeKind, CreatorSession, NativeDocument } from "../../shared/creator";
import type { Catalog } from "../../shared/types";
import { DraftPreview } from "../creator/DraftPreview";
import { exportDraft } from "../creator/state";
import { errorText } from "../api";
import { Library } from "../Library";
import { sourceImportCandidates } from "../plugins/ImportedSource";
import "./materials.css";
function kindOf(document: NativeDocument): CreativeKind {
  return document.schema === "rp.card/0.1" ? "card" : "preset";
}
function origin(document: NativeDocument) {
  return document.id.startsWith("created-")
    ? "工坊发布"
    : document.compatibility ||
        /^(?:nativecard|nativepreset|generic)-[a-f0-9]{12}$/.test(
          document.id,
        )
      ? "导入素材"
      : "原生素材";
}
export function MaterialWorkspace({
  visible,
  catalog,
  loading,
  onExit,
  onRefresh,
  onEdit,
  onNewCreator,
  onStartStory,
  onCreatorSession,
}: {
  visible: boolean;
  catalog: Catalog;
  loading: boolean;
  onExit: () => void;
  onRefresh: () => Promise<void>;
  onEdit: (document: NativeDocument) => Promise<void>;
  onNewCreator: () => void;
  onStartStory: (document: NativeDocument) => void;
  onCreatorSession: (session: CreatorSession) => void;
}) {
  const [tab, setTab] = useState<"catalog" | "sources">("catalog");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | CreativeKind>("all");
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sourceId, setSourceId] = useState("");
  const all = useMemo(() => [...catalog.cards, ...catalog.presets], [catalog]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return all.filter(
      (document) =>
        (kind === "all" || kindOf(document) === kind) &&
        (!normalized ||
          JSON.stringify(document).toLocaleLowerCase().includes(normalized)),
    );
  }, [all, kind, query]);
  const selected =
    filtered.find((document) => document.id === selectedId) ?? filtered[0];
  async function edit(document: NativeDocument) {
    setBusy(true);
    setError("");
    try {
      await onEdit(document);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      await onRefresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function viewSource(document: NativeDocument) {
    const ids = sourceImportCandidates(
      document,
      document.schema === "rp.card/0.1" ? document.world.variables : {},
    );
    setSourceId(ids[0] ?? "");
    setTab("sources");
  }
  return (
    <section
      className="material-surface"
      hidden={!visible}
      aria-label="素材工作区"
    >
      <header className="material-head">
        <div>
          <p className="eyebrow">MATERIAL WORKSPACE</p>
          <h1>素材库</h1>
          <p className="fine">
            管理角色卡与预设，查看完整内容，创建独立编辑草稿，或用于新故事。
          </p>
        </div>
        <div className="actions">
          <button onClick={onNewCreator}>
            <Plus size={14} />
            新建素材
          </button>
          <button onClick={onExit}>
            <ArrowLeft size={14} />
            返回阅读
          </button>
        </div>
      </header>
      <div className="material-tabs" role="group" aria-label="素材库分区">
        <button
          aria-pressed={tab === "catalog"}
          onClick={() => setTab("catalog")}
        >
          全部素材 · {all.length}
        </button>
        <button
          aria-pressed={tab === "sources"}
          onClick={() => setTab("sources")}
        >
          导入与来源诊断
        </button>
        <button disabled={busy || loading} onClick={() => void refresh()}>
          <RefreshCw size={13} />
          刷新目录
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {tab === "sources" ? (
        <div className="material-sources">
          <Library
            onCreatorSession={onCreatorSession}
            initialImportId={sourceId || undefined}
            onImported={() => {
              void onRefresh().catch((e) => setError(errorText(e)));
            }}
          />
        </div>
      ) : (
        <div className="material-layout">
          <aside className="material-browser" aria-label="素材目录">
            <label>
              搜索素材
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="标题、人物、模块或完整正文"
              />
            </label>
            <label>
              素材类型
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as typeof kind)}
              >
                <option value="all">角色卡与预设</option>
                <option value="card">角色卡</option>
                <option value="preset">创作预设</option>
              </select>
            </label>
            <p className="fine">
              {loading
                ? "正在读取目录…"
                : `${filtered.length} / ${all.length} 份素材`}
            </p>
            <div className="material-choices">
              {filtered.map((document) => (
                <button
                  key={`${document.schema}:${document.id}`}
                  aria-pressed={selected?.id === document.id}
                  onClick={() => setSelectedId(document.id)}
                >
                  <strong>{document.title || "未命名素材"}</strong>
                  <small>
                    {kindOf(document) === "card" ? "角色卡" : "预设"} ·{" "}
                    {origin(document)} · {document.modules.length} 个模块
                  </small>
                  <small>{document.id}</small>
                </button>
              ))}
            </div>
            {!loading && !filtered.length && (
              <p className="muted">
                没有匹配的素材。可以调整搜索、导入原文件，或新建一份。
              </p>
            )}
          </aside>
          <section className="material-detail" aria-label="所选素材详情">
            {selected ? (
              <>
                <header className="material-detail-head">
                  <div>
                    <p className="eyebrow">
                      {origin(selected)} ·{" "}
                      {kindOf(selected) === "card" ? "角色卡" : "创作预设"}
                    </p>
                    <p className="fine">{selected.id}</p>
                  </div>
                  <div className="actions">
                    <button onClick={() => exportDraft(selected)}>
                      <Download size={13} />
                      导出原生 JSON
                    </button>
                    <button disabled={busy} onClick={() => void edit(selected)}>
                      <FilePenLine size={13} />
                      {busy ? "建立草稿中…" : "编辑 / 与 AI 续写"}
                    </button>
                    <button
                      className="primary"
                      onClick={() => onStartStory(selected)}
                    >
                      用于新故事 ↗
                    </button>
                  </div>
                </header>
                <p className="notice">
                  编辑会建立独立的持久创作会话；发布新素材后再选择使用。既有素材与正在进行的故事不会被直接修改。
                </p>
                {sourceImportCandidates(
                  selected,
                  selected.schema === "rp.card/0.1"
                    ? selected.world.variables
                    : {},
                ).length > 0 && (
                  <button
                    className="text-button"
                    onClick={() => viewSource(selected)}
                  >
                    查看这份素材的原始模块与前端兼容诊断
                  </button>
                )}
                <DraftPreview document={selected} />
              </>
            ) : (
              <div className="material-empty">
                <p>
                  {loading
                    ? "正在读取素材…"
                    : "选择一份素材，查看人物、模块与声明字段。"}
                </p>
                <button onClick={onNewCreator}>新建创作会话</button>
              </div>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
