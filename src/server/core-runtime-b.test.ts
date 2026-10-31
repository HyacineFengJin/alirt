import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, OutputContract, Preset, PromptModule } from '../shared/types';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { acceptOutputs, compileOutputPlan, outputResultSchema } from './output-runtime';
import { compilePromptPlan, publicPromptView } from './prompt-compiler';
import { updateRuntimeConfiguration } from './runtime-config';
import { clone, project, SessionStore } from './store';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const module = (id: string, extra: Partial<PromptModule> = {}): PromptModule => ({ id, title: id, category: 'supplement', content: `RULE_${id}`, enabled: true, targets: ['prose'], phase: 'compose', priority: 0, ...extra });
const output = (id: string, extra: Partial<OutputContract> = {}): OutputContract => ({ id, title: id, type: 'text', instruction: 'Summarize the supplied public scene briefly.', enabled: true, required: true, priority: 0, audience: 'public', display: { placement: 'after-prose' }, ...extra });
class TestProvider implements ModelProvider {
  calls: AgentRequest[] = [];
  failKind?: 'role' | 'world' | 'prose';
  outputs?: unknown;
  roleHook?: (request: AgentRequest) => Promise<void>;
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request);
    if (this.failKind === request.kind) throw new Error('Recorded provider failure');
    if (request.kind === 'role') { await this.roleHook?.(request); return { summary: 'NPC reports.', expression: 'NPC speaks.', proposals: [] }; }
    if (request.kind === 'world') return { summary: 'Scene remains.', changes: [], events: ['The bell is audible.'] };
    return { title: 'Scene', text: 'Rain taps the dock.', person: 'third', pov: 'limited', ...(this.outputs === undefined ? {} : { outputs: this.outputs }) };
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rp-core-b-')); roots.push(root);
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.roles.push({ id: 'npc', name: 'NPC', persona: 'A harbor keeper.', goals: [], peers: ['player'], phase: 'active', presence: 'present', state: {}, knowledge: [] });
  const store = new SessionStore(root), provider = new TestProvider(), engine = new TurnEngine(store, provider);
  const id = store.create(card, preset).id;
  let index = 0;
  const run = async (mode: 'action' | 'author' = 'action', requestId = `test-${++index}`) => {
    const result = engine.submit(id, { requestId, expectedRevision: store.get(id).revision, action: 'Ask about the bell.', mode });
    await engine.idle(id); return result;
  };
  const configure = (modules: PromptModule[], outputs?: OutputContract[]) => {
    updateRuntimeConfiguration(store, id, { expectedRevision: store.get(id).revision, reason: 'Install test rules', cardModules: modules, ...(outputs ? { cardOutputs: outputs } : {}) });
  };
  return { root, store, provider, engine, id, run, configure };
}
const text = (request: AgentRequest) => request.system + JSON.stringify(request.promptLayout);

