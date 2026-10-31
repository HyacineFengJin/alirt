import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CharacterCard, Json, Preset } from '../shared/types';
import type { StateChange, StateRule } from '../shared/state-rules';
import { createNativeTemplate, materializeNativeDocument, validateNativeDocument } from '../shared/native';
import { applyStateTransaction, StateTransactionError } from './state-runtime';
import { SessionStore } from './store';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { portableNativeProjection } from '../importer/compiler';

const cap: StateRule = { id: 'score-cap', type: 'delta-limit', field: 'score', maxIncrease: 30, authority: 'model' };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
function cardFixture(): CharacterCard {
  const card = createNativeTemplate('card') as CharacterCard;
  card.id = 'delta-test'; card.stateRules = [structuredClone(cap)];
  card.fields = [
    { key: 'score', label: 'Score', type: 'number', min: -100, max: 1000, audience: 'author', editable: true },
    { key: 'gate', label: 'Gate', type: 'boolean', audience: 'public', editable: true },
  ];
  card.world.variables = { score: 100, gate: false };
  card.roles[0].state = { score: 100, gate: false }; card.roles[0].peers = ['npc'];
  card.roles.push({ id: 'npc', name: 'NPC', persona: '', goals: [], peers: ['player'], phase: 'active', presence: 'present', state: { score: 100, gate: false }, knowledge: [] });
  card.roles.push({ id: 'spectator', name: 'Spectator', persona: '', goals: [], peers: [], phase: 'dormant', presence: 'absent', state: { gate: false }, knowledge: [] });
  return card;
}
const change = (value: Json, roleId = 'npc'): StateChange[] => [{ roleId, key: 'score', value }];
function rejected(action: () => unknown, expected = 'STATE_RULE_VIOLATION') {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error instanceof StateTransactionError).toBe(true);
  expect((error as StateTransactionError).code).toBe(expected);
}

describe('native numeric delta-limit transactions', () => {
  it('validates explicit authority, finite nonnegative bounds and actual unique numeric-field holders', () => {
    for (const rule of [cap, { ...cap, authority: 'all' }, { ...cap, maxIncrease: 0, maxDecrease: 0 }, { ...cap, owners: ['world', 'npc'] }]) {
      const card = cardFixture(); card.stateRules = [rule as StateRule];
      expect(validateNativeDocument('card', card).map(issue => issue.path)).toEqual([]);
    }
    const invalid = [
      { ...cap, authority: undefined }, { ...cap, authority: 'author' }, { ...cap, field: 'missing' }, { ...cap, field: 'gate' },
      { ...cap, maxIncrease: -1 }, { ...cap, maxIncrease: NaN }, { ...cap, maxDecrease: Infinity },
      { id: 'missing-cap', type: 'delta-limit', field: 'score', authority: 'model' },
      { ...cap, owners: [] }, { ...cap, owners: ['npc', 'npc'] }, { ...cap, owners: ['spectator'] },
      { ...cap, owners: ['missing'] }, { ...cap, owners: ['*'] }, { ...cap, owners: ['__proto__'] },
    ];
    for (const rule of invalid) {
      const card = cardFixture(); card.stateRules = [rule as StateRule];
      expect(validateNativeDocument('card', card).some(issue => issue.path.startsWith('/stateRules'))).toBe(true);
      rejected(() => applyStateTransaction(card, [], { authority: 'model', rules: card.stateRules }), 'STATE_RULE_UNSUPPORTED');
    }
  });

  it('allows the exact increase boundary and unlimited decreases while preserving declared absolute bounds', () => {
    const card = cardFixture();
    expect(applyStateTransaction(card, change(130), { authority: 'model', rules: [cap] }).nextState.roles[1].state.score).toBe(130);
    expect(applyStateTransaction(card, change(-100), { authority: 'model', rules: [cap] }).nextState.roles[1].state.score).toBe(-100);
    rejected(() => applyStateTransaction(card, change(130.00001), { authority: 'model', rules: [cap] }));
    rejected(() => applyStateTransaction(card, change(-101), { authority: 'model', rules: [cap] }), 'STATE_RANGE');
    const decrease: StateRule = { id: 'decrease', type: 'delta-limit', field: 'score', maxDecrease: 4, authority: 'model' };
    expect(applyStateTransaction(card, change(96), { authority: 'model', rules: [decrease] }).nextState.roles[1].state.score).toBe(96);
    rejected(() => applyStateTransaction(card, change(95), { authority: 'model', rules: [decrease] }));
    expect(applyStateTransaction(card, change(500), { authority: 'model', rules: [decrease] }).nextState.roles[1].state.score).toBe(500);
  });

  it('defaults to every actual owner including world and scopes explicit owners independently', () => {
    const card = cardFixture();
    for (const roleId of ['world', 'player', 'npc']) rejected(() => applyStateTransaction(card, change(131, roleId), { authority: 'model', rules: [cap] }));
    const scoped: StateRule = { ...cap, owners: ['npc'] };
    expect(applyStateTransaction(card, change(900, 'world'), { authority: 'model', rules: [scoped] }).nextState.world.variables.score).toBe(900);
    const changes = ['world', 'player', 'npc'].flatMap(roleId => change(130, roleId));
    expect(applyStateTransaction(card, changes, { authority: 'model', rules: [cap] }).audit.length).toBe(3);
  });

  it('does not coerce unknown baselines or block unrelated writes, genesis, or explicit author initialization', () => {
    const card = cardFixture(); card.roles[1].state.score = null;
    expect(applyStateTransaction(card, [], { authority: 'model', rules: [cap] }).audit.length).toBe(0);
    expect(applyStateTransaction(card, [{ roleId: 'npc', key: 'gate', value: true }], { authority: 'model', rules: [cap] }).nextState.roles[1].state.score).toBe(null);
    for (const value of [-100, 0, 30, 100]) rejected(() => applyStateTransaction(card, change(value), { authority: 'model', rules: [cap] }));
    const author = applyStateTransaction(card, change(900), { authority: 'author', rules: [cap] });
    expect(author.nextState.roles[1].state.score).toBe(900);
    expect(applyStateTransaction(author.nextState, change(930), { authority: 'model', rules: [cap] }).nextState.roles[1].state.score).toBe(930);
    expect(applyStateTransaction(cardFixture(), change(900), { authority: 'author', rules: [cap] }).nextState.roles[1].state.score).toBe(900);
    const all: StateRule = { ...cap, authority: 'all' };
    rejected(() => applyStateTransaction(cardFixture(), change(131), { authority: 'author', rules: [all] }));
    rejected(() => applyStateTransaction(card, change(100), { authority: 'author', rules: [all] }));
    expect(applyStateTransaction(cardFixture(), change(130), { authority: 'author', rules: [all] }).nextState.roles[1].state.score).toBe(130);
  });

  it('checks final derived effects atomically and cannot split an oversized change across repeated proposals or rule effects', () => {
    const card = cardFixture(), before = hash(card);
    const effect: StateRule = { id: 'derived-score', type: 'transition', trigger: { roleId: 'world', key: 'gate' }, effects: [{ type: 'set', roleId: 'npc', key: 'score', value: 131 }] };
    const input: StateChange[] = [{ roleId: 'world', key: 'gate', value: true }, { roleId: 'player', key: 'score', value: 120 }];
    rejected(() => applyStateTransaction(card, input, { authority: 'model', rules: [effect, cap] }));
    expect(hash(card)).toBe(before);
    const duplicatedEffect: StateRule = { ...effect, id: 'duplicate-effect' };
    rejected(() => applyStateTransaction(card, input, { authority: 'model', rules: [effect, duplicatedEffect, cap] }));
    rejected(() => applyStateTransaction(card, [...change(120), ...change(140)], { authority: 'model', rules: [cap] }), 'STATE_WRITE_CONFLICT');
    rejected(() => applyStateTransaction(card, [...change(131), ...change(131)], { authority: 'model', rules: [cap] }));
    expect(applyStateTransaction(card, [...change(130), ...change(130)], { authority: 'model', rules: [cap] }).audit.length).toBe(1);
    const allowed: StateRule = { ...effect, effects: [{ type: 'increment', roleId: 'npc', key: 'score', amount: 30 }] };
    const accepted = applyStateTransaction(card, input, { authority: 'model', rules: [allowed, cap] });
    expect(accepted.nextState.roles[1].state.score).toBe(130);
    expect(accepted.audit.find(entry => entry.roleId === 'npc')?.origin).toBe('rule');
    card.roles[1].state.score = null;
    rejected(() => applyStateTransaction(card, input, { authority: 'model', rules: [effect, cap] }));
  });

  it('keeps legacy snapshots without the new rule unbounded by it', () => {
    const card = cardFixture(); delete card.stateRules;
    expect(applyStateTransaction(card, change(500), { authority: 'model', rules: card.stateRules }).nextState.roles[1].state.score).toBe(500);
  });
});

