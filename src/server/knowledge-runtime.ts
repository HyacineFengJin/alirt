import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { textCarrierObservationText, type TextCarrierState, type TextCarrierViewReceipt } from '../shared/text-carriers';
import { validateStateJson } from '../shared/state-value-schema';
import type { Audience, Knowledge, RoleDefinition, WorldEvent } from '../shared/types';
import type { KnowledgeDelivery, KnowledgeEdit, KnowledgeObservation, KnowledgeOrigin, KnowledgeRegistry, KnowledgeSource, ProvenancedKnowledge } from '../shared/knowledge';
import { validateEventLedger } from './event-ledger';

export interface KnowledgeSession {
  roles: RoleDefinition[];
  knowledgeRegistry?: KnowledgeRegistry;
  events?: WorldEvent[];
  revision?: number;
  textCarriers?: TextCarrierState;
}
export class KnowledgeError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
function reject(code: string, message: string): never { throw new KnowledgeError(code, message); }
const copy = <T>(value: T): T => structuredClone(value);
const safeId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !['__proto__', 'constructor', 'prototype'].includes(value);
const readable = (audience: Audience, role: string) => role === 'author' || audience === 'public' || Array.isArray(audience) && audience.includes(role);
const active = (knowledge: ProvenancedKnowledge) => !knowledge.lifecycle || knowledge.lifecycle === 'active';
const initialId = (roleId: string, knowledgeId: string) => `card:${encodeURIComponent(roleId)}:${encodeURIComponent(knowledgeId)}`;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function carrierCommandFingerprint(value: unknown): string {
  function canonical(node: any): any {
    if (Array.isArray(node)) return node.map(canonical);
    return node && typeof node === 'object' ? Object.fromEntries(Object.keys(node).sort().map(key => [key, canonical(node[key])])) : node;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
/** This local proof deliberately has no dependency on the carrier controller or
 * the store: observation knowledge must remain safe during store migration. */
function carrierObservation(session: KnowledgeSession, roleId: string, event: WorldEvent, observation: KnowledgeObservation): WorldEvent {
  const state = session.textCarriers;
  if (observation.sceneId !== 'main' || event.actor !== 'host' || event.audience !== 'author' || !record(event.data)
    || !exact(event.data, ['schema', 'sceneId', 'observerRoleIds', 'viewId']) || event.data.schema !== 'rp.text-carrier-view-observation/0.1'
    || event.data.sceneId !== 'main' || !isDeepStrictEqual(event.data.observerRoleIds, [roleId]) || !safeId(event.data.viewId)
    || validateStateJson(state).length || !record(state) || !exact(state, ['schema', 'carriers', 'views', 'commands'])
    || state.schema !== 'rp.text-carriers/0.1' || !Array.isArray(state.carriers) || !Array.isArray(state.views) || !Array.isArray(state.commands)
    || !Number.isSafeInteger(session.revision)) reject('KNOWLEDGE_OBSERVATION', 'Carrier observation requires its exact private receipt and reader');
  const receipts = state.views.filter(view => view.id === (event.data as Record<string, unknown>).viewId), view = receipts[0];
  if (receipts.length !== 1 || !record(view) || !exact(view, ['id', 'intentId', 'materialTurnId', 'worldRevision', 'carrierId', 'carrierVersion', 'readerRoleId', 'readerName', 'location', 'time', 'origin', 'carrier', 'observationEventId'])
    || !safeId(view.id) || !safeId(view.intentId) || !safeId(view.materialTurnId) || view.materialTurnId !== event.turnId
    || view.readerRoleId !== roleId || !(typeof view.readerName === 'string' && view.readerName.trim()) || !(typeof view.location === 'string' && view.location.trim()) || !(view.time === null || typeof view.time === 'string')
    || view.observationEventId !== event.id || state.views.filter(other => other.observationEventId === event.id).length !== 1
    || !Number.isSafeInteger(view.worldRevision) || view.worldRevision < 1 || view.worldRevision > session.revision!
    || !safeId(view.carrierId) || !Number.isSafeInteger(view.carrierVersion) || view.carrierVersion < 1
    || !record(view.carrier) || !exact(view.carrier, ['medium', 'title', 'text', 'sourceEventId']) || !record(view.origin)
    || !(view.origin.kind === 'player' && exact(view.origin, ['kind']) || view.origin.kind === 'behavior' && exact(view.origin, ['kind', 'behaviorId']) && safeId(view.origin.behaviorId)))
    reject('KNOWLEDGE_OBSERVATION', 'Carrier observation differs from its immutable reader or material turn');
  const carriers = state.carriers.filter(carrier => carrier.id === view.carrierId), carrier = carriers[0];
  const versions = Array.isArray(carrier?.versions) ? carrier.versions.filter(version => version.version === view.carrierVersion) : [], version = versions[0];
  if (carriers.length !== 1 || !record(carrier) || !exact(carrier, ['id', 'versions']) || versions.length !== 1 || !record(version) || !exact(version, ['version', 'retired', 'sourceEventId', 'revision', 'medium', 'title', 'text', 'location', 'available'])
    || version.retired !== false || version.available !== true || !Number.isSafeInteger(version.revision) || version.revision < 1 || version.revision > view.worldRevision
    || version.location !== view.location || !['paper', 'screen'].includes(version.medium) || !(typeof version.title === 'string' && version.title.trim()) || typeof version.text !== 'string' || !version.text.trim()
    || !isDeepStrictEqual(view.carrier, { medium: version.medium, title: version.title, text: version.text, sourceEventId: version.sourceEventId }))
    reject('KNOWLEDGE_OBSERVATION', 'Carrier observation snapshot differs from its canonical version');
  const audits = session.events!.filter(source => source.id === version.sourceEventId), audit = audits[0], data = audit?.data;
  if (audits.length !== 1 || audit.kind !== 'text-carrier-control' || audit.actor !== 'author' || audit.audience !== 'author' || !record(data)
    || !exact(data, ['schema', 'carrierId', 'version', 'revision', 'fingerprint', 'command']) || data.schema !== 'rp.text-carrier-control-audit/0.1'
    || data.carrierId !== view.carrierId || data.version !== view.carrierVersion || data.revision !== version.revision || !record(data.command)
    || !(data.command.operation === 'create' && view.carrierVersion === 1 && exact(data.command, ['requestId', 'expectedRevision', 'reason', 'operation', 'content'])
      || data.command.operation === 'update' && exact(data.command, ['requestId', 'expectedRevision', 'reason', 'operation', 'carrierId', 'expectedVersion', 'content'])
        && data.command.carrierId === view.carrierId && data.command.expectedVersion === view.carrierVersion - 1)
    || !safeId(data.command.requestId) || typeof data.command.reason !== 'string' || !data.command.reason.trim()
    || data.fingerprint !== carrierCommandFingerprint(data.command) || data.command.expectedRevision !== version.revision - 1
    || !isDeepStrictEqual(data.command.content, { medium: version.medium, title: version.title, text: version.text, location: version.location, available: version.available })
    || !session.events!.some(source => source.kind === 'world-adjudication' && source.actor === 'world' && source.audience === 'author' && source.turnId === view.materialTurnId)
    || event.text !== textCarrierObservationText(view as TextCarrierViewReceipt)) reject('KNOWLEDGE_OBSERVATION', 'Carrier observation lacks matching version, adjudication or literal text');
  const commands = state.commands.filter(command => command.requestId === (data.command as Record<string, unknown>).requestId);
  if (commands.length !== 1 || !isDeepStrictEqual(commands[0], { requestId: data.command.requestId, fingerprint: data.fingerprint,
    carrierId: view.carrierId, version: view.carrierVersion, revision: version.revision })) reject('KNOWLEDGE_OBSERVATION', 'Carrier observation command receipt differs from its canonical source');
  return event;
}
function observationEvent(session: KnowledgeSession, roleId: string, observation: KnowledgeObservation): WorldEvent {
  if (validateStateJson(observation).length || !record(observation) || Object.keys(observation).length !== 2 || !safeId(observation.eventId) || !safeId(observation.sceneId)
    || validateEventLedger(session.events).length) reject('KNOWLEDGE_OBSERVATION', 'Observation requires a valid retained event ledger and identity');
  const matches = session.events!.filter(event => event.id === observation.eventId), event = matches[0];
  if (matches.length === 1 && event?.kind === 'text-carrier-view-observation') return carrierObservation(session, roleId, event, observation);
  if (matches.length !== 1 || !event || event.audience !== 'author' || !['parallel-behavior', 'parallel-world-event'].includes(event.kind)
    || !record(event.data) || event.data.sceneId !== observation.sceneId || !Array.isArray(event.data.observerRoleIds)
    || !event.data.observerRoleIds.includes(roleId) || new Set(event.data.observerRoleIds).size !== event.data.observerRoleIds.length
    || event.data.observerRoleIds.some(id => typeof id !== 'string' || !session.roles.some(role => role.id === id))
    || typeof event.text !== 'string' || !event.text.trim()) reject('KNOWLEDGE_OBSERVATION', 'The owner did not observe a retained approved parallel event');
  if (event.kind === 'parallel-behavior' && (event.actor !== roleId || !record(event.data.behavior)
    || event.data.behavior.roleId !== roleId || event.data.behavior.text !== event.text || !['speech', 'action'].includes(event.data.behavior.kind as string)))
    reject('KNOWLEDGE_OBSERVATION', 'Behavior observation must be the actor\'s own approved event');
  if (event.kind === 'parallel-world-event' && (event.actor !== 'parallel-world' || !record(event.data.fact) || event.data.fact.text !== event.text))
    reject('KNOWLEDGE_OBSERVATION', 'Fact observation must match committed scene material');
  return event;
}

function observationText(event: WorldEvent): string {
  if (event.kind === 'text-carrier-view-observation') return `载体观察：${event.text}`;
  return event.kind === 'parallel-behavior' ? `场外已批准${(event.data as any).behavior.kind === 'speech' ? '发言' : '行动'}：${event.text}` : `场外已观察事件：${event.text}`;
}

function validateAudience(value: unknown, roles: RoleDefinition[]): asserts value is Audience {
  if (value === 'public' || value === 'author') return;
  if (!Array.isArray(value) || value.some(id => !safeId(id) || !roles.some(role => role.id === id)) || new Set(value).size !== value.length) {
    reject('KNOWLEDGE_AUDIENCE', 'Knowledge audience must name existing roles, public, or author');
  }
}
function refs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(id => !safeId(id))) reject('KNOWLEDGE_SOURCE', 'Invalid knowledge source references');
  return [...new Set(value as string[])];
}
function registry(session: KnowledgeSession): KnowledgeRegistry {
  return session.knowledgeRegistry ?? reject('KNOWLEDGE_REGISTRY', 'Knowledge registry is not initialized');
}
function sourceMap(session: KnowledgeSession): Map<string, KnowledgeSource> {
  return new Map(registry(session).sources.map(source => [source.id, source]));
}

