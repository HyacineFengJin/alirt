import { describe, expect, it } from 'vitest';
import { validateEventLedger } from './event-ledger';
import { validateStateJson } from '../shared/state-value-schema';

describe('finite JSON event ledger envelope', () => {
  it('applies the unchanged JSON budget per event rather than to the aggregate history', () => {
    const ledger = Array.from({ length: 100 }, (_, index) => ({ id: `event-${index}`, data: { values: Array.from({ length: 1100 }, (_, item) => item) } }));
    expect(validateStateJson(ledger)[0].message).toContain('depth or size');
    expect(validateEventLedger(Object.freeze(ledger))).toEqual([]);
    expect(validateEventLedger([{ data: Array(100001).fill(0) }])[0].message).toContain('depth or size');
  });
  it('rejects sparse/accessor/subclass/prototype/symbol/extra/hidden array properties without reading getters', () => {
    let reads = 0;
    const accessor: unknown[] = []; accessor.length = 1;
    Object.defineProperty(accessor, '0', { enumerable: true, get() { reads++; return {}; } });
    const extra = Object.assign([{}], { extra: true });
    const hidden = Object.defineProperty([{}], 'extra', { value: true });
    const hiddenIndex = Object.defineProperty([{}], '0', { enumerable: false, value: {} });
    const symbol = Object.assign([{}], { [Symbol('extra')]: true });
    const prototype = Object.setPrototypeOf([{}], {});
    class Ledger extends Array<unknown> {}
    const subclass = new Ledger(); subclass.push({});
    for (const value of [null, {}, new Array(1), accessor, extra, hidden, hiddenIndex, symbol, prototype, subclass]) expect(validateEventLedger(value).length).toBeGreaterThan(0);
    expect(reads).toBe(0);
  });
  it('retains nested accessor, prototype, cycle and nonfinite JSON rejection with an event-relative path', () => {
    let reads = 0;
    const getter = Object.defineProperty({}, 'bad', { enumerable: true, get() { reads++; return 0; } });
    const cycle: any = {}; cycle.self = cycle;
    for (const value of [getter, cycle, new Date(), { value: Infinity }, { value: undefined }]) {
      expect(validateEventLedger([{ id: 'first' }, value])[0].path).toMatch(/^\/1/);
    }
    expect(reads).toBe(0);
  });
});
