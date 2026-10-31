import { validateStateJson } from './state-value-schema';

export type StoryTaskKind = 'main' | 'side';
export type StoryTaskStatus = 'active' | 'completed' | 'shelved';
export interface StoryProgressPosition { time: string | null; location: string | null }
export interface StoryProgressTask {
  id: string; kind: StoryTaskKind; ordinal: number; title: string; summary: string; status: StoryTaskStatus;
  createdAtSequence: number; updatedAtSequence: number; completedAtSequence?: number;
  evidence: { eventIds: string[] };
}
export interface StoryProgressState {
  schema: 'rp.story-progress/0.1'; sequence: number; nextMainIndex: number; nextSideIndex: number;
  tasks: StoryProgressTask[]; worldRevision: number; before: StoryProgressPosition; after: StoryProgressPosition;
}
export interface StoryProgressEvidence { factIndexes: number[]; eventIds: string[] }
export type StoryProgressOperation =
  | { op: 'create'; kind: StoryTaskKind; title: string; summary: string; status: 'active' | 'shelved'; evidence: StoryProgressEvidence }
  | { op: 'update'; taskId: string; title?: string; summary?: string; status?: StoryTaskStatus; evidence: StoryProgressEvidence };
export interface StoryProgressPatch { operations: StoryProgressOperation[] }
export interface StoryProgressIssue { path: string; message: string }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min = 1): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const exact = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));
function stringIds(value: unknown): value is string[] { return Array.isArray(value) && value.every(text) && new Set(value).size === value.length; }

/** Parentheses denote a factor of 1000 above conventional Roman numerals, so
 * even safe-integer ordinals have bounded IDs rather than enormous M strings. */
export function storyMainRoman(ordinal: number): string {
  if (!integer(ordinal)) throw new Error('Invalid story task ordinal');
  if (ordinal >= 4000) return `(${storyMainRoman(Math.floor(ordinal / 1000))})${ordinal % 1000 ? storyMainRoman(ordinal % 1000) : ''}`;
  const values: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let result = '';
  for (const [value, glyph] of values) while (ordinal >= value) { result += glyph; ordinal -= value; }
  return result;
}
export function storyTaskId(kind: StoryTaskKind, ordinal: number): string {
  if (!integer(ordinal) || !['main', 'side'].includes(kind)) throw new Error('Invalid story task identity');
  return kind === 'main' ? `MQ.${storyMainRoman(ordinal)}` : `SQ.${ordinal}`;
}

export function validateStoryProgressPosition(value: unknown): boolean {
  return record(value) && exact(value, ['time', 'location']) && [value.time, value.location].every(item => item === null || typeof item === 'string');
}

/** Validation never repairs corrupt held state or invokes getters. */
export function validateStoryProgress(value: unknown): StoryProgressIssue[] {
  const json = validateStateJson(value);
  if (json.length) return json.map(({ path, message }) => ({ path, message }));
  const issue = (path: string, message: string): StoryProgressIssue[] => [{ path, message }];
  if (!record(value) || !exact(value, ['schema', 'sequence', 'nextMainIndex', 'nextSideIndex', 'tasks', 'worldRevision', 'before', 'after'])) return issue('', 'Invalid story progress shape');
  if (value.schema !== 'rp.story-progress/0.1' || !integer(value.sequence) || !integer(value.worldRevision)
    || !integer(value.nextMainIndex) || !integer(value.nextSideIndex) || !validateStoryProgressPosition(value.before) || !validateStoryProgressPosition(value.after) || !Array.isArray(value.tasks)) return issue('', 'Invalid story progress metadata');
  const ids = new Set<string>(); let main = 0; let mainCount = 0; let sideCount = 0;
  const ordinals = { main: new Set<number>(), side: new Set<number>() };
  for (const [index, task] of value.tasks.entries()) {
    const path = `/tasks/${index}`;
    if (!record(task) || !exact(task, ['id', 'kind', 'ordinal', 'title', 'summary', 'status', 'createdAtSequence', 'updatedAtSequence', 'evidence'], ['completedAtSequence'])) return issue(path, 'Invalid task shape');
    if (task.kind !== 'main' && task.kind !== 'side') return issue(path, 'Invalid task kind');
    if (!integer(task.ordinal) || task.id !== storyTaskId(task.kind, task.ordinal) || ids.has(task.id as string) || ordinals[task.kind].has(task.ordinal)) return issue(path, 'Invalid or duplicate host task identity');
    ids.add(task.id as string); ordinals[task.kind].add(task.ordinal);
    if (!text(task.title) || !text(task.summary) || !['active', 'completed', 'shelved'].includes(task.status as string)) return issue(path, 'Invalid task text or status');
    if (!integer(task.createdAtSequence) || !integer(task.updatedAtSequence) || task.createdAtSequence > task.updatedAtSequence || task.updatedAtSequence > value.sequence) return issue(path, 'Invalid task sequence');
    if (task.status === 'completed' ? !integer(task.completedAtSequence) || task.completedAtSequence !== task.updatedAtSequence : Object.hasOwn(task, 'completedAtSequence')) return issue(path, 'Invalid task completion sequence');
    if (!record(task.evidence) || !exact(task.evidence, ['eventIds']) || !stringIds(task.evidence.eventIds) || !task.evidence.eventIds.length) return issue(path, 'Task requires unique canonical event evidence');
    if (task.kind === 'main') { mainCount++; if (task.status !== 'completed') main++; } else sideCount++;
  }
  if (main > 1) return issue('/tasks', 'At most one unfinished main task is allowed');
  for (const [kind, count, next] of [['main', mainCount, value.nextMainIndex], ['side', sideCount, value.nextSideIndex]] as const)
    if (count !== next - 1 || [...ordinals[kind]].some(ordinal => ordinal >= next)) return issue('', 'Task counters must exactly preserve archived monotonic identities');
  return [];
}