/** Validate the complete graph before a proposal can be committed. Array/Map lookup is prototype safe. */
function validateGraph(session: KnowledgeSession) {
  const ledger = registry(session);
  if (ledger.schema !== 'rp.knowledge/0.1' || !Array.isArray(ledger.sources) || !Array.isArray(ledger.history)) reject('KNOWLEDGE_REGISTRY', 'Invalid knowledge registry');
  const sources = new Map<string, KnowledgeSource>();
  for (const source of ledger.sources) {
    if (!safeId(source.id) || sources.has(source.id)) reject('KNOWLEDGE_SOURCE', 'Duplicate or invalid knowledge source id');
    if (!session.roles.some(role => role.id === source.ownerRoleId) || !safeId(source.knowledgeId)) reject('KNOWLEDGE_SOURCE', 'Invalid source owner');
    if (!['card', 'author', 'derived', 'peer'].includes(source.kind) || !['active', 'withdrawn', 'stale'].includes(source.lifecycle) || !['known', 'uncertain'].includes(source.certainty) || typeof source.text !== 'string') reject('KNOWLEDGE_SOURCE', 'Invalid knowledge source');
    validateAudience(source.audience, session.roles);
    source.sourceRefs = refs(source.sourceRefs);
    if (source.observation !== undefined) {
      const event = observationEvent(session, source.ownerRoleId, source.observation);
      if (source.kind !== 'derived' || source.sourceRefs.length || source.certainty !== 'known'
        || JSON.stringify(source.audience) !== JSON.stringify([source.ownerRoleId]) || source.text !== observationText(event))
        reject('KNOWLEDGE_OBSERVATION', 'Observation source differs from its owner or canonical event');
    }
    sources.set(source.id, source);
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  function visit(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) reject('KNOWLEDGE_CYCLE', 'Knowledge source references contain a cycle');
    const source = sources.get(id) ?? reject('KNOWLEDGE_SOURCE', 'Unknown knowledge source reference');
    visiting.add(id);
    for (const dependency of source.sourceRefs) visit(dependency);
    visiting.delete(id); visited.add(id);
  }
  for (const source of sources.values()) visit(source.id);
  for (const role of session.roles) {
    const ids = new Set<string>();
    for (const raw of role.knowledge) {
      const entry = raw as ProvenancedKnowledge;
      if (!safeId(entry.id) || ids.has(entry.id)) reject('KNOWLEDGE_ID', 'Duplicate or invalid knowledge id');
      ids.add(entry.id);
      if (typeof entry.text !== 'string' || !['known', 'uncertain'].includes(entry.status) || entry.lifecycle && !['active', 'withdrawn', 'stale'].includes(entry.lifecycle)) reject('KNOWLEDGE_ENTRY', 'Invalid knowledge entry');
      validateAudience(entry.audience, session.roles);
      const source = entry.provenance && sources.get(entry.provenance.sourceId);
      if (!source || source.ownerRoleId !== role.id || source.knowledgeId !== entry.id || source.text !== entry.text || source.certainty !== entry.status || source.lifecycle !== (entry.lifecycle ?? 'active') || JSON.stringify(source.audience) !== JSON.stringify(entry.audience) || JSON.stringify(source.sourceRefs) !== JSON.stringify(refs(entry.provenance?.sourceRefs)) || source.kind !== entry.provenance?.kind) reject('KNOWLEDGE_SOURCE', 'Knowledge does not match its registered source');
      if (JSON.stringify(source.observation) !== JSON.stringify(entry.provenance?.observation)) reject('KNOWLEDGE_OBSERVATION', 'Observation provenance differs from its source');
      if (source.lifecycle === 'active' && source.sourceRefs.some(id => sources.get(id)?.lifecycle !== 'active')) reject('KNOWLEDGE_SOURCE', 'Active knowledge depends on an unavailable source');
      if (source.certainty === 'known' && source.sourceRefs.some(id => sources.get(id)?.certainty === 'uncertain')) reject('KNOWLEDGE_CERTAINTY', 'Uncertain sources cannot establish known facts');
    }
  }
}

