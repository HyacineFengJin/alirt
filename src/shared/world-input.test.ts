import { describe, expect, it, vi } from 'vitest';
import { validateWorldInputEvidence, validateWorldInputSelection, type WorldInputEvidence } from './world-input';

const selection = () => ({ serviceId: 'test.service', referenceId: 'result-1', parameters: { actor: 'player', nested: [true, null, 3] } });
const evidence = (): WorldInputEvidence => ({ schema: 'rp.world-input/0.1', id: 'input:1', serviceId: 'test.service', referenceId: 'result-1',
  kind: 'local-result', title: 'Reviewed local result', payload: { score: 3, notes: ['Settled'] } });
describe('strict world input contracts', () => {
  it('returns detached exact JSON selections and evidence', () => {
    const input = selection(), output = validateWorldInputSelection(input); output.parameters = { changed: true };
    expect(input).toEqual(selection());
    const held = evidence(), checked = validateWorldInputEvidence(held);
    (checked.payload as any).notes.push('Changed'); expect(held).toEqual(evidence());
    expect(validateWorldInputSelection({ ...selection(), parameters: null })).toEqual({ ...selection(), parameters: null });
  });
  it.each([
    undefined, null, [], {}, { ...selection(), extra: true }, { ...selection(), serviceId: '  ' },
    { ...selection(), referenceId: '' }, { ...selection(), parameters: undefined },
    { ...selection(), parameters: NaN }, { ...selection(), parameters: new Date() },
    { ...selection(), parameters: JSON.parse('{"__proto__":1}') },
  ])('rejects malformed selections %#', input => { expect(() => validateWorldInputSelection(input)).toThrow(); });
  it.each([
    { ...evidence(), schema: 'unsupported' }, { ...evidence(), id: '' }, { ...evidence(), kind: ' ' },
    { ...evidence(), title: '' }, { ...evidence(), serviceId: null }, { ...evidence(), referenceId: 3 },
    { ...evidence(), payload: { value: Infinity } }, { ...evidence(), payload: new Map() },
    { ...evidence(), requestFingerprint: 'untrusted-extra' },
  ])('rejects malformed evidence %#', input => { expect(() => validateWorldInputEvidence(input)).toThrow(); });
  it('rejects accessors, hidden properties, symbols, cycles, and sparse arrays without invoking getters', () => {
    const getter = vi.fn(() => ({})), accessor = Object.defineProperty(selection(), 'parameters', { enumerable: true, get: getter });
    const hidden = Object.defineProperty(selection(), 'hidden', { value: 3 });
    const symbol = { ...selection(), [Symbol('hidden')]: 1 }, cycle: any = {}; cycle.self = cycle;
    for (const value of [accessor, hidden, symbol, { ...selection(), parameters: cycle }, { ...selection(), parameters: new Array(1) }]) {
      expect(() => validateWorldInputSelection(value)).toThrow();
    }
    const payload = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
    expect(() => validateWorldInputEvidence({ ...evidence(), payload })).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
});
