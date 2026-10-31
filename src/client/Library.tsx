import { useEffect, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { FrontendPreview } from "./FrontendPreview";
import type { ImportDetail, ImportSummary } from "../shared/types";
import { api, errorText, type FrontendAsset } from "./api";
import type { CreatorSession } from "../shared/creator";
import { creatorApi } from "./creator/api";
import { storageRead, storageWrite } from "./layout";
const dispositionLabels = {
  native: "已映射到原生模块",
  preserved: "保留原文",
  "needs-adapter": "需要适配",
  isolated: "已隔离",
};
export function Library({
  onImported,
  initialImportId,
  onCreatorSession,
}: {
  onImported: () => void;
  initialImportId?: string;
  onCreatorSession?: (session: CreatorSession) => void;
}) {
  const [assets, setAssets] = useState<FrontendAsset[]>([]);
  const [preview, setPreview] = useState("");
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [detail, setDetail] = useState<ImportDetail>();
  const [selected, setSelected] = useState(initialImportId ?? "");
  useEffect(() => {
    if (initialImportId) setSelected(initialImportId);
  }, [initialImportId]);
  const [moduleId, setModuleId] = useState("");
  const [busy, setBusy] = useState(false);
  const [converting, setConverting] = useState(false);
  const conversionRequests = useRef(new Map<string, string>());
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api
      .imports()
      .then((items) => {
        if (active) setImports(items);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    setDetail(undefined);
    setAssets([]);
    setPreview("");
    setError("");
    api
      .frontendAssets(selected)
      .then((items) => {
        if (active) setAssets(items);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    api
      .importDetail(selected)
      .then((item) => {
        if (active) {
          setDetail(item);
          setModuleId(item.modules[0]?.id ?? "");
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [selected]);
  async function upload(file: File) {
    setBusy(true);
    setError("");
    try {
      const item = await api.importFile(file);
      setImports(await api.imports());
      setSelected(item.id);
      setAssets(await api.frontendAssets(item.id));
      setDetail(item);
      setModuleId(item.modules[0]?.id ?? "");
      onImported();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function convert() {
    if (!detail || converting || !onCreatorSession) return;
    const key = `rp:conversion:pending:${detail.id}`;
    const requestId = conversionRequests.current.get(detail.id) || storageRead(key) || crypto.randomUUID();
    conversionRequests.current.set(detail.id, requestId);
    storageWrite(key, requestId);
    setConverting(true);
    setError("");
    try {
      const result = await creatorApi.convert(detail.id, { requestId });
      storageWrite(key, "");
      conversionRequests.current.delete(detail.id);
      onCreatorSession(result.session);
    } catch (e) { setError(errorText(e)); }
    finally { setConverting(false); }
  }
  const module = detail?.modules.find((item) => item.id === moduleId);
  return (
    <div className="library">
      <p className="muted">
        保留来源提示、关闭状态和前端材料，并分别标注目标转换情况。原文件中的启用开关不等于目标平台已经执行。
      </p>
      <label className="upload-button">
        <FileUp size={16} />
        {busy ? "正在读取与转换…" : "导入角色卡 / 预设"}
        <input
          type="file"
          accept=".json,.png,application/json,image/png"
          disabled={busy || converting}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
            e.target.value = "";
          }}
        />
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="library-grid">
        <div className="import-list" aria-label="导入文件">
          {imports.map((item) => (
            <button
              key={item.id}
              aria-pressed={item.id === selected}
              onClick={() => setSelected(item.id)}
            >
              <strong>{item.title}</strong>
              <small>
                {item.kind === "card" ? "角色卡" : "预设"} · {item.promptCount}{" "}
                个提示 · {item.frontendCount} 个前端材料
              </small>
              <small>{item.status}</small>
            </button>
          ))}
          {imports.length === 0 && <p className="muted">尚无已导入文件。</p>}
        </div>
        <div className="import-detail">
          {detail ? (
            <>
              <h3>{detail.title}</h3>
              {onCreatorSession && <div>
                <button disabled={busy || converting} onClick={() => void convert()}>{converting ? "建立转换草稿中…" : "建立语义转换草稿"}</button>
                <p className="fine">在创作工坊持续编辑转换草稿，核对原文覆盖与未适配材料后再发布。</p>
              </div>}
              <p className="fine">
                来源：{detail.sourceFile} · {detail.importedAt}
              </p>
              <div className="coverage">
                <strong>保留核验</strong>
                <span>
                  {detail.preservation.retainedPrompts} /{" "}
                  {detail.preservation.inputPrompts} 个来源提示
                </span>
                <span>
                  {detail.preservation.exactPromptTexts
                    ? "提示原文逐字保留"
                    : "原文存在差异，请检查诊断"}
                </span>
                <span>
                  新增提示字符：{detail.preservation.addedPromptCharacters}
                </span>
              </div>
              {detail.preservation.missingPointers.length > 0 && (
                <p className="error">
                  缺失位置：{detail.preservation.missingPointers.join("、")}
                </p>
              )}
              {detail.warnings.map((text, index) => (
                <p className="notice" key={index}>
                  {text}
                </p>
              ))}
              <label>
                选择来源模块
                <select
                  value={moduleId}
                  onChange={(e) => setModuleId(e.target.value)}
                >
                  {detail.modules.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title} · {dispositionLabels[item.disposition]}
                    </option>
                  ))}
                </select>
              </label>
              {assets.length > 0 && (
                <details className="frontend-previews">
                  <summary>来源界面 · {assets.length} 个材料</summary>
                  <p className="notice">
                    静态外观预览仅加载后端提供的隔离 HTML /
                    CSS。脚本、酒馆绑定与远程资源停用，不能视为行为等价迁移。
                  </p>
                  <label>
                    选择界面材料
                    <select
                      value={preview}
                      onChange={(e) => setPreview(e.target.value)}
                    >
                      <option value="">选择后预览</option>
                      {assets.map((asset, index) => (
                        <option key={asset.pointer} value={String(index)}>
                          {asset.kind} · {asset.pointer}
                        </option>
                      ))}
                    </select>
                  </label>
                  {preview !== "" && assets[Number(preview)] && (
                    <FrontendPreview asset={assets[Number(preview)]} />
                  )}
                </details>
              )}
              {module && (
                <>
                  <div className="module-meta">
                    <span>
                      来源开关：
                      {module.sourceEnabled === null
                        ? "未声明"
                        : module.sourceEnabled
                          ? "开启"
                          : "关闭"}
                    </span>
                    <span>
                      目标状态：{dispositionLabels[module.disposition]}
                    </span>
                    <span>类型：{module.kind}</span>
                  </div>
                  <p className="fine">来源路径：{module.pointer}</p>
                  {module.notes.map((note, index) => (
                    <p className="notice" key={index}>
                      {note}
                    </p>
                  ))}
                  <pre
                    className="source-text module-content"
                    tabIndex={0}
                    aria-label="完整来源模块内容"
                  >
                    {module.content}
                  </pre>
                  <p className="fine">
                    内容以纯文本展示。脚本、酒馆助手绑定及来源界面不因文本已保留而自动可用。
                  </p>
                </>
              )}
            </>
          ) : (
            <p className="empty-note">
              {selected
                ? "正在读取来源内容…"
                : "选择文件查看完整模块与转换覆盖。"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
