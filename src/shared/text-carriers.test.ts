import { describe, expect, it } from 'vitest';
import { createNativeTemplate, validateNativeDocument } from './native';
import { projectViewedCarrierOutput, validViewedCarriersOutput, type TextCarrierViewReceipt, type ViewedCarriersOutput } from './text-carriers';
import type { AuxiliaryOutput, Json, Preset } from './types';

const receipt = (role: string): TextCarrierViewReceipt => ({
  id: `view:${role}`, intentId: `intent:${role}`, materialTurnId: 'original-turn', worldRevision: 3,
  carrierId: 'notice', carrierVersion: 1, readerRoleId: role, readerName: `Original ${role}`, location: 'Hall', time: null,
  origin: { kind: 'behavior', behaviorId: `behavior:${role}` }, carrier: { medium: 'paper', title: 'Original title', text: `BODY_FOR_${role}`, sourceEventId: 'author-version-1' }, observationEventId: `observation:${role}`,
});
function output(): AuxiliaryOutput {
  const value: ViewedCarriersOutput = { schema: 'rp.viewed-carriers/0.1', materialTurnId: 'original-turn', worldRevision: 3, views: [receipt('a'), receipt('b')] };
  return { key: 'preset:media', title: 'Media', type: 'object', audience: 'public', placement: 'after-prose', display: { placement: 'after-prose', renderer: 'viewed-carriers' },
    provenance: { kind: 'committed-carrier-views', materialTurnId: 'original-turn', worldRevision: 3, viewIds: ['view:a', 'view:b'] }, value: value as unknown as Json };
}
describe('immutable viewed carrier disclosure', () => {
  it('filters both body and provenance to the reader while retaining immutable author snapshots', () => {
    const original = output(), bytes = JSON.stringify(original), author = projectViewedCarrierOutput(original, 'author');
    expect(author).toEqual(original);
    const own = projectViewedCarrierOutput(original, 'a')!;
    expect((own.value as unknown as ViewedCarriersOutput).views).toEqual([receipt('a')]);
    expect(own.provenance).toMatchObject({ viewIds: ['view:a'], materialTurnId: 'original-turn', worldRevision: 3 });
    expect(JSON.stringify(own)).not.toContain('BODY_FOR_b');
    expect(projectViewedCarrierOutput(original, 'player')).toBeUndefined(); expect(JSON.stringify(original)).toBe(bytes);
  });
  it('fails closed for duplicate identities, mixed batches, altered stamps and model-shaped carrier values', () => {
    const original = output(), value = original.value as unknown as ViewedCarriersOutput;
    expect(validViewedCarriersOutput(value)).toBe(true);
    expect(validViewedCarriersOutput({ ...value, views: [value.views[0], value.views[0]] })).toBe(false);
    expect(validViewedCarriersOutput({ ...value, materialTurnId: null })).toBe(false);
    expect(validViewedCarriersOutput({ ...value, views: [{ ...value.views[0], worldRevision: 4 }] })).toBe(false);
    expect(validViewedCarriersOutput({ ...value, views: [{ ...value.views[0], carrier: { ...value.views[0].carrier, html: '<script>arbitrary()</script>' } }] })).toBe(false);
    expect(projectViewedCarrierOutput({ ...original, provenance: { ...original.provenance!, kind: 'committed-carrier-views', materialTurnId: 'original-turn', worldRevision: 3, viewIds: ['view:b', 'view:a'] } }, 'a')).toBeUndefined();
    expect(projectViewedCarrierOutput({ ...original, value: '<htmlcontent>invented</htmlcontent>' }, 'author')).toBeUndefined();
    const getter = Object.defineProperty({}, 'schema', { enumerable: true, get: () => { throw new Error('must not run'); } });
    expect(validViewedCarriersOutput(getter)).toBe(false);
  });
  it('requires the trusted object selector, public scope and native renderer together', () => {
    const preset = createNativeTemplate('preset') as Preset;
    preset.outputs = [{ id: 'media', title: 'Media', instruction: 'Original source retained.', type: 'object', enabled: false, required: false, priority: 1, audience: 'public',
      valueFrom: { kind: 'viewed-carriers' }, display: { placement: 'after-prose', renderer: 'viewed-carriers' } }];
    expect(validateNativeDocument('preset', preset)).toEqual([]);
    for (const patch of [{ valueFrom: undefined }, { type: 'text' }, { audience: 'author' }, { display: { placement: 'after-prose', renderer: 'sandbox-html' } }]) {
      const bad = structuredClone(preset); bad.outputs![0] = { ...bad.outputs![0], ...patch } as any;
      if (patch.valueFrom === undefined && Object.hasOwn(patch, 'valueFrom')) delete bad.outputs![0].valueFrom;
      expect(validateNativeDocument('preset', bad).length).toBeGreaterThan(0);
    }
  });
});