/** Lazy/idempotent migration reads existing card knowledge only; it never replays mail or events. */
export function migrateKnowledge<T extends KnowledgeSession>(session: T): T {
  const next = copy(session);
  if (next.knowledgeRegistry) { validateGraph(next); return next; }
  next.knowledgeRegistry = { schema: 'rp.knowledge/0.1', sources: [], history: [] };
  for (const role of next.roles) for (const raw of role.knowledge) {
    const entry = raw as ProvenancedKnowledge;
    const provenance = entry.provenance ?? { sourceId: initialId(role.id, entry.id), sourceRefs: [], kind: 'card' as const };
    entry.provenance = { ...provenance, sourceRefs: refs(provenance.sourceRefs) };
    entry.lifecycle ??= 'active';
    next.knowledgeRegistry.sources.push({ id: provenance.sourceId, ownerRoleId: role.id, knowledgeId: entry.id,
      text: entry.text, audience: copy(entry.audience), certainty: entry.status, lifecycle: entry.lifecycle,
      kind: provenance.kind, sourceRefs: refs(provenance.sourceRefs),
      ...(provenance.observation ? { observation: copy(provenance.observation) } : {}),
      ...(provenance.receivedFrom ? { receivedFrom: provenance.receivedFrom } : {}), ...(provenance.deliveryId ? { deliveryId: provenance.deliveryId } : {}) });
  }
  validateGraph(next);
  return next;
}

