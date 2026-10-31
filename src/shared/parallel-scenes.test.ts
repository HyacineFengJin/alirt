import { describe, expect, it } from 'vitest';
import { validateParallelSceneDefinition, validateParallelScenesCommand } from './parallel-scenes';

const scene = () => ({ id: 'scene-a', title: '场外核对', enabled: false, participantRoleIds: ['actor'], locationKey: 'location', goal: '在已知地点核对已有告示' });
const command = () => ({ requestId: 'request-a', expectedRevision: 0, reason: '明确授权', operation: 'upsert', scene: scene() });
describe('parallel scene author contracts', () => {
  it('accepts exact definitions and finite zero/one/two scene selections without imposing a participant cap', () => {
    expect(validateParallelScenesCommand(command())).toEqual([]);
    expect(validateParallelSceneDefinition({ ...scene(), participantRoleIds: Array.from({ length: 30 }, (_, index) => `actor-${index}`) })).toEqual([]);
    for (const selectedSceneIds of [[], ['a'], ['a', 'b']]) expect(validateParallelScenesCommand({ requestId: 'select', expectedRevision: 0, reason: '明确选择', operation: 'select', selectedSceneIds })).toEqual([]);
    expect(validateParallelSceneDefinition({ ...scene(), generation: 1 }, true)).toEqual([]);
  });
  it('rejects model-owned generations, extra fields, duplicate/empty participants and invalid selections', () => {
    for (const value of [{ ...scene(), generation: 1 }, { ...scene(), participantRoleIds: [] }, { ...scene(), participantRoleIds: ['a', 'a'] }, { ...scene(), locationKey: ' ' }, { ...scene(), goal: ' ' }]) expect(validateParallelSceneDefinition(value).length).toBeGreaterThan(0);
    for (const selectedSceneIds of [['a', 'a'], ['a', 'b', 'c']]) expect(validateParallelScenesCommand({ requestId: 'x', expectedRevision: 0, reason: '选择', operation: 'select', selectedSceneIds }).length).toBeGreaterThan(0);
    expect(validateParallelScenesCommand({ ...command(), phase: 'active' }).length).toBeGreaterThan(0);
  });
  it('rejects non-JSON/accessor/prototype/cycle/hidden/sparse input without invoking getters', () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, 'scene', { enumerable: true, get() { reads++; return scene(); } });
    const cyclic: any = command(); cyclic.scene.self = cyclic;
    for (const value of [accessor, cyclic, Object.assign(Object.create({}), command()), Object.defineProperty(command(), 'hidden', { value: true }), { ...command(), expectedRevision: Infinity }, { ...command(), scene: { ...scene(), participantRoleIds: new Array(1) } }]) expect(validateParallelScenesCommand(value).length).toBeGreaterThan(0);
    expect(reads).toBe(0);
  });
});
