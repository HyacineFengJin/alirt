import { useEffect, useState } from "react";
import type { ImportDetail } from "../../shared/types";
import { api, errorText, type FrontendAsset, type RuntimeConfiguration } from "../api";
import { FrontendPreview } from "../FrontendPreview";
import type { PanelContext } from "./registry";
import { NativeRuntimeControls } from "./NativeRuntimeControls";
import { WorldDataBrowser } from './WorldDataBrowser';

export function defaultAssetIndex(assets: FrontendAsset[]) {
  const admitted = assets.findIndex(
    (asset) => asset.sourceAdmitted !== false && !!asset.previewHtml,
  );
  return admitted >= 0 ? admitted : assets.length ? 0 : -1;
}
export function sourceEnabled(asset: FrontendAsset, detail?: ImportDetail) {
  return (
    asset.sourceEnabled ??
    detail?.modules.find((module) => module.pointer === asset.pointer)
      ?.sourceEnabled ??
    null
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** Origin association is display metadata only; never restore active prompt compatibility. */
export function sourceImportCandidates(
  card: unknown,
  variables: unknown,
): string[] {
  const metadata = record(card) ? card : {};
  const world = record(variables) ? variables : {};
  const retained = Object.entries(metadata)
    .filter(([key]) => /^sourceCompatibility(?:_[1-9]\d*)?$/.test(key))
    .map(([, value]) => (record(value) ? value.importId : undefined));
  const candidates = [
    record(metadata.compatibility)
      ? metadata.compatibility.importId
      : undefined,
    world.sourceImportId,
    ...retained,
  ];
  return [
    ...new Set(
      candidates.filter(
        (value): value is string =>
          typeof value === "string" &&
          /^[a-z][a-z0-9-]{0,63}-[a-f0-9]{12}$/.test(value),
      ),
    ),
  ];
}
export function resolveSourceImportId(
  card: unknown,
  variables: unknown,
  existingIds: ReadonlySet<string>,
): string | undefined {
  return sourceImportCandidates(card, variables).find((id) =>
    existingIds.has(id),
  );
}
const enabledLabel = (value: boolean | null) =>
  value === null ? "未声明" : value ? "开启" : "关闭";

/** Mounted only while this session's source panel is open. No imported code enters the host DOM. */
export function ImportedSource(context: PanelContext) {
  return context.session.perspective === 'author' ? <AuthorImportedSource key={context.session.id} {...context} /> : <p className="muted">来源检查与运行配置仅供作者使用；当前视角不读取作者工具或来源档案。</p>;
}
function AuthorImportedSource(context: PanelContext) {
  const { session, catalog } = context;
  const [bound, setBound] = useState<{ sessionId: string; runtime: RuntimeConfiguration }>();
  const [source, setSource] = useState<'card' | 'preset'>('card');
  useEffect(() => {
    const controller = new AbortController();
    api.runtime(session.id, controller.signal).then(value => { if (!controller.signal.aborted) setBound({ sessionId: session.id, runtime: value }); }).catch(() => { /* Source inspection can still fall back to catalog metadata. */ });
    return () => controller.abort();
  }, [session.id, session.revision]);
  const currentRuntime = bound?.sessionId === session.id ? bound.runtime : undefined;
  const card = currentRuntime?.card ?? catalog.cards.find((item) => item.id === session.cardId);
  const preset = currentRuntime?.preset ?? catalog.presets.find((item) => item.id === session.presetId);
  const document = source === 'card' ? card : preset;
  const variables = source === 'card' ? session.world.variables : undefined;
  const candidates = sourceImportCandidates(document, variables);
  const candidateKey = JSON.stringify(candidates);
  const [importId, setImportId] = useState<string>();
  const [missingSource, setMissingSource] = useState(false);
  const [assets, setAssets] = useState<FrontendAsset[]>([]);
  const [detail, setDetail] = useState<ImportDetail>();
  const [selected, setSelected] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setImportId(undefined);
    setMissingSource(false);
    setError("");
    setAssets([]);
    setDetail(undefined);
    setSelected(-1);
    if (!candidates.length) {
      setLoading(false);
      return;
    }
    setLoading(true);
    async function load() {
      try {
        const imports = await api.imports();
        if (!active) return;
        const verified = resolveSourceImportId(
          document,
          variables,
          new Set(imports.map((item) => item.id)),
        );
        if (!verified) {
          setMissingSource(true);
          return;
        }
        setImportId(verified);
        const [frontend, source] = await Promise.allSettled([
          api.frontendAssets(verified),
          api.importDetail(verified),
        ]);
        if (!active) return;
        if (frontend.status === "fulfilled") {
          setAssets(frontend.value);
          setSelected(defaultAssetIndex(frontend.value));
        } else setError(errorText(frontend.reason));
        if (source.status === "fulfilled") setDetail(source.value);
        else setError(errorText(source.reason));
      } catch (e) {
        if (active) setError(errorText(e));
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [candidateKey, attempt]);
  const asset = assets[selected];
  return (
    <>
      <p className="eyebrow">原生运行与来源界面</p>
      <NativeRuntimeControls {...context} />
      <WorldDataBrowser {...context} />
      <label>来源文件<select aria-label="兼容来源文件" value={source} onChange={event => setSource(event.target.value as 'card' | 'preset')}><option value="card">角色卡 · {card?.title ?? session.title}</option><option value="preset">预设 · {preset?.title ?? session.presetId}</option></select></label>
      <p className="fine">{document?.description ?? session.title}</p>
      {loading && <p className="muted">正在读取来源界面…</p>}
      {error && (
        <div role="alert">
          <p className="error">{error}</p>
          <button onClick={() => setAttempt((value) => value + 1)}>
            重试来源读取
          </button>
        </div>
      )}
      {importId ? (
        <>
          {detail?.runtime && <details className="native-pack-report"><summary>原生适配基线 · {detail.runtime.adapter}</summary>
            <p className="fine">可选开场 {detail.runtime.counts.openings} · 角色 {detail.runtime.counts.roles} · 章节 {detail.runtime.counts.chapters} · 附加输出 {detail.runtime.counts.outputs}。当前故事的开关见运行设置。</p>
            {detail.runtime.features.map(feature => <section key={feature.id}><h3>{feature.title} · {{ available: '已接通', partial: '部分接通', unavailable: '未接通' }[feature.status]}</h3><p className="fine">{feature.detail}</p><p className="fine">入口：{feature.entry}</p></section>)}
            <details><summary>当前限制</summary><ul>{detail.runtime.limitations.map((limitation, index) => <li className="fine" key={index}>{limitation}</li>)}</ul></details>
          </details>}
          <p className="notice">
            保留来源 HTML / CSS
            外观，在隔离框架中只读显示。原脚本、酒馆绑定、变量回写和远程资源尚未接通；不代表原界面功能已迁移。
          </p>
          {document?.compatibility ? (
            <p className="fine">转换状态：{document.compatibility.status}</p>
          ) : (
            <p className="fine">
              独立原生草稿保留的来源界面：{importId}
              。当前卡片仍使用编辑后的原生提示。
            </p>
          )}
          {assets.length > 0 && (
            <label>
              来源界面材料
              <select
                aria-label="停靠面板来源界面"
                value={selected}
                onChange={(event) => setSelected(Number(event.target.value))}
              >
                {assets.map((item, index) => (
                  <option key={`${item.pointer}:${index}`} value={index}>
                    {item.kind} · {enabledLabel(sourceEnabled(item, detail))} ·{" "}
                    {item.previewHtml && item.sourceAdmitted !== false
                      ? "静态预览"
                      : item.sourceAdmitted === false
                        ? "隔离"
                        : "仅材料"}{" "}
                    · {item.pointer}
                  </option>
                ))}
              </select>
            </label>
          )}
          {asset && (
            <div className="docked-source-preview">
              <p className="fine">
                来源开关：{enabledLabel(sourceEnabled(asset, detail))} ·
                目标状态：
                {asset.previewHtml && asset.sourceAdmitted !== false
                  ? "只读静态预览"
                  : "待适配 / 隔离"}
              </p>
              {sourceEnabled(asset, detail) === false && (
                <p className="notice">
                  该材料在来源中关闭。这里仅供检查，不会启用其原脚本。
                </p>
              )}
              <FrontendPreview key={asset.pointer} asset={asset} />
            </div>
          )}
          {!loading && !error && assets.length === 0 && (
            <p className="muted">
              此导入卡没有可用前端材料；提示与模块仍可在素材库查看。
            </p>
          )}
        </>
      ) : !loading && !error ? (
        <p className="muted">
          {missingSource
            ? "关联的原始导入材料当前不存在；编辑后的原生内容仍可使用。"
            : "这是原生卡片，没有来源前端材料。"}
        </p>
      ) : null}
    </>
  );
}