function requireRole(session: KnowledgeSession, id: string) {
  if (!safeId(id)) reject('ROLE_UNKNOWN', 'Unknown knowledge owner');
  return session.roles.find(role => role.id === id) ?? reject('ROLE_UNKNOWN', 'Unknown knowledge owner');
}
function validateReferences(session: KnowledgeSession, sourceRefs: string[], actor = 'author') {
  const sources = sourceMap(session);
  for (const id of sourceRefs) {
    const source = sources.get(id) ?? reject('KNOWLEDGE_SOURCE', 'Unknown knowledge source reference');
    if (source.lifecycle !== 'active') reject('KNOWLEDGE_SOURCE_INACTIVE', 'Knowledge source is no longer active');
    if (!readable(source.audience, actor)) reject('KNOWLEDGE_SOURCE_FORBIDDEN', 'Knowledge source is not available to the sender');
    if (actor !== 'author' && !session.roles.some(role => role.knowledge.some(raw => {
      const entry = raw as ProvenancedKnowledge;
      return active(entry) && entry.provenance?.sourceId === id && readable(entry.audience, actor);
    }))) reject('KNOWLEDGE_SOURCE_FORBIDDEN', 'Knowledge source is not available to the sender');
  }
}

/** Withdrawal invalidates all descendants, including received mail and later summaries. */
function withdraw(session: KnowledgeSession, sourceId: string, reason: 'replaced' | 'retracted') {
  const sources = sourceMap(session), root = sources.get(sourceId) ?? reject('KNOWLEDGE_SOURCE', 'Unknown knowledge source');
  root.lifecycle = 'withdrawn';
  const invalid = new Set([sourceId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const source of sources.values()) if (!invalid.has(source.id) && source.sourceRefs.some(id => invalid.has(id))) {
      invalid.add(source.id); if (source.lifecycle === 'active') source.lifecycle = 'stale'; changed = true;
    }
  }
  for (const role of session.roles) for (const raw of role.knowledge) {
    const entry = raw as ProvenancedKnowledge, id = entry.provenance?.sourceId;
    if (!id || !invalid.has(id)) continue;
    if (active(entry)) registry(session).history.push({ roleId: role.id, knowledge: copy(entry), reason: id === sourceId ? reason : 'source-withdrawn' });
    entry.lifecycle = sources.get(id)!.lifecycle;
  }
}
function insert(session: KnowledgeSession, roleId: string, input: { id: string; text: string; audience: Audience; status: Knowledge['status']; sourceRefs: string[]; kind: KnowledgeOrigin; receivedFrom?: string; deliveryId?: string; observation?: KnowledgeObservation }) {
  const sourceId = `knowledge:${randomUUID()}`, sources = sourceMap(session);
  const status = input.status === 'uncertain' || input.sourceRefs.some(id => sources.get(id)!.certainty === 'uncertain') ? 'uncertain' : 'known';
  const entry: ProvenancedKnowledge = { id: input.id, text: input.text, audience: copy(input.audience), status, lifecycle: 'active',
    provenance: { sourceId, sourceRefs: [...input.sourceRefs], kind: input.kind,
      ...(input.observation ? { observation: copy(input.observation) } : {}),
      ...(input.receivedFrom ? { receivedFrom: input.receivedFrom } : {}), ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}) } };
  registry(session).sources.push({ id: sourceId, ownerRoleId: roleId, knowledgeId: input.id, text: input.text, audience: copy(input.audience),
    certainty: status, lifecycle: 'active', kind: input.kind, sourceRefs: [...input.sourceRefs],
    ...(input.observation ? { observation: copy(input.observation) } : {}),
    ...(input.receivedFrom ? { receivedFrom: input.receivedFrom } : {}), ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}) });
  const role = requireRole(session, roleId), index = role.knowledge.findIndex(knowledge => knowledge.id === input.id);
  if (index < 0) role.knowledge.push(entry); else role.knowledge[index] = entry;
}

