import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { textCarrierObservationText, type TextCarrierSelection, type TextCarrierTarget, type TextCarrierViewIntent,
  type TextCarrierViewOutcome, type TextCarrierViewReceipt } from '../shared/text-carriers';
import type { BehaviorCandidate } from '../shared/behavior';
import type { Json } from '../shared/types';
import { validateStateJson } from '../shared/state-value-schema';
import { proposeKnowledgeObservation } from './knowledge-runtime';
import { ApiError, clone, event, type SessionStore, type StoredSession } from './store';
import { parseTextCarrierSelection, readTextCarrierState, textCarrierTargets } from './text-carriers';

export interface TextCarrierViewBridge {
  targets: readonly TextCarrierTarget[];
  propose(input: unknown): { prepared: true; committed: false; intentId: string; behaviorId: string };
}
const fail = (message: string): never => { throw new ApiError(409, 'TEXT_CARRIER_VIEW', message); };
const obj = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
const key = (reader: string, selection: TextCarrierSelection) => JSON.stringify([reader, selection.carrierId, selection.version]);
const targetMatches = (target: TextCarrierTarget, selection: TextCarrierSelection) => target.carrierId === selection.carrierId && target.version === selection.version;

/** The caller omits carrierViews entirely when no intent exists, preserving
 * legacy world schemas. Every staged intent requires exactly one outcome. */
export function carrierViewOutcomesSchema(intents: readonly TextCarrierViewIntent[]): Record<string, unknown> | undefined {
  if (!intents.length) return undefined;
  if (new Set(intents.map(intent => intent.id)).size !== intents.length) return fail('Duplicate carrier intent IDs');
  return { type: 'array', minItems: intents.length, maxItems: intents.length, uniqueItems: true, items: { type: 'object', additionalProperties: false,
    required: ['intentId', 'outcome'], properties: { intentId: { type: 'string', enum: intents.map(intent => intent.id) }, outcome: { type: 'string', enum: ['viewed', 'blocked'] } } } };
}
function outcomes(raw: unknown, intents: readonly TextCarrierViewIntent[]): TextCarrierViewOutcome[] {
  if (!intents.length && raw === undefined) return [];
  if (validateStateJson(raw).length || !Array.isArray(raw) || raw.length !== intents.length) return fail('World must decide every carrier view intent exactly once');
  const allowed = new Set(intents.map(intent => intent.id)), seen = new Set<string>();
  for (const item of raw) {
    if (!obj(item) || Object.keys(item).length !== 2 || !Object.hasOwn(item, 'intentId') || !Object.hasOwn(item, 'outcome') || typeof item.intentId !== 'string'
      || !allowed.has(item.intentId) || seen.has(item.intentId) || !['viewed', 'blocked'].includes(item.outcome as string)) return fail('Carrier outcomes must use unique current intent IDs and viewed/blocked only');
    seen.add(item.intentId);
  }
  return clone(raw) as TextCarrierViewOutcome[];
}

/** One main-scene world transaction stages attempts, then activates immutable
 * readings only in its detached successful world proposal. No model sees body
 * text through targets, proposal replies, intents, or behavior candidates. */
