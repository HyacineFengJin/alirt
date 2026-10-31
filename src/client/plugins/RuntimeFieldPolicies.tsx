import { useState } from 'react';
import type { RoleDefinition, StateField } from '../../shared/types';
import type { RuntimeFieldPolicyPatch } from '../../shared/runtime-config';
import { validateStateFieldDefinition } from '../../shared/state-value-schema';

const keys = ['audience', 'editable', 'writableBy', 'min', 'max', 'nullable', 'valueSchema'] as const;
/** Only changed policies travel over the API; clearing an optional bound is explicit. */
export function changedFieldPolicies(base: StateField[], next: StateField[]): RuntimeFieldPolicyPatch[] {
  if (base.length !== next.length || new Set(next.map(field => field.key)).size !== next.length) throw new Error('这里不能增删或重命名字段。');
  return next.flatMap(field => {
    const previous = base.find(item => item.key === field.key);
    if (!previous || previous.type !== field.type) throw new Error('这里不能更换字段或类型。');
    const patch: Record<string, unknown> & { key: string } = { key: field.key };
    for (const key of keys) if (JSON.stringify(previous[key]) !== JSON.stringify(field[key])) {
      patch[key] = field[key] === undefined
        ? ['min', 'max', 'valueSchema'].includes(key) ? null : key === 'nullable' ? false : key === 'writableBy' ? 'model' : undefined
        : field[key];
    }
    return Object.keys(patch).length > 1 ? [patch as RuntimeFieldPolicyPatch] : [];
  });
}
export interface FieldPolicyDraft {
  audience: 'public' | 'author' | 'roles'; roleIds: string;
  editable: boolean; writableBy: 'model' | 'author' | 'derived'; nullable: boolean;
  min: string; max: string; schema: string;
}
export function fieldPolicyDraft(field: StateField): FieldPolicyDraft {
  return { audience: Array.isArray(field.audience) ? 'roles' : field.audience, roleIds: Array.isArray(field.audience) ? field.audience.join(', ') : '',
    editable: field.editable, writableBy: field.writableBy ?? 'model', nullable: field.nullable ?? false,
    min: field.min === undefined ? '' : String(field.min), max: field.max === undefined ? '' : String(field.max),
    schema: field.valueSchema ? JSON.stringify(field.valueSchema, null, 2) : '' };
}
export function parseFieldPolicyDraft(field: StateField, draft: FieldPolicyDraft, roles: Pick<RoleDefinition, 'id'>[]): StateField {
  const next = structuredClone(field);
  if (draft.audience === 'roles') {
    const ids = draft.roleIds.split(',').map(value => value.trim());
    if (ids.some(id => !id || !roles.some(role => role.id === id)) || new Set(ids).size !== ids.length) throw new Error('请填写不重复的已有角色 ID，用英文逗号分隔。');
    next.audience = ids;
  } else next.audience = draft.audience;
  next.editable = draft.editable;
  if (field.writableBy === undefined && draft.writableBy === 'model') delete next.writableBy;
  else next.writableBy = draft.writableBy;
  if (field.nullable === undefined && !draft.nullable) delete next.nullable;
  else next.nullable = draft.nullable;
  for (const key of ['min', 'max'] as const) {
    const text = draft[key].trim();
    if (!text) delete next[key];
    else {
      if (field.type !== 'number' || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || !Number.isFinite(Number(text))) throw new Error('上下限需要有效的有限数字；留空表示不设置。');
      next[key] = Number(text);
    }
  }
  if (!draft.schema.trim()) delete next.valueSchema;
  else { try { next.valueSchema = JSON.parse(draft.schema); } catch { throw new Error('结构约束需要合法 JSON；留空表示不设置。'); } }
  const issue = validateStateFieldDefinition(next)[0];
  if (issue) throw new Error(`${issue.path}：${issue.message}`);
  return next;
}

