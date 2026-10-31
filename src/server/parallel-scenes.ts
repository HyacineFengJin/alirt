import { createHash } from 'node:crypto';
import { PARALLEL_SCENES_SERVICE_ID, validateParallelSceneDefinition, validateParallelScenesCommand, type ParallelAppearanceEvidence, type ParallelSceneDiagnostic, type ParallelSceneGrant, type ParallelSceneParticipantView, type ParallelSceneReadiness, type ParallelSceneRoleView, type ParallelSceneSelection, type ParallelScenesCommand, type ParallelScenesResult, type ParallelScenesView } from '../shared/parallel-scenes';
import type { BehaviorCandidate } from '../shared/behavior';
import type { Json, RoleDefinition, WorldEvent } from '../shared/types';
import { isRemoteInteraction } from '../shared/role-interaction';
import { validateStateFieldDefinition, validateStateFieldValue, validateStateJson } from '../shared/state-value-schema';
import { parseBehaviorApproval } from './behavior-runtime';
import { validateEventLedger } from './event-ledger';
import { initializationContext } from './initialization-runtime';
import type { SessionCommandService } from './session-services';
import { assertRevision, clone, event, fail, mayRead, type SessionStore, type StoredSession } from './store';

const schema = 'rp.parallel-scenes/0.1';
interface Receipt { requestId: string; fingerprint: string; revision: number }
interface Registry { schema: typeof schema; grants: ParallelSceneGrant[]; archives: ParallelSceneGrant[]; selectedSceneIds: string[]; receipts: Receipt[] }
const integrity = (message: string): never => fail('PARALLEL_SCENES_INTEGRITY', message, 409);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonblank = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
function exactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key) && (() => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return descriptor.enumerable && 'value' in descriptor;
  })());
}
function stable(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const fingerprint = (command: ParallelScenesCommand) => createHash('sha256').update(stable(command as unknown as Json)).digest('hex');
function increment(value: number) { if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) return integrity('Parallel scene counter exhausted'); return value + 1; }
const maximum = (values: Iterable<number>) => { let max = 0; for (const value of values) max = Math.max(max, value); return max; };

function ledger(session: Readonly<StoredSession>): readonly WorldEvent[] {
  if (validateEventLedger(session.events).length) return integrity('Invalid retained event ledger');
  const ids = new Set<string>();
  for (const entry of session.events) {
    if (!entry || !nonblank(entry.id) || ids.has(entry.id)) return integrity('Retained event identities must be unique');
    ids.add(entry.id);
  }
  return session.events;
}
function noSharedSelectedRoles(data: Registry): boolean {
  const roles = new Set<string>();
  for (const id of data.selectedSceneIds) {
    const grant = data.grants.find(item => item.id === id) ?? data.archives.filter(item => item.id === id).at(-1);
    if (!grant) return false;
    for (const roleId of grant.participantRoleIds) { if (roles.has(roleId)) return false; roles.add(roleId); }
  }
  return true;
}
function registry(session: Readonly<StoredSession>): Registry {
  const raw = session.hostServices?.[PARALLEL_SCENES_SERVICE_ID], audits = ledger(session).filter(entry => entry.kind === 'parallel-scenes-control');
  if (raw === undefined) {
    if (audits.length) return integrity('Parallel scene receipts are missing; retained audit requires review');
    return { schema, grants: [], archives: [], selectedSceneIds: [], receipts: [] };
  }
  if (!exactRecord(raw, ['schema', 'grants', 'archives', 'selectedSceneIds', 'receipts']) || raw.schema !== schema
    || validateEventLedger(raw.grants).length || validateEventLedger(raw.archives).length || validateEventLedger(raw.receipts).length
    || validateStateJson(raw.selectedSceneIds).length || !Array.isArray(raw.selectedSceneIds) || raw.selectedSceneIds.length > 2
    || raw.selectedSceneIds.some(id => !nonblank(id)) || new Set(raw.selectedSceneIds).size !== raw.selectedSceneIds.length) return integrity('Invalid retained parallel scene registry');
  const data = clone(raw) as unknown as Registry, currentIds = new Set<string>(), versions = new Map<string, Set<number>>();
  for (const grant of [...data.archives, ...data.grants]) {
    if (validateParallelSceneDefinition(grant, true).length) return integrity('Invalid retained parallel scene grant');
    const seen = versions.get(grant.id) ?? new Set<number>();
    if (seen.has(grant.generation)) return integrity('Parallel scene generations must never be reused');
    seen.add(grant.generation); versions.set(grant.id, seen);
  }
  for (const seen of versions.values()) if (maximum(seen) !== seen.size) return integrity('Parallel scene generation history is incomplete');
  for (const grant of data.grants) {
    if (currentIds.has(grant.id) || grant.generation !== maximum(versions.get(grant.id)!)) return integrity('Current parallel scene grant is not its latest generation');
    currentIds.add(grant.id);
  }
  if (data.selectedSceneIds.some(id => !versions.has(id)) || !noSharedSelectedRoles(data)) return integrity('Selected parallel scenes are invalid or share an actor');
  const ids = new Set<string>(); let revision = 0;
  for (const receipt of data.receipts) {
    if (!exactRecord(receipt, ['requestId', 'fingerprint', 'revision']) || !nonblank(receipt.requestId) || ids.has(receipt.requestId)
      || typeof receipt.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) || !Number.isSafeInteger(receipt.revision) || receipt.revision <= revision || receipt.revision > session.revision) return integrity('Invalid parallel scene receipt');
    const matching = audits.filter(entry => record(entry.data) && entry.data.requestId === receipt.requestId), audit = matching[0];
    if (matching.length !== 1 || audit.actor !== 'author' || audit.audience !== 'author' || !record(audit.data)
      || audit.data.schema !== 'rp.parallel-scenes-control-audit/0.1' || audit.data.fingerprint !== receipt.fingerprint || audit.data.revision !== receipt.revision || !nonblank(audit.data.reason)) return integrity('Parallel scene receipt does not match its private audit');
    ids.add(receipt.requestId); revision = receipt.revision;
  }
  if (audits.length !== data.receipts.length) return integrity('Parallel scene receipts do not match retained audits');
  return data;
}

