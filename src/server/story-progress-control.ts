import { createHash } from 'node:crypto';
import { STORY_PROGRESS_CONTROL_SERVICE_ID, validateStoryProgressControlCommand, type StoryProgressControlCommand, type StoryProgressControlResult, type StoryProgressControlView } from '../shared/story-progress-control';
import { validateStoryProgress } from '../shared/story-progress';
import type { Json, WorldEvent } from '../shared/types';
import { validateStateJson } from '../shared/state-value-schema';
import { reduceStoryProgress } from './story-progress';
import { publicFactEvent, publicWorldFact } from './world-facts-runtime';
import { validateEventLedger } from './event-ledger';
import type { SessionCommandService } from './session-services';
import { assertRevision, clone, event, fail, type SessionStore, type StoredSession } from './store';

const schema = 'rp.story-progress-control/0.1';
interface Receipt { requestId: string; fingerprint: string; revision: number }
interface Held { schema: typeof schema; requests: Receipt[] }
const integrity = (message: string): never => fail('STORY_PROGRESS_CONTROL_INTEGRITY', message, 409);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
/** Sort JSON object keys only. Field/array contents (including reason and the
 * originally submitted CAS revision) remain part of the command fingerprint. */
function stable(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = (command: StoryProgressControlCommand) => createHash('sha256').update(stable(command as unknown as Json)).digest('hex');

function receipts(session: Readonly<StoredSession>): Held {
  const raw = session.hostServices?.[STORY_PROGRESS_CONTROL_SERVICE_ID];
  if (validateEventLedger(session.events).length) return integrity('Invalid retained event ledger');
  const audits = session.events.filter(entry => entry?.kind === 'story-progress-control');
  if (raw === undefined) {
    if (audits.length) return integrity('Author correction receipts are missing; retained audit requires review');
    return { schema, requests: [] };
  }
  if (validateStateJson(raw).length || !record(raw) || !exact(raw, ['schema', 'requests']) || raw.schema !== schema || !Array.isArray(raw.requests)) return integrity('Invalid retained story progress command receipts');
  const ids = new Set<string>(); let revision = 0;
  for (const receipt of raw.requests) {
    if (!record(receipt) || !exact(receipt, ['requestId', 'fingerprint', 'revision'])
      || typeof receipt.requestId !== 'string' || !receipt.requestId.trim() || receipt.requestId.trim() !== receipt.requestId || ids.has(receipt.requestId)
      || typeof receipt.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)
      || !Number.isSafeInteger(receipt.revision) || (receipt.revision as number) <= revision || (receipt.revision as number) > session.revision) return integrity('Invalid retained story progress command receipt');
    ids.add(receipt.requestId); revision = receipt.revision as number;
    const matching = audits.filter(entry => record(entry.data) && entry.data.requestId === receipt.requestId);
    const audit = matching[0];
    if (matching.length !== 1 || audit.actor !== 'author' || audit.audience !== 'author' || !record(audit.data)
      || audit.data.schema !== 'rp.story-progress-control-audit/0.1' || audit.data.fingerprint !== receipt.fingerprint
      || audit.data.revision !== receipt.revision || typeof audit.data.reason !== 'string' || !audit.data.reason.trim()) return integrity('Author correction receipt differs from its retained audit');
  }
  if (audits.length !== raw.requests.length) return integrity('Author correction receipts do not match retained audits');
  return clone(raw) as unknown as Held;
}

/** Only canonical public world events are selectable. The fact projection is
 * still applied even though the DTO discards all payload fields. */
