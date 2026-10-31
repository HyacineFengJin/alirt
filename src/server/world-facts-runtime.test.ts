import { describe, expect, it } from 'vitest';
import { compileWorldFacts, publicFactEvent, publicWorldFact, WorldFactsContractError, type WorldFactsContext } from './world-facts-runtime';
import { createHash } from 'node:crypto';
import type { ResolvedWorldFact } from '../shared/world-facts';
import type { WorldEvent } from '../shared/types';
import type { Json, StateField } from '../shared/types';

function context(): WorldFactsContext {
  const field = (key: string, audience: StateField['audience'], writableBy?: StateField['writableBy']): StateField => ({
    key, label: key, type: key === 'inventory' ? 'list' : 'number', audience, editable: true, ...(writableBy ? { writableBy } : {}),
  });
  return {
    acceptedBehaviors: [{ id: 'current:approved', roleId: 'a', kind: 'action', text: '伸手接住钥匙。' }],
    finalState: {
      world: { variables: { weather: 2, secret: 42, playerSwitch: 1, derived: 8 } },
      roles: [{ id: 'a', state: { inventory: [{ name: 'key', tags: ['brass'] }], hidden: 6, private: 4, undeclared: 9 } }],
      fields: [field('weather', 'public'), field('secret', 'author'), field('inventory', 'public'), field('hidden', ['a']),
        field('playerSwitch', 'public', 'author'), field('derived', 'public', 'derived'), field('private', ['a', 'b'])],
    },
    hasOpeningSetup: true, hasPlayerAction: true,
  };
}
const fact = (sources: unknown[], text = '钥匙落在掌心。') => ({ text, sources });
const compile = (sources: unknown[], suppliedContext = context()) => compileWorldFacts({ facts: [fact(sources)] }, suppliedContext);