/** Appearance is host staging or exact world-approved behavior, never a current
 * lifecycle flag, relationship selection, prose string or raw role result. */
export function parallelAppearanceEvidence(session: Readonly<StoredSession>): Map<string, ParallelAppearanceEvidence[]> {
  const events = ledger(session), result = new Map<string, ParallelAppearanceEvidence[]>();
  const known = new Set(session.roles.filter(role => role.id !== session.playerRoleId).map(role => role.id));
  const append = (evidence: ParallelAppearanceEvidence) => {
    const existing = result.get(evidence.roleId) ?? [];
    if (!existing.some(item => item.kind === evidence.kind)) existing.push(evidence);
    result.set(evidence.roleId, existing);
  };
  let setup: ReturnType<typeof initializationContext>;
  try { setup = initializationContext(session); }
  catch { return integrity('Initialization appearance receipt requires review'); }
  if (setup && session.initialization) for (const cast of setup.opening.cast) {
    if (known.has(cast.roleId) && cast.phase === 'active' && (cast.presence === 'present' || cast.presence === 'absent' && isRemoteInteraction(cast.interaction))) append({ kind: 'opening-cast', roleId: cast.roleId, openingId: setup.opening.id, definitionHash: session.initialization.definitionHash });
  }
  const behaviorIdCounts = new Map<string, number>();
  for (const entry of events) if (entry.kind === 'role-behavior' && entry.audience === 'public' && record(entry.data) && typeof entry.data.id === 'string') behaviorIdCounts.set(entry.data.id, (behaviorIdCounts.get(entry.data.id) ?? 0) + 1);
  for (const entry of events) {
    const data = entry.data;
    if (entry.kind !== 'role-behavior' || entry.audience !== 'public' || !known.has(entry.actor) || !nonblank(entry.turnId)
      || !session.turns.some(turn => turn.id === entry.turnId) || !record(data) || !nonblank(data.id) || behaviorIdCounts.get(data.id) !== 1
      || data.roleId !== entry.actor || !['speech', 'action'].includes(data.kind as string) || !nonblank(data.text) || data.text !== entry.text
      || !Object.keys(data).every(key => ['id', 'roleId', 'kind', 'text', 'interaction'].includes(key))
      || data.interaction !== undefined && (!isRemoteInteraction(data.interaction) || data.kind !== 'speech')) continue;
    const world = events.filter(event => event.turnId === entry.turnId && event.kind === 'world-adjudication' && event.actor === 'world' && event.audience === 'author');
    const audits = events.filter(event => event.turnId === entry.turnId && event.kind === 'behavior-adjudication' && event.actor === 'world' && event.audience === 'author');
    if (world.length !== 1 || audits.length !== 1 || !record(audits[0].data) || !Array.isArray(audits[0].data.candidates)) continue;
    let approved: BehaviorCandidate[];
    try { approved = parseBehaviorApproval(audits[0].data, audits[0].data.candidates as unknown as BehaviorCandidate[]).acceptedBehaviors; }
    catch { continue; }
    const candidate = approved.find(candidate => candidate.id === data.id);
    if (!candidate || candidate.roleId !== entry.actor || candidate.kind !== data.kind || candidate.text !== data.text
      || !Object.keys(candidate).every(key => ['id', 'roleId', 'kind', 'text', 'interaction'].includes(key))
      || (candidate.interaction?.mode ?? null) !== (isRemoteInteraction(data.interaction) ? data.interaction.mode : null)
      || (isRemoteInteraction(candidate.interaction) ? candidate.interaction.channel : null) !== (isRemoteInteraction(data.interaction) ? data.interaction.channel : null)) continue;
    append({ kind: 'approved-behavior', roleId: entry.actor, eventId: entry.id, turnId: entry.turnId, behaviorId: data.id });
  }
  return result;
}

