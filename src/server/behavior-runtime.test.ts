import { describe, expect, it } from 'vitest';
import { BehaviorContractError, createBehaviorCandidates, parseBehaviorApproval, type BehaviorReport } from './behavior-runtime';
import type { BehaviorCandidate } from '../shared/behavior';

const factory = (prefix = 'delivery') => { let ordinal = 0; return () => `${prefix}:${ordinal++}`; };
const candidates: BehaviorCandidate[] = [
  { id: 'a-speech', roleId: 'a', kind: 'speech', text: '先听我说。' },
  { id: 'a-action', roleId: 'a', kind: 'action', text: '伸手去拿钥匙。' },
  { id: 'b-speech', roleId: 'b', kind: 'speech', text: '等等。' },
];

describe('host behavior candidates', () => {
  it('uses only public speech and actions, retaining exact text and source role', () => {
    const reports = [{ roleId: 'a', summary: '已经拿到钥匙的声称', expression: 'legacy must not leak',
      public: { summary: 'private or unadjudicated summary', speech: ['  原话。\n', '第二句。'], actions: ['伸手。'] } }];
    const before = structuredClone(reports);
    const result = createBehaviorCandidates(reports, factory());
    expect(result).toEqual([
      { id: 'delivery:0', roleId: 'a', kind: 'speech', text: '  原话。\n' },
      { id: 'delivery:1', roleId: 'a', kind: 'speech', text: '第二句。' },
      { id: 'delivery:2', roleId: 'a', kind: 'action', text: '伸手。' },
    ]);
    expect(reports).toEqual(before);
  });

  it('never falls back to legacy expression when public behavior is empty', () => {
    expect(createBehaviorCandidates([{ roleId: 'a', expression: 'legacy', public: { speech: [], actions: [] } }], factory())).toEqual([]);
  });

  it('requires approval for legacy expression and does not turn a summary into behavior', () => {
    const reports = [{ roleId: 'a', summary: 'Summary only' }, { roleId: 'b', expression: 'Old speech.' }];
    expect(createBehaviorCandidates(reports, factory())).toEqual([
      { id: 'delivery:0', roleId: 'b', kind: 'speech', text: 'Old speech.' },
    ]);
  });

  it('lets the host distinguish repeated deliveries and repeated text', () => {
    const reports = [{ roleId: 'a', public: { speech: ['Same.', 'Same.'], actions: [] } }];
    const first = createBehaviorCandidates(reports, factory('delivery-1'));
    const second = createBehaviorCandidates(reports, factory('delivery-2'));
    expect(new Set([...first, ...second].map(candidate => candidate.id)).size).toBe(4);
    expect(() => parseBehaviorApproval({ acceptedBehaviorIds: [first[0].id] }, second)).toThrow(/Unknown current-turn/);
  });

  it.each(['', '  ', undefined, 1])('rejects an invalid host id %#', id => {
    expect(() => createBehaviorCandidates([{ roleId: 'a', expression: 'Hi' }], () => id as string)).toThrow(BehaviorContractError);
  });

  it('rejects duplicate host ids instead of silently merging behaviors', () => {
    expect(() => createBehaviorCandidates([{ roleId: 'a', public: { speech: ['One', 'Two'], actions: [] } }], () => 'same')).toThrow(/unique/);
  });

  it.each([
    { roleId: '', expression: 'Hi' },
    { roleId: 'a', expression: 1 },
    { roleId: 'a', public: undefined, expression: 'No fallback' },
    { roleId: 'a', public: { speech: 'bad', actions: [] }, expression: 'No fallback' },
    { roleId: 'a', public: { speech: [1], actions: [] } },
  ])('fails closed on malformed report %#', report => {
    expect(() => createBehaviorCandidates([report as unknown as BehaviorReport], factory())).toThrow(BehaviorContractError);
  });
});

describe('world behavior approval', () => {
  it('selects only explicit ids in world order across roles and kinds', () => {
    const result = parseBehaviorApproval({ acceptedBehaviorIds: ['b-speech', 'a-action'] }, candidates);
    expect(result).toEqual({ acceptedBehaviorIds: ['b-speech', 'a-action'], acceptedBehaviors: [candidates[2], candidates[1]], diagnostics: [] });
    expect(result.acceptedBehaviors.map(candidate => candidate.id)).not.toContain('a-speech');
  });

  it('makes an explicit empty list an intentional denial without a warning', () => {
    expect(parseBehaviorApproval({ acceptedBehaviorIds: [] }, candidates)).toEqual({ acceptedBehaviorIds: [], acceptedBehaviors: [], diagnostics: [] });
  });

  it('fails closed and warns when an older world result has no approval field', () => {
    expect(parseBehaviorApproval({ summary: 'All done.', events: ['A did everything.'] }, candidates)).toMatchObject({
      acceptedBehaviorIds: [], acceptedBehaviors: [], diagnostics: [{ severity: 'warning', code: 'behavior-approval-missing' }],
    });
  });

  it('does not trust approval inherited through a prototype', () => {
    expect(parseBehaviorApproval(Object.create({ acceptedBehaviorIds: ['a-action'] }), candidates).acceptedBehaviors).toEqual([]);
  });

  it.each([undefined, null, 'a-speech', {}, [1], ['a-speech', null], ['unknown'], ['a-speech', 'a-speech'], new Array(1)])('rejects a present invalid approval %#', acceptedBehaviorIds => {
    expect(() => parseBehaviorApproval({ acceptedBehaviorIds }, candidates)).toThrow(BehaviorContractError);
    try { parseBehaviorApproval({ acceptedBehaviorIds }, candidates); }
    catch (error) { expect(error).toMatchObject({ code: 'BEHAVIOR_APPROVAL' }); }
  });

  it.each([null, undefined, [], 'bad', 1])('rejects a non-object world result %#', value => {
    expect(() => parseBehaviorApproval(value, candidates)).toThrow(/World result/);
  });

  it('rejects approval with no current-turn candidates', () => {
    expect(() => parseBehaviorApproval({ acceptedBehaviorIds: ['previous-turn'] }, [])).toThrow(/Unknown current-turn/);
    expect(parseBehaviorApproval({ acceptedBehaviorIds: [] }, [])).toMatchObject({ acceptedBehaviors: [], diagnostics: [] });
  });

  it('rejects an ambiguous host candidate set even when the world approves nothing', () => {
    expect(() => parseBehaviorApproval({ acceptedBehaviorIds: [] }, [candidates[0], { ...candidates[1], id: candidates[0].id }])).toThrow(/unique/);
  });

  it('does not mutate inputs on success, failure, or later result mutation', () => {
    const suppliedCandidates = structuredClone(candidates);
    const world = { acceptedBehaviorIds: ['b-speech', 'a-action'] };
    const beforeCandidates = structuredClone(suppliedCandidates), beforeWorld = structuredClone(world);
    const result = parseBehaviorApproval(world, suppliedCandidates);
    result.acceptedBehaviors[0].text = 'Changed';
    result.acceptedBehaviorIds.reverse();
    expect(suppliedCandidates).toEqual(beforeCandidates);
    expect(world).toEqual(beforeWorld);
    const invalid = { acceptedBehaviorIds: ['a-speech', 'unknown'] };
    expect(() => parseBehaviorApproval(invalid, suppliedCandidates)).toThrow();
    expect(invalid).toEqual({ acceptedBehaviorIds: ['a-speech', 'unknown'] });
    expect(suppliedCandidates).toEqual(beforeCandidates);
  });
});