describe('public world fact compilation', () => {
  it('preserves sourced fact order and current approved references while excluding world audit and legacy text', () => {
    const input = {
      facts: [fact([{ kind: 'behavior', id: 'current:approved' }, { kind: 'state', roleId: 'a', key: 'inventory' }]),
        fact([{ kind: 'world-development' }], '风吹开了窗户。')],
      summary: 'AUTHOR SECRET: not public prose', events: ['Unapproved summary claim'], proposals: [{ private: true }],
    };
    const result = compileWorldFacts(input, context());
    expect(result).toEqual({ mode: 'sourced', diagnostics: [], facts: [
      { text: '钥匙落在掌心。', sources: [{ kind: 'behavior', id: 'current:approved' },
        { kind: 'state', roleId: 'a', key: 'inventory', value: [{ name: 'key', tags: ['brass'] }] }] },
      { text: '风吹开了窗户。', sources: [{ kind: 'world-development' }] },
    ] });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|Unapproved|private/);
  });

  it('reads the final host value, including author-written and derived public fields, without granting write authority', () => {
    const supplied = context();
    supplied.finalState.world.variables = { weather: 5, playerSwitch: 3, derived: 16 };
    expect(compile([{ kind: 'state', roleId: 'world', key: 'weather' },
      { kind: 'state', roleId: 'world', key: 'playerSwitch' },
      { kind: 'state', roleId: 'world', key: 'derived' }], supplied).facts[0].sources).toEqual([
      { kind: 'state', roleId: 'world', key: 'weather', value: 5 },
      { kind: 'state', roleId: 'world', key: 'playerSwitch', value: 3 },
      { kind: 'state', roleId: 'world', key: 'derived', value: 16 },
    ]);
  });

  it.each([
    { kind: 'behavior', id: 'current:denied' },
    { kind: 'behavior', id: 'previous:approved' },
    { kind: 'state', roleId: 'world', key: 'secret' },
    { kind: 'state', roleId: 'a', key: 'hidden' },
    { kind: 'state', roleId: 'a', key: 'private' },
    { kind: 'state', roleId: 'a', key: 'undeclared' },
    { kind: 'state', roleId: 'missing', key: 'weather' },
    { kind: 'state', roleId: 'a', key: 'weather' },
    { kind: 'state', roleId: 'world', key: 'constructor' },
  ])('rejects unavailable or nonpublic references %#', source => {
    expect(() => compile([source])).toThrow(WorldFactsContractError);
  });

  it('binds action and opening references to this turn without copying raw input', () => {
    const sources = [{ kind: 'player-action' }, { kind: 'opening-setup' }];
    expect(compile(sources).facts[0].sources).toEqual(sources);
    expect(() => compile(sources, { ...context(), hasPlayerAction: false })).toThrow(/current player action/);
    expect(() => compile(sources, { ...context(), hasOpeningSetup: false })).toThrow(/supplied this turn/);
  });

  it.each([
    { kind: 'state', roleId: 'world', key: 'weather', value: 999 },
    { kind: 'behavior', id: 'current:approved', text: 'fabricated substitute' },
    { kind: 'player-action', action: 'copied raw action' },
    { kind: 'opening-setup', text: 'invented opening' },
    { kind: 'world-development', private: 'leak' },
    { kind: 'legacy' }, { kind: 'summary' }, { kind: '' }, {}, null,
  ])('rejects malformed sources and model-supplied host values %#', source => {
    expect(() => compile([source])).toThrow(WorldFactsContractError);
  });

  it('rejects duplicate references even when source property order differs', () => {
    expect(() => compile([{ kind: 'state', roleId: 'world', key: 'weather' },
      { key: 'weather', roleId: 'world', kind: 'state' }])).toThrow(/Duplicate/);
    expect(() => compile([{ kind: 'behavior', id: 'current:approved' }, { kind: 'behavior', id: 'current:approved' }])).toThrow(/Duplicate/);
    expect(compileWorldFacts({ facts: [fact([{ kind: 'world-development' }]), fact([{ kind: 'world-development' }])] }, context()).facts).toHaveLength(2);
  });

  it.each([undefined, null, {}, 'bad', [null], [fact([])], [fact([{ kind: 'world-development' }], '  ')],
    [{ ...fact([{ kind: 'world-development' }]), secret: 'extra' }], new Array(1)])('never rescues invalid present facts through legacy events %#', facts => {
    expect(() => compileWorldFacts({ facts, events: ['Must not escape validation'], summary: 'Must not escape either' }, context())).toThrow(WorldFactsContractError);
  });

  it('treats an explicit empty fact list as an intentional result, with no legacy fallback', () => {
    expect(compileWorldFacts({ facts: [], events: ['Ignore'], summary: 'Ignore' }, context())).toEqual({ mode: 'sourced', facts: [], diagnostics: [] });
  });

  it('rejects forged sparse arrays and accessors without evaluating model-supplied getters', () => {
    const forged = Object.assign(new Array(1), { extra: fact([{ kind: 'world-development' }]) });
    expect(() => compileWorldFacts({ facts: forged }, context())).toThrow(WorldFactsContractError);
    let reads = 0;
    const source = { kind: 'state', roleId: 'world', get key() { reads++; return 'weather'; } };
    expect(() => compile([source])).toThrow(WorldFactsContractError);
    const facts = [fact([{ kind: 'world-development' }])];
    Object.defineProperty(facts, '0', { enumerable: true, get() { reads++; return fact([{ kind: 'world-development' }]); } });
    expect(() => compileWorldFacts({ facts }, context())).toThrow(WorldFactsContractError);
    expect(reads).toBe(0);
  });

  it('retains legacy event strings with empty sources and a compatibility warning, never summary', () => {
    expect(compileWorldFacts({ events: ['Old event.', '  Exact old text.\n'], summary: 'Private audit' }, context())).toEqual({
      mode: 'legacy', facts: [{ text: 'Old event.', sources: [] }, { text: '  Exact old text.\n', sources: [] }],
      diagnostics: [{ code: 'world-facts-legacy', severity: 'warning', path: 'facts',
        message: 'World result omitted facts; legacy events have no verified public sources.' }],
    });
    expect(compileWorldFacts({ summary: 'Only audit.' }, context())).toMatchObject({ mode: 'legacy', facts: [] });
    expect(() => compileWorldFacts({ events: [5] }, context())).toThrow(/array of strings/);
  });

  it('does not share nested state values or fact/source objects and leaves inputs intact on failure', () => {
    const supplied = context(), world = { facts: [fact([{ kind: 'state', roleId: 'a', key: 'inventory' }])] };
    const beforeState = structuredClone(supplied), beforeWorld = structuredClone(world);
    const result = compileWorldFacts(world, supplied);
    const source = result.facts[0].sources[0];
    if (source.kind !== 'state') throw new Error('Expected state source');
    (source.value as { tags: Json[] }[])[0].tags.push('changed');
    result.facts[0].text = 'Changed';
    result.facts[0].sources.push({ kind: 'world-development' });
    expect(supplied).toEqual(beforeState);
    expect(world).toEqual(beforeWorld);
    expect(() => compileWorldFacts({ facts: [...world.facts, fact([{ kind: 'state', roleId: 'a', key: 'hidden' }])] }, supplied)).toThrow();
    expect(supplied).toEqual(beforeState);
    expect(world).toEqual(beforeWorld);
  });
});