function heldValue(role: RoleDefinition, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(role.state, key);
  return descriptor?.enumerable && 'value' in descriptor ? descriptor.value : undefined;
}
const diagnostic = (code: string, message: string, roleId?: string): ParallelSceneDiagnostic => ({ code, message, ...(roleId ? { roleId } : {}) });
function rolesView(session: Readonly<StoredSession>): ParallelSceneRoleView[] {
  const evidence = parallelAppearanceEvidence(session);
  return session.roles.filter(role => role.id !== session.playerRoleId).map(role => {
    const diagnostics: ParallelSceneDiagnostic[] = [];
    if (role.phase !== 'active') diagnostics.push(diagnostic('role-inactive', 'Actor must already be active; this grant never activates it.', role.id));
    if (role.presence !== 'absent') diagnostics.push(diagnostic('role-present', 'Actor must be absent from the main scene.', role.id));
    const interactionValid = role.interaction === undefined || !validateStateJson(role.interaction).length
      && (isRemoteInteraction(role.interaction) || exactRecord(role.interaction, ['mode']) && role.interaction.mode === 'local');
    if (!interactionValid) diagnostics.push(diagnostic('role-interaction-invalid', 'Actor interaction metadata requires review before this grant can run.', role.id));
    else if (isRemoteInteraction(role.interaction)) diagnostics.push(diagnostic('role-main-remote', 'Remove the main-scene remote grant through an explicit lifecycle command first.', role.id));
    const appearanceEvidence = evidence.get(role.id) ?? [];
    if (!appearanceEvidence.length) diagnostics.push(diagnostic('appearance-unknown', 'No validated opening-cast or approved-behavior appearance evidence.', role.id));
    const readableStringFields = session.fields.filter(field => field.type === 'string' && mayRead(field.audience, role.id)
      && session.fields.filter(other => other.key === field.key).length === 1 && !validateStateFieldDefinition(field).length).map(field => {
      const held = heldValue(role, field.key), known = nonblank(held) && !validateStateFieldValue(field, held, { initial: true }).length;
      return { key: field.key, label: field.label, value: known ? held : null, known };
    });
    return { roleId: role.id, name: role.name, phase: role.phase, presence: role.presence, interaction: interactionValid ? clone(role.interaction ?? null) : null, appearanceEvidence,
      readableStringFields, heldStringKeys: readableStringFields.filter(field => field.known).map(field => field.key), ready: !diagnostics.length, diagnostics };
  });
}
function readiness(session: Readonly<StoredSession>, grant: ParallelSceneGrant, roles: ParallelSceneRoleView[]): ParallelSceneReadiness {
  const diagnostics: ParallelSceneDiagnostic[] = [], participants: ParallelSceneParticipantView[] = [];
  if (!grant.enabled) diagnostics.push(diagnostic('scene-disabled', 'Scene grant is disabled.'));
  for (const id of grant.participantRoleIds) {
    const role = roles.find(role => role.roleId === id);
    if (!role) { diagnostics.push(diagnostic('role-unknown', 'Scene refers to an unavailable or player identity.', id)); continue; }
    const field = role.readableStringFields.find(field => field.key === grant.locationKey), value = field?.value ?? null;
    const participant = { ...clone(role), location: { key: grant.locationKey, value, readable: !!field } };
    participants.push(participant); diagnostics.push(...role.diagnostics);
    if (!field) diagnostics.push(diagnostic('location-unreadable', 'Location binding needs an existing own-readable string field.', id));
    else if (value === null) diagnostics.push(diagnostic('location-unknown', 'Location is absent, blank or invalid; the main world location is not a fallback.', id));
  }
  const values = participants.map(role => role.location.value), location = values.length === grant.participantRoleIds.length && values.every(value => value !== null && value === values[0]) ? values[0] : null;
  if (values.some(value => value !== null) && values.some(value => value !== values[0])) diagnostics.push(diagnostic('location-mismatch', 'All participant location bindings must have the same held literal.'));
  return { sceneId: grant.id, ready: !diagnostics.length && location !== null, location, participants, diagnostics };
}
function view(session: Readonly<StoredSession>, data: Registry): ParallelScenesView {
  const roles = rolesView(session), sceneReadiness = data.grants.map(grant => readiness(session, grant, roles));
  for (const id of data.selectedSceneIds) if (!data.grants.some(grant => grant.id === id)) sceneReadiness.push({ sceneId: id, ready: false, location: null, participants: [], diagnostics: [diagnostic('scene-removed', 'Selected scene is archived; explicitly change the selection or recreate a new grant generation.')] });
  return { schema: 'rp.parallel-scenes-control/0.1', revision: session.revision, grants: clone(data.grants), archives: clone(data.archives), selectedSceneIds: [...data.selectedSceneIds], roles, sceneReadiness };
}
export function readParallelScenes(session: Readonly<StoredSession>): ParallelScenesView { return view(session, registry(session)); }
/** Only readiness; the producer still checks source output/module/runtime gates.
 * This helper dispatches nothing and never alters lifecycle or declared state. */