/** Caller applies revision checks and persists the complete proposal atomically. */
export function proposeKnowledgeObservation<T extends KnowledgeSession>(session: T, roleId: string, observation: KnowledgeObservation): T {
  const next = migrateKnowledge(session), role = requireRole(next, roleId), event = observationEvent(next, roleId, observation);
  const id = `observed:${observation.eventId}`;
  // Withdrawal or an explicit author replacement owns this memory thereafter.
  // Re-reading a retained event is never an instruction to restore it.
  if (role.knowledge.some(entry => entry.id === id)) return next;
  insert(next, roleId, { id, text: observationText(event), audience: [roleId], status: 'known', sourceRefs: [], kind: 'derived', observation });
  validateGraph(next); return next;
}

/** Caller applies revision checks and persists the complete proposal atomically. */
export function proposeKnowledgeEdit<T extends KnowledgeSession>(session: T, input: KnowledgeEdit): T {
  const next = migrateKnowledge(session), role = requireRole(next, input.roleId);
  if (!safeId(input.id)) reject('KNOWLEDGE_ID', 'Invalid knowledge id');
  const previous = role.knowledge.find(entry => entry.id === input.id) as ProvenancedKnowledge | undefined;
  if (input.operation === 'retract') {
    if (!previous) reject('KNOWLEDGE_UNKNOWN', 'Unknown knowledge entry');
    if (previous.lifecycle !== 'withdrawn') withdraw(next, previous.provenance!.sourceId, 'retracted');
  } else if (input.operation === 'upsert') {
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 100_000) reject('KNOWLEDGE_TEXT', 'Knowledge text must be nonempty and at most 100000 characters');
    const audience = input.audience ?? previous?.audience ?? [input.roleId], status = input.status ?? previous?.status ?? 'uncertain', sourceRefs = refs(input.sourceRefs ?? previous?.provenance?.sourceRefs);
    validateAudience(audience, next.roles);
    if (!['known', 'uncertain'].includes(status)) reject('KNOWLEDGE_CERTAINTY', 'Invalid knowledge certainty');
    validateReferences(next, sourceRefs);
    const sources = sourceMap(next);
    const effectiveStatus = status === 'uncertain' || sourceRefs.some(id => sources.get(id)!.certainty === 'uncertain') ? 'uncertain' : 'known';
    if (previous && active(previous) && previous.text === input.text && previous.status === effectiveStatus && JSON.stringify(previous.audience) === JSON.stringify(audience) && JSON.stringify(previous.provenance!.sourceRefs) === JSON.stringify(sourceRefs)) return next;
    if (previous) withdraw(next, previous.provenance!.sourceId, 'replaced');
    // Referencing the version being replaced, or its descendants, would immediately invalidate the replacement.
    validateReferences(next, sourceRefs);
    insert(next, input.roleId, { id: input.id, text: input.text, audience, status, sourceRefs, kind: sourceRefs.length ? 'derived' : 'author' });
  } else reject('KNOWLEDGE_OPERATION', 'Unknown knowledge operation');
  validateGraph(next);
  return next;
}