export class TextCarrierTurn {
  private readonly initial: StoredSession;
  private readonly staged = new Map<string, TextCarrierViewIntent>();
  private readonly behavior = new Map<string, BehaviorCandidate>();
  private terminal: 'open' | 'committed' | 'aborted' = 'open';
  private closed = false;
  constructor(private readonly store: SessionStore, private readonly sessionId: string, private readonly turnId: string, private readonly signal: AbortSignal) {
    this.initial = clone(store.get(sessionId));
    if (this.initial.turns.filter(turn => turn.id === turnId).length !== 1) fail('Carrier viewing requires its existing host turn');
    readTextCarrierState(this.initial);
  }
  private live() {
    if (this.closed || this.signal.aborted || this.terminal !== 'open') fail('Carrier view delivery is closed');
    const current = this.store.get(this.sessionId), turn = current.turns.find(turn => turn.id === this.turnId);
    if (!turn || !['queued', 'running'].includes(turn.status) || current.revision !== this.initial.revision) fail('Carrier view turn is no longer active at its original revision');
  }
  private stage(roleId: string, selection: TextCarrierSelection, allowed: readonly TextCarrierTarget[], player: boolean): TextCarrierViewIntent {
    this.live();
    if (!allowed.some(target => targetMatches(target, selection)) || !textCarrierTargets(this.initial, roleId).some(target => targetMatches(target, selection))
      || !textCarrierTargets(this.store.get(this.sessionId), roleId).some(target => targetMatches(target, selection))) return fail('Select a current, originally delivered local carrier version');
    const identity = key(roleId, selection), prior = this.staged.get(identity); if (prior) return clone(prior);
    const intent: TextCarrierViewIntent = { ...selection, id: `carrier-intent:${randomUUID()}`, readerRoleId: roleId, location: this.initial.world.location,
      origin: player ? { kind: 'player' } : { kind: 'behavior', behaviorId: `carrier-view:${randomUUID()}` } };
    const target = allowed.find(target => targetMatches(target, selection))!;
    const candidate: BehaviorCandidate | undefined = intent.origin.kind === 'behavior' ? { id: intent.origin.behaviorId, roleId, kind: 'action',
      text: `尝试查看${target.medium === 'paper' ? '纸张' : '屏幕'}「${target.title}」（版本 ${target.version}）上的文字。` } : undefined;
    const next = clone(this.store.get(this.sessionId));
    event(next, { kind: 'text-carrier-view-prepared', actor: 'host', turnId: this.turnId, audience: 'author',
      text: 'Carrier view intent prepared; no text has been disclosed.', data: { schema: 'rp.text-carrier-view-intent/0.1', intent: intent as unknown as Json } });
    this.store.save(next); this.staged.set(identity, intent); if (candidate) this.behavior.set(candidate.id, candidate);
    return clone(intent);
  }
  forRole(roleId: string): TextCarrierViewBridge {
    this.live();
    if (roleId === this.initial.playerRoleId || !this.initial.roles.some(role => role.id === roleId)) return fail('Only an existing NPC receives a carrier proposal tool');
    const targets = freeze(clone(textCarrierTargets(this.initial, roleId)));
    return Object.freeze({ targets, propose: (raw: unknown) => {
      const intent = this.stage(roleId, parseTextCarrierSelection(raw), targets, false);
      if (intent.origin.kind !== 'behavior') return fail('NPC carrier view requires its staged action');
      return { prepared: true as const, committed: false as const, intentId: intent.id, behaviorId: intent.origin.behaviorId };
    } });
  }
  player(raw: unknown): TextCarrierViewIntent {
    return this.stage(this.initial.playerRoleId, parseTextCarrierSelection(raw), textCarrierTargets(this.initial, this.initial.playerRoleId), true);
  }
  candidates(): BehaviorCandidate[] { return clone([...this.behavior.values()]); }
  intents(): TextCarrierViewIntent[] { return clone([...this.staged.values()]); }
  commit(session: StoredSession, rawOutcomes: unknown, acceptedBehaviors: readonly BehaviorCandidate[]): StoredSession {
    if (session.id !== this.sessionId || this.signal.aborted || this.terminal === 'aborted' || this.closed && this.terminal !== 'committed') return fail('Carrier view transaction is closed or belongs to another story');
    if (this.terminal === 'open') this.live();
    const intents = this.intents(), decisions = outcomes(rawOutcomes, intents);
    let next = clone(session); if (!intents.length) return next;
    const held = readTextCarrierState(next);
    if (!next.events.some(entry => entry.turnId === this.turnId && entry.kind === 'world-adjudication' && entry.actor === 'world' && entry.audience === 'author')) return fail('Carrier views require this turn\'s successful world adjudication');
    // The engine passes its next committed revision. Nothing is persisted here.
    if (next.revision !== this.initial.revision + 1) return fail('Carrier views require the next world revision');
    if (validateStateJson(acceptedBehaviors).length) return fail('Carrier behavior approvals must be ordinary JSON');
    for (const intent of intents) {
      const prepared = next.events.filter(entry => entry.kind === 'text-carrier-view-prepared' && entry.turnId === this.turnId && entry.actor === 'host' && entry.audience === 'author'
        && obj(entry.data) && obj(entry.data.intent) && entry.data.intent.id === intent.id);
      if (prepared.length !== 1 || !isDeepStrictEqual(prepared[0].data, { schema: 'rp.text-carrier-view-intent/0.1', intent })) return fail('Carrier intent differs from its pending audit');
      const decision = decisions.find(decision => decision.intentId === intent.id)!;
      const existing = held.views.find(view => view.intentId === intent.id);
      if (existing) {
        if (decision.outcome !== 'viewed' || existing.materialTurnId !== this.turnId || existing.readerRoleId !== intent.readerRoleId || existing.carrierId !== intent.carrierId
          || existing.carrierVersion !== intent.version || !isDeepStrictEqual(existing.origin, intent.origin)) return fail('Committed carrier view differs from its outcome');
        continue;
      }
      if (decision.outcome === 'blocked') continue;
      if (this.terminal === 'committed') return fail('A finished carrier batch cannot be applied to an uncommitted snapshot');
      if (intent.origin.kind === 'behavior') {
        const behaviorId = intent.origin.behaviorId, candidate = this.behavior.get(behaviorId);
        const approved = acceptedBehaviors.filter(item => item.id === behaviorId);
        if (!candidate || approved.length !== 1 || !isDeepStrictEqual(approved[0], candidate)) return fail('A viewed NPC intent requires its exact approved staged action');
      } else if (intent.readerRoleId !== this.initial.playerRoleId) return fail('Player reading requires the host player intent');
      if (!textCarrierTargets(this.initial, intent.readerRoleId).some(target => targetMatches(target, intent))
        || !textCarrierTargets(next, intent.readerRoleId).some(target => targetMatches(target, intent))
        || next.world.location !== intent.location || this.initial.world.location !== intent.location) return fail('Reader and carrier must remain available in the same main location');
      const original = readTextCarrierState(this.initial).carriers.find(carrier => carrier.id === intent.carrierId)!.versions.at(-1)!;
      const final = held.carriers.find(carrier => carrier.id === intent.carrierId)!.versions.at(-1)!;
      if (!isDeepStrictEqual(original, final)) return fail('Carrier version changed during world adjudication');
      const reader = next.roles.find(role => role.id === intent.readerRoleId)!;
      const receipt: TextCarrierViewReceipt = { id: `carrier-receipt:${randomUUID()}`, intentId: intent.id, materialTurnId: this.turnId, worldRevision: next.revision,
        carrierId: intent.carrierId, carrierVersion: intent.version, readerRoleId: intent.readerRoleId, readerName: reader.name,
        location: intent.location, time: next.world.time || null, origin: clone(intent.origin), carrier: {
          medium: final.medium, title: final.title, text: final.text, sourceEventId: final.sourceEventId }, observationEventId: randomUUID() };
      next.events.push({ id: receipt.observationEventId, at: new Date().toISOString(), turnId: this.turnId, kind: 'text-carrier-view-observation', actor: 'host', audience: 'author',
        text: textCarrierObservationText(receipt), data: { schema: 'rp.text-carrier-view-observation/0.1', sceneId: 'main', observerRoleIds: [intent.readerRoleId], viewId: receipt.id } });
      held.views.push(receipt); next.textCarriers = held;
      const text = `${reader.name}查看了${final.medium === 'paper' ? '纸张' : '屏幕'}「${final.title}」（版本 ${final.version}）上的文字。`;
      event(next, { kind: 'world-event', actor: 'world', turnId: this.turnId, audience: 'public', text, data: { fact: { text,
        sources: [intent.origin.kind === 'player' ? { kind: 'player-action' } : { kind: 'behavior', id: intent.origin.behaviorId }] },
        carrierView: { viewId: receipt.id, carrierId: intent.carrierId, version: intent.version, medium: final.medium, title: final.title, readerRoleId: intent.readerRoleId, location: intent.location } } });
      next = proposeKnowledgeObservation(next, intent.readerRoleId, { eventId: receipt.observationEventId, sceneId: 'main' });
    }
    next.textCarriers = held; readTextCarrierState(next); this.terminal = 'committed'; return next;
  }
  abort(session: StoredSession): StoredSession {
    if (session.id !== this.sessionId) return fail('Carrier abort belongs to another story');
    const next = clone(session), held = readTextCarrierState(next);
    if (this.terminal === 'committed') return next;
    for (const intent of this.staged.values()) {
      if (held.views.some(view => view.intentId === intent.id) || next.events.some(entry => entry.kind === 'text-carrier-view-aborted' && entry.turnId === this.turnId && obj(entry.data) && entry.data.intentId === intent.id)) continue;
      event(next, { kind: 'text-carrier-view-aborted', actor: 'host', turnId: this.turnId, audience: 'author', text: 'Uncommitted carrier view intent discarded.',
        data: { schema: 'rp.text-carrier-view-abort/0.1', intentId: intent.id } });
    }
    this.terminal = 'aborted'; return next;
  }
  close(): void { this.closed = true; }
}
