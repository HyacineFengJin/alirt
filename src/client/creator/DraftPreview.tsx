import { useState } from "react";
import type { NativeDocument } from "../../shared/creator";
import type { CharacterCard, PromptModule } from "../../shared/types";
const categoryLabels = {
  model: "模型适配",
  style: "文风",
  constraint: "约束",
  supplement: "补充资料",
  protocol: "输出协议",
};
function Text({ children }: { children: string }) {
  return <p className="creator-full-text">{children || "（空）"}</p>;
}
function Module({ module }: { module: PromptModule }) {
  return (
    <details className="creator-module">
      <summary>
        {module.title}
        <span>
          {categoryLabels[module.category]} · {module.enabled ? "启用" : "关闭"}
        </span>
      </summary>
      <p className="fine">
        {module.id} · {module.phase} · {module.targets.join(" / ")} · 优先级{" "}
        {module.priority}
      </p>
      <Text>{module.content}</Text>
      {module.condition && (
        <details>
          <summary>启用条件</summary>
          <pre className="source-text">
            {JSON.stringify(module.condition, null, 2)}
          </pre>
        </details>
      )}
    </details>
  );
}
export function DraftPreview({ document }: { document: NativeDocument }) {
  const [moduleQuery, setModuleQuery] = useState("");
  const visibleModules = document.modules.filter((module) =>
    `${module.title}\n${module.id}\n${module.content}`
      .toLocaleLowerCase()
      .includes(moduleQuery.toLocaleLowerCase()),
  );
  const card =
    document.schema === "rp.card/0.1" ? (document as CharacterCard) : undefined;
  return (
    <div className="creator-draft-content">
      <p className="eyebrow">{card ? "角色卡" : "创作预设"} · 原生草稿</p>
      <h2>{document.title || "尚未命名"}</h2>
      <Text>{document.description}</Text>
      {document.compatibility && (
        <p className="notice">
          来源适配：{document.compatibility.status}
          。这里只编辑来源的可支持原生子集，原始包与未适配脚本仍独立保留。
          {document.compatibility.warnings.join("；")}
        </p>
      )}
      {card ? (
        <>
          <section>
            <h3>开篇</h3>
            <Text>{card.opening}</Text>
          </section>
          <section>
            <h3>世界与玩家</h3>
            <p>
              {card.world.location} · {card.world.time}
            </p>
            <p className="fine">
              玩家控制：
              {card.roles.find((role) => role.id === card.playerRoleId)?.name ??
                card.playerRoleId}
            </p>
            <details>
              <summary>世界变量</summary>
              <pre className="source-text">
                {JSON.stringify(card.world.variables, null, 2)}
              </pre>
            </details>
          </section>
          <section>
            <h3>角色 · {card.roles.length}</h3>
            {card.roles.map((role) => (
              <details className="creator-role" key={role.id}>
                <summary>
                  {role.name}
                  <span>
                    {role.phase} · {role.presence}
                  </span>
                </summary>
                <Text>{role.persona}</Text>
                <h4>目标</h4>
                <ul>
                  {role.goals.map((goal, index) => (
                    <li key={index}>{goal}</li>
                  ))}
                </ul>
                <p className="fine">
                  关联角色：
                  {role.peers
                    .map(
                      (id) =>
                        card.roles.find((item) => item.id === id)?.name ?? id,
                    )
                    .join("、") || "无"}
                </p>
                <details>
                  <summary>状态</summary>
                  <pre className="source-text">
                    {JSON.stringify(role.state, null, 2)}
                  </pre>
                </details>
                {role.knowledge.length > 0 && (
                  <details>
                    <summary>知识与读者 · {role.knowledge.length}</summary>
                    {role.knowledge.map((item) => (
                      <div key={item.id}>
                        <Text>{item.text}</Text>
                        <p className="fine">
                          {item.status} · 读者{" "}
                          {typeof item.audience === "string"
                            ? item.audience
                            : item.audience.join(" / ")}
                        </p>
                      </div>
                    ))}
                  </details>
                )}
              </details>
            ))}
          </section>
          <details>
            <summary>状态字段 · {card.fields.length}</summary>
            {card.fields.map((field) => (
              <p key={field.key}>
                {field.label} · {field.type} ·{" "}
                {field.editable ? "允许作者修正" : "只读"}
                <small className="block fine">
                  {field.key}
                  {field.min !== undefined ? ` · 下限 ${field.min}` : ""}
                  {field.max !== undefined ? ` · 上限 ${field.max}` : ""}
                </small>
              </p>
            ))}
          </details>
          <details>
            <summary>停靠面板 · {card.panels.length}</summary>
            {card.panels.map((panel) => (
              <p key={panel.id}>
                {panel.title} · {panel.kind} ·{" "}
                {panel.side === "left" ? "左侧" : "右侧"}
              </p>
            ))}
          </details>
          {card.stateRules?.length ? (
            <details>
              <summary>世界约束</summary>
              <pre className="source-text">
                {JSON.stringify(card.stateRules, null, 2)}
              </pre>
            </details>
          ) : null}
        </>
      ) : (
        <section>
          <h3>叙述策略</h3>
          <p className="fine">
            人称：
            {document.schema === "rp.preset/0.1"
              ? document.narration.person
              : ""}{" "}
            · 视角：
            {document.schema === "rp.preset/0.1" ? document.narration.pov : ""}
          </p>
        </section>
      )}
      <section>
        <h3>提示模块 · {document.modules.length}</h3>
        <label>
          查找提示模块
          <input
            type="search"
            value={moduleQuery}
            onChange={(event) => setModuleQuery(event.target.value)}
            placeholder="模块名称、ID 或完整内容"
          />
        </label>
        <p className="fine">
          显示 {visibleModules.length} / {document.modules.length}
        </p>
        {visibleModules.map((module) => (
          <Module key={module.id} module={module} />
        ))}
        {!document.modules.length && (
          <p className="muted">
            尚无模块。可以告诉创作助手需要的文风、约束与设定。
          </p>
        )}
      </section>
    </div>
  );
}
