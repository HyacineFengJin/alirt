import { createHash } from 'node:crypto';
import type { CharacterCard, InitialStateChange, InitializationReceipt, InitializationSelection, OpeningDefinition, RoleDefinition } from '../shared/types';
import { validateRuntimeDocument } from './worldbook-runtime';
import { expandNativeMacros } from '../shared/native';
import { assertStateJson } from './state-runtime';
import type { StoredSession } from './store';

export class InitializationError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'InitializationError'; }
}
function fail(code: string, message: string): never { throw new InitializationError(code, message); }
function fingerprint(value: unknown) {
  const canonical = (node: any): any => Array.isArray(node) ? node.map(canonical)
    : node && typeof node === 'object' ? Object.fromEntries(Object.keys(node).sort().map(key => [key, canonical(node[key])])) : node;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function parseSelection(value: unknown): InitializationSelection {
  try { assertStateJson(value); } catch { fail('INITIALIZATION_SELECTION', 'Opening selections must contain ordinary JSON data.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length)
    fail('INITIALIZATION_SELECTION', 'Select an opening and player profile.');
  const result: InitializationSelection = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (key === 'selectedRoleGroups' && 'value' in descriptor) {
      const groups = descriptor.value;
      if (!groups || typeof groups !== 'object' || Array.isArray(groups)) fail('INITIALIZATION_SELECTION', 'Selected role groups must be an explicit group map.');
      const selected: Record<string, string[]> = {};
      for (const [id, ids] of Object.entries(groups)) {
        if (!id.trim()) fail('INITIALIZATION_SELECTION', 'Selected role group IDs must be nonempty.');
        selected[id] = parseSelection({ selectedRoleIds: ids }).selectedRoleIds!;
      }
      result.selectedRoleGroups = selected; continue;
    }
    if (key === 'selectedRoleIds' && 'value' in descriptor) {
      const ids = descriptor.value;
      if (!Array.isArray(ids) || Object.getPrototypeOf(ids) !== Array.prototype || ids.length > 100000 || Object.getOwnPropertySymbols(ids).length || Object.keys(ids).length !== ids.length
        || Array.from({ length: ids.length }, (_, index) => Object.getOwnPropertyDescriptor(ids, index)).some(item => !item || !('value' in item) || typeof item.value !== 'string' || !item.value.trim()))
        fail('INITIALIZATION_SELECTION', 'Selected role IDs must be an explicit list of nonempty text.');
      result.selectedRoleIds = Array.from({ length: ids.length }, (_, index) => Object.getOwnPropertyDescriptor(ids, index)!.value); continue;
    }
    if (!['openingId', 'playerProfileId'].includes(key) || !('value' in descriptor)
      || typeof descriptor.value !== 'string' || !descriptor.value.trim()) fail('INITIALIZATION_SELECTION', 'Opening and player profile IDs must be nonempty text.');
    result[key as 'openingId' | 'playerProfileId'] = descriptor.value;
  }
  return result;
}
function canonicalGroups(card: CharacterCard, opening: OpeningDefinition, ids: string[] | undefined, selected: InitializationSelection['selectedRoleGroups']) {
  if (!opening.roleGroups) {
    if (selected !== undefined) fail('INITIALIZATION_SELECTION', 'This opening does not accept selected role groups.');
    return undefined;
  }
  if (ids !== undefined) fail('INITIALIZATION_SELECTION', 'Role group openings do not accept legacy selected role IDs.');
  if (!selected || Object.keys(selected).length !== opening.roleGroups.length || opening.roleGroups.some(group => !Object.hasOwn(selected, group.id)))
    fail('INITIALIZATION_SELECTION', 'Explicitly select every declared role group and no other groups.');
  const canonical: Record<string, string[]> = {};
  for (const group of opening.roleGroups) {
    const chosen = selected[group.id];
    if (!chosen || chosen.length < group.min || chosen.length > group.max || new Set(chosen).size !== chosen.length
      || chosen.some(id => !group.roleIds.includes(id) || !card.roles.some(role => role.id === id && role.phase !== 'retired'))
      || group.subsetOf && chosen.some(id => !canonical[group.subsetOf!]?.includes(id)))
      fail('INITIALIZATION_SELECTION', 'Select unique available roles within each group and its selected parent.');
    canonical[group.id] = group.roleIds.filter(id => chosen.includes(id));
  }
  return canonical;
}
function resolveOpening(card: CharacterCard, opening: OpeningDefinition, ids: string[] | undefined, groups?: InitializationSelection['selectedRoleGroups']): OpeningDefinition {
  const rule = opening.roleSelection, resolved = structuredClone(opening);
  const chosenGroups = canonicalGroups(card, opening, ids, groups);
  if (opening.roleGroups && chosenGroups) {
    const replacements = new Map<string, string>();
    for (const group of opening.roleGroups) {
      const selected = chosenGroups[group.id], names = (chosen: string[]) => chosen.map(id => card.roles.find(role => role.id === id)!.name).join(group.nameSeparator) || (group.emptyName ?? '无');
      replacements.set(group.nameToken, names(selected));
      if (group.complementNameToken) replacements.set(group.complementNameToken, names(group.roleIds.filter(id => !selected.includes(id))));
      if (group.selected && group.unselected) resolved.cast = resolved.cast.map(member => group.roleIds.includes(member.roleId)
        ? { roleId: member.roleId, ...structuredClone(selected.includes(member.roleId) ? group.selected! : group.unselected!) } : member);
      resolved.state = [...(resolved.state ?? []), ...group.roleIds.flatMap(roleId => (selected.includes(roleId) ? group.selectedState ?? [] : group.unselectedState ?? [])
        .map(change => ({ roleId, ...structuredClone(change) })))];
    }
    // One replacement pass prevents a role name containing a token from being interpreted again.
    const replace = (text: string) => text.replace(/\[\[[a-z][a-z0-9-]{0,63}\]\]/g, token => replacements.get(token) ?? token);
    if (resolved.instruction !== undefined) resolved.instruction = replace(resolved.instruction);
    if (resolved.delivery) for (const target of ['world', 'prose'] as const)
      if (resolved.delivery[target] !== undefined) resolved.delivery[target] = replace(resolved.delivery[target]);
    delete resolved.roleGroups;
    return resolved;
  }
  if (!rule) {
    if (ids !== undefined) fail('INITIALIZATION_SELECTION', 'This opening does not accept selected roles.');
    return resolved;
  }
  if (!ids || ids.length < rule.min || ids.length > rule.max || new Set(ids).size !== ids.length
    || ids.some(id => !rule.roleIds.includes(id) || !card.roles.some(role => role.id === id && role.phase !== 'retired')))
    fail('INITIALIZATION_SELECTION', 'Select a valid, unique subset of available opening roles.');
  const names = ids.map(id => card.roles.find(role => role.id === id)!.name).join(rule.nameSeparator);
  const replace = (text: string) => text.split(rule.nameToken).join(names);
  if (resolved.instruction !== undefined) resolved.instruction = replace(resolved.instruction);
  if (resolved.delivery) for (const target of ['world', 'prose'] as const)
    if (resolved.delivery[target] !== undefined) resolved.delivery[target] = replace(resolved.delivery[target]);
  resolved.cast = resolved.cast.map(member => rule.roleIds.includes(member.roleId)
    ? { roleId: member.roleId, ...structuredClone(ids.includes(member.roleId) ? rule.selected : rule.unselected) } : member);
  resolved.state = [...(resolved.state ?? []), ...ids.flatMap(roleId => (rule.selectedState ?? []).map(change => ({ roleId, ...structuredClone(change) })))];
  delete resolved.roleSelection;
  return resolved;
}
function choose<T extends { id: string }>(items: T[], chosen: string | undefined, fallback: string | undefined): T {
  const id = chosen ?? fallback ?? (items.length === 1 ? items[0].id : undefined);
  const item = items.find(item => item.id === id);
  if (!item) fail('INITIALIZATION_SELECTION', 'Select an available opening and player profile for this card.');
  return item;
}
function applyLayer(world: CharacterCard['world'], roles: RoleDefinition[], changes: InitialStateChange[] = []) {
  for (const change of changes) {
    const target = change.roleId === 'world' ? world.variables : roles.find(role => role.id === change.roleId)!.state;
    target[change.key] = structuredClone(change.value);
  }
}

/** Pure genesis composition, not an ongoing author/model state edit. No transitions execute.
 * The store checks final declared world invariants before its first durable save.
 */
export function initializeStory(card: CharacterCard, value: unknown = {}) {
  const selection = parseSelection(value), definition = card.initialization;
  const world = structuredClone(card.world), roles = structuredClone(card.roles);
  if (!definition) {
    if (Object.keys(selection).length) fail('INITIALIZATION_UNAVAILABLE', 'This card has no configurable opening or player profile.');
    return { world, roles, opening: card.opening, receipt: undefined };
  }
  if (validateRuntimeDocument('card', card).length) fail('INITIALIZATION_DEFINITION', 'Review the invalid initialization card before creating a story.');
  const selectedOpening = choose(definition.openings, selection.openingId, definition.defaultOpeningId);
  const selectedRoleGroups = canonicalGroups(card, selectedOpening, selection.selectedRoleIds, selection.selectedRoleGroups);
  const opening = resolveOpening(card, selectedOpening, selection.selectedRoleIds, selectedRoleGroups);
  const profile = choose(definition.playerProfiles, selection.playerProfileId, definition.defaultPlayerProfileId);
  applyLayer(world, roles, profile.state);
  applyLayer(world, roles, opening.state);
  if (opening.world?.location !== undefined) world.location = opening.world.location;
  if (opening.world?.time !== undefined) world.time = opening.world.time;
  for (const cast of opening.cast) {
    const role = roles.find(role => role.id === cast.roleId)!;
    const mirror = role.stateMirrors?.presence;
    const explicitPresence = mirror === undefined ? undefined
      : opening.state?.find(change => change.roleId === role.id && change.key === mirror)
        ?? profile.state?.find(change => change.roleId === role.id && change.key === mirror);
    if (explicitPresence && explicitPresence.value !== (cast.presence === 'present'))
      fail('INITIALIZATION_CONFLICT', 'The effective initial presence value conflicts with the explicit opening cast.');
    role.phase = cast.phase; role.presence = cast.presence;
    // Each complete cast owns this opening's scene participation. Other openings
    // cannot inherit a remote grant from the card's default baseline.
    if (cast.interaction) role.interaction = structuredClone(cast.interaction);
    else delete role.interaction;
    // A similarly named field in an older card is ordinary state. Only an
    // explicit binding grants the cast authority over a structural mirror.
    if (mirror !== undefined) role.state[mirror] = cast.presence === 'present';
  }
  const player = roles.find(role => role.id === card.playerRoleId)!;
  player.name = profile.name; player.persona = profile.persona;
  // A selected profile replaces a base persona, not the source text of another role/module.
  delete player.personaSourcePointer;
  const openingText = expandNativeMacros(opening.text, { user: player.name, char: card.title });
  const composed = { ...structuredClone(card), world, roles, opening: openingText };
  if (validateRuntimeDocument('card', composed).length)
    fail('INITIALIZATION_RESULT', 'The chosen baseline does not satisfy the native card schema.');
  const receipt: InitializationReceipt = { schema: 'rp.initialization-receipt/0.1', openingId: opening.id,
    playerProfileId: profile.id, definitionHash: fingerprint(definition),
    ...(selectedOpening.roleSelection ? { selectedRoleIds: [...selection.selectedRoleIds!], resolvedOpening: structuredClone(opening) } : {}),
    ...(selectedRoleGroups ? { selectedRoleGroups, resolvedOpening: structuredClone(opening) } : {}) };
  return { world, roles, opening: openingText, receipt };
}

/** Definitions remain bound snapshots. This never reapplies an opening or profile.
 * Callers must select delivery.world/prose explicitly; opening.instruction remains
 * legacy-only when delivery is absent. source is provenance, never dispatch content.
 */
export function initializationContext(session: Pick<StoredSession, 'card' | 'roles' | 'playerRoleId' | 'initialization'>) {
  const definition = session.card.initialization, receipt = session.initialization;
  if (receipt) {
    try { assertStateJson(receipt); } catch { fail('INITIALIZATION_RECEIPT', 'Initialization receipt must contain ordinary JSON data.'); }
  }
  if (!definition) {
    if (receipt) fail('INITIALIZATION_RECEIPT', 'Initialization receipt has no matching definition.');
    return;
  }
  if (!receipt || receipt.schema !== 'rp.initialization-receipt/0.1' || receipt.definitionHash !== fingerprint(definition))
    fail('INITIALIZATION_RECEIPT', 'Initialization receipt does not match this story definition.');
  const opening = definition.openings.find(item => item.id === receipt.openingId);
  const profile = definition.playerProfiles.find(item => item.id === receipt.playerProfileId);
  const player = session.roles.find(role => role.id === session.playerRoleId);
  if (!opening || !profile || !player) fail('INITIALIZATION_RECEIPT', 'The selected opening or player profile is unavailable.');
  const selectedRoleIds = Object.hasOwn(receipt, 'selectedRoleIds') ? parseSelection({ selectedRoleIds: receipt.selectedRoleIds }).selectedRoleIds : undefined;
  const selectedRoleGroups = Object.hasOwn(receipt, 'selectedRoleGroups') ? parseSelection({ selectedRoleGroups: receipt.selectedRoleGroups }).selectedRoleGroups : undefined;
  const canonical = canonicalGroups(session.card, opening, selectedRoleIds, selectedRoleGroups);
  if (canonical && fingerprint(canonical) !== fingerprint(selectedRoleGroups)) fail('INITIALIZATION_RECEIPT', 'Selected role groups must retain canonical candidate order.');
  let resolved = resolveOpening(session.card, opening, selectedRoleIds, canonical);
  if (opening.roleSelection || opening.roleGroups) {
    if (!receipt.resolvedOpening || fingerprint(resolved) !== fingerprint(receipt.resolvedOpening))
      fail('INITIALIZATION_RECEIPT', 'The selected role receipt does not match the resolved opening.');
    resolved = structuredClone(receipt.resolvedOpening);
  } else if (receipt.resolvedOpening !== undefined) fail('INITIALIZATION_RECEIPT', 'Unexpected resolved opening receipt.');
  const expand = (text: string) => expandNativeMacros(text, { user: player.name, char: session.card.title });
  resolved.text = expand(resolved.text);
  if (resolved.instruction !== undefined) resolved.instruction = expand(resolved.instruction);
  if (resolved.delivery) for (const target of ['world', 'prose'] as const) if (resolved.delivery[target] !== undefined) resolved.delivery[target] = expand(resolved.delivery[target]);
  return { opening: resolved, playerProfile: { name: player.name, persona: player.persona } };
}