/** Validation is reusable at mail acceptance; learning still requires a separate receipt proposal. */
function prepareDelivery<T extends KnowledgeSession>(session: T, input: KnowledgeDelivery) {
  const next = migrateKnowledge(session);
  requireRole(next, input.from); requireRole(next, input.to);
  if (!safeId(input.id) || input.from === input.to) reject('KNOWLEDGE_DELIVERY', 'Invalid knowledge delivery');
  if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 100_000) reject('KNOWLEDGE_TEXT', 'Delivery body must be nonempty and at most 100000 characters');
  const sourceRefs = refs(input.sourceRefs);
  const previous = registry(next).sources.find(source => source.deliveryId === input.id);
  if (previous) {
    if (previous.ownerRoleId !== input.to || previous.receivedFrom !== input.from || previous.text !== input.body || JSON.stringify(previous.sourceRefs) !== JSON.stringify(sourceRefs)) reject('KNOWLEDGE_DELIVERY_CONFLICT', 'Delivery id was already used for different content');
    return { next, sourceRefs, duplicate: true };
  }
  validateReferences(next, sourceRefs, input.from);
  const id = `peer:${input.id}`;
  if (requireRole(next, input.to).knowledge.some(entry => entry.id === id)) reject('KNOWLEDGE_ID', 'Delivery knowledge id already exists');
  return { next, sourceRefs, duplicate: false };
}

