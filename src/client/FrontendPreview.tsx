import { useState } from "react";
import type { FrontendAsset } from "./api";

export function FrontendPreview({ asset }: { asset: FrontendAsset }) {
  const [sourceOpen, setSourceOpen] = useState(false);
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'; form-action 'none'; base-uri 'none'">`;
  return (
    <div>
      <p className="fine">{asset.pointer}</p>
      {asset.missingApis.length > 0 && (
        <p className="notice">缺少接口：{asset.missingApis.join("、")}</p>
      )}
      {asset.remoteReferences.length > 0 && (
        <p className="notice">
          {asset.remoteReferences.length} 个外部引用在预览中阻断。
        </p>
      )}
      {asset.sourceText && (
        <details onToggle={(event) => setSourceOpen(event.currentTarget.open)}>
          <summary>
            来源界面完整材料{asset.sourceAdmitted === false ? " · 已隔离" : ""}
          </summary>
          {sourceOpen && (
            <pre className="source-text" tabIndex={0}>
              {asset.sourceText}
            </pre>
          )}
        </details>
      )}
      {asset.previewHtml && asset.sourceAdmitted !== false ? (
        <iframe
          title={`静态来源界面 ${asset.pointer}`}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={csp + asset.previewHtml}
          className="frontend-preview"
        />
      ) : (
        <p className="muted">
          此材料没有安全静态预览；完整来源已由导入服务保留。
        </p>
      )}
    </div>
  );
}