describe('turn-scoped trusted host input facts', () => {
  const evidence = () => ({ schema: 'rp.world-input/0.1' as const, id: 'host-input:current', serviceId: 'test.result', referenceId: 'completed:1',
    kind: 'local-result', title: 'Completed local result', payload: { score: 42, rounds: [{ score: 42 }] } });
  it('resolves the exact current trusted payload into facts without sharing it', () => {
    const trusted = evidence(), supplied = { ...context(), worldInputs: [trusted] };
    const source = { kind: 'host-input', id: trusted.id };
    const result = compile([source, { kind: 'player-action' }], supplied), resolved = result.facts[0].sources[0];
    expect(resolved).toEqual({ ...source, evidence: trusted });
    if (resolved.kind !== 'host-input') throw new Error('Expected host input');
    (resolved.evidence.payload as any).rounds[0].score = 999;
    expect(trusted).toEqual(evidence()); expect(source).toEqual({ kind: 'host-input', id: trusted.id });
  });
  it('rejects unavailable and historical IDs, duplicates, and model-supplied payloads', () => {
    const current = evidence(), supplied = { ...context(), worldInputs: [current] };
    for (const source of [
      { kind: 'host-input', id: 'unknown' }, { kind: 'host-input', id: 'host-input:previous' },
      { kind: 'host-input', id: current.id, evidence: current }, { kind: 'host-input', id: current.id, payload: { score: 999 } },
    ]) expect(() => compile([source], supplied)).toThrow(WorldFactsContractError);
    expect(() => compile([{ kind: 'host-input', id: current.id }])).toThrow(/current-turn host input/);
    expect(() => compile([{ kind: 'host-input', id: current.id }, { id: current.id, kind: 'host-input' }], supplied)).toThrow(/Duplicate/);
    expect(() => compile([], { ...supplied, worldInputs: [current, evidence()] })).toThrow(/Duplicate current host input/);
  });
  it('rejects malformed trusted evidence instead of admitting non-JSON or evaluating getters', () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, 'score', { enumerable: true, get() { reads++; return 42; } });
    for (const payload of [undefined, NaN, new Date(), accessor, new Array(1)]) {
      const supplied = { ...context(), worldInputs: [{ ...evidence(), payload }] as any };
      expect(() => compile([{ kind: 'host-input', id: evidence().id }], supplied)).toThrow(WorldFactsContractError);
    }
    expect(reads).toBe(0);
    // Existing legacy compatibility still has no implicit host references or payload copies.
    expect(compileWorldFacts({ events: ['Legacy event'] }, { ...context(), worldInputs: [evidence()] }).facts)
      .toEqual([{ text: 'Legacy event', sources: [] }]);
  });
});

