import type { CharacterCard, CreateSession, InitializationSelection } from "../shared/types";
import type { OpeningRoleSelectionGroup } from '../shared/initialization';

export interface NewStorySelection extends InitializationSelection {
  cardId: string;
}

function copyRoleGroups(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) return;
  const entries: [string, string[]][] = [];
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !('value' in descriptor)) return;
    const ids = descriptor.value;
    if (!Array.isArray(ids) || Object.getPrototypeOf(ids) !== Array.prototype || Reflect.ownKeys(ids).length !== ids.length + 1) return;
    const copied: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const item = Object.getOwnPropertyDescriptor(ids, String(i));
      if (!item || !('value' in item) || typeof item.value !== 'string' || !item.value.trim()) return;
      copied.push(item.value);
    }
    entries.push([key, copied]);
  }
  return Object.fromEntries(entries);
}
function emptyRoleGroups(groups: OpeningRoleSelectionGroup[]): Record<string, string[]> {
  return Object.fromEntries(groups.map(group => [group.id, []]));
}

/** A scene change preserves explicit choices only when the group definitions agree. */
export function selectNewStoryOpening(card: CharacterCard, selection: NewStorySelection, openingId: string): NewStorySelection {
  const current = card.initialization?.openings.find(item => item.id === selection.openingId);
  const target = card.initialization?.openings.find(item => item.id === openingId);
  const { selectedRoleIds: _oldRoles, selectedRoleGroups: _oldGroups, ...base } = selection;
  return { ...base, openingId,
    ...(target?.roleSelection ? { selectedRoleIds: [] } : {}),
    ...(target?.roleGroups ? { selectedRoleGroups: current?.roleGroups && JSON.stringify(current.roleGroups) === JSON.stringify(target.roleGroups)
      ? copyRoleGroups(selection.selectedRoleGroups) ?? emptyRoleGroups(target.roleGroups) : emptyRoleGroups(target.roleGroups) } : {}),
  };
}

/** Source-style dependent checkboxes; no request is sent and no identity is inferred. */
export function toggleNewStoryRoleGroup(card: CharacterCard, selection: NewStorySelection, groupId: string, roleId: string, checked: boolean): NewStorySelection {
  const groups = card.initialization?.openings.find(item => item.id === selection.openingId)?.roleGroups;
  const group = groups?.find(item => item.id === groupId);
  if (!groups || !group || !group.roleIds.includes(roleId)) return selection;
  const previous = copyRoleGroups(selection.selectedRoleGroups) ?? emptyRoleGroups(groups);
  const ids = previous[group.id] ?? [];
  if (checked && (!card.roles.some(role => role.id === roleId && role.phase !== 'retired' && role.id !== card.playerRoleId)
    || !ids.includes(roleId) && ids.length >= group.max || group.subsetOf && !previous[group.subsetOf]?.includes(roleId))) return selection;
  const next = { ...previous, [group.id]: checked ? ids.includes(roleId) ? [...ids] : [...ids, roleId] : ids.filter(id => id !== roleId) };
  const ordered = (definition: OpeningRoleSelectionGroup, values: string[]) => [...definition.roleIds.filter(id => values.includes(id)), ...values.filter(id => !definition.roleIds.includes(id))];
  next[group.id] = ordered(group, next[group.id]);
  for (const child of groups) {
    if (!child.subsetOf) continue;
    const parent = next[child.subsetOf] ?? [];
    const added = parent.filter(id => !previous[child.subsetOf!]?.includes(id));
    const selected = (next[child.id] ?? []).filter(id => parent.includes(id));
    if (child.selectWithParent) for (const id of added) {
      if (child.roleIds.includes(id) && !selected.includes(id) && selected.length < child.max) selected.push(id);
    }
    next[child.id] = ordered(child, selected);
  }
  return { ...selection, selectedRoleGroups: next };
}

function selectedId(
  options: { id: string }[],
  defaultId: string | undefined,
  selected: string | undefined,
): string {
  if (selected !== undefined)
    return options.some((option) => option.id === selected) ? selected : "";
  if (defaultId && options.some((option) => option.id === defaultId))
    return defaultId;
  return options.length === 1 ? options[0].id : "";
}

export function resolveNewStorySelection(
  card: CharacterCard,
  selection: NewStorySelection,
): NewStorySelection {
  const config = card.initialization;
  if (!config) return { cardId: card.id };
  const current = selection.cardId === card.id ? selection : undefined;
  const openingId = selectedId(config.openings, config.defaultOpeningId, current?.openingId);
  const opening = config.openings.find(item => item.id === openingId);
  return {
    cardId: card.id,
    openingId,
    playerProfileId: selectedId(config.playerProfiles, config.defaultPlayerProfileId, current?.playerProfileId),
    ...(opening?.roleSelection ? { selectedRoleIds: current?.selectedRoleIds?.slice() ?? [] } : {}),
    ...(opening?.roleGroups ? { selectedRoleGroups: current?.selectedRoleGroups === undefined
      ? emptyRoleGroups(opening.roleGroups) : copyRoleGroups(current.selectedRoleGroups) ?? {} } : {}),
  };
}

export function newStoryRequest(
  card: CharacterCard | undefined,
  presetId: string,
  selection: NewStorySelection,
): CreateSession | undefined {
  if (!card || !presetId) return;
  const resolved = resolveNewStorySelection(card, selection);
  if (card.initialization && (!resolved.openingId || !resolved.playerProfileId))
    return;
  const opening = card.initialization?.openings.find(item => item.id === resolved.openingId), roleSelection = opening?.roleSelection;
  if (roleSelection && opening?.roleGroups) return;
  if (roleSelection) {
    if (selection.cardId === card.id && selection.selectedRoleGroups !== undefined) return;
    const ids = resolved.selectedRoleIds ?? [];
    if (ids.length < roleSelection.min || ids.length > roleSelection.max || new Set(ids).size !== ids.length
      || ids.some(id => !roleSelection.roleIds.includes(id) || !card.roles.some(role => role.id === id && role.phase !== 'retired'))) return;
  }
  if (opening?.roleGroups) {
    if (selection.cardId === card.id && selection.selectedRoleIds !== undefined) return;
    const groups = opening.roleGroups, selected = resolved.selectedRoleGroups;
    if (!groups.length || !selected || Object.keys(selected).length !== groups.length || groups.some(group => !Object.hasOwn(selected, group.id))) return;
    const seen = new Map<string, OpeningRoleSelectionGroup>();
    for (const group of groups) {
      if (seen.has(group.id) || !group.roleIds.length || new Set(group.roleIds).size !== group.roleIds.length
        || !Number.isSafeInteger(group.min) || !Number.isSafeInteger(group.max) || group.min < 0 || group.max > group.roleIds.length || group.min > group.max
        || group.subsetOf && (!seen.has(group.subsetOf) || group.roleIds.some(id => !seen.get(group.subsetOf!)!.roleIds.includes(id)))) return;
      const ids = selected[group.id];
      if (!Array.isArray(ids) || ids.length < group.min || ids.length > group.max || new Set(ids).size !== ids.length
        || ids.some(id => !group.roleIds.includes(id) || id === card.playerRoleId || !card.roles.some(role => role.id === id && role.phase !== 'retired'))
        || group.subsetOf && ids.some(id => !selected[group.subsetOf!].includes(id))) return;
      seen.set(group.id, group);
    }
    resolved.selectedRoleGroups = Object.fromEntries(groups.map(group => [group.id, group.roleIds.filter(id => selected[group.id].includes(id))]));
  }
  return { ...resolved, presetId };
}

export function storySummary(text: string, limit = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}
