import type { PanelContext } from './registry';
import { StateEditor } from './StateEditor';

/** Select from the projected session, never from a catalog or another role's fallback. */
export function projectedRoleState(context: Pick<PanelContext, 'session' | 'selectedRole'>) {
  const role = context.session.roles.find(role => role.id === context.selectedRole?.id);
  return role ? { role, fields: context.session.fields.filter(field => Object.hasOwn(role.state, field.key)) } : undefined;
}

export function RoleStateFields(context: PanelContext) {
  const selected = projectedRoleState(context);
  if (!selected) return <p className="muted">请先选择角色。</p>;
  return <>
    <p className="eyebrow">{selected.role.name}</p>
    {selected.fields.map(field => <StateEditor key={`${selected.role.id}:${field.key}`} {...context} selectedRole={selected.role} field={field} />)}
    {!selected.fields.length && <p className="muted">此故事未声明可显示的状态字段。</p>}
  </>;
}