class LocalProvider implements ModelProvider {
  calls: AgentRequest[] = [];
  changes: StateChange[] = [];
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request);
    if (request.kind === 'role') return { public: { summary: '', speech: [], actions: [] }, proposals: [{ roleId: 'npc', key: 'score', value: 1000 }] };
    if (request.kind === 'world') return { summary: 'Adjudicated locally.', changes: this.changes, facts: [], acceptedBehaviorIds: [] };
    return { title: 'Scene', text: 'The room remains quiet.', person: 'third', pov: 'limited' };
  }
}

describe('delta-limit on the real turn engine commit path (local stub only)', () => {
  it('commits once after role/world adjudication, rejects oversized batches and resets the allowance only for the next successful turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-delta-engine-')), store = new SessionStore(root), provider = new LocalProvider(), engine = new TurnEngine(store, provider);
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }); }); cleanups.push(() => engine.close());
    const card = cardFixture(), preset = createNativeTemplate('preset') as Preset;
    const id = store.create(card, preset).id;
    let request = 0;
    async function turn(value: number) {
      provider.changes = change(value);
      const revision = store.get(id).revision;
      engine.submit(id, { requestId: `delta-turn-${++request}`, expectedRevision: revision, action: 'Continue.', mode: 'action' });
      await engine.idle(id);
    }
    await turn(131);
    expect(store.get(id).revision).toBe(0); expect(store.get(id).roles[1].state.score).toBe(100);
    expect(store.get(id).turns.at(-1)?.status).toBe('failed');
    expect(store.get(id).events.filter(event => event.kind === 'state-commit').length).toBe(0);
    expect(provider.calls.filter(call => call.kind === 'prose').length).toBe(0);
    await turn(130);
    expect(store.get(id).revision).toBe(1); expect(store.get(id).roles[1].state.score).toBe(130);
    expect(store.get(id).events.filter(event => event.kind === 'state-transaction').length).toBe(1);
    await turn(161);
    expect(store.get(id).revision).toBe(1); expect(store.get(id).roles[1].state.score).toBe(130);
    await turn(160);
    expect(store.get(id).revision).toBe(2); expect(store.get(id).roles[1].state.score).toBe(160);
    expect(provider.calls.filter(call => call.kind === 'world').length).toBe(4);
    expect(provider.calls.filter(call => call.kind === 'role').length).toBe(4);
    expect(store.get(id).events.filter(event => event.kind === 'state-transaction').length).toBe(2);
    expect((provider.calls.find(call => call.kind === 'world')?.input as any).stateRules[0].type).toBe('delta-limit');
  });
});
