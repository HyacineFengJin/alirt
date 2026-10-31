import type { CharacterCard } from "../shared/types";
import { selectNewStoryOpening, storySummary, toggleNewStoryRoleGroup, type NewStorySelection } from "./new-story";

export function NewStoryInitialization({
  card,
  selection,
  onChange,
  disabled = false,
}: {
  card: CharacterCard;
  selection: NewStorySelection;
  onChange: (selection: NewStorySelection) => void;
  disabled?: boolean;
}) {
  const config = card.initialization;
  if (!config) return null;
  const opening = config.openings.find((item) => item.id === selection.openingId);
  const profile = config.playerProfiles.find((item) => item.id === selection.playerProfileId);
  const selectedIds = selection.selectedRoleIds ?? [];
  const roleSelection = opening?.roleSelection;
  const singleCast = opening?.cast.map(item => {
    if (!roleSelection?.roleIds.includes(item.roleId)) return item;
    const { interaction: _baselineInteraction, ...base } = item;
    return { ...base, ...(selectedIds.includes(item.roleId) ? roleSelection.selected : roleSelection.unselected) };
  }) ?? [];
  const cast = (opening?.roleGroups ?? []).reduce((members, group) => {
    if (!group.selected || !group.unselected) return members;
    const ids = selection.selectedRoleGroups?.[group.id] ?? [];
    return members.map(member => group.roleIds.includes(member.roleId)
      ? { roleId: member.roleId, ...(ids.includes(member.roleId) ? group.selected! : group.unselected!) } : member);
  }, singleCast);
  const present = cast.filter((item) => item.presence === "present");
  const remote = cast.filter(item => item.interaction?.mode === 'remote');
  const names = present.map((item) =>
    item.roleId === card.playerRoleId && profile
      ? profile.name
      : card.roles.find((role) => role.id === item.roleId)?.name,
  ).filter(Boolean);
  return (
    <>
      <label>
        开场
        <select
          value={selection.openingId ?? ""}
          disabled={disabled}
          onChange={(event) => onChange(selectNewStoryOpening(card, selection, event.target.value))}
        >
          <option value="">请选择开场</option>
          {config.openings.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
      </label>
      {roleSelection && <fieldset disabled={disabled} className="selection-note opening-role-selection">
        <legend>参与角色</legend>
        <p className="fine">选择 {roleSelection.min}～{roleSelection.max} 位；本次已选 {selectedIds.length} 位。</p>
        <div className="opening-role-options">{roleSelection.roleIds.map(id => {
          const role = card.roles.find(role => role.id === id), unavailable = !role || role.phase === 'retired';
          return <label key={id}>
          <input type="checkbox" checked={selectedIds.includes(id)}
            disabled={disabled || unavailable || !selectedIds.includes(id) && selectedIds.length >= roleSelection.max}
            onChange={event => onChange({ ...selection, selectedRoleIds: event.target.checked
              ? [...selectedIds, id] : selectedIds.filter(selected => selected !== id) })} />
          {role?.name ?? id}{unavailable ? '（不可用）' : ''}
        </label>; })}</div>
        {selectedIds.length < roleSelection.min && <p className="muted">请选择参与角色后进入故事。</p>}
      </fieldset>}
      {opening?.roleGroups?.map(group => {
        const ids = selection.selectedRoleGroups?.[group.id] ?? [];
        const parent = opening.roleGroups?.find(item => item.id === group.subsetOf);
        const parentIds = parent ? selection.selectedRoleGroups?.[parent.id] ?? [] : undefined;
        const selectedNames = group.roleIds.filter(id => ids.includes(id)).map(id => card.roles.find(role => role.id === id)?.name ?? id);
        return <fieldset key={group.id} disabled={disabled} className="selection-note opening-role-selection">
          <legend>{group.title}</legend>
          <p className="fine">选择 {group.min}～{group.max} 位；本次已选 {ids.length} 位{selectedNames.length ? `：${selectedNames.join('、')}` : ''}。</p>
          {parent && <p className="fine">仅可从「{parent.title}」已选角色中选择；可取消本组勾选，保留前一分组身份。</p>}
          <div className="opening-role-options">{group.roleIds.map(id => {
            const role = card.roles.find(role => role.id === id), selected = ids.includes(id), unavailable = !role || role.phase === 'retired' || id === card.playerRoleId;
            return <label key={id}><input type="checkbox" aria-label={`${group.title} · ${role?.name ?? id}`} checked={selected}
              disabled={disabled || !selected && (unavailable || ids.length >= group.max || !!parentIds && !parentIds.includes(id))}
              onChange={event => onChange(toggleNewStoryRoleGroup(card, selection, group.id, id, event.target.checked))} />{role?.name ?? id}{unavailable ? '（不可用）' : ''}</label>;
          })}</div>
          {ids.length < group.min && <p className="muted">此分组至少选择 {group.min} 位后才能进入故事。</p>}
        </fieldset>;
      })}
      {opening && (
        <div className="selection-note" aria-label="开场概要">
          <p>{storySummary(opening.text) || (opening.instruction ? "此开场将由世界 Agent 裁定，再生成正文。" : "此开场尚无文字概要。")}</p>
          {(opening.world?.location || opening.world?.time) && (
            <p className="fine">{[opening.world.location, opening.world.time].filter(Boolean).join(" · ")}</p>
          )}
          <p className="fine">{present.length} 位角色在场{names.length ? `：${names.slice(0, 5).join("、")}${names.length > 5 ? "等" : ""}` : ""}</p>
          {remote.length > 0 && <p className="fine">{remote.length} 位角色远程参与：{remote.map(item => card.roles.find(role => role.id === item.roleId)?.name ?? item.roleId).join('、')}。远程参与不代表到场。</p>}
        </div>
      )}
      <label>
        玩家人设
        <select
          value={selection.playerProfileId ?? ""}
          disabled={disabled}
          onChange={(event) => onChange({ ...selection, playerProfileId: event.target.value })}
        >
          <option value="">请选择玩家人设</option>
          {config.playerProfiles.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
      </label>
      {profile && (
        <div className="selection-note" aria-label="玩家人设概要">
          <p><strong>{profile.name}</strong></p>
          <p>{storySummary(profile.persona) || "未预填玩家人设。"}</p>
        </div>
      )}
      {(!opening || !profile) && <p className="muted">请选择开场和玩家人设后进入故事。</p>}
    </>
  );
}
