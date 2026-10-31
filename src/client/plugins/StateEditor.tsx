import { useState } from "react";
import type { Json, StateField } from "../../shared/types";
import { validateStateFieldValue } from "../../shared/state-value-schema";
import { errorText } from "../api";
import type { PanelContext } from "./registry";
export function display(value: Json | undefined, unknownLabel = "未设定") {
  return value === undefined || value === null
    ? unknownLabel
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
}
export function parseStateValue(field: StateField, value: string): Json {
  let parsed: Json;
  if (field.type === "number") {
    const number = Number(value);
    if (!value.trim() || !Number.isFinite(number))
      throw new Error("请输入有效数字");
    if (
      (field.min !== undefined && number < field.min) ||
      (field.max !== undefined && number > field.max)
    )
      throw new Error(
        `数值应在 ${field.min ?? "不限"} 到 ${field.max ?? "不限"} 之间`,
      );
    parsed = number;
  } else if (field.type === "boolean") {
    if (value !== "true" && value !== "false") throw new Error("请选择是或否");
    parsed = value === "true";
  } else if (field.type === "list") {
    const list: unknown = JSON.parse(value);
    if (!Array.isArray(list))
      throw new Error('列表应使用 JSON 数组，例如 ["钥匙", "信"]');
    parsed = list as Json[];
  } else parsed = value;
  const issues = validateStateFieldValue(field, parsed);
  if (issues.length) throw new Error(`${issues[0].path}: ${issues[0].message}`);
  return parsed;
}
export function StateEditor({
  field,
  world = false,
  unknownLabel = "未设定",
  ...context
}: PanelContext & { field: StateField; world?: boolean; unknownLabel?: string }) {
  const role = world
    ? { id: "world", state: context.session.world.variables }
    : context.selectedRole!;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [reason, setReason] = useState("");
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [unset, setUnset] = useState(false);
  async function save() {
    if (field.writableBy === "derived") return;
    setBusy(true);
    setError("");
    try {
      await context.editState({
        expectedRevision: revision,
        roleId: role.id,
        key: field.key,
        value: field.nullable && unset ? null : parseStateValue(field, draft),
        reason: reason.trim(),
      });
      setEditing(false);
      setReason("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="state-field">
      <div className="row">
        <span>{field.label}</span>
        <strong>{display(role.state[field.key], unknownLabel)}</strong>
      </div>
      {field.type === "number" &&
        typeof role.state[field.key] === "number" &&
        field.max !== undefined &&
        field.min !== undefined && (
          <meter
            min={field.min}
            max={field.max}
            value={role.state[field.key] as number}
            aria-label={field.label}
          />
        )}{" "}
      {field.writableBy === "derived" && <small className="fine">规则计算</small>}
      {field.editable && field.writableBy !== "derived" && !context.readOnly && !editing && (
        <button
          className="text-button"
          onClick={() => {
            setDraft(
              role.state[field.key] === null || role.state[field.key] === undefined ? "" : field.type === "string"
                ? String(role.state[field.key] ?? "")
                : JSON.stringify(
                    role.state[field.key] ?? (field.type === "list" ? [] : 0),
                  ),
            );
            setRevision(context.session.revision);
            setUnset(!!field.nullable && role.state[field.key] === null);
            setEditing(true);
          }}
        >
          修正
        </button>
      )}
      {editing && (
        <div className="editor">
          {field.nullable && <label className="check"><input type="checkbox" checked={unset} onChange={e => setUnset(e.target.checked)} />未设定</label>}
          <label>
            新值
            {field.type === "boolean" ? (
              <select disabled={unset} value={draft} onChange={(e) => setDraft(e.target.value)}>
                {!draft && <option value="">请选择</option>}
                <option value="true">是</option>
                <option value="false">否</option>
              </select>
            ) : field.type === "list" ? (
              <textarea
                disabled={unset}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
              />
            ) : (
              <input
                disabled={unset}
                value={draft}
                type={field.type === "number" ? "number" : "text"}
                min={field.min}
                max={field.max}
                onChange={(e) => setDraft(e.target.value)}
              />
            )}
          </label>
          <label>
            修正原因
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="说明这次修正的依据"
            />
          </label>
          <p className="fine">
            基于世界版本 {revision}；冲突时需重新打开编辑。
          </p>
          <div className="actions">
            <button
              disabled={busy || context.readOnly || !reason.trim()}
              onClick={save}
            >
              {busy ? "保存中…" : "保存修正"}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setError("");
              }}
            >
              取消
            </button>
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
