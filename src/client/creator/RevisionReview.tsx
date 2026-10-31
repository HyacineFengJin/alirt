import { useMemo, useState } from "react";
import type { CreatorSession } from "../../shared/creator";
import { documentChanges } from "./state";
const origins = {
  seed: "起始草稿",
  user: "手动编辑",
  agent: "AI 编辑",
  restore: "恢复版本",
};
export function RevisionReview({
  session,
  disabled,
  restore,
}: {
  session: CreatorSession;
  disabled: boolean;
  restore: (revision: number) => Promise<void>;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const revision =
    session.revisions.find((item) => item.revision === selected) ??
    session.revisions.at(-2) ??
    session.revisions[0];
  const changes = useMemo(
    () =>
      revision ? documentChanges(revision.document, session.document) : [],
    [revision, session.document],
  );
  return (
    <section className="creator-revisions">
      <h3>版本记录</h3>
      <p className="fine">
        选择历史版本与当前草稿逐项比较。恢复会另存为新版本。
      </p>
      <label>
        比较基准
        <select
          value={revision?.revision ?? ""}
          onChange={(event) => setSelected(Number(event.target.value))}
        >
          {[...session.revisions].reverse().map((item) => (
            <option key={item.revision} value={item.revision}>
              版本 {item.revision} · {origins[item.origin]} · {item.summary}
            </option>
          ))}
        </select>
      </label>
      {revision && (
        <>
          <p className="fine">
            {revision.at} · {revision.summary}
          </p>
          <div className="row">
            <p>
              版本 {revision.revision} → 当前版本 {session.revision}
            </p>
            <button
              disabled={disabled || revision.revision === session.revision}
              onClick={() => void restore(revision.revision)}
            >
              恢复为新版本
            </button>
          </div>
          {changes.length ? (
            <div className="creator-change-list">
              {changes.map((change) => (
                <details key={change.path}>
                  <summary>
                    {change.path}
                    <span>
                      {change.before === undefined
                        ? "新增"
                        : change.after === undefined
                          ? "移除"
                          : "修改"}
                    </span>
                  </summary>
                  <div className="creator-comparison">
                    <div>
                      <h4>历史版本 {revision.revision}</h4>
                      <pre>{change.before ?? "（不存在）"}</pre>
                    </div>
                    <div>
                      <h4>当前版本 {session.revision}</h4>
                      <pre>{change.after ?? "（不存在）"}</pre>
                    </div>
                  </div>
                </details>
              ))}
            </div>
          ) : (
            <p className="muted">所选版本与当前草稿内容相同。</p>
          )}
        </>
      )}
    </section>
  );
}
