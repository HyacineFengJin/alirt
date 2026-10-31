import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ProvenancedKnowledge } from '../shared/knowledge';
import type { Json, SessionSnapshot } from '../shared/types';
import { validateStateJson } from '../shared/state-value-schema';
import type { AgentModule, AgentModuleContext } from './agent-modules';
import { eligibleKnowledgeReferences, proposeKnowledgeEdit } from './knowledge-runtime';
import { validateEventLedger } from './event-ledger';
import { ApiError, clone, event, type SessionStore, type StoredSession } from './store';

export const DERIVED_MEMORY_MODULE_ID = 'rp.derived-memory';
export interface DerivedMemoryInput { key: string; kind: 'inference' | 'summary'; text: string; sourceRefs: string[] }
export interface DerivedMemoryBridge {
  references: readonly { id: string; text: string; status: 'known' | 'uncertain' }[];
  prepare(input: unknown): { prepared: true; committed: false; knowledgeId: string; kind: 'inference' | 'summary'; duplicate: boolean };
}
const fail = (message: string, code = 'DERIVED_MEMORY_INPUT', status = 400): never => { throw new ApiError(status, code, message); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const identity = (value: unknown): value is string => text(value) && value.trim() === value && value.length <= 512 && !['__proto__', 'constructor', 'prototype'].includes(value);
function exact(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function ordinary(value: unknown, label: string) { if (validateStateJson(value).length) fail(`${label} must contain ordinary JSON only`); }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function input(value: unknown): DerivedMemoryInput {
  ordinary(value, 'Derived memory');
  if (!record(value) || !exact(value, ['key', 'kind', 'text', 'sourceRefs']) || !identity(value.key) || !['inference', 'summary'].includes(value.kind as string)
    || !text(value.text) || value.text.length > 100_000 || !Array.isArray(value.sourceRefs) || !value.sourceRefs.length || value.sourceRefs.some(ref => !identity(ref))
    || new Set(value.sourceRefs).size !== value.sourceRefs.length) return fail('Provide exact key, kind, text and nonempty unique opaque sourceRefs');
  return clone({ key: value.key, kind: value.kind, text: value.text, sourceRefs: value.sourceRefs }) as DerivedMemoryInput;
}
const digest = (value: DerivedMemoryInput) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface Draft extends DerivedMemoryInput { roleId: string; knowledgeId: string; fingerprint: string; preparedEventId: string }
function owner(session: StoredSession, roleId: string) {
  if (!identity(roleId) || roleId === session.playerRoleId || session.roles.filter(role => role.id === roleId).length !== 1) fail('Only the current existing NPC may prepare its own memory', 'DERIVED_MEMORY_OWNER');
  return session.roles.find(role => role.id === roleId)!;
}
const currentReferences = (session: StoredSession, roleId: string) => { owner(session, roleId); return eligibleKnowledgeReferences(session, roleId); };
function requireReferences(session: StoredSession, roleId: string, refs: string[], allowed?: Set<string>) {
  const active = new Set(currentReferences(session, roleId).map(reference => reference.id));
  if (refs.some(ref => !active.has(ref) || allowed && !allowed.has(ref))) fail('Each source must be an originally delivered, still active readable opaque reference', 'DERIVED_MEMORY_SOURCE');
}
const auditData = (draft: Draft) => ({ schema: 'rp.derived-memory-draft/0.1', knowledgeId: draft.knowledgeId, roleId: draft.roleId, key: draft.key,
  kind: draft.kind, text: draft.text, sourceRefs: [...draft.sourceRefs], fingerprint: draft.fingerprint });
function committed(session: StoredSession, turnId: string, draft: Draft): boolean {
  const matching = session.events.filter(entry => entry.kind === 'derived-memory-committed' && entry.turnId === turnId && record(entry.data) && entry.data.knowledgeId === draft.knowledgeId);
  if (!matching.length) return false;
  const data = matching[0].data as Record<string, Json>;
  if (matching.length !== 1 || matching[0].actor !== 'host' || matching[0].audience !== 'author' || data.roleId !== draft.roleId || data.fingerprint !== draft.fingerprint || typeof data.sourceId !== 'string')
    fail('Committed derived memory audit differs from its draft', 'DERIVED_MEMORY_INTEGRITY', 409);
  const source = session.knowledgeRegistry?.sources.find(source => source.id === data.sourceId);
  if (!source || source.kind !== 'derived' || source.ownerRoleId !== draft.roleId || source.knowledgeId !== draft.knowledgeId || source.text !== draft.text
    || source.certainty !== 'uncertain' || !isDeepStrictEqual(source.sourceRefs, draft.sourceRefs) || !isDeepStrictEqual(source.audience, [draft.roleId]) || source.observation !== undefined)
    fail('Committed derived memory source differs from its audit', 'DERIVED_MEMORY_INTEGRITY', 409);
  return true;
}

/** One host turn owns drafts. Only prepare saves (a private pending audit).
 * commit/abort return detached proposals for the parent's single state save. */
export class DerivedMemoryTurn {
  private drafts = new Map<string, Draft>();
  private closed = false;
  private terminal: 'open' | 'committed' | 'aborted' = 'open';
  constructor(private readonly store: SessionStore, private readonly sessionId: string, private readonly turnId: string, private readonly signal: AbortSignal) {
    const session = store.get(sessionId);
    if (!identity(turnId) || session.turns.filter(turn => turn.id === turnId).length !== 1) fail('Derived memory requires its existing host turn', 'DERIVED_MEMORY_TURN');
  }
  private live() {
    if (this.closed || this.terminal !== 'open' || this.signal.aborted) fail('Derived memory delivery is closed', 'DERIVED_MEMORY_CLOSED', 409);
    const turn = this.store.get(this.sessionId).turns.find(turn => turn.id === this.turnId);
    if (!turn || !['queued', 'running'].includes(turn.status)) fail('Derived memory delivery is no longer active', 'DERIVED_MEMORY_CLOSED', 409);
  }
  forRole(view: SessionSnapshot, roleId: string): DerivedMemoryBridge {
    this.live(); const current = this.store.get(this.sessionId); owner(current, roleId);
    if (view.id !== this.sessionId || view.perspective !== roleId || !view.roles.some(role => role.id === roleId)) fail('Derived memory needs the actual delivered NPC perspective', 'DERIVED_MEMORY_OWNER');
    // Match against the actual supplied snapshot, not every public source that
    // happens to be readable elsewhere in the complete host session.
    const sources = new Map((current.knowledgeRegistry?.sources ?? []).map(source => [source.id, source]));
    const references = currentReferences(current, roleId).filter(reference => {
      const source = sources.get(reference.id);
      return source && view.roles.some(role => role.id === source.ownerRoleId && role.knowledge.some(entry => entry.id === source.knowledgeId
        && entry.text === reference.text && entry.status === reference.status));
    });
    const allowed = new Set(references.map(reference => reference.id));
    return Object.freeze({ references: freeze(clone(references)), prepare: (raw: unknown) => {
      this.live(); const value = input(raw), current = this.store.get(this.sessionId); requireReferences(current, roleId, value.sourceRefs, allowed);
      const key = JSON.stringify([roleId, value.key]), previous = this.drafts.get(key), fingerprint = digest(value);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('This actor key already identifies a different memory draft', 'DERIVED_MEMORY_KEY_CONFLICT', 409);
        return { prepared: true as const, committed: false as const, knowledgeId: previous.knowledgeId, kind: previous.kind, duplicate: true };
      }
      const draft: Draft = { ...value, roleId, knowledgeId: `derived-memory:${randomUUID()}`, fingerprint, preparedEventId: '' };
      if (current.roles.some(role => role.knowledge.some(entry => entry.id === draft.knowledgeId))) fail('Derived memory cannot overwrite an existing entry', 'DERIVED_MEMORY_INTEGRITY', 409);
      const next = clone(current);
      event(next, { kind: 'derived-memory-prepared', actor: 'host', turnId: this.turnId, audience: 'author', text: 'Derived memory prepared; awaiting successful world commit.', data: auditData(draft) });
      draft.preparedEventId = next.events.at(-1)!.id;
      this.store.save(next); this.drafts.set(key, draft);
      return { prepared: true as const, committed: false as const, knowledgeId: draft.knowledgeId, kind: draft.kind, duplicate: false };
    } });
  }
  commit(session: StoredSession): StoredSession {
    if (session.id !== this.sessionId) fail('Derived memory commit belongs to another story', 'DERIVED_MEMORY_TURN');
    if (this.terminal === 'aborted' || this.closed && this.terminal !== 'committed') fail('Derived memory delivery is closed', 'DERIVED_MEMORY_CLOSED', 409);
    if (this.signal.aborted) fail('Derived memory delivery was cancelled', 'DERIVED_MEMORY_CLOSED', 409);
    let next = clone(session);
    if (!this.drafts.size) return next;
    if (!next.events.some(entry => entry.turnId === this.turnId && entry.kind === 'world-adjudication' && entry.actor === 'world' && entry.audience === 'author'))
      fail('Derived memories require this turn\'s successful world adjudication', 'DERIVED_MEMORY_COMMIT');
    for (const draft of this.drafts.values()) {
      if (committed(next, this.turnId, draft)) continue;
      const prepared = next.events.filter(entry => entry.id === draft.preparedEventId && entry.kind === 'derived-memory-prepared' && entry.turnId === this.turnId && entry.actor === 'host' && entry.audience === 'author');
      if (prepared.length !== 1 || !isDeepStrictEqual(prepared[0].data, auditData(draft))) fail('Memory draft differs from its prepared audit', 'DERIVED_MEMORY_INTEGRITY', 409);
      if (next.events.some(entry => entry.kind === 'derived-memory-aborted' && entry.turnId === this.turnId && record(entry.data) && entry.data.knowledgeId === draft.knowledgeId))
        fail('Aborted memory draft cannot be committed', 'DERIVED_MEMORY_COMMIT');
      requireReferences(this.store.get(this.sessionId), draft.roleId, draft.sourceRefs);
      requireReferences(next, draft.roleId, draft.sourceRefs);
      if (next.roles.some(role => role.knowledge.some(entry => entry.id === draft.knowledgeId))) fail('Derived memory cannot overwrite an existing entry', 'DERIVED_MEMORY_INTEGRITY', 409);
      next = proposeKnowledgeEdit(next, { operation: 'upsert', roleId: draft.roleId, id: draft.knowledgeId, text: draft.text, sourceRefs: draft.sourceRefs, status: 'uncertain', audience: [draft.roleId] });
      const entry = next.roles.find(role => role.id === draft.roleId)!.knowledge.find(entry => entry.id === draft.knowledgeId) as ProvenancedKnowledge;
      event(next, { kind: 'derived-memory-committed', actor: 'host', turnId: this.turnId, audience: 'author', text: 'Committed private derived memory with explicit source lineage.',
        data: { schema: 'rp.derived-memory-commit/0.1', roleId: draft.roleId, knowledgeId: draft.knowledgeId, kind: draft.kind, fingerprint: draft.fingerprint, sourceId: entry.provenance!.sourceId } });
    }
    this.terminal = 'committed'; return next;
  }
  abort(session: StoredSession): StoredSession {
    if (session.id !== this.sessionId) fail('Derived memory abort belongs to another story', 'DERIVED_MEMORY_TURN');
    const next = clone(session);
    for (const draft of this.drafts.values()) {
      if (committed(next, this.turnId, draft) || next.events.some(entry => entry.kind === 'derived-memory-aborted' && entry.turnId === this.turnId && record(entry.data) && entry.data.knowledgeId === draft.knowledgeId)) continue;
      event(next, { kind: 'derived-memory-aborted', actor: 'host', turnId: this.turnId, audience: 'author', text: 'Uncommitted derived memory discarded.',
        data: { schema: 'rp.derived-memory-abort/0.1', roleId: draft.roleId, knowledgeId: draft.knowledgeId, fingerprint: draft.fingerprint } });
    }
    if ([...this.drafts.values()].some(draft => !committed(next, this.turnId, draft))) this.terminal = 'aborted';
    return next;
  }
  close(): void { this.closed = true; }
}

/** Failed provisional tool text cannot survive through a clean native binding.
 * Current running drafts and committed historical notes are excluded. */
export function derivedMemoryAttemptBoundary(session: StoredSession, roleId: string): unknown {
  if (validateEventLedger(session.events).length) fail('Invalid derived memory event ledger', 'DERIVED_MEMORY_INTEGRITY', 409);
  const failed = new Set(session.turns.filter(turn => ['failed', 'interrupted'].includes(turn.status)).map(turn => turn.id));
  const committedIds = new Set(session.events.filter(entry => entry.kind === 'derived-memory-committed' && record(entry.data) && entry.data.roleId === roleId)
    .map(entry => JSON.stringify([entry.turnId, (entry.data as Record<string, Json>).knowledgeId])));
  return { schema: 'rp.derived-memory-attempt-boundary/0.1', drafts: session.events.filter(entry => entry.kind === 'derived-memory-prepared' && entry.audience === 'author' && entry.actor === 'host'
    && !!entry.turnId && failed.has(entry.turnId) && record(entry.data) && entry.data.roleId === roleId && identity(entry.data.knowledgeId)
    && !committedIds.has(JSON.stringify([entry.turnId, entry.data.knowledgeId])))
    .map(entry => ({ turnId: entry.turnId!, knowledgeId: (entry.data as Record<string, Json>).knowledgeId as string })) };
}

export const derivedMemoryModule: AgentModule = {
  meta: { id: DERIVED_MEMORY_MODULE_ID, title: 'Private source-linked derived memory', version: '0.1.0', apiVersion: 'rp.agent-module/0.1', requires: ['rp.role-agents'] },
  roleTools: context => {
    const bridge = (context as AgentModuleContext & { derivedMemory?: DerivedMemoryBridge }).derivedMemory;
    if (!bridge || typeof bridge.prepare !== 'function' || !Array.isArray(bridge.references)) return fail('Derived memory module requires a host delivery bridge', 'DERIVED_MEMORY_BRIDGE');
    return [{ name: 'derive_memory', description: 'Prepare your own private uncertain inference or summary using nonempty current opaque knowledgeReferences. References identify recorded knowledge, not proof that quoted claims are true. The note remains pending until the host world commit; it never approves behavior, changes state or teaches another actor.',
      parameters: { type: 'object', additionalProperties: false, required: ['key', 'kind', 'text', 'sourceRefs'], properties: {
        key: { type: 'string', minLength: 1, maxLength: 512, pattern: '\\S' }, kind: { type: 'string', enum: ['inference', 'summary'] },
        text: { type: 'string', minLength: 1, maxLength: 100000, pattern: '\\S' }, sourceRefs: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
      } }, execute: value => { if (context.signal.aborted) fail('Derived memory delivery was cancelled', 'DERIVED_MEMORY_CLOSED', 409); return bridge.prepare(value); } }];
  },
};