export function validateKnowledgeDelivery(session: KnowledgeSession, input: KnowledgeDelivery): void {
  prepareDelivery(session, input);
}

/** Receipt learns the exact message body as an uncertain claim, with explicit lineage only. */
export function proposeKnowledgeDelivery<T extends KnowledgeSession>(session: T, input: KnowledgeDelivery): T {
  const { next, sourceRefs, duplicate } = prepareDelivery(session, input);
  if (duplicate) return next;
  insert(next, input.to, { id: `peer:${input.id}`, text: input.body, audience: [input.to], status: 'uncertain', sourceRefs, kind: 'peer', receivedFrom: input.from, deliveryId: input.id });
  validateGraph(next);
  return next;
}

/** Fast projection for a host session already migrated and validated at its storage boundary. */
export function projectKnowledgeEntries(entries: Knowledge[], perspective: string): ProvenancedKnowledge[] {
  return entries.filter(raw => {
    const entry = raw as ProvenancedKnowledge;
    return perspective === 'author' || active(entry) && readable(entry.audience, perspective);
  }).map(raw => {
    const entry = raw as ProvenancedKnowledge;
    if (perspective === 'author') return copy(entry);
    // Source identity, dependency shape and delivery metadata are host-private.
    return { id: entry.id, text: entry.text, audience: copy(entry.audience), status: entry.status };
  });
}

/** Author can inspect inactive text; every other consumer receives active, audience-filtered text only. */
export function projectRoleKnowledge(session: KnowledgeSession, roleId: string, perspective: string): ProvenancedKnowledge[] {
  const next = migrateKnowledge(session);
  return projectKnowledgeEntries(requireRole(next, roleId).knowledge, perspective);
}

/** Trusted role prompt construction only: these opaque handles may be passed back in peer_send. */
export function eligibleKnowledgeReferences(session: KnowledgeSession, roleId: string): { id: string; text: string; status: Knowledge['status'] }[] {
  const next = migrateKnowledge(session);
  requireRole(next, roleId);
  return registry(next).sources.filter(source => source.lifecycle === 'active' && readable(source.audience, roleId) && next.roles.some(role => role.knowledge.some(raw => {
    const entry = raw as ProvenancedKnowledge;
    return active(entry) && entry.provenance?.sourceId === source.id && readable(entry.audience, roleId);
  }))).map(source => ({ id: source.id, text: source.text, status: source.certainty }));
}
