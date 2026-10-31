import { describe, expect, it } from 'vitest';
import type { ProseReviewContext, ProseReviewFinding } from '../shared/prose-review';
import { AgentModuleRegistry } from './agent-modules';
import { compileResultValidator } from './result-schema.mjs';
import { parseProseReviewContext, parseProseReviewResult, proseReviewModule, proseReviewRequest, PROSE_REVIEW_MODULE_ID } from './prose-review';

function context(): ProseReviewContext {
  return { target: { kind: 'main', entryId: 'draft-1' }, targetHash: 'a'.repeat(64), materialHash: 'b'.repeat(64), segments: [
    { id: 'title', kind: 'title', text: 'An ordinary afternoon' },
    { id: 'narration-1', kind: 'narration', text: 'She read the phone, then knocked on the door.' },
    { id: 'speech-1', kind: 'speech', text: 'The train leaves at midnight.' },
    { id: 'summary', kind: 'summary', text: 'She knew the train was late.' },
  ], material: { references: [
    { ref: 'scene:location', kind: 'scene', text: 'At the doorway; exact date is unknown.' },
    { ref: 'behavior:message', kind: 'behavior', text: 'An approved remote message was sent: The train leaves at midnight.' },
    { ref: 'world:rain', kind: 'world-fact', text: 'It is raining outside.' },
  ], limitations: ['Delivery does not establish that the recipient read the message.'] } };
}
const finding = (): ProseReviewFinding => ({ segmentId: 'narration-1', quote: 'read the phone', category: 'action', severity: 'concern',
  explanation: 'The approved message records sending, not recipient reading.', sourceRefs: ['behavior:message'] });
const result = () => ({ summary: 'One possible unsupported action.', findings: [finding()] });

