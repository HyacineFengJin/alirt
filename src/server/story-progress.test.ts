import { describe, expect, it } from 'vitest';
import { reduceStoryProgress, type StoryProgressContext } from './story-progress';
import { ApiError } from './store';
import { formatStoryProgress, type StoryProgressState } from '../shared/story-progress';
import type { WorldEvent } from '../shared/types';
import { validateStateJson } from '../shared/state-value-schema';

const fact = (id = 'fact-1', overrides: Partial<WorldEvent> = {}): WorldEvent => ({ id, at: 'host-time', turnId: 'turn-1', kind: 'world-event', actor: 'world', audience: 'public', text: '公开告示已贴出', data: { fact: { text: '公开告示已贴出', sources: [{ kind: 'world-development' }] } }, ...overrides });
const context = (overrides: Partial<StoryProgressContext> = {}): StoryProgressContext => ({ priorEvents: [], currentEvents: [fact()], factEventIds: ['fact-1'], worldRevision: 9, before: { time: null, location: '车站' }, after: { time: '第三日 · 午后', location: '车站' }, ...overrides });
const create = (kind: 'main' | 'side' = 'main') => ({ op: 'create', kind, title: '调查', summary: '核对公开告示', status: 'active', evidence: { factIndexes: [0], eventIds: [] } });
const patch = (operations: unknown[] = [create()]) => ({ operations });
function frozen<T>(value: T): T { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) frozen(child); } return value; }
function rejects(action: () => unknown) { try { action(); throw Error('expected failure'); } catch (error) { expect(error).toBeInstanceOf(ApiError); expect((error as ApiError).code).toBe('STORY_PROGRESS'); } }
const next = (previous: StoryProgressState, overrides: Partial<StoryProgressContext> = {}) => context({ previous, priorEvents: [fact()], currentEvents: [fact('fact-2')], factEventIds: ['fact-2'], worldRevision: 10, ...overrides });

