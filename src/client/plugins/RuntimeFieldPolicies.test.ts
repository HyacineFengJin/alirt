import { describe, expect, it } from 'vitest';
import type { StateField } from '../../shared/types';
import { changedFieldPolicies, fieldPolicyDraft, parseFieldPolicyDraft } from './RuntimeFieldPolicies';

describe('runtime field policy draft', () => {
  const field: StateField = { key: 'affinity', label: '待裁定好感', type: 'number', audience: 'author', editable: false, writableBy: 'author' };
  it('explicitly admits an author-selected policy without changing field identity', () => {
    const next = parseFieldPolicyDraft(field, { ...fieldPolicyDraft(field), min: '-100', max: '100', editable: true, writableBy: 'model' }, []);
    expect(changedFieldPolicies([field], [next])).toEqual([{ key: 'affinity', min: -100, max: 100, editable: true, writableBy: 'model' }]);
    expect(next.key).toBe(field.key); expect(next.type).toBe(field.type);
    expect(field).not.toHaveProperty('min');
  });
  it('clears constraints with null patches rather than silently retaining old bounds', () => {
    const base = { ...field, min: -100, max: 100, valueSchema: { type: 'number' as const, min: -100, max: 100 } };
    const next = parseFieldPolicyDraft(base, { ...fieldPolicyDraft(base), min: '', max: '', schema: '' }, []);
    expect(changedFieldPolicies([base], [next])).toEqual([{ key: field.key, min: null, max: null, valueSchema: null }]);
  });
  it('rejects malformed constraints and disclosure targets before sending a command', () => {
    for (const patch of [{ min: 'NaN' }, { min: '200', max: '100' }, { schema: '{' }, { schema: '{"type":"list","items":{"type":"string"}}' },
      { audience: 'roles' as const, roleIds: 'missing' }, { audience: 'roles' as const, roleIds: 'npc,npc' }]) {
      expect(() => parseFieldPolicyDraft(field, { ...fieldPolicyDraft(field), ...patch }, [{ id: 'npc' }])).toThrow();
    }
    expect(parseFieldPolicyDraft(field, { ...fieldPolicyDraft(field), audience: 'roles', roleIds: 'npc' }, [{ id: 'npc' }]).audience).toEqual(['npc']);
  });
  it('keeps untouched optional defaults absent so plugin field declarations stay intact', () => {
    const legacy = { ...field }; delete legacy.writableBy;
    expect(parseFieldPolicyDraft(legacy, fieldPolicyDraft(legacy), [])).toEqual(legacy);
    expect(changedFieldPolicies([legacy], [parseFieldPolicyDraft(legacy, fieldPolicyDraft(legacy), [])])).toEqual([]);
  });
  it('refuses field replacement or type changes through a policy-only editor', () => {
    expect(() => changedFieldPolicies([field], [{ ...field, key: 'replacement' }])).toThrow();
    expect(() => changedFieldPolicies([field], [{ ...field, type: 'string' }])).toThrow();
  });
});
