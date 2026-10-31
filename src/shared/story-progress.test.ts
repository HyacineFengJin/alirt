import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { formatStoryProgress, storyMainRoman, storyTaskId, STORY_PROGRESS_PATCH_SCHEMA, validateStoryProgress, validateStoryProgressPatch, type StoryProgressState } from './story-progress';

const patch = () => ({ operations: [{ op: 'create', kind: 'main', title: '调查', summary: '核对公开告示', status: 'active', evidence: { factIndexes: [0], eventIds: [] } }] });
const state = (): StoryProgressState => ({ schema: 'rp.story-progress/0.1', sequence: 2, nextMainIndex: 2, nextSideIndex: 1, tasks: [{
  id: 'MQ.I', kind: 'main', ordinal: 1, title: '调查<告示>', summary: '已核对&记录', status: 'completed', createdAtSequence: 1, updatedAtSequence: 2, completedAtSequence: 2, evidence: { eventIds: ['fact-1'] },
}], worldRevision: 9, before: { time: null, location: '' }, after: { time: '第三日 · 午后', location: '车站' } });

describe('story progress shared contract', () => {
  it('matches world patch schema and strict host validation without model-owned counters', () => {
    const validate = new Ajv({ strict: true }).compile(STORY_PROGRESS_PATCH_SCHEMA);
    const values = [patch(), { operations: [] }, { operations: [{ op: 'update', taskId: 'MQ.I', status: 'completed', evidence: { factIndexes: [], eventIds: ['old-fact'] } }] }];
    for (const value of values) { expect(validate(value)).toBe(true); expect(validateStoryProgressPatch(value)).toEqual([]); }
    const invalid = [
      { ...patch(), sequence: 4 },
      { operations: [{ ...patch().operations[0], id: 'MQ.IV' }] },
      { operations: [{ ...patch().operations[0], evidence: { factIndexes: [], eventIds: [] } }] },
      { operations: [{ op: 'update', taskId: 'MQ.I', evidence: { factIndexes: [0], eventIds: [] } }] },
      { operations: [{ ...patch().operations[0], status: 'completed' }] },
      { operations: [{ ...patch().operations[0], title: '  ' }] },
      { operations: [{ ...patch().operations[0], evidence: { factIndexes: [0.5], eventIds: [] } }] },
      { operations: [{ ...patch().operations[0], evidence: { factIndexes: [0, 0], eventIds: [] } }] },
    ];
    for (const value of invalid) { expect(validate(value)).toBe(false); expect(validateStoryProgressPatch(value).length).toBeGreaterThan(0); }
  });

  it('rejects accessors, prototypes, sparse arrays, cycles and nonfinite values without executing getters', () => {
    let calls = 0;
    const getter = Object.defineProperty({}, 'operations', { enumerable: true, get() { calls++; return []; } });
    const cyclic: any = { operations: [] }; cyclic.operations.push(cyclic);
    for (const value of [getter, Object.assign(Object.create({}), patch()), { operations: new Array(1) }, cyclic, { operations: [], unknown: Infinity }]) expect(validateStoryProgressPatch(value).length).toBeGreaterThan(0);
    expect(calls).toBe(0);
  });

  it('fails corrupt held metadata, host identities, counters and archives instead of silently resetting', () => {
    expect(validateStoryProgress(state())).toEqual([]);
    const corrupt: any[] = [
      { ...state(), nextMainIndex: 3 }, { ...state(), sequence: 1 }, { ...state(), PG: 2 },
      { ...state(), tasks: [{ ...state().tasks[0], id: 'MQ.II' }] },
      { ...state(), tasks: [{ ...state().tasks[0], completedAtSequence: 1 }] },
      { ...state(), tasks: [{ ...state().tasks[0], evidence: { eventIds: [] } }] },
      { ...state(), tasks: [{ ...state().tasks[0], status: 'active' }] },
    ];
    for (const value of corrupt) expect(validateStoryProgress(value).length).toBeGreaterThan(0);
    const unfinished = [1, 2].map(ordinal => {
      const { completedAtSequence: _completed, ...task } = state().tasks[0];
      return { ...task, id: storyTaskId('main', ordinal), ordinal, status: 'shelved' };
    });
    expect(validateStoryProgress({ ...state(), nextMainIndex: 3, tasks: unfinished })[0].message).toContain('one unfinished main');
  });

  it('formats only canonical held values, escapes carriers and hides completion after its batch without mutating archives', () => {
    const value = state(); const before = JSON.stringify(value);
    const text = formatStoryProgress(value);
    expect(text).toContain('任务进度'); expect(text).not.toContain('<');
    expect(text).toContain('调查&lt;告示&gt;'); expect(text).toContain('已核对&amp;记录');
    expect(text).toContain('时间：未知 → 第三日 · 午后'); expect(text).toContain('地点：未知 → 车站');
    expect(text).toContain('经过时长：未知'); expect(text).toContain('进展修订：2');
    expect(formatStoryProgress({ ...value, sequence: 3 })).not.toContain('MQ.I');
    expect(JSON.stringify(value)).toBe(before);
  });

  it('uses monotonic Roman main and decimal side identities without an unbounded string at safe-integer limits', () => {
    expect([1, 4, 9, 49, 3999, 4000].map(storyMainRoman)).toEqual(['I', 'IV', 'IX', 'XLIX', 'MMMCMXCIX', '(IV)']);
    expect(storyTaskId('side', 14)).toBe('SQ.14');
    expect(storyMainRoman(Number.MAX_SAFE_INTEGER).length).toBeLessThan(150);
    expect(() => storyMainRoman(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});
