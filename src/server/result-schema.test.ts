import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileResultValidator, validatedResultExecution } from './result-schema.mjs';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset } from '../shared/types';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { CreatorEngine, CreatorStore } from './creator';
import { clone, SessionStore } from './store';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
// Unit boundary uses an injected constructor. The separate native tests verify
// the real DSH tool error when a pinned runtime is explicitly available.
class ToolArgsError extends Error {
  code = 'INVALID_ARGS';
  constructor(violations: string[]) { super(violations.join('\n')); }
}
async function schemas() {
  const root = await mkdtemp(join(tmpdir(), 'rp-wire-schemas-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const calls: AgentRequest[] = [], results = new Map<string, unknown>();
  const provider: ModelProvider = { configured: () => true, async run(request) {
    calls.push(request);
    const result = request.kind === 'role' ? { public: { summary: 'A neutral witness.', speech: [], actions: [] }, proposals: [] }
      : request.kind === 'world' ? { summary: 'No new consequence.', changes: [], acceptedBehaviorIds: [], facts: [] }
      : request.kind === 'creator' ? { message: 'Draft reviewed.' } : { title: 'Scene', text: 'The studio is quiet.', person: 'third', pov: 'limited' };
    results.set(request.kind, result); return result;
  } };
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.roles.push({ ...clone(card.roles[0]), id: 'npc', name: 'Neutral witness' });
  const store = new SessionStore(join(root, 'sessions')), id = store.create(card, preset).id, engine = new TurnEngine(store, provider); cleanups.push(() => engine.close());
  engine.submit(id, { requestId: 'capture-wire', expectedRevision: 0, mode: 'action', action: 'Observe the studio.' }); await engine.idle(id);
  expect(store.get(id).turns.at(-1)?.status).toBe('completed');
  const drafts = new CreatorStore(join(root, 'creator')), draft = drafts.create({ kind: 'preset' }, createNativeTemplate('preset'));
  const creator = new CreatorEngine(drafts, provider); cleanups.push(() => creator.close());
  creator.submit(draft.id, { requestId: 'capture-creator', expectedRevision: 0, instruction: 'Review the blank draft.' }); await creator.idle(draft.id);
  expect(calls.map(request => request.kind)).toEqual(['role', 'world', 'prose', 'creator']);
  return { calls, results, store, id };
}

describe('strict native completion schema boundary', () => {
  it('compiles unmodified actual role/world/prose/creator schemas and accepts their structured results', async () => {
    const { calls, results } = await schemas();
    for (const call of calls) {
      const before = clone(call.resultSchema), validate = compileResultValidator(call.resultSchema);
      expect(validate(results.get(call.kind))).toEqual([]); expect(call.resultSchema).toEqual(before);
      expect(validate({ ...(results.get(call.kind) as object), unexpected: null }).length).toBeGreaterThan(0);
    }
  });

  it('returns the supplied tool error before any completion effect, then accepts corrected arguments in the same delivery', async () => {
    const { calls, store, id } = await schemas(), schema = calls.find(request => request.kind === 'world')!.resultSchema;
    const validate = compileResultValidator(schema), valid = { summary: 'Terminal facts only.', changes: [], acceptedBehaviorIds: [],
      facts: Array.from({ length: 7 }, () => ({ text: 'The rehearsal remains quiet.', sources: [{ kind: 'world-development' }] })) };
    const malformed = clone(valid) as any; malformed.facts[6].sources_placeholder = null;
    const original = clone(malformed), host = clone(store.get(id)), concludeTurn = vi.fn(), agent = {}, exec = { agent, concludeTurn };
    let finished = false, accepted: unknown;
    const complete = vi.fn(args => { accepted = args; finished = true; concludeTurn(); return { resultAccepted: true }; });
    const execute = validatedResultExecution(validate, ToolArgsError, { isActive: (context: any) => !finished && context.agent === agent, complete });
    let error: any; try { execute(malformed, exec); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ToolArgsError); expect(error.code).toBe('INVALID_ARGS'); expect(error.message).toContain('/facts/6/sources_placeholder');
    expect(complete).not.toHaveBeenCalled(); expect(concludeTurn).not.toHaveBeenCalled(); expect(finished).toBe(false); expect(accepted).toBeUndefined();
    expect(malformed).toEqual(original); expect(store.get(id)).toEqual(host);
    expect(execute(valid, exec)).toEqual({ resultAccepted: true }); expect(accepted).toBe(valid); expect(concludeTurn).toHaveBeenCalledTimes(1);
    expect(() => execute(valid, exec)).toThrow(/no longer active/); expect(complete).toHaveBeenCalledTimes(1);
  });

  it('enforces anyOf/minItems/const rather than treating them as annotations', async () => {
    const { calls } = await schemas(), validate = compileResultValidator(calls.find(request => request.kind === 'world')!.resultSchema);
    const result = (sources: unknown[]) => ({ summary: 'Audit', changes: [], acceptedBehaviorIds: [], facts: [{ text: 'Quiet.', sources }] });
    expect(validate(result([])).some((message: string) => message.includes('fewer than 1'))).toBe(true);
    expect(validate(result([{ kind: 'not-a-source' }])).some((message: string) => message.includes('constant') || message.includes('anyOf'))).toBe(true);
    expect(validate(result([{ kind: 'state', roleId: 'npc' }])).length).toBeGreaterThan(0);
    expect(validate(result([{ kind: 'state', roleId: 'npc', key: 'score' }]))).toEqual([]);
  });

  it('rejects unsupported/invalid schemas before a completion can be registered and never mutates input data', () => {
    for (const schema of [{ type: 'object', unsupportedKeyword: true }, { type: 'object', required: 'invalid' },
      { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }, { $ref: 'https://example.invalid/schema' },
      { $async: true, type: 'object' }]) expect(() => compileResultValidator(schema)).toThrow(/Invalid or unsupported/);
    const validate = compileResultValidator({ type: 'object', properties: { amount: { type: 'number' }, optional: { type: 'string', default: 'must not insert' } }, required: ['amount'], additionalProperties: false });
    const input = { amount: '3', extra: null }, before = clone(input);
    expect(validate(input).length).toBeGreaterThan(0); expect(input).toEqual(before);
    const valid = { amount: 3 }; expect(validate(valid)).toEqual([]); expect(valid).not.toHaveProperty('optional');
    let reads = 0; const accessor = Object.defineProperty({}, 'amount', { enumerable: true, get() { reads++; return 3; } });
    expect(validate(accessor).length).toBeGreaterThan(0); expect(reads).toBe(0);
    expect(compileResultValidator({ type: ['string', 'null'] })(null)).toEqual([]);
    expect(compileResultValidator({ type: ['string', 'null'] })(3).length).toBeGreaterThan(0);
  });
});
