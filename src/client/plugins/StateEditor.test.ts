import { describe, expect, it } from 'vitest';
import { parseStateValue } from './StateEditor';
import type { StateField } from '../../shared/types';

describe('structured state editor', () => {
  const skills: StateField = { key: 'skills', label: '技能', type: 'list', audience: ['performer'], editable: true,
    valueSchema: { type: 'list', items: { type: 'object', properties: {
      name: { type: 'string' }, effect: { type: 'string', enum: ['score_bonus'] },
      value: { type: 'number' }, ap: { type: 'number' },
    }, required: ['name', 'effect', 'value', 'ap'] } } };
  it('rejects malformed structured rows before submitting an author edit', () => {
    expect(() => parseStateValue(skills, '[{"name":"test","effect":"invented","value":0.5,"ap":1}]')).toThrow();
    expect(() => parseStateValue(skills, '[{"name":"test","effect":"score_bonus","value":0.5}]')).toThrow();
    expect(parseStateValue(skills, '[{"name":"test","effect":"score_bonus","value":0.5,"ap":1}]')).toEqual([
      { name: 'test', effect: 'score_bonus', value: 0.5, ap: 1 },
    ]);
  });
  it('keeps blank numbers distinct from a declared unknown state', () => {
    const field: StateField = { key: 'gr', label: 'GR', type: 'number', audience: 'author', editable: true, nullable: true };
    expect(() => parseStateValue(field, '')).toThrow();
    expect(parseStateValue(field, '0')).toBe(0);
  });
});