describe('host story progress reducer', () => {
  it('supports a long public canonical ledger over the aggregate JSON budget without weakening per-event checks', () => {
    const priorEvents = Array.from({ length: 100 }, (_, index) => fact(`old-${index}`, { data: { fact: { text: '公开告示已贴出', sources: [{ kind: 'state', roleId: 'world', key: 'public-list', value: Array.from({ length: 1100 }, (_, item) => `item-${item}`) }] } } }));
    expect(validateStateJson(priorEvents)[0].message).toContain('depth or size');
    expect(priorEvents.every(event => !validateStateJson(event).length)).toBe(true);
    const result = reduceStoryProgress(patch([{ ...create(), evidence: { factIndexes: [], eventIds: ['old-0'] } }]), context({ priorEvents }));
    expect(result.tasks[0].evidence.eventIds).toEqual(['old-0']);
    let reads = 0; const accessor: WorldEvent[] = []; accessor.length = 1;
    Object.defineProperty(accessor, '0', { enumerable: true, get() { reads++; return fact(); } });
    for (const events of [new Array(1), accessor, Object.assign([fact()], { extra: true }), Object.setPrototypeOf([fact()], {})]) rejects(() => reduceStoryProgress(patch(), context({ priorEvents: events })));
    expect(reads).toBe(0);
  });

  it('allocates host identities, resolves fact indexes and retained evidence, and returns detached data from frozen inputs', () => {
    const input = frozen(patch([create(), { ...create('side'), evidence: { factIndexes: [], eventIds: ['old-fact'] } }]));
    const ctx = frozen(context({ priorEvents: [fact('old-fact', { data: undefined })] }));
    // Omit absent optional data just as canonical JSON does.
    const old = fact('old-fact'); delete old.data;
    const safeCtx = frozen(context({ priorEvents: [old] }));
    const before = JSON.stringify([input, safeCtx]);
    const result = reduceStoryProgress(input, safeCtx);
    expect(result).toMatchObject({ sequence: 1, nextMainIndex: 2, nextSideIndex: 2, worldRevision: 9 });
    expect(result.tasks.map(task => [task.id, task.evidence.eventIds])).toEqual([['MQ.I', ['fact-1']], ['SQ.1', ['old-fact']]]);
    result.after.location = 'edited output'; result.tasks[0].evidence.eventIds.push('not-source');
    expect(JSON.stringify([input, safeCtx])).toBe(before);
    // Present-but-undefined is not a silently tolerated JSON field.
    rejects(() => reduceStoryProgress(input, ctx));
  });

  it('increments each world-progress batch including empty operations, never computes elapsed time and rejects repeated revisions', () => {
    const first = reduceStoryProgress(patch([]), context());
    expect(first.sequence).toBe(1); expect(first.tasks).toEqual([]);
    const second = reduceStoryProgress(patch([]), next(first));
    expect(second.sequence).toBe(2); expect(second.nextMainIndex).toBe(1);
    expect(formatStoryProgress(second)).toContain('经过时长：未知');
    rejects(() => reduceStoryProgress(patch([]), next(second)));
    expect(first.sequence).toBe(1);
  });

  it('completes the old main before creating a new main in the same batch and preserves completion archives', () => {
    const first = frozen(reduceStoryProgress(patch(), context()));
    const completion = { op: 'update', taskId: 'MQ.I', status: 'completed', summary: '核对完毕', evidence: { factIndexes: [0], eventIds: ['fact-1'] } };
    const result = reduceStoryProgress(patch([completion, create()]), next(first));
    expect(result.tasks.map(task => [task.id, task.status])).toEqual([['MQ.I', 'completed'], ['MQ.II', 'active']]);
    expect(result.tasks[0]).toMatchObject({ createdAtSequence: 1, updatedAtSequence: 2, completedAtSequence: 2, evidence: { eventIds: ['fact-1', 'fact-2'] } });
    expect(formatStoryProgress(result)).toContain('MQ.I [已完成]');
    const third = reduceStoryProgress(patch([]), next(result, { priorEvents: [fact(), fact('fact-2')], currentEvents: [], factEventIds: [], worldRevision: 11 }));
    expect(formatStoryProgress(third)).not.toContain('MQ.I [已完成]');
    expect(third.tasks[0]).toEqual(result.tasks[0]); expect(first.tasks[0].status).toBe('active');
    rejects(() => reduceStoryProgress(patch([create(), completion]), next(first)));
    rejects(() => reduceStoryProgress(patch([{ ...completion, taskId: 'MQ.I' }]), next(result, { priorEvents: [fact(), fact('fact-2')], currentEvents: [], factEventIds: [], worldRevision: 11 })));
  });

  it('counts shelved main as unfinished and rejects invalid updates or missing changes atomically', () => {
    const first = reduceStoryProgress(patch([{ ...create(), status: 'shelved' }]), context());
    const before = JSON.stringify(first);
    for (const operations of [[create()], [{ op: 'update', taskId: 'MQ.unknown', title: '更名', evidence: { factIndexes: [0], eventIds: [] } }], [{ op: 'update', taskId: 'MQ.I', evidence: { factIndexes: [0], eventIds: [] } }], [{ op: 'update', taskId: 'MQ.I', title: '更名', sequence: 8, evidence: { factIndexes: [0], eventIds: [] } }]]) rejects(() => reduceStoryProgress(patch(operations), next(first)));
    expect(JSON.stringify(first)).toBe(before);
    expect(reduceStoryProgress(patch([{ op: 'update', taskId: 'MQ.I', status: 'active', evidence: { factIndexes: [0], eventIds: [] } }]), next(first)).tasks[0].status).toBe('active');
  });

  it('rejects private/raw/behavior/host-output/colliding/uncompiled/mismatched or missing evidence', () => {
    const denied = [fact('x', { audience: 'author' }), fact('x', { kind: 'role-result' }), fact('x', { kind: 'role-behavior' }), fact('x', { kind: 'host-output' }), fact('x', { actor: 'role-1' }), fact('x', { text: 'not the compiled fact' })];
    for (const event of denied) {
      const op = { ...create(), evidence: { factIndexes: [], eventIds: ['x'] } };
      rejects(() => reduceStoryProgress(patch([op]), context({ priorEvents: [event] })));
    }
    rejects(() => reduceStoryProgress(patch(), context({ factEventIds: ['missing'] })));
    rejects(() => reduceStoryProgress(patch(), context({ priorEvents: [fact()] })));
    const legacy = fact(); delete legacy.data;
    rejects(() => reduceStoryProgress(patch(), context({ currentEvents: [legacy] })));
    rejects(() => reduceStoryProgress(patch([{ ...create(), evidence: { factIndexes: [1], eventIds: [] } }]), context()));
    rejects(() => reduceStoryProgress(patch([{ ...create(), evidence: { factIndexes: [], eventIds: [] } }]), context()));
    rejects(() => reduceStoryProgress(patch([{ ...create(), evidence: { factIndexes: [], eventIds: ['missing'] } }]), context()));
  });

  it('refuses corrupt held state and withdrawn/missing held evidence instead of resetting, including counter overflow', () => {
    const first = reduceStoryProgress(patch(), context());
    rejects(() => reduceStoryProgress(patch([]), next({ ...first, nextMainIndex: 99 })));
    rejects(() => reduceStoryProgress(patch([]), next(first, { priorEvents: [] })));
    rejects(() => reduceStoryProgress(patch([]), next({ ...first, sequence: Number.MAX_SAFE_INTEGER })));
    expect(first.tasks[0].id).toBe('MQ.I');
  });
});