describe('durable activation at actual delivery boundaries', () => {
  it('previews and idempotent submissions do not spend rules or advance the clock; author prose uses the current tick', async () => {
    const f = await fixture(); f.configure([module('once', { lifetime: { once: true } })]);
    const before = JSON.stringify(f.store.get(f.id));
    const preview = await f.engine.preview(f.id, { target: 'prose' });
    expect(preview.modules.map(entry => entry.ref.moduleId)).toContain('once');
    expect(JSON.stringify(f.store.get(f.id))).toBe(before); expect(f.provider.calls).toHaveLength(0);
    const accepted = await f.run('action', 'stable-request');
    expect(f.store.get(f.id).turns[0].activationTurn).toBe(1);
    const count = f.provider.calls.length;
    expect(await f.run('action', 'stable-request')).toMatchObject({ turnId: accepted.turnId, duplicate: true });
    expect(f.provider.calls).toHaveLength(count);
    await f.run('author'); await f.run();
    expect(f.store.get(f.id).turns.map(turn => turn.activationTurn)).toEqual([1, 1, 2]);
    const prose = f.provider.calls.filter(call => call.kind === 'prose');
    expect(text(prose[0])).toContain('RULE_once'); expect(text(prose[1])).not.toContain('RULE_once'); expect(text(prose[2])).not.toContain('RULE_once');
    expect(prose[1].sessionId).not.toBe(prose[0].sessionId);
  });

  it('does not consume a failed target delivery and persists accepted consumption across a restart', async () => {
    const f = await fixture(); f.configure([module('once', { lifetime: { once: true } })]);
    f.provider.failKind = 'prose'; await f.run();
    expect(f.store.get(f.id).turns[0]).toMatchObject({ status: 'failed', phase: 'compose-failed', activationTurn: 1 });
    expect(f.store.get(f.id).promptActivations?.prose?.['card:once']?.consumed).not.toBe(true);
    f.provider.failKind = undefined; await f.run('author');
    expect(f.store.get(f.id).promptActivations?.prose['card:once'].consumed).toBe(true);
    const reopened = new SessionStore(f.root), engine = new TurnEngine(reopened, f.provider);
    expect((await engine.preview(f.id, { target: 'prose' })).modules.map(entry => entry.ref.moduleId)).not.toContain('once');
    expect(project(reopened.get(f.id)) as any).not.toHaveProperty('promptActivations');
    expect(project(reopened.get(f.id), 'npc') as any).not.toHaveProperty('promptActivations');
  });

  it('consumes one-shot role rules per logical NPC delivery, including several direct deliveries in one turn', async () => {
    const f = await fixture();
    const session = clone(f.store.get(f.id)), peer = clone(session.roles.find(role => role.id === 'npc')!);
    peer.id = 'peer'; peer.name = 'Peer'; peer.peers = ['npc'];
    session.roles.push(peer); session.card.roles.push(clone(peer));
    session.roles.find(role => role.id === 'npc')!.peers = ['peer']; session.card.roles.find(role => role.id === 'npc')!.peers = ['peer'];
    f.store.save(session);
    f.configure([module('role-once', { targets: ['role'], phase: 'decide', lifetime: { once: true } })]);
    f.provider.roleHook = async request => {
      const delivery = (request.input as any).delivery;
      if (delivery.to === 'peer' && delivery.kind === 'host') await request.tools[0].execute({ to: 'npc', key: 'one-question', kind: 'request', replyTo: null, body: 'What do you know?' });
    };
    await f.run();
    const npc = f.provider.calls.filter(call => call.kind === 'role' && (call.input as any).delivery.to === 'npc');
    expect(npc).toHaveLength(2); expect(text(npc[0])).toContain('RULE_role-once'); expect(text(npc[1])).not.toContain('RULE_role-once');
    expect(f.store.get(f.id).promptActivations?.['role:peer']['card:role-once'].consumed).toBe(true);
    expect(f.store.get(f.id).turns[0].status).toBe('completed');
  });
});

