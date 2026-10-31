import type { WorldEvent } from '../shared/types';
import { validateStateJson } from '../shared/state-value-schema';
import { storyTaskId, validateStoryProgress, validateStoryProgressPatch, validateStoryProgressPosition, type StoryProgressPatch, type StoryProgressPosition, type StoryProgressState } from '../shared/story-progress';
import { publicWorldFact } from './world-facts-runtime';
import { validateEventLedger } from './event-ledger';
import { fail } from './store';

export interface StoryProgressContext {
  previous?: unknown;
  priorEvents: readonly WorldEvent[];
  currentEvents: readonly WorldEvent[];
  /** Zero-based compiled fact indexes map to these newly appended public events. */
  factEventIds: readonly string[];
  worldRevision: number;
  before: StoryProgressPosition;
  after: StoryProgressPosition;
}
const bad = (message: string): never => fail('STORY_PROGRESS', message);
const increment = (value: number) => { if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) return bad('Story progress counter exhausted'); return value + 1; };

function canonical(event: WorldEvent, compiled: boolean): boolean {
  if (event.kind !== 'world-event' || event.actor !== 'world' || event.audience !== 'public' || typeof event.text !== 'string' || !event.text.trim()) return false;
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data) || !Object.hasOwn(event.data, 'fact')) return !compiled;
  try {
    const fact = publicWorldFact(event.data.fact as never);
    return fact.text === event.text && fact.sources.length > 0;
  } catch { return false; }
}

/** Invoke once within a successful capability-enabled world transaction, after
 * public facts are appended and before saving, or an explicit author correction.
 * Prose/recovery must never call it.
 * The previous revision guard rejects reapplication to an already reduced state. */
export function reduceStoryProgress(rawPatch: unknown, context: StoryProgressContext): StoryProgressState {
  const patchError = validateStoryProgressPatch(rawPatch)[0]; if (patchError) return bad(`${patchError.path}: ${patchError.message}`);
  const { previous } = context;
  if (previous !== undefined) { const error = validateStoryProgress(previous)[0]; if (error) return bad(`Corrupt held story progress: ${error.path}: ${error.message}`); }
  if (validateStateJson({ factEventIds: context.factEventIds, worldRevision: context.worldRevision, before: context.before, after: context.after }).length
    || validateEventLedger(context.priorEvents).length || validateEventLedger(context.currentEvents).length || !Array.isArray(context.factEventIds)
    || !Number.isSafeInteger(context.worldRevision) || context.worldRevision < 1
    || !validateStoryProgressPosition(context.before) || !validateStoryProgressPosition(context.after)) return bad('Invalid story progress commit context');
  const held = previous as StoryProgressState | undefined;
  if (held && context.worldRevision <= held.worldRevision) return bad('Story progress requires a new committed world revision');
  const events = new Map<string, WorldEvent>(); const current = new Set<string>();
  for (const [index, list] of [context.priorEvents, context.currentEvents].entries()) for (const event of list) {
    if (!event || typeof event.id !== 'string' || !event.id.trim() || events.has(event.id)) return bad('Commit evidence event IDs must be unique');
    events.set(event.id, event); if (index === 1) current.add(event.id);
  }
  const facts = new Set<string>();
  for (const id of context.factEventIds) {
    if (typeof id !== 'string' || !current.has(id) || facts.has(id) || !canonical(events.get(id)!, true)) return bad('Compiled fact indexes require unique current public fact events');
    facts.add(id);
  }
  const state: StoryProgressState = held ? structuredClone(held) : { schema: 'rp.story-progress/0.1', sequence: 0, nextMainIndex: 1, nextSideIndex: 1, tasks: [], worldRevision: context.worldRevision, before: structuredClone(context.before), after: structuredClone(context.after) };
  for (const task of state.tasks) for (const id of task.evidence.eventIds) if (!events.has(id) || !canonical(events.get(id)!, false)) return bad(`Held task evidence is not a retained public world event: ${id}`);
  state.sequence = increment(state.sequence); state.worldRevision = context.worldRevision;
  state.before = structuredClone(context.before); state.after = structuredClone(context.after);
  for (const op of (rawPatch as StoryProgressPatch).operations) {
    const evidence = new Set<string>();
    for (const index of op.evidence.factIndexes) {
      if (index >= context.factEventIds.length) return bad(`Unknown compiled fact index: ${index}`);
      evidence.add(context.factEventIds[index]);
    }
    for (const id of op.evidence.eventIds) {
      if (!events.has(id) || !canonical(events.get(id)!, false)) return bad(`Evidence is not a retained public world event: ${id}`);
      evidence.add(id);
    }
    if (op.op === 'create') {
      if (op.kind === 'main' && state.tasks.some(task => task.kind === 'main' && task.status !== 'completed')) return bad('An unfinished main task already exists');
      const key = op.kind === 'main' ? 'nextMainIndex' : 'nextSideIndex';
      const ordinal = state[key]; state[key] = increment(ordinal);
      state.tasks.push({ id: storyTaskId(op.kind, ordinal), kind: op.kind, ordinal, title: op.title, summary: op.summary, status: op.status,
        createdAtSequence: state.sequence, updatedAtSequence: state.sequence, evidence: { eventIds: [...evidence] } });
    } else {
      const task = state.tasks.find(task => task.id === op.taskId);
      if (!task || task.status === 'completed') return bad(`Cannot update unknown or completed task: ${op.taskId}`);
      if (op.title !== undefined) task.title = op.title;
      if (op.summary !== undefined) task.summary = op.summary;
      if (op.status !== undefined) task.status = op.status;
      task.updatedAtSequence = state.sequence;
      if (task.status === 'completed') task.completedAtSequence = state.sequence;
      task.evidence.eventIds = [...new Set([...task.evidence.eventIds, ...evidence])];
    }
  }
  const error = validateStoryProgress(state)[0]; if (error) return bad(`${error.path}: ${error.message}`);
  return state;
}
