import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { NativeDocument } from "../../shared/creator";
import type { AgentKind, PromptModule, RolePhase } from "../../shared/types";
import {
  addModule,
  linkedRoleNames,
  moveModule,
  orderModulePriorities,
  removeModule,
  roleModules,
  updateDocumentField,
  updateModule,
  updateRole,
  updateWorldField,
} from "./structured";
const categories = {
  model: "模型适配",
  style: "文风",
  constraint: "约束",
  supplement: "补充资料",
  protocol: "输出协议",
};
const phases = {
  decide: "角色决策前",
  coordinate: "世界协调前",
  compose: "成文前",
};
const rolePhases: Record<RolePhase, string> = {
  active: "活跃",
  dormant: "休眠",
  faded: "淡出",
  retired: "退场",
};
const consumers: Record<AgentKind, string> = {
  role: "角色",
  world: "世界",
  prose: "成文",
};
function ModuleForm({
  document,
  module,
  index,
  disabled,
  change,
}: {
  document: NativeDocument;
  module: PromptModule;
  index: number;
  disabled: boolean;
  change: (value: NativeDocument) => void;
}) {
  const [open, setOpen] = useState(false);
  const [priorityDraft, setPriorityDraft] = useState(String(module.priority));
  useEffect(() => setPriorityDraft(String(module.priority)), [module.priority]);
  const linked = linkedRoleNames(document, module);
  const patch = (value: Partial<PromptModule>) =>
    change(updateModule(document, module.id, value));
  return (
    <details
      className="structured-module"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <strong>{module.title || "未命名模块"}</strong>
        <span>
          {categories[module.category]} · {module.enabled ? "启用" : "关闭"} ·
          优先级 {module.priority}
        </span>
      </summary>
      {open && (
        <fieldset disabled={disabled}>
          <div className="row">
            <span className="fine">稳定 ID：{module.id}</span>
            <div className="actions">
              <button
                type="button"
                disabled={index === 0 || disabled}
                onClick={() => change(moveModule(document, module.id, -1))}
                aria-label={`上移模块 ${module.title || module.id}`}
              >
                <ArrowUp size={13} />
              </button>
              <button
                type="button"
                disabled={index === document.modules.length - 1 || disabled}
                onClick={() => change(moveModule(document, module.id, 1))}
                aria-label={`下移模块 ${module.title || module.id}`}
              >
                <ArrowDown size={13} />
              </button>
              <button
                type="button"
                onClick={() => change(removeModule(document, module.id))}
              >
                <Trash2 size={13} />
                移除模块
              </button>
            </div>
          </div>
          <label>
            模块名称
            <input
              value={module.title}
              onChange={(event) => patch({ title: event.target.value })}
            />
          </label>
          <div className="structured-grid">
            <label>
              分区
              <select
                value={module.category}
                onChange={(event) =>
                  patch({
                    category: event.target.value as PromptModule["category"],
                  })
                }
              >
                {Object.entries(categories).map(([value, title]) => (
                  <option key={value} value={value}>
                    {title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              生效阶段
              <select
                value={module.phase}
                onChange={(event) =>
                  patch({ phase: event.target.value as PromptModule["phase"] })
                }
              >
                {Object.entries(phases).map(([value, title]) => (
                  <option key={value} value={value}>
                    {title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              优先级
              <input
                type="number"
                value={priorityDraft}
                onChange={(event) => setPriorityDraft(event.target.value)}
                onBlur={() => {
                  const value = Number(priorityDraft);
                  if (priorityDraft.trim() && Number.isFinite(value))
                    patch({ priority: value });
                  else setPriorityDraft(String(module.priority));
                }}
              />
            </label>
          </div>
          <label className="structured-check">
            <input
              type="checkbox"
              checked={module.enabled}
              onChange={(event) => patch({ enabled: event.target.checked })}
            />
            启用此模块
          </label>
          <div className="structured-targets">
            <span>消费者</span>
            {(Object.keys(consumers) as AgentKind[]).map((kind) => (
              <label key={kind} className="structured-check">
                <input
                  type="checkbox"
                  checked={module.targets.includes(kind)}
                  onChange={(event) =>
                    patch({
                      targets: event.target.checked
                        ? [...module.targets, kind]
                        : module.targets.filter((item) => item !== kind),
                    })
                  }
                />
                {consumers[kind]}
              </label>
            ))}
          </div>
          {linked.length > 0 && (
            <p className="notice">
              此原文与角色「{linked.join("、")}
              」的人物设定关联。在此编辑正文会同时更新角色设定及同源副本；编辑角色设定也会同步到这里。
            </p>
          )}
          <label>
            完整提示正文
            <textarea
              value={module.content}
              onChange={(event) => patch({ content: event.target.value })}
              rows={9}
            />
          </label>
          <label className="structured-check">
            <input
              type="checkbox"
              checked={!!module.activation}
              onChange={(event) =>
                patch({
                  activation: event.target.checked ? { keys: [] } : undefined,
                })
              }
            />
            按关键词选入
          </label>
          {module.activation && (
            <div className="structured-activation">
              <label>
                主要关键词（每行一个）
                <textarea
                  value={module.activation.keys.join("\n")}
                  rows={3}
                  onChange={(event) =>
                    patch({
                      activation: {
                        ...module.activation!,
                        keys: event.target.value.split("\n"),
                      },
                    })
                  }
                />
              </label>
              <label className="structured-check">
                <input
                  type="checkbox"
                  checked={!!module.activation.selective}
                  onChange={(event) =>
                    patch({
                      activation: {
                        ...module.activation!,
                        selective: event.target.checked,
                      },
                    })
                  }
                />
                同时要求次要关键词
              </label>
              <label>
                次要关键词（每行一个）
                <textarea
                  value={(module.activation.secondaryKeys ?? []).join("\n")}
                  rows={3}
                  onChange={(event) =>
                    patch({
                      activation: {
                        ...module.activation!,
                        secondaryKeys: event.target.value.split("\n"),
                      },
                    })
                  }
                />
              </label>
              <p className="fine">
                空关键词不会触发。关键词与已有状态条件分别保留；复杂来源机制仍可能需要适配。
              </p>
            </div>
          )}
          {module.condition && (
            <details>
              <summary>已有状态条件（高级 JSON 中可编辑）</summary>
              <pre className="source-text">
                {JSON.stringify(module.condition, null, 2)}
              </pre>
            </details>
          )}
        </fieldset>
      )}
    </details>
  );
}
export function StructuredEditor({
  document,
  disabled,
  change,
}: {
  document: NativeDocument;
  disabled: boolean;
  change: (value: NativeDocument) => void;
}) {
  const [moduleQuery, setModuleQuery] = useState("");
  const card = document.schema === "rp.card/0.1" ? document : undefined;
  const modules = document.modules.filter((module) =>
    `${module.title}\n${module.id}\n${module.content}`
      .toLocaleLowerCase()
      .includes(moduleQuery.toLocaleLowerCase()),
  );
  return (
    <section className="structured-editor" aria-label="结构化编辑">
      <p className="fine">
        修改会先保留在当前编辑草稿，填写修改说明后保存为新版本。未显示的字段与来源元数据保持原样。
      </p>
      <fieldset disabled={disabled}>
        <h3>基本信息</h3>
        <label>
          素材标题
          <input
            value={document.title}
            onChange={(event) =>
              change(updateDocumentField(document, "title", event.target.value))
            }
          />
        </label>
        <label>
          素材说明
          <textarea
            value={document.description}
            onChange={(event) =>
              change(
                updateDocumentField(
                  document,
                  "description",
                  event.target.value,
                ),
              )
            }
            rows={3}
          />
        </label>
        {card ? (
          <>
            <label>
              开篇正文
              <textarea
                value={card.opening}
                onChange={(event) =>
                  change(
                    updateDocumentField(
                      document,
                      "opening",
                      event.target.value,
                    ),
                  )
                }
                rows={7}
              />
            </label>
            <div className="structured-grid">
              <label>
                世界地点
                <input
                  value={card.world.location}
                  onChange={(event) =>
                    change(
                      updateWorldField(
                        document,
                        "location",
                        event.target.value,
                      ),
                    )
                  }
                />
              </label>
              <label>
                世界时间
                <input
                  value={card.world.time}
                  onChange={(event) =>
                    change(
                      updateWorldField(document, "time", event.target.value),
                    )
                  }
                />
              </label>
            </div>
            <h3>角色 · {card.roles.length}</h3>
            {card.roles.map((role) => (
              <details className="structured-role" key={role.id}>
                <summary>
                  {role.name || "未命名角色"}
                  <span>
                    {role.id === card.playerRoleId ? "玩家控制 · " : ""}
                    {rolePhases[role.phase]} ·{" "}
                    {role.presence === "present" ? "在场" : "离场"}
                  </span>
                </summary>
                <label>
                  角色姓名
                  <input
                    value={role.name}
                    onChange={(event) =>
                      change(
                        updateRole(document, role.id, {
                          name: event.target.value,
                        }),
                      )
                    }
                  />
                </label>
                {roleModules(card, role).length > 0 && (
                  <p className="notice">
                    与 {roleModules(card, role).length}{" "}
                    个来源提示模块关联。修改人物设定时会同时更新这些模块的原文副本。
                  </p>
                )}
                <label>
                  人物设定
                  <textarea
                    value={role.persona}
                    onChange={(event) =>
                      change(
                        updateRole(document, role.id, {
                          persona: event.target.value,
                        }),
                      )
                    }
                    rows={7}
                  />
                </label>
                <div className="structured-grid">
                  <label>
                    活动状态
                    <select
                      value={role.phase}
                      onChange={(event) =>
                        change(
                          updateRole(document, role.id, {
                            phase: event.target.value as RolePhase,
                          }),
                        )
                      }
                    >
                      {Object.entries(rolePhases).map(([value, name]) => (
                        <option key={value} value={value}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    在场状态
                    <select
                      value={role.presence}
                      onChange={(event) =>
                        change(
                          updateRole(document, role.id, {
                            presence: event.target.value as
                              | "present"
                              | "absent",
                          }),
                        )
                      }
                    >
                      <option value="present">在场</option>
                      <option value="absent">离场</option>
                    </select>
                  </label>
                </div>
                <p className="fine">
                  目标、知识、状态值与权限可在高级 JSON 中继续编辑。
                </p>
              </details>
            ))}
          </>
        ) : document.schema === "rp.preset/0.1" ? (
          <>
            <h3>叙述策略</h3>
            <div className="structured-grid">
              <label>
                人称
                <select
                  value={document.narration.person}
                  onChange={(event) => {
                    const next = structuredClone(document);
                    next.narration.person = event.target
                      .value as typeof document.narration.person;
                    change(next);
                  }}
                >
                  <option value="auto">自行决定</option>
                  <option value="first">第一人称</option>
                  <option value="third">第三人称</option>
                </select>
              </label>
              <label>
                叙述范围
                <select
                  value={document.narration.pov}
                  onChange={(event) => {
                    const next = structuredClone(document);
                    next.narration.pov = event.target
                      .value as typeof document.narration.pov;
                    change(next);
                  }}
                >
                  <option value="auto">自行决定</option>
                  <option value="limited">有限视角</option>
                  <option value="omniscient">全知</option>
                </select>
              </label>
            </div>
          </>
        ) : null}
      </fieldset>
      <section>
        <div className="row">
          <h3>提示模块 · {document.modules.length}</h3>
          <button
            disabled={disabled}
            onClick={() =>
              change(addModule(document, `module-${crypto.randomUUID()}`))
            }
          >
            <Plus size={13} />
            添加模块
          </button>
        </div>
        <label>
          查找模块
          <input
            type="search"
            value={moduleQuery}
            onChange={(event) => setModuleQuery(event.target.value)}
            placeholder="名称、ID 或完整正文"
          />
        </label>
        <p className="fine">
          运行先按优先级排序，同优先级才按列表顺序。上下移动只改变列表位置；下面的按钮会显式重设所有模块优先级。
        </p>
        <button
          disabled={disabled || !document.modules.length}
          onClick={() => change(orderModulePriorities(document))}
        >
          按当前列表重设优先级为 10、20、30…
        </button>
        <p className="fine">
          显示 {modules.length} / {document.modules.length} 个模块
        </p>
        {modules.map((module) => (
          <ModuleForm
            key={module.id}
            document={document}
            module={module}
            index={document.modules.findIndex((item) => item.id === module.id)}
            disabled={disabled}
            change={change}
          />
        ))}
        {!modules.length && <p className="muted">没有匹配的模块。</p>}
      </section>
    </section>
  );
}