describe('read-only prose review contract', () => {
  it('is an additional module disabled by default with no role dependency or tools', () => {
    const registry = new AgentModuleRegistry([proseReviewModule]);
    for (const profile of ['full', 'compact', 'minimal']) expect(registry.resolve({ profile }).enabled).not.toContain(PROSE_REVIEW_MODULE_ID);
    const enabled = registry.resolve({ profile: 'minimal', modules: { [PROSE_REVIEW_MODULE_ID]: true } });
    expect(enabled.enabled).toEqual([PROSE_REVIEW_MODULE_ID]);
    expect(proseReviewModule.roleTools).toBeUndefined(); expect(proseReviewModule.meta.requires).toBeUndefined();
  });

  it('builds only detached current draft/material input, leaving saved prose and evidence unchanged', () => {
    const current = context(), before = structuredClone(current), request = proseReviewRequest(current);
    expect(request.input).toEqual({ draft: { segments: before.segments }, material: before.material });
    expect(Object.keys(request.input as object)).toEqual(['draft', 'material']);
    expect(request.input).not.toHaveProperty('target'); expect(request.input).not.toHaveProperty('targetHash');
    expect(request.system).toContain('advisory semantic opinions'); expect(request.system).toContain('does not establish');
    const raw = result(), rawBefore = structuredClone(raw), parsed = parseProseReviewResult(raw, current);
    expect(parsed).toEqual(rawBefore); expect(raw).toEqual(rawBefore); expect(current).toEqual(before);
    raw.findings[0].quote = 'changed'; current.segments[1].text = 'changed'; current.material.references[0].text = 'changed';
    expect(parsed).toEqual(rawBefore); expect(request.input).toEqual({ draft: { segments: before.segments }, material: before.material });
  });

  it('constrains native findings to current non-speech segment IDs and whitelisted reference IDs', () => {
    const request = proseReviewRequest(context()), validate = compileResultValidator(request.resultSchema);
    expect(validate(result())).toEqual([]);
    for (const patch of [{ segmentId: 'old-draft' }, { segmentId: 'speech-1' }, { sourceRefs: ['private:knowledge'] },
      { sourceRefs: ['world:rain', 'world:rain'] }, { category: 'approved' }, { quote: '   ' }, { explanation: '' }, { approved: true }]) {
      const raw = result(); Object.assign(raw.findings[0], patch);
      expect(validate(raw).length).toBeGreaterThan(0); expect(() => parseProseReviewResult(raw, context())).toThrow();
    }
    const acceptedNativeButWrongQuote = result(); acceptedNativeButWrongQuote.findings[0].quote = 'She knew the train was late.';
    expect(validate(acceptedNativeButWrongQuote)).toEqual([]); // Substring permission is an additional host check.
    expect(() => parseProseReviewResult(acceptedNativeButWrongQuote, context())).toThrow('exactly');
  });

  it('checks quotation within its own eligible segment without normalization or cross-segment matching', () => {
    const current = context();
    for (const patch of [{ quote: 'read  the phone' }, { quote: 'READ THE PHONE' }, { segmentId: 'summary' },
      { segmentId: 'speech-1', quote: current.segments[2].text }, { quote: 'door.The train' }]) {
      const raw = result(); Object.assign(raw.findings[0], patch);
      expect(() => parseProseReviewResult(raw, current)).toThrow();
    }
    const raw = result(); raw.findings[0] = { ...finding(), segmentId: 'summary', quote: 'knew', category: 'interiority', sourceRefs: [] };
    expect(parseProseReviewResult(raw, current)).toEqual(raw);
  });

  it('accepts empty findings as an opinion without certification, mutation, or replacement draft fields', () => {
    const current = context(), before = structuredClone(current), raw = { summary: 'No concerns identified in this limited review.', findings: [] };
    expect(parseProseReviewResult(raw, current)).toEqual(raw); expect(current).toEqual(before);
    for (const extra of [{ approved: true }, { safe: true }, { text: 'A replacement passage' }, { worldChanges: [] }]) {
      expect(() => parseProseReviewResult({ ...raw, ...extra }, current)).toThrow();
      expect(compileResultValidator(proseReviewRequest(current).resultSchema)({ ...raw, ...extra }).length).toBeGreaterThan(0);
    }
  });

  it('supports no references and no eligible targets without generating invalid enum schemas', () => {
    const current = context(); current.material.references = [];
    const raw = result(); raw.findings[0].sourceRefs = [];
    const request = proseReviewRequest(current), validate = compileResultValidator(request.resultSchema);
    expect(validate(raw)).toEqual([]); expect(parseProseReviewResult(raw, current)).toEqual(raw);
    expect(JSON.stringify(request.resultSchema)).not.toContain('"enum":[]');
    current.segments = current.segments.filter(segment => segment.kind === 'speech');
    const speechOnly = compileResultValidator(proseReviewRequest(current).resultSchema);
    expect(speechOnly({ summary: 'No eligible narration.', findings: [] })).toEqual([]);
    expect(speechOnly(raw).length).toBeGreaterThan(0);
    expect(() => parseProseReviewResult(raw, current)).toThrow();
  });

  it('rejects malformed, duplicate, hidden, accessor and unsafe-prototype context before reading it', () => {
    const mutations: ((value: ProseReviewContext) => void)[] = [
      value => { value.segments.push({ ...value.segments[0] }); },
      value => { value.material.references.push({ ...value.material.references[0] }); },
      value => { Object.assign(value.material.references[0], { kind: 'role-knowledge' }); },
      value => { Object.assign(value, { authorCommand: 'Do something private' }); },
      value => { Object.assign(value.target, { runId: 'unrelated' }); },
      value => { value.materialHash = 'not-a-hash'; },
      value => { Object.defineProperty(value, 'hidden', { value: true }); },
      value => { Object.setPrototypeOf(value.material, { inheritedPrivate: 'secret' }); },
    ];
    for (const mutate of mutations) { const current = context(); mutate(current); expect(() => parseProseReviewContext(current)).toThrow(); }
    let calls = 0; const current = context();
    Object.defineProperty(current.segments[0], 'text', { enumerable: true, get() { calls++; throw new Error('getter invoked'); } });
    expect(() => proseReviewRequest(current)).toThrow('ordinary JSON'); expect(calls).toBe(0);
    expect(() => parseProseReviewContext(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects non-JSON or extra model fields without executing accessors; supports parallel target snapshots', () => {
    let calls = 0; const raw = result();
    Object.defineProperty(raw.findings[0], 'quote', { enumerable: true, get() { calls++; return 'read the phone'; } });
    expect(() => parseProseReviewResult(raw, context())).toThrow('ordinary JSON'); expect(calls).toBe(0);
    expect(() => parseProseReviewResult({ ...result(), findings: [{ ...finding(), sourceRefs: ['old-prose'] }] }, context())).toThrow();
    const current = context(); current.target = { kind: 'parallel', runId: 'run', renderAttemptId: 'render' };
    const snapshot = parseProseReviewContext(current); current.segments[0].text = 'mutated';
    expect(snapshot.target).toEqual({ kind: 'parallel', runId: 'run', renderAttemptId: 'render' });
    expect(snapshot.segments[0].text).toBe('An ordinary afternoon');
  });
});