function Policy({ field, roles, disabled, change, invalid }: {
  field: StateField; roles: RoleDefinition[]; disabled: boolean;
  change: (value: StateField) => void; invalid: (message: string) => void;
}) {
  const [original] = useState(() => structuredClone(field));
  const [draft, setDraft] = useState(() => fieldPolicyDraft(field)), [error, setError] = useState('');
  function update(patch: Partial<FieldPolicyDraft>) {
    const next = { ...draft, ...patch }; setDraft(next);
    try { const value = parseFieldPolicyDraft(original, next, roles); change(value); setError(''); invalid(''); }
    catch (error) { const message = error instanceof Error ? error.message : '字段策略无效'; setError(message); invalid(message); }
  }
  return <details className="runtime-field-policy"><summary>{field.label}<small> · {field.key} · {field.type}</small></summary>
    <fieldset disabled={disabled}><div className="runtime-policy-grid">
      <label>可读范围<select value={draft.audience} onChange={event => update({ audience: event.target.value as FieldPolicyDraft['audience'] })}><option value="author">仅作者／世界裁定</option><option value="public">公开</option><option value="roles">指定角色</option></select></label>
      <label>直接写入者<select value={draft.writableBy} onChange={event => update({ writableBy: event.target.value as FieldPolicyDraft['writableBy'] })}><option value="model">模型与作者</option><option value="author">仅作者</option><option value="derived">仅声明式派生规则</option></select></label>
      {draft.audience === 'roles' && <label>可读角色 ID<input value={draft.roleIds} onChange={event => update({ roleIds: event.target.value })} placeholder="role-4, player" /></label>}
      {field.type === 'number' && <><label>最小值<input inputMode="decimal" value={draft.min} onChange={event => update({ min: event.target.value })} placeholder="不设置" /></label><label>最大值<input inputMode="decimal" value={draft.max} onChange={event => update({ max: event.target.value })} placeholder="不设置" /></label></>}
    </div><div className="runtime-policy-checks"><label><input type="checkbox" checked={draft.editable} onChange={event => update({ editable: event.target.checked })} />作者可手动改值</label><label><input type="checkbox" checked={draft.nullable} onChange={event => update({ nullable: event.target.checked })} />允许写为未设定</label></div>
    <details><summary>结构约束 JSON</summary><label>字段结构约束<textarea rows={7} value={draft.schema} onChange={event => update({ schema: event.target.value })} spellCheck={false}/></label><p className="fine">只支持声明的数据结构、枚举与数值约束；不运行代码。留空移除额外结构约束。</p></details></fieldset>
    {error && <p className="error" role="alert">{error}</p>}
  </details>;
}

export function RuntimeFieldPolicies({ fields, roles, disabled, change, invalid }: {
  fields: StateField[]; roles: RoleDefinition[]; disabled: boolean;
  change: (fields: StateField[]) => void; invalid: (key: string, message: string) => void;
}) {
  const [search, setSearch] = useState('');
  return <details className="runtime-field-policies"><summary>状态字段 · 权限与约束（{fields.length}）</summary>
    <p className="fine">这里始终修改当前角色卡的已有字段规则，不改当前值。同一字段键的所有持有者共用此策略；指定角色可读该字段在所有持有者上的值。</p>
    <p className="fine">保存会核对当前所有持有者及关联规则，冲突时整笔拒绝。字段的界面只读与模型写权限分别设置；有绑定的插件仍会检查自身约束。</p>
    <p className="fine">公开范围的调整用于后续读取，已保存的历史正文不会自动撤回。世界裁定可读作者字段。</p>
    <label>查找状态字段<input value={search} onChange={event => setSearch(event.target.value)} placeholder="名称 / 字段 ID" /></label>
    {fields.map(field => <div key={field.key} hidden={!!search && !`${field.label} ${field.key}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())}><Policy field={field} roles={roles} disabled={disabled}
      change={value => change(fields.map(item => item.key === value.key ? value : item))} invalid={message => invalid(field.key, message)} /></div>)}
  </details>;
}