describe('structured auxiliary outputs at prose commit', () => {
  it('builds the submitted result schema, persists/discloses attachments, and never turns suggestions into world state', async () => {
    const f = await fixture();
    f.configure([], [output('summary'), output('options', { type: 'list', audience: ['npc'], display: { placement: 'side-panel' } }), output('notes', { type: 'object', audience: 'author', display: { placement: 'hidden' } })]);
    f.provider.outputs = { 'card:summary': 'The scene is rainy.', 'card:options': ['Consider another question.'], 'card:notes': { suggestedLocation: 'mountain', mutate: true } };
    const world = clone(f.store.get(f.id).world);
    await f.run();
    const current = f.store.get(f.id), request = f.provider.calls.find(call => call.kind === 'prose')!, schema = request.resultSchema as any;
    expect(schema.required).toContain('outputs'); expect(schema.properties.outputs.required).toEqual(['card:summary', 'card:options', 'card:notes']);
    expect(schema.properties.outputs.additionalProperties).toBe(false);
    expect(current.world).toEqual(world); expect(current.panels.some(panel => panel.kind === 'outputs')).toBe(true);
    expect(current.prose.at(-1)?.attachments).toHaveLength(3);
    expect(project(current, 'player').prose.at(-1)?.attachments?.map(entry => entry.key)).toEqual(['card:summary']);
    expect(project(current, 'npc').prose.at(-1)?.attachments?.map(entry => entry.key)).toEqual(['card:summary', 'card:options']);
    expect(JSON.stringify(request.input)).not.toContain('suggestedLocation');
    f.provider.outputs = undefined;
    f.configure([], []); await f.run();
    const following = f.provider.calls.filter(call => call.kind === 'prose').at(-1)!;
    expect(following.sessionId).not.toBe(request.sessionId);
    expect(JSON.stringify(following.input)).not.toMatch(/suggestedLocation|Consider another question/);
  });

  it('rejects wrong or undeclared returned outputs atomically while retaining committed world events and unconsumed prose rule', async () => {
    const f = await fixture();
    f.configure([module('once', { lifetime: { once: true } })], [output('list', { type: 'list' })]);
    f.provider.outputs = { 'card:list': 'not a list' }; await f.run();
    const current = f.store.get(f.id);
    expect(current.turns.at(-1)).toMatchObject({ status: 'failed', phase: 'compose-failed' });
    expect(current.revision).toBe(2); expect(current.prose.filter(entry => entry.turnId)).toEqual([]);
    expect(current.events.some(entry => entry.kind === 'world-adjudication')).toBe(true);
    expect(current.promptActivations?.prose?.['card:once']?.consumed).not.toBe(true);
    f.provider.outputs = { 'card:list': [], surprise: 'undeclared' }; await f.run('author');
    expect(f.store.get(f.id).turns.at(-1)?.error).toContain('Undeclared');
    f.provider.outputs = { 'card:list': [] }; await f.run('author');
    expect(f.store.get(f.id).turns.at(-1)?.status).toBe('completed');
    expect(f.store.get(f.id).revision).toBe(2);
  });

  it('gates required outputs by active modules/public conditions, blocks unknown facts before prose, and previews without effects', async () => {
    const f = await fixture();
    f.configure([module('off', { enabled: false })], [output('inactive', { module: 'off' }), output('unknown', { condition: { path: 'world.variables.privateMissing', equals: true } })]);
    const preview = await f.engine.preview(f.id, { target: 'prose' });
    expect(preview.valid).toBe(false); expect(preview.diagnostics.some(entry => entry.code === 'output-condition-unknown')).toBe(true);
    expect(f.provider.calls).toEqual([]); await f.run();
    expect(f.provider.calls.map(call => call.kind)).toEqual(['role', 'world']);
    const changed = clone(f.store.get(f.id).card.outputs!); changed[1].required = false;
    updateRuntimeConfiguration(f.store, f.id, { expectedRevision: f.store.get(f.id).revision, reason: 'Optional unknown', cardOutputs: changed });
    await f.run('author');
    expect(f.store.get(f.id).turns.at(-1)?.status).toBe('completed');
    expect((f.provider.calls.at(-1)!.resultSchema as any).properties).not.toHaveProperty('outputs');
  });

  it('keeps same IDs source-qualified, accepts omitted optional outputs, and rejects unsafe values', async () => {
    const f = await fixture(), session = clone(f.store.get(f.id));
    session.card.outputs = [output('same', { required: false })]; session.preset.outputs = [output('same', { type: 'object', required: false })];
    const prompt = compilePromptPlan(session, 'prose', 'compose', { snapshot: publicPromptView(session), text: '' });
    const plan = compileOutputPlan(session, prompt, publicPromptView(session));
    expect(plan.contracts.map(entry => entry.key)).toEqual(['card:same', 'preset:same']); expect(acceptOutputs(undefined, plan)).toEqual([]);
    expect(outputResultSchema({ properties: {}, required: [] }, plan).required).toEqual([]);
    for (const value of [{ 'card:same': 123 }, { 'preset:same': { number: Infinity } }, JSON.parse('{"preset:same":{"__proto__":{}}}')]) expect(() => acceptOutputs(value, plan)).toThrow();
    expect(acceptOutputs({ 'preset:same': {} }, plan)).toHaveLength(1);
    const listPlan = { ...plan, contracts: [{ ...plan.contracts[0], type: 'list' as const }] };
    const extra = ['valid']; Object.assign(extra, { ignored: 'would disappear' });
    for (const value of [Array(1), extra]) expect(() => acceptOutputs({ 'card:same': value }, listPlan)).toThrow();
  });
});
