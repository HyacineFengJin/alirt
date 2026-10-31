import { describe, expect, it } from 'vitest';
import { materializeRoleStage } from './role-stage-runtime';
import type { RoleStageTemplate } from '../shared/role-stage';

const body = '公共|戒备|陌生|熟悉|信任|亲密|结尾';
const template: RoleStageTemplate = {
  schema: 'rp.role-stage/0.1', roleId: 'role-a', field: 'affinity',
  stages: [{ id: 'a', max: 0 }, { id: 'b', min: 0, max: 350 }, { id: 'c', min: 350, max: 700 }, { id: 'd', min: 700, max: 900 }, { id: 'e', min: 900 }],
  parts: [{ start: 0, end: 3 }, { start: 3, end: 6, stageId: 'a' }, { start: 6, end: 9, stageId: 'b' }, { start: 9, end: 12, stageId: 'c' }, { start: 12, end: 15, stageId: 'd' }, { start: 15, end: 18, stageId: 'e' }, { start: 18, end: 20 }],
};
describe('role stage materialization', () => {
  it.each([[-1, 'a', '戒备'], [0, 'b', '陌生'], [349, 'b', '陌生'], [350, 'c', '熟悉'], [699, 'c', '熟悉'], [700, 'd', '信任'], [899, 'd', '信任'], [900, 'e', '亲密'], [1000, 'e', '亲密']] as const)('selects only the interval containing %s', (value, stageId, text) => {
    expect(materializeRoleStage(body, template, value)).toEqual({ content: `公共|${text}|结尾`, stageId, unknown: false, diagnostics: [] });
  });
  it.each([null, undefined, '350', false, true, {}, [], Number.NaN, Infinity, -Infinity])('delivers only common parts for unknown value %#', value => {
    expect(materializeRoleStage(body, template, value)).toMatchObject({ content: '公共|结尾', unknown: true, diagnostics: [{ code: 'role-stage-unknown', severity: 'warning' }] });
    expect(materializeRoleStage(body, template, value)).not.toHaveProperty('stageId');
  });
  it('orders selected parts by original offset without modifying the template', () => {
    const reversed = { ...template, parts: [...template.parts].reverse() };
    const original = structuredClone(reversed);
    expect(materializeRoleStage(body, reversed, 350).content).toBe('公共|熟悉|结尾');
    expect(reversed).toEqual(original);
  });
  it('fails closed for invalid intervals or ranges', () => {
    const invalid = structuredClone(template); invalid.stages[1].min = 1;
    expect(materializeRoleStage(body, invalid, 350)).toMatchObject({ content: '', diagnostics: [{ severity: 'error', code: 'role-stage-invalid' }] });
  });
});