export function validateStoryProgressPatch(value: unknown): StoryProgressIssue[] {
  const json = validateStateJson(value); if (json.length) return json.map(({ path, message }) => ({ path, message }));
  const fail = (path: string, message: string): StoryProgressIssue[] => [{ path, message }];
  if (!record(value) || !exact(value, ['operations']) || !Array.isArray(value.operations)) return fail('', 'Expected exact operations array');
  for (const [index, op] of value.operations.entries()) {
    const path = `/operations/${index}`;
    if (!record(op)) return fail(path, 'Expected operation object');
    if (op.op === 'create') {
      if (!exact(op, ['op', 'kind', 'title', 'summary', 'status', 'evidence']) || !['main', 'side'].includes(op.kind as string)
        || !text(op.title) || !text(op.summary) || !['active', 'shelved'].includes(op.status as string)) return fail(path, 'Invalid create operation');
    } else if (op.op === 'update') {
      if (!exact(op, ['op', 'taskId', 'evidence'], ['title', 'summary', 'status']) || !text(op.taskId)
        || !['title', 'summary', 'status'].some(key => Object.hasOwn(op, key))
        || Object.hasOwn(op, 'title') && !text(op.title) || Object.hasOwn(op, 'summary') && !text(op.summary)
        || Object.hasOwn(op, 'status') && !['active', 'completed', 'shelved'].includes(op.status as string)) return fail(path, 'Invalid update operation');
    } else return fail(path, 'Unknown story progress operation');
    const evidence = op.evidence;
    if (!record(evidence) || !exact(evidence, ['factIndexes', 'eventIds']) || !Array.isArray(evidence.factIndexes)
      || evidence.factIndexes.some(index => !integer(index, 0)) || new Set(evidence.factIndexes).size !== evidence.factIndexes.length
      || !stringIds(evidence.eventIds) || !evidence.factIndexes.length && !evidence.eventIds.length) return fail(path, 'Operation requires unique fact indexes or canonical event IDs');
  }
  return [];
}

const nonblank = { type: 'string', pattern: '\\S' };
const evidenceSchema = { type: 'object', additionalProperties: false, required: ['factIndexes', 'eventIds'], properties: {
  factIndexes: { type: 'array', uniqueItems: true, items: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } },
  eventIds: { type: 'array', uniqueItems: true, items: nonblank },
}, anyOf: [{ properties: { factIndexes: { type: 'array', minItems: 1 } } }, { properties: { eventIds: { type: 'array', minItems: 1 } } }] };
/** World-result JSON schema, not a prose-writer schema. No model-authored IDs or counters. */
export const STORY_PROGRESS_PATCH_SCHEMA = { type: 'object', additionalProperties: false, required: ['operations'], properties: { operations: { type: 'array', items: { oneOf: [
  { type: 'object', additionalProperties: false, required: ['op', 'kind', 'title', 'summary', 'status', 'evidence'], properties: {
    op: { const: 'create' }, kind: { enum: ['main', 'side'] }, title: nonblank, summary: nonblank, status: { enum: ['active', 'shelved'] }, evidence: evidenceSchema,
  } },
  { type: 'object', additionalProperties: false, required: ['op', 'taskId', 'evidence'], anyOf: ['title', 'summary', 'status'].map(key => ({ required: [key] })), properties: {
    op: { const: 'update' }, taskId: nonblank, title: nonblank, summary: nonblank, status: { enum: ['active', 'completed', 'shelved'] }, evidence: evidenceSchema,
  } },
] } } } } as const;
export const STORY_PROGRESS_PROTOCOL = 'When story progress is enabled, return storyProgress:{operations:[]}. Propose tasks only when supported by supplied public canonical world-event IDs or zero-based indexes into this result\'s compiled public facts. Each create/update needs evidence; do not use role reports, private mail or prose. Create accepts kind main|side, nonblank title/summary and status active|shelved. Update accepts an existing taskId and at least one title/summary/status field (active|completed|shelved); completed tasks cannot be changed. At most one unfinished main task may remain; complete an old main before creating a new one. Never assign task IDs, ordinals, PG/sequence, counters or timestamps. Host allocates these only after a successful world commit; no task operation is also a clock, inventory or character-state change.';

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const literal = (value: string | null) => value === null || !value.trim() ? '未知' : escape(value);
/** Completed tasks appear on their completion batch only; their archives are untouched. */
export function formatStoryProgress(value: StoryProgressState): string {
  const errors = validateStoryProgress(value); if (errors.length) throw new Error(`Invalid story progress: ${errors[0].message}`);
  const tasks = value.tasks.filter(task => task.status !== 'completed' || task.completedAtSequence === value.sequence);
  const taskText = tasks.map(task => `${task.id} [${({ active: '进行中', completed: '已完成', shelved: '搁置' })[task.status]}] ${escape(task.title)}\n${escape(task.summary)}\n证据：${task.evidence.eventIds.map(escape).join('、')}`).join('\n\n') || '暂无已记录任务';
  return `任务进度\n${taskText}\n进展修订：${value.sequence}（已提交事务，含作者修正，非时间）\n时间：${literal(value.before.time)} → ${literal(value.after.time)}\n地点：${literal(value.before.location)} → ${literal(value.after.location)}\n经过时长：未知（不据时间标签推算）\n故事版本：${value.worldRevision}`;
}