function publicEvents(session: Readonly<StoredSession>): WorldEvent[] {
  if (validateEventLedger(session.events).length) return integrity('Invalid retained event ledger');
  const ids = new Set<string>(), result: WorldEvent[] = [];
  for (const source of session.events) {
    if (!source || typeof source.id !== 'string' || !source.id.trim() || ids.has(source.id)) return integrity('Retained event IDs must be unique');
    ids.add(source.id);
    if (source.audience !== 'public' || source.actor !== 'world' || source.kind !== 'world-event') continue;
    if (typeof source.text !== 'string' || !source.text.trim() || source.turnId !== undefined && (typeof source.turnId !== 'string' || !source.turnId.trim())) return integrity('Invalid public world event');
    let projected: WorldEvent;
    try { projected = publicFactEvent(source); }
    catch { return integrity('Public world event provenance requires review'); }
    if (record(projected.data) && Object.hasOwn(projected.data, 'fact')) {
      try {
        const fact = publicWorldFact(projected.data.fact as never);
        if (fact.text !== projected.text || !fact.sources.length) return integrity('Public world event does not match its fact');
      } catch { return integrity('Public world event provenance requires review'); }
    }
    result.push(projected);
  }
  return result;
}

export function readStoryProgressControl(session: Readonly<StoredSession>): StoryProgressControlView {
  receipts(session);
  const events = publicEvents(session), available = new Set(events.map(event => event.id));
  if (session.storyProgress !== undefined) {
    const error = validateStoryProgress(session.storyProgress)[0];
    if (error) return integrity(`Invalid held story progress: ${error.message}`);
    if (session.storyProgress.worldRevision > session.revision || session.storyProgress.tasks.some(task => task.evidence.eventIds.some(id => !available.has(id)))) return integrity('Held story progress refers to unavailable public evidence or a future revision');
  }
  return { schema, revision: session.revision, progress: session.storyProgress === undefined ? null : clone(session.storyProgress),
    publicEvents: events.map(({ id, turnId, text }) => ({ id, ...(turnId === undefined ? {} : { turnId }), text })) };
}

export function applyStoryProgressControl(store: SessionStore, id: string, input: unknown): StoryProgressControlResult {
  const issue = validateStoryProgressControlCommand(input)[0];
  if (issue) return fail('STORY_PROGRESS_CONTROL_INPUT', `${issue.path}: ${issue.message}`);
  const command = clone(input) as StoryProgressControlCommand, current = store.get(id), held = receipts(current), fingerprint = digest(command);
  const previous = held.requests.find(receipt => receipt.requestId === command.requestId);
  if (previous) {
    if (previous.fingerprint !== fingerprint) return fail('STORY_PROGRESS_CONTROL_REQUEST', 'This request ID already identifies a different author correction', 409);
    return { ...readStoryProgressControl(current), requestId: command.requestId, duplicate: true, appliedRevision: previous.revision };
  }
  assertRevision(current, command.expectedRevision);
  if (!Number.isSafeInteger(current.revision) || current.revision >= Number.MAX_SAFE_INTEGER) return integrity('Session revision exhausted');
  // Validate held data before any mutation, even when the command has no ops.
  readStoryProgressControl(current);
  const next = clone(current), revision = current.revision + 1;
  const position = { time: current.world.time, location: current.world.location };
  next.storyProgress = reduceStoryProgress(command.patch, { previous: current.storyProgress, priorEvents: publicEvents(current), currentEvents: [], factEventIds: [], worldRevision: revision, before: position, after: position });
  next.revision = revision;
  held.requests.push({ requestId: command.requestId, fingerprint, revision });
  next.hostServices = { ...next.hostServices, [STORY_PROGRESS_CONTROL_SERVICE_ID]: held as unknown as Json };
  event(next, { kind: 'story-progress-control', actor: 'author', audience: 'author', text: 'Author corrected story progress.', data: {
    schema: 'rp.story-progress-control-audit/0.1', requestId: command.requestId, fingerprint, reason: command.reason, revision, sequence: next.storyProgress.sequence,
  } });
  const result = { ...readStoryProgressControl(next), requestId: command.requestId, duplicate: false, appliedRevision: revision };
  store.save(next);
  return result;
}

export const storyProgressControlService: SessionCommandService = {
  id: STORY_PROGRESS_CONTROL_SERVICE_ID, title: 'Story progress author controller', read: readStoryProgressControl, apply: applyStoryProgressControl,
};
