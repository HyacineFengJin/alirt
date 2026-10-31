import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ROLE_VISUAL_SERVICE_ID, validCardVisualDefaults, validVisualCrop, validVisualImageRef,
  type RoleVisualState, type RoleVisualsSnapshot, type RoleVisualsView, type VisualBinding, type VisualCommand, type VisualCommandResult,
  type VisualImageAsset, type VisualImageRef } from '../shared/visual-assets';
import type { Json } from '../shared/types';
import { validateStateJson } from '../shared/state-value-schema';
import { validateEventLedger } from './event-ledger';
import type { SessionCommandService } from './session-services';
import { ApiError, assertRevision, clone, event, type SessionStore, type StoredSession } from './store';

export interface VisualAssetLibrary { list(): VisualImageAsset[] }
const fail = (message: string, status = 400): never => { throw new ApiError(status, 'ROLE_VISUALS', message); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const identity = (value: unknown): value is string => text(value) && value === value.trim() && !['__proto__', 'prototype', 'constructor'].includes(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && (value as number) >= minimum;
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const fingerprint = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
function parseCommand(value: unknown): VisualCommand {
  if (validateStateJson(value).length || !object(value) || !identity(value.requestId) || !integer(value.expectedRevision) || !text(value.reason)
    || !identity(value.roleId) || value.slot !== 'dialogue-avatar' || !integer(value.expectedVersion)
    || !(value.operation === 'bind' && exact(value, ['requestId', 'expectedRevision', 'reason', 'roleId', 'slot', 'expectedVersion', 'operation', 'assetId', 'crop'])
      && typeof value.assetId === 'string' && /^[a-f0-9]{64}$/.test(value.assetId) && validVisualCrop(value.crop)
      || ['reset', 'hide'].includes(value.operation as string) && exact(value, ['requestId', 'expectedRevision', 'reason', 'roleId', 'slot', 'expectedVersion', 'operation'])))
    return fail('Provide an exact role visual bind/reset/hide command, CAS version and reason');
  return clone(value) as unknown as VisualCommand;
}
function binding(value: unknown): value is VisualBinding {
  return object(value) && (value.kind === 'asset' && exact(value, ['kind', 'image', 'crop']) && validVisualImageRef(value.image) && validVisualCrop(value.crop)
    || ['none', 'default'].includes(value.kind as string) && exact(value, ['kind']));
}
export function readRoleVisualState(session: Readonly<StoredSession>): RoleVisualState {
  const raw = session.visuals;
  if (raw === undefined) {
    if (session.events.some(entry => entry.kind === 'role-visual-control')) return fail('Role visual bindings are missing their author audit', 409);
    return { schema: 'rp.role-visuals/0.1', bindings: [], commands: [] };
  }
  if (validateStateJson(raw).length || validateEventLedger(session.events).length || !object(raw) || !exact(raw, ['schema', 'bindings', 'commands'])
    || raw.schema !== 'rp.role-visuals/0.1' || !Array.isArray(raw.bindings) || !Array.isArray(raw.commands)) return fail('Invalid retained role visuals', 409);
  const keys = new Set<string>(), sources = new Set<string>(), audits = session.events.filter(entry => entry.kind === 'role-visual-control');
  let versionCount = 0;
  for (const record of raw.bindings) {
    if (!object(record) || !exact(record, ['roleId', 'slot', 'versions']) || !identity(record.roleId) || record.slot !== 'dialogue-avatar'
      || !session.roles.some(role => role.id === record.roleId) || !Array.isArray(record.versions) || !record.versions.length) return fail('Role visual binding has no exact existing role', 409);
    const key = JSON.stringify([record.roleId, record.slot]); if (keys.has(key)) return fail('Duplicate role visual binding', 409); keys.add(key);
    let previousRevision = -1;
    for (const [index, version] of record.versions.entries()) {
      if (!object(version) || !exact(version, ['version', 'revision', 'sourceEventId', 'value']) || version.version !== index + 1 || !integer(version.revision, 1)
        || version.revision <= previousRevision || version.revision > session.revision || !identity(version.sourceEventId) || sources.has(version.sourceEventId) || !binding(version.value)) return fail('Invalid immutable visual binding version', 409);
      const matched = audits.filter(entry => entry.id === version.sourceEventId), audit = matched[0];
      if (matched.length !== 1 || audit.actor !== 'author' || audit.audience !== 'author' || !object(audit.data)
        || !exact(audit.data, ['schema', 'roleId', 'slot', 'version', 'revision', 'fingerprint', 'command', 'value']) || audit.data.schema !== 'rp.role-visual-control/0.1'
        || audit.data.roleId !== record.roleId || audit.data.slot !== record.slot || audit.data.version !== version.version || audit.data.revision !== version.revision) return fail('Visual binding differs from its author audit', 409);
      let command: VisualCommand;
      try { command = parseCommand(audit.data.command); } catch { return fail('Invalid retained visual binding command', 409); }
      const expected: VisualBinding = command.operation === 'bind' ? { kind: 'asset', image: (version.value as Extract<VisualBinding, { kind: 'asset' }>).image, crop: command.crop }
        : command.operation === 'hide' ? { kind: 'none' } : { kind: 'default' };
      if (command.roleId !== record.roleId || command.slot !== record.slot || command.expectedVersion !== index || command.expectedRevision !== version.revision - 1
        || audit.data.fingerprint !== fingerprint(command) || !isDeepStrictEqual(audit.data.value, version.value) || !isDeepStrictEqual(version.value, expected)
        || command.operation === 'bind' && (version.value.kind !== 'asset' || version.value.image.assetId !== command.assetId)) return fail('Visual command differs from its retained binding', 409);
      sources.add(version.sourceEventId); previousRevision = version.revision; versionCount++;
    }
  }
  const requests = new Set<string>();
  for (const receipt of raw.commands) {
    if (!object(receipt) || !exact(receipt, ['requestId', 'fingerprint', 'roleId', 'slot', 'version', 'revision']) || !identity(receipt.requestId)
      || requests.has(receipt.requestId) || !identity(receipt.roleId) || receipt.slot !== 'dialogue-avatar' || !integer(receipt.version, 1) || !integer(receipt.revision, 1)) return fail('Invalid visual command receipt', 409);
    const record = raw.bindings.find(record => record.roleId === receipt.roleId && record.slot === receipt.slot), version = record?.versions.find(version => version.version === receipt.version);
    const audit = audits.find(entry => entry.id === version?.sourceEventId);
    if (!version || version.revision !== receipt.revision || !object(audit?.data) || !object(audit.data.command)
      || audit.data.command.requestId !== receipt.requestId || audit.data.fingerprint !== receipt.fingerprint) return fail('Visual receipt differs from its author audit', 409);
    requests.add(receipt.requestId);
  }
  if (raw.commands.length !== versionCount || audits.length !== versionCount) return fail('Visual binding and command audit counts differ', 409);
  return clone(raw) as unknown as RoleVisualState;
}

/** Pure synchronous UI projection. Source/default resolution is identity-based;
 * absence of image files is a renderer fallback, never a name-based reassignment. */
export function readRoleVisuals(session: Readonly<StoredSession>): RoleVisualsSnapshot {
  const held = readRoleVisualState(session), defaults = session.card.visuals;
  if (defaults !== undefined && !validCardVisualDefaults(defaults)) return fail('Invalid source role visual defaults', 409);
  const result: RoleVisualsSnapshot = { schema: 'rp.role-visuals-view/0.1', visuals: [] };
  for (const role of session.roles) {
    const record = held.bindings.find(record => record.roleId === role.id && record.slot === 'dialogue-avatar'), latest = record?.versions.at(-1);
    if (latest?.value.kind === 'none') continue;
    if (latest?.value.kind === 'asset') result.visuals.push({ roleId: role.id, slot: 'dialogue-avatar', image: clone(latest.value.image), crop: clone(latest.value.crop),
      provenance: { kind: 'author', version: latest.version, revision: latest.revision, sourceEventId: latest.sourceEventId } });
    else if (defaults?.enabled) {
      const source = defaults.defaults.find(entry => entry.roleId === role.id && entry.slot === 'dialogue-avatar');
      if (source) result.visuals.push({ roleId: role.id, slot: 'dialogue-avatar', image: clone(source.image), crop: clone(source.crop),
        provenance: { kind: 'source', ...clone(defaults.source) } });
    }
  }
  return result;
}
function imageReference(asset: VisualImageAsset): VisualImageRef {
  const { assetId, sha256, mimeType, width, height, bytes } = asset; return { assetId, sha256, mimeType, width, height, bytes };
}
export function applyRoleVisualCommand(store: SessionStore, id: string, input: unknown, library: VisualAssetLibrary): VisualCommandResult {
  const command = parseCommand(input), current = store.get(id), held = readRoleVisualState(current), hash = fingerprint(command), prior = held.commands.find(receipt => receipt.requestId === command.requestId);
  if (prior) {
    if (prior.fingerprint !== hash) return fail('This request ID identifies another role visual command', 409);
    return { revision: prior.revision, roleId: prior.roleId, slot: prior.slot, version: prior.version, duplicate: true };
  }
  assertRevision(current, command.expectedRevision);
  if (!integer(current.revision) || current.revision >= Number.MAX_SAFE_INTEGER || current.roles.filter(role => role.id === command.roleId).length !== 1) return fail('Choose one existing native role identity', 409);
  let record = held.bindings.find(record => record.roleId === command.roleId && record.slot === command.slot);
  const latest = record?.versions.at(-1);
  if ((latest?.version ?? 0) !== command.expectedVersion || latest && latest.version >= Number.MAX_SAFE_INTEGER) return fail('Role visual binding version changed', 409);
  let value: VisualBinding;
  if (command.operation === 'bind') {
    const asset = library.list().find(asset => asset.assetId === command.assetId);
    if (!asset || !validVisualImageRef(imageReference(asset))) return fail('Select an existing normalized local library asset');
    value = { kind: 'asset', image: imageReference(asset), crop: clone(command.crop) };
  } else value = { kind: command.operation === 'hide' ? 'none' : 'default' };
  const next = clone(current), version = (latest?.version ?? 0) + 1, revision = current.revision + 1;
  event(next, { kind: 'role-visual-control', actor: 'author', audience: 'author', text: 'Author changed a role image presentation.', data: {
    schema: 'rp.role-visual-control/0.1', roleId: command.roleId, slot: command.slot, version, revision, fingerprint: hash, command: command as unknown as Json, value: clone(value) as unknown as Json,
  } });
  if (!record) { record = { roleId: command.roleId, slot: command.slot, versions: [] }; held.bindings.push(record); }
  record.versions.push({ version, revision, sourceEventId: next.events.at(-1)!.id, value });
  held.commands.push({ requestId: command.requestId, fingerprint: hash, roleId: command.roleId, slot: command.slot, version, revision });
  next.revision = revision; next.visuals = held; readRoleVisuals(next); store.save(next);
  return { revision, roleId: command.roleId, slot: command.slot, version, duplicate: false };
}
export function createRoleVisualsService(library: VisualAssetLibrary): SessionCommandService {
  return { id: ROLE_VISUAL_SERVICE_ID, title: 'Role visual author controller', read: session => {
    const held = readRoleVisualState(session);
    const view: RoleVisualsView = { revision: session.revision, roles: session.roles.map(({ id, name }) => ({ id, name })), assets: clone(library.list()), bindings: held.bindings, current: readRoleVisuals(session) };
    return view;
  }, apply: (store, id, input) => applyRoleVisualCommand(store, id, input, library) };
}