describe('public host fact disclosure', () => {
  const resolved = (): ResolvedWorldFact => ({ text: 'The final stage result is a win.', sources: [
    { kind: 'state', roleId: 'world', key: 'score', value: { final: 42 } },
    { kind: 'host-input', id: 'settled-1', evidence: { schema: 'rp.world-input/0.1', id: 'settled-1', serviceId: 'local-stage', referenceId: 'battle-1',
      kind: 'stage-result', title: 'Completed stage', payload: { winner: 'self', rounds: [{ alias: 'PRIVATE_ROUND_ALIAS', score: 42 }], unapprovedDetail: 'PRIVATE_RAW_DETAIL' } } },
  ] });
  const event = (): WorldEvent => ({ id: 'event-1', at: '2026-10-31', turnId: 'turn-1', kind: 'world-event', actor: 'world', audience: 'public',
    text: resolved().text, data: { fact: resolved() as any, retained: { source: 'World adjudication' } } });
  it('publishes stable provenance and payload hash with only approved fact text, leaving full audit intact', () => {
    const raw = resolved(), before = structuredClone(raw), projected = publicWorldFact(raw), host = raw.sources[1];
    if (host.kind !== 'host-input') throw new Error('Expected host input');
    expect(projected).toEqual({ text: raw.text, sources: [raw.sources[0], { kind: 'host-input', id: 'settled-1', evidenceRef: {
      schema: 'rp.world-input-reference/0.1', serviceId: 'local-stage', referenceId: 'battle-1', kind: 'stage-result', title: 'Completed stage',
      payloadSha256: createHash('sha256').update(JSON.stringify(host.evidence.payload)).digest('hex'),
    } }] });
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE_ROUND_ALIAS|PRIVATE_RAW_DETAIL|"payload"|"rounds"|"winner"/);
    expect(raw).toEqual(before); expect(JSON.stringify(raw)).toContain('PRIVATE_ROUND_ALIAS');
    const state = projected.sources[0]; if (state.kind !== 'state') throw new Error('Expected state');
    (state.value as any).final = 99; expect(raw).toEqual(before);
    expect(publicWorldFact(projected)).toEqual(projected);
  });
  it('projects historical full events without mutation, preserves other data, and is idempotent', () => {
    const raw = event(), before = structuredClone(raw), output = publicFactEvent(raw);
    expect(output).toEqual({ ...raw, data: { retained: { source: 'World adjudication' }, fact: publicWorldFact(resolved()) } });
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE_ROUND_ALIAS|PRIVATE_RAW_DETAIL|"payload"/);
    expect(raw).toEqual(before); expect(output).not.toBe(raw); expect(output.data).not.toBe(raw.data);
    expect(publicFactEvent(output)).toEqual(output);
    const legacy = { ...event(), data: { retained: ['Legacy value'] } };
    expect(publicFactEvent(legacy)).toEqual(legacy); expect(publicFactEvent(legacy).data).not.toBe(legacy.data);
  });
  it('fails closed for malformed historical evidence or references and never evaluates accessors', () => {
    const badEvidence = [
      { ...(resolved().sources[1] as any).evidence, payload: undefined },
      { ...(resolved().sources[1] as any).evidence, id: 'different' },
      { ...(resolved().sources[1] as any).evidence, extra: 'PRIVATE_RAW_DETAIL' },
      { ...(resolved().sources[1] as any).evidence, payload: JSON.parse('{"__proto__":{"leak":true}}') },
    ];
    for (const evidence of badEvidence) {
      const fact = { text: 'Approved', sources: [{ kind: 'host-input', id: 'settled-1', evidence }] };
      expect(() => publicWorldFact(fact as any)).toThrow(WorldFactsContractError);
      expect(() => publicFactEvent({ ...event(), data: { fact: fact as any } })).toThrow(WorldFactsContractError);
    }
    const publicSource = publicWorldFact(resolved()).sources[1] as any;
    for (const source of [
      { ...publicSource, evidence: (resolved().sources[1] as any).evidence },
      { ...publicSource, evidenceRef: { ...publicSource.evidenceRef, payload: 'leak' } },
      { ...publicSource, evidenceRef: { ...publicSource.evidenceRef, payloadSha256: 'not-a-hash' } },
      { kind: 'host-input', id: 'settled-1' },
    ]) expect(() => publicWorldFact({ text: 'Approved', sources: [source] })).toThrow(WorldFactsContractError);
    let reads = 0;
    const accessor = Object.defineProperty({}, 'payload', { enumerable: true, get() { reads++; return 'leak'; } });
    expect(() => publicFactEvent({ ...event(), data: { fact: accessor } })).toThrow(WorldFactsContractError);
    expect(() => publicWorldFact({ ...resolved(), sources: [Object.assign(Object.create({ hidden: 'leak' }), publicSource)] })).toThrow(WorldFactsContractError);
    expect(reads).toBe(0); expect(({} as any).leak).toBeUndefined();
  });
});
