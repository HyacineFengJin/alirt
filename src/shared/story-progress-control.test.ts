import { describe, expect, it } from 'vitest';
import { validateStoryProgressControlCommand } from './story-progress-control';

const command = () => ({ requestId: 'author-1', expectedRevision: 1, reason: '核对后修正', patch: { operations: [{ op: 'create', kind: 'main', title: '调查', summary: '核对告示', status: 'active', evidence: { factIndexes: [], eventIds: ['public-fact'] } }] } });

describe('story progress author command', () => {
  it('requires exact metadata and event evidence without accepting model fact indexes or host identities', () => {
    expect(validateStoryProgressControlCommand(command())).toEqual([]);
    expect(validateStoryProgressControlCommand({ ...command(), expectedRevision: 0, patch: { operations: [] } })).toEqual([]);
    const c = command();
    for (const input of [{ ...c, reason: '  ' }, { ...c, expectedRevision: 1.5 }, { ...c, requestId: ' spaced ' }, { ...c, sequence: 9 }, { ...c, patch: { operations: [{ ...c.patch.operations[0], evidence: { factIndexes: [0], eventIds: [] } }] } }, { ...c, patch: { operations: [{ ...c.patch.operations[0], id: 'MQ.IV' }] } }]) expect(validateStoryProgressControlCommand(input).length).toBeGreaterThan(0);
  });
  it('rejects hostile accessors without reading them', () => {
    let reads = 0;
    const input = Object.defineProperty({}, 'requestId', { enumerable: true, get() { reads++; return 'x'; } });
    expect(validateStoryProgressControlCommand(input).length).toBeGreaterThan(0); expect(reads).toBe(0);
  });
});