export function selectParallelScenes(session: Readonly<StoredSession>): ParallelSceneSelection {
  const current = readParallelScenes(session), scenes: ParallelSceneSelection['scenes'] = [], blocked: ParallelSceneSelection['blocked'] = [];
  for (const id of current.selectedSceneIds) {
    const ready = current.sceneReadiness.find(scene => scene.sceneId === id)!, grant = current.grants.find(scene => scene.id === id);
    if (!ready.ready || !grant || ready.location === null) blocked.push({ sceneId: id, diagnostics: clone(ready.diagnostics) });
    else scenes.push({ ...clone(grant), location: ready.location, participants: clone(ready.participants) });
  }
  return { scenes, blocked };
}

export function applyParallelScenes(store: SessionStore, id: string, input: unknown): ParallelScenesResult {
  const issue = validateParallelScenesCommand(input)[0]; if (issue) return fail('PARALLEL_SCENES_INPUT', `${issue.path}: ${issue.message}`);
  const command = clone(input) as ParallelScenesCommand, current = store.get(id), data = registry(current), digest = fingerprint(command);
  const previous = data.receipts.find(receipt => receipt.requestId === command.requestId);
  if (previous) {
    if (previous.fingerprint !== digest) return fail('PARALLEL_SCENES_REQUEST', 'This request ID identifies a different author command', 409);
    return { ...view(current, data), requestId: command.requestId, duplicate: true, appliedRevision: previous.revision };
  }
  assertRevision(current, command.expectedRevision);
  if (command.operation === 'upsert') {
    if (command.scene.participantRoleIds.some(roleId => roleId === current.playerRoleId || current.roles.filter(role => role.id === roleId).length !== 1)) return fail('PARALLEL_SCENES_IDENTITY', 'Scene participants must be existing unique nonplayer native identities');
    const old = data.grants.find(grant => grant.id === command.scene.id);
    const generations = [...data.archives, ...data.grants].filter(grant => grant.id === command.scene.id).map(grant => grant.generation);
    const generation = generations.length ? increment(maximum(generations)) : 1;
    if (old) data.archives.push(clone(old));
    data.grants = data.grants.filter(grant => grant.id !== command.scene.id);
    data.grants.push({ ...clone(command.scene), generation });
  } else if (command.operation === 'remove') {
    const old = data.grants.find(grant => grant.id === command.sceneId);
    if (!old) return fail('PARALLEL_SCENES_UNKNOWN', 'Scene grant is not current', 404);
    data.archives.push(clone(old)); data.grants = data.grants.filter(grant => grant.id !== command.sceneId);
  } else {
    if (command.selectedSceneIds.some(sceneId => !data.grants.some(grant => grant.id === sceneId))) return fail('PARALLEL_SCENES_UNKNOWN', 'Select current scene grants', 404);
    data.selectedSceneIds = [...command.selectedSceneIds];
  }
  if (!noSharedSelectedRoles(data)) return fail('PARALLEL_SCENES_OVERLAP', 'Two selected scenes cannot share an actor');
  const next = clone(current); next.revision = increment(current.revision);
  data.receipts.push({ requestId: command.requestId, fingerprint: digest, revision: next.revision });
  next.hostServices = { ...next.hostServices, [PARALLEL_SCENES_SERVICE_ID]: data as unknown as Json };
  event(next, { kind: 'parallel-scenes-control', actor: 'author', audience: 'author', text: 'Author changed parallel scene grants.', data: {
    schema: 'rp.parallel-scenes-control-audit/0.1', requestId: command.requestId, fingerprint: digest, reason: command.reason, revision: next.revision,
  } });
  const result = { ...readParallelScenes(next), requestId: command.requestId, duplicate: false, appliedRevision: next.revision };
  store.save(next); return result;
}
export const parallelScenesService: SessionCommandService = { id: PARALLEL_SCENES_SERVICE_ID, title: 'Parallel scenes author controller', read: readParallelScenes, apply: applyParallelScenes };
