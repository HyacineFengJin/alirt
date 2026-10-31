import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { TEXT_CARRIER_SERVICE_ID, textCarrierObservationText, type TextCarrierCommand, type TextCarrierCommandResult, type TextCarrierContent,
  type TextCarrierSelection, type TextCarrierState, type TextCarriersView, type TextCarrierTarget } from '../shared/text-carriers';
import type { Json, WorldEvent } from '../shared/types';
import { validateStateJson } from '../shared/state-value-schema';
import { isRemoteInteraction } from '../shared/role-interaction';
import { validateEventLedger } from './event-ledger';
import type { SessionCommandService } from './session-services';
import { ApiError, assertRevision, clone, event, type SessionStore, type StoredSession } from './store';

export interface TextCarrierLedgerSession {
  revision: number; roles: readonly { id: string; name: string }[]; events: readonly WorldEvent[]; textCarriers?: TextCarrierState;
}
const fail = (message: string, status = 400): never => { throw new ApiError(status, status === 409 ? 'TEXT_CARRIER_CONFLICT' : 'TEXT_CARRIER_INPUT', message); };
const obj = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonblank = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const identity = (value: unknown): value is string => nonblank(value) && value.trim() === value && !['__proto__', 'prototype', 'constructor'].includes(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function ordinary(value: unknown) { if (validateStateJson(value).length) fail('Text carriers require ordinary JSON without accessors or unsafe keys'); }
function content(value: unknown): TextCarrierContent {
  ordinary(value);
  if (!obj(value) || !exact(value, ['medium', 'title', 'text', 'location', 'available']) || !['paper', 'screen'].includes(value.medium as string)
    || !nonblank(value.title) || !nonblank(value.text) || !nonblank(value.location) || typeof value.available !== 'boolean') return fail('Provide exact medium, title, text, location and available content');
  return clone(value) as unknown as TextCarrierContent;
}
export function parseTextCarrierSelection(value: unknown): TextCarrierSelection {
  ordinary(value);
  if (!obj(value) || !exact(value, ['carrierId', 'version']) || !identity(value.carrierId) || !positive(value.version)) return fail('Select an exact carrierId and positive integer version');
  return { carrierId: value.carrierId, version: value.version };
}
function command(value: unknown): TextCarrierCommand {
  ordinary(value);
  if (!obj(value) || !identity(value.requestId) || !revision(value.expectedRevision) || !nonblank(value.reason)) return fail('Text carrier commands require requestId, expectedRevision and an explicit reason');
  const common = ['requestId', 'expectedRevision', 'reason', 'operation'];
  if (value.operation === 'create' && exact(value, [...common, 'content'])) content(value.content);
  else if (['update', 'retire'].includes(value.operation as string) && exact(value, [...common, 'carrierId', 'expectedVersion', ...(value.operation === 'update' ? ['content'] : [])])
    && identity(value.carrierId) && positive(value.expectedVersion)) { if (value.operation === 'update') content(value.content); }
  else return fail('Invalid text carrier operation or fields');
  return clone(value) as unknown as TextCarrierCommand;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const fingerprint = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
const empty = (): TextCarrierState => ({ schema: 'rp.text-carriers/0.1', carriers: [], views: [], commands: [] });

/** Validate the private canonical ledger, including immutable version and
 * observation anchors. Reading never synthesizes a carrier or a view. */
export function readTextCarrierState(session: TextCarrierLedgerSession): TextCarrierState {
  const raw = session.textCarriers;
  if (raw === undefined) {
    if (session.events.some(entry => entry.kind === 'text-carrier-control' || entry.kind === 'text-carrier-view-observation')) return fail('Text carrier ledger is missing its retained audit', 409);
    return empty();
  }
  if (validateStateJson(raw).length || validateEventLedger(session.events).length || !obj(raw) || !exact(raw, ['schema', 'carriers', 'views', 'commands'])
    || raw.schema !== 'rp.text-carriers/0.1' || !Array.isArray(raw.carriers) || !Array.isArray(raw.views) || !Array.isArray(raw.commands)) return fail('Invalid retained text carrier ledger', 409);
  const ids = new Set<string>(), eventIds = new Set<string>(), versions = new Map<string, Record<string, unknown>>();
  for (const carrier of raw.carriers) {
    if (!obj(carrier) || !exact(carrier, ['id', 'versions']) || !identity(carrier.id) || ids.has(carrier.id) || !Array.isArray(carrier.versions) || !carrier.versions.length) return fail('Invalid carrier identity or versions', 409);
    ids.add(carrier.id); let previousRevision = -1, retired = false;
    for (const [index, version] of carrier.versions.entries()) {
      if (!obj(version) || !exact(version, ['version', 'retired', 'sourceEventId', 'revision', 'medium', 'title', 'text', 'location', 'available'])
        || version.version !== index + 1 || !positive(version.revision) || version.revision <= previousRevision || version.revision > session.revision
        || typeof version.retired !== 'boolean' || retired || version.retired && version.available !== false || !identity(version.sourceEventId) || eventIds.has(version.sourceEventId))
        return fail('Invalid immutable carrier version', 409);
      content({ medium: version.medium, title: version.title, text: version.text, location: version.location, available: version.available });
      const audits = session.events.filter(entry => entry.id === version.sourceEventId), audit = audits[0];
      if (audits.length !== 1 || audit.kind !== 'text-carrier-control' || audit.actor !== 'author' || audit.audience !== 'author' || !obj(audit.data)
        || audit.data.schema !== 'rp.text-carrier-control-audit/0.1' || audit.data.carrierId !== carrier.id || audit.data.version !== version.version || audit.data.revision !== version.revision)
        return fail('Carrier version differs from its author audit', 409);
      let submitted: TextCarrierCommand;
      try { submitted = command(audit.data.command); } catch { return fail('Invalid retained carrier command', 409); }
      if (!exact(audit.data, ['schema', 'carrierId', 'version', 'revision', 'fingerprint', 'command']) || audit.data.fingerprint !== fingerprint(submitted)
        || submitted.expectedRevision !== version.revision - 1 || (index === 0 ? submitted.operation !== 'create' : submitted.operation === 'create'
          || submitted.carrierId !== carrier.id || submitted.expectedVersion !== index)) return fail('Carrier command differs from its version', 409);
      const expected = submitted.operation === 'retire' ? { ...(carrier.versions[index - 1] as object), available: false } : submitted.content;
      if (version.retired !== (submitted.operation === 'retire') || !isDeepStrictEqual(
        { medium: version.medium, title: version.title, text: version.text, location: version.location, available: version.available },
        { medium: (expected as TextCarrierContent).medium, title: (expected as TextCarrierContent).title, text: (expected as TextCarrierContent).text,
          location: (expected as TextCarrierContent).location, available: (expected as TextCarrierContent).available })) return fail('Carrier content differs from its immutable command', 409);
      eventIds.add(version.sourceEventId); versions.set(JSON.stringify([carrier.id, version.version]), version); previousRevision = version.revision; retired = version.retired;
    }
  }
  const requests = new Set<string>();
  for (const receipt of raw.commands) {
    if (!obj(receipt) || !exact(receipt, ['requestId', 'fingerprint', 'carrierId', 'version', 'revision']) || !identity(receipt.requestId) || requests.has(receipt.requestId)
      || typeof receipt.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) || !identity(receipt.carrierId) || !positive(receipt.version) || !positive(receipt.revision)) return fail('Invalid carrier command receipt', 409);
    const version = versions.get(JSON.stringify([receipt.carrierId, receipt.version])), audit = session.events.find(entry => entry.id === version?.sourceEventId);
    if (!version || version.revision !== receipt.revision || !obj(audit?.data) || audit.data.fingerprint !== receipt.fingerprint
      || !obj(audit.data.command) || audit.data.command.requestId !== receipt.requestId) return fail('Carrier command receipt differs from author audit', 409);
    requests.add(receipt.requestId);
  }
  if (raw.commands.length !== versions.size || session.events.filter(entry => entry.kind === 'text-carrier-control').length !== versions.size) return fail('Carrier version and command audit counts differ', 409);
  const viewIds = new Set<string>(), intentIds = new Set<string>();
  for (const view of raw.views) {
    if (!obj(view) || !exact(view, ['id', 'intentId', 'materialTurnId', 'worldRevision', 'carrierId', 'carrierVersion', 'readerRoleId', 'readerName', 'location', 'time', 'origin', 'carrier', 'observationEventId'])
      || !identity(view.id) || viewIds.has(view.id) || !identity(view.intentId) || intentIds.has(view.intentId) || !identity(view.materialTurnId) || !positive(view.worldRevision)
      || view.worldRevision > session.revision || !identity(view.carrierId) || !positive(view.carrierVersion) || !identity(view.readerRoleId) || !session.roles.some(role => role.id === view.readerRoleId)
      || !nonblank(view.readerName) || !nonblank(view.location) || !(view.time === null || typeof view.time === 'string') || !identity(view.observationEventId)
      || !obj(view.carrier) || !exact(view.carrier, ['medium', 'title', 'text', 'sourceEventId']) || !obj(view.origin)
      || !(view.origin.kind === 'player' && exact(view.origin, ['kind']) || view.origin.kind === 'behavior' && exact(view.origin, ['kind', 'behaviorId']) && identity(view.origin.behaviorId))) return fail('Invalid retained text carrier view receipt', 409);
    const version = versions.get(JSON.stringify([view.carrierId, view.carrierVersion]));
    if (!version || version.retired || !version.available || (version.revision as number) > view.worldRevision || version.location !== view.location
      || !isDeepStrictEqual(view.carrier, { medium: version.medium, title: version.title, text: version.text, sourceEventId: version.sourceEventId })) return fail('View snapshot differs from its immutable carrier version', 409);
    const observations = session.events.filter(entry => entry.id === view.observationEventId), observation = observations[0];
    if (observations.length !== 1 || observation.kind !== 'text-carrier-view-observation' || observation.actor !== 'host' || observation.audience !== 'author'
      || observation.turnId !== view.materialTurnId || !isDeepStrictEqual(observation.data, { schema: 'rp.text-carrier-view-observation/0.1', sceneId: 'main', observerRoleIds: [view.readerRoleId], viewId: view.id })
      || observation.text !== textCarrierObservationText(view as unknown as TextCarrierState['views'][number])) return fail('View observation differs from its immutable receipt', 409);
    if (!session.events.some(entry => entry.turnId === view.materialTurnId && entry.kind === 'world-adjudication' && entry.actor === 'world' && entry.audience === 'author')) return fail('View receipt has no committed world adjudication', 409);
    viewIds.add(view.id); intentIds.add(view.intentId);
  }
  if (session.events.filter(entry => entry.kind === 'text-carrier-view-observation').length !== raw.views.length) return fail('Text carrier observations differ from retained receipts', 409);
  return clone(raw) as unknown as TextCarrierState;
}

export function textCarrierTargets(session: Readonly<StoredSession>, roleId: string): TextCarrierTarget[] {
  const state = readTextCarrierState(session), roles = session.roles.filter(role => role.id === roleId), role = roles[0];
  if (roles.length !== 1 || role.phase !== 'active' || role.presence !== 'present' || isRemoteInteraction(role.interaction) || !nonblank(session.world.location)) return [];
  return state.carriers.flatMap(carrier => {
    const version = carrier.versions.at(-1)!;
    return version.available && !version.retired && version.location === session.world.location
      ? [{ carrierId: carrier.id, version: version.version, medium: version.medium, title: version.title, location: version.location }] : [];
  });
}
export function readTextCarriers(session: Readonly<StoredSession>): TextCarriersView {
  const state = readTextCarrierState(session);
  return { revision: session.revision, carriers: state.carriers, views: state.views, targets: textCarrierTargets(session, session.playerRoleId) };
}
export function applyTextCarrierCommand(store: SessionStore, id: string, input: unknown): TextCarrierCommandResult {
  const value = command(input), current = store.get(id), held = readTextCarrierState(current), hash = fingerprint(value), previous = held.commands.find(entry => entry.requestId === value.requestId);
  if (previous) {
    if (previous.fingerprint !== hash) return fail('This request ID already identifies another carrier command', 409);
    return { revision: previous.revision, carrierId: previous.carrierId, version: previous.version, duplicate: true };
  }
  assertRevision(current, value.expectedRevision);
  if (!revision(current.revision) || current.revision >= Number.MAX_SAFE_INTEGER) return fail('Session revision exhausted', 409);
  const next = clone(current), carrier = value.operation === 'create' ? { id: randomUUID(), versions: [] as TextCarrierState['carriers'][number]['versions'] }
    : held.carriers.find(carrier => carrier.id === value.carrierId);
  if (!carrier) return fail('Unknown carrier', 409);
  const prior = carrier.versions.at(-1);
  if (value.operation !== 'create' && (!prior || prior.version !== value.expectedVersion || prior.retired)) return fail('Carrier version changed or is retired', 409);
  if (prior && prior.version >= Number.MAX_SAFE_INTEGER) return fail('Carrier version exhausted', 409);
  const version = (prior?.version ?? 0) + 1, appliedRevision = current.revision + 1;
  event(next, { kind: 'text-carrier-control', actor: 'author', audience: 'author', text: 'Author calibrated a text carrier.', data: {
    schema: 'rp.text-carrier-control-audit/0.1', carrierId: carrier.id, version, revision: appliedRevision, fingerprint: hash, command: value as unknown as Json,
  } });
  const body = value.operation === 'retire' ? { medium: prior!.medium, title: prior!.title, text: prior!.text, location: prior!.location, available: false } : value.content;
  carrier.versions.push({ ...body, version, retired: value.operation === 'retire', sourceEventId: next.events.at(-1)!.id, revision: appliedRevision });
  if (value.operation === 'create') held.carriers.push(carrier);
  held.commands.push({ requestId: value.requestId, fingerprint: hash, carrierId: carrier.id, version, revision: appliedRevision });
  next.revision = appliedRevision; next.textCarriers = held; readTextCarrierState(next); store.save(next);
  return { revision: appliedRevision, carrierId: carrier.id, version, duplicate: false };
}
export const textCarriersService: SessionCommandService = { id: TEXT_CARRIER_SERVICE_ID, title: 'Text carrier author controller', read: readTextCarriers, apply: applyTextCarrierCommand };
