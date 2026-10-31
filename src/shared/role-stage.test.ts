import { describe, expect, it } from 'vitest';
import { validateRoleStageTemplate, type RoleStageTemplate } from './role-stage';

const body = '共同😀AB';
const template: RoleStageTemplate = { schema: 'rp.role-stage/0.1', roleId: 'role-a', field: 'affinity', stages: [{ id: 'a', max: 0 }, { id: 'b', min: 0 }], parts: [{ start: 0, end: 4 }, { start: 4, end: 5, stageId: 'a' }, { start: 5, end: 6, stageId: 'b' }] };
describe('role stage template validation', () => {
  it('accepts finite adjacent intervals with complete UTF-16 coverage', () => {
    expect(validateRoleStageTemplate(template, body)).toEqual([]);
  });
  it.each([
    (value: RoleStageTemplate) => { value.stages[0].min = -1000; },
    (value: RoleStageTemplate) => { value.stages[1].max = 1000; },
    (value: RoleStageTemplate) => { value.stages[1].min = 1; },
    (value: RoleStageTemplate) => { value.stages[0].max = Infinity; },
    (value: RoleStageTemplate) => { value.stages[1].id = 'a'; },
    (value: RoleStageTemplate) => { value.parts[1].stageId = 'unknown'; },
    (value: RoleStageTemplate) => { value.parts[0].end = 3; },
    (value: RoleStageTemplate) => { value.parts[0].end = 5; },
    (value: RoleStageTemplate) => { value.parts[2].end = 7; },
    (value: RoleStageTemplate) => { value.parts[0].start = 0.5; },
  ])('rejects invalid bounds, references and text partitions %#', mutate => {
    const invalid = structuredClone(template); mutate(invalid);
    expect(validateRoleStageTemplate(invalid, body).length).toBeGreaterThan(0);
  });
  it.each([null, [], {}, 'template'])('rejects malformed structure %#', value => {
    expect(validateRoleStageTemplate(value, body).length).toBeGreaterThan(0);
  });
  it('requires excluded control ranges for EJS tags', () => {
    const text = '<% code %>A';
    const value: RoleStageTemplate = { ...template, stages: [{ id: 'a' }], parts: [{ start: 0, end: text.length, stageId: 'a' }] };
    expect(validateRoleStageTemplate(value, text)).toContainEqual(expect.objectContaining({ path: '/controlRanges' }));
  });
  it('validates restricted label outputs inside controls and requires literal labels', () => {
    const text = '<%= stage %>A';
    const value: RoleStageTemplate = { ...template, stages: [{ id: 'a', label: 'A' }], parts: [{ start: 12, end: 13, stageId: 'a' }], controlRanges: [{ start: 0, end: 12 }], outputs: [{ start: 0, end: 12, kind: 'stage-label' }] };
    expect(validateRoleStageTemplate(value, text)).toEqual([]);
    const unlabeled = structuredClone(value); delete unlabeled.stages[0].label;
    expect(validateRoleStageTemplate(unlabeled, text).length).toBeGreaterThan(0);
    const repeated = structuredClone(value); repeated.outputs!.push(repeated.outputs![0]);
    expect(validateRoleStageTemplate(repeated, text).length).toBeGreaterThan(0);
    const partial = structuredClone(value); partial.outputs![0].end = 11;
    expect(validateRoleStageTemplate(partial, text).length).toBeGreaterThan(0);
  });
});
