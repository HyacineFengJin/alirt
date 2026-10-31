import type { ConversionReport } from "../../server/compatibility";

export function ConversionReview({ report }: { report: ConversionReport }) {
  return <details className="creator-diagnostics" open={!report.readyForReview}>
    <summary>导入转换审阅 · {report.readyForReview ? "可审阅发布" : "需要修正"} · 版本 {report.revision}</summary>
    <p className="fine">来源：{report.conversion.importId}。原文保留核验通过后，仍需审阅原生行为；来源运行等价性尚未建立。</p>
    <p>来源字符串保留：{report.preservation.allSourceStringsRetained ? "完整" : "存在缺失"} · 原生提示副本：{report.preservation.nativePromptCopiesIntact ? "完整" : "已改动或缺失"} · 原始提示：{report.preservation.retainedOriginalPrompts} / {report.preservation.originalPrompts}</p>
    {!report.readyForReview && <p className="notice">发布前需修复提示保留或原生结构错误。可通过下方手动编辑，或向创作助手说明需要调整的原生结构。</p>}
    {report.diagnostics.length > 0 && <ul>{report.diagnostics.map((item, index) => <li key={`${item.code}:${index}`} className={item.severity === "error" ? "error" : "fine"}>{item.severity === "error" ? "错误" : "提示"} · {item.pointer && <code>{item.pointer} · </code>}{item.message}</li>)}</ul>}
    {report.nativeIssues.length > 0 && <ul>{report.nativeIssues.map((item, index) => <li key={index} className="error"><code>{item.path}</code> · {item.message}</li>)}</ul>}
    <details><summary>提示覆盖 · {report.coverage.length}</summary>{report.coverage.map((item, index) => <div key={`${item.pointer}:${index}`}>
      <p><code>{item.pointer}</code> · {item.characters} 字符 · {item.retainedExact ? "原文已保留" : "原文核验失败"} · {item.runtimeState === "bound" ? "已有原生绑定" : "仅保留来源"}</p>
      {item.nativeBindings.map((binding, i) => <p className="fine" key={`${binding.path}:${i}`}><code>{binding.path}</code> · {binding.sourceLinked ? "已关联来源" : "原文匹配"}</p>)}
    </div>)}</details>
    <details><summary>待适配与隔离材料 · {report.unsupported.length}</summary>{report.unsupported.map((item, index) => <p className="fine" key={`${item.pointer}:${index}`}><code>{item.pointer}</code> · {item.kind} · {item.reason}</p>)}</details>
    <p className="fine">来源脚本、正则与前端材料仅作保留材料；发布原生草稿不会启用这些来源行为。</p>
  </details>;
}
