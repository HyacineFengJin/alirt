import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate, validateNativeDocument } from '../shared/native';
import type { CharacterCard, OutputContract, Preset, PromptModule } from '../shared/types';
import { AgentModuleRegistry, type AgentModuleContext } from './agent-modules';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { compileResultValidator } from './result-schema.mjs';
import { updateRuntimeConfiguration } from './runtime-config';
import { clone, project, SessionStore } from './store';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const contract = (): OutputContract => ({ id: 'progress', title: 'Current event and progress', type: 'text', instruction: 'Host-rendered committed progress only.',
  enabled: true, required: true, priority: 0, audience: 'public', display: { placement: 'after-prose', renderer: 'folded' }, valueFrom: { kind: 'story-progress' } });
const module = (): PromptModule => ({ id: 'progress-module', title: 'Progress formatting source', content: 'Use the host progress artifact.', enabled: true,
  targets: ['prose'], phase: 'compose', category: 'supplement', priority: 0 });
const publicFact = (text = 'The public archive desk is available.') => ({ text, sources: [{ kind: 'world-development' }] });
const create = (kind: 'main' | 'side', title: string) => ({ op: 'create', kind, title, summary: `${title} supported by the public record.`, status: 'active', evidence: { factIndexes: [0], eventIds: [] } });
const result = (operations: unknown[] = [], facts: unknown[] = [publicFact()]) => ({ summary: 'Public world adjudication.', changes: [], acceptedBehaviorIds: [], facts, storyProgress: { operations } });
class Provider implements ModelProvider {
  calls: AgentRequest[] = [];
  failWriter = false;
  world: (request: AgentRequest) => any = () => result();
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request);
    if (request.kind === 'role') {
      const tool = request.tools.find(tool => tool.name === 'read_scene');
      if (tool) await tool.execute({});
      return { public: { summary: '', speech: [], actions: [] }, proposals: [] };
    }
    if (request.kind === 'world') return this.world(request);
    if (request.kind !== 'prose') throw new Error('Unexpected creator call');
    if (this.failWriter) throw new Error('Controlled writer failure');
    return { title: 'Archive', text: 'The public desk remains available.', person: 'third', pov: 'limited' };
  }
}
async function fixture(options: { enabled?: boolean; role?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rp-story-progress-runtime-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.world.time = '春·午后'; card.world.location = 'Public archive';
  card.world.variables = { enableProgress: true, counter: 0 };
  card.fields = [{ key: 'enableProgress', label: 'Progress condition', type: 'boolean', audience: 'public', editable: true },
    { key: 'counter', label: 'Counter', type: 'number', audience: 'public', editable: true }];
  card.modules = []; preset.modules = []; preset.outputs = [];
  card.outputs = options.enabled === false ? [] : [contract()];
  if (options.role) {
    card.roles.push({ id: 'npc', name: 'Keeper', persona: 'An archive keeper.', goals: [], peers: ['player'], phase: 'active', presence: 'present', state: {}, knowledge: [] });
    card.roles[0].peers = ['npc'];
  }
  const store = new SessionStore(root), id = store.create(card, preset).id, provider = new Provider();
  const contexts: AgentModuleContext[] = [];
  const modules = new AgentModuleRegistry([{ meta: { id: 'test.progress-reader', title: 'Reader', version: '1', apiVersion: 'rp.agent-module/0.1', requires: ['rp.role-agents'] },
    roleTools: context => { contexts.push(context); return [{ name: 'read_scene', description: 'Read permitted scene.', parameters: { type: 'object', properties: {} }, execute: () => context.view }]; } }]);
  if (options.role) { const next = clone(store.get(id)); next.agentRuntime = { profile: 'full', modules: { 'test.progress-reader': true } }; store.save(next); }
  const engine = new TurnEngine(store, provider, undefined, { modules }); cleanups.push(() => engine.close());
  let sequence = 0;
  const turn = async (mode: 'action' | 'author' = 'action') => {
    const input = { requestId: `progress-${++sequence}`, expectedRevision: store.get(id).revision, mode, action: mode === 'author' ? 'Rewrite only the committed scene.' : 'Look at the public desk.' };
    engine.submit(id, input); await engine.idle(id); return input;
  };
  const configure = (patch: Parameters<typeof updateRuntimeConfiguration>[2]) => updateRuntimeConfiguration(store, id, patch);
  return { root, card, preset, store, id, provider, engine, contexts, turn, configure };
}
const progressOutput = (session: ReturnType<SessionStore['get']>) => session.prose.at(-1)?.attachments?.find(output => output.key === 'card:progress');

describe('story progress through the real world commit and prose lifecycle', () => {
  it('admits the world schema only through auxiliary, contract, module and public condition gates', async () => {
    const f = await fixture({ enabled: false });
    f.provider.world = () => ({ summary: 'Ordinary scene.', changes: [], acceptedBehaviorIds: [], facts: [] });
    const configurations = [
      { cardOutputs: [] },
      { cardOutputs: [{ ...contract(), enabled: false }] },
      { cardModules: [{ ...module(), enabled: false }], cardOutputs: [{ ...contract(), module: 'progress-module' }] },
      { cardModules: [{ ...module(), condition: { path: 'world.variables.enableProgress', equals: false } }], cardOutputs: [{ ...contract(), module: 'progress-module' }] },
      { cardModules: [module()], cardOutputs: [{ ...contract(), module: 'progress-module', condition: { path: 'world.variables.enableProgress', equals: false } }] },
      { cardModules: [module()], cardOutputs: [{ ...contract(), module: 'progress-module' }], agentRuntime: { profile: 'full' as const, modules: { 'rp.auxiliary-outputs': false } } },
      { cardModules: [module()], cardOutputs: [{ ...contract(), module: 'progress-module', condition: { path: 'world.variables.enableProgress', equals: true } }], agentRuntime: { profile: 'full' as const } },
    ];
    for (const [index, configuration] of configurations.entries()) {
      if (index) f.configure({ ...configuration, expectedRevision: f.store.get(f.id).revision, reason: `Explicit producer configuration ${index}` });
      await f.turn();
      expect(f.store.get(f.id).turns.at(-1)?.status).toBe('completed');
      const world = f.provider.calls.filter(call => call.kind === 'world').at(-1)!;
      expect(Object.hasOwn((world.resultSchema as any).properties, 'storyProgress')).toBe(index === configurations.length - 1);
      expect(world.system.includes('When story progress is enabled')).toBe(index === configurations.length - 1);
      expect(compileResultValidator(world.resultSchema)(f.provider.world(world))).toEqual([]);
      if (index < configurations.length - 1) expect(f.store.get(f.id).storyProgress).toBeUndefined();
    }
    expect(f.store.get(f.id).storyProgress?.sequence).toBe(1);
    const worlds = f.provider.calls.filter(call => call.kind === 'world');
    expect(worlds.at(-1)!.sessionId).not.toBe(worlds.at(-2)!.sessionId);
    const enabled = worlds.at(-1)!;
    expect(compileResultValidator(enabled.resultSchema)(result([create('main', 'Find a public record')]))).toEqual([]);
    expect(compileResultValidator(enabled.resultSchema)(result([{ ...create('main', 'Forged host identity'), id: 'MQ.X', sequence: 99 }])).length).toBeGreaterThan(0);
    expect(validateNativeDocument('card', { ...f.card, outputs: [contract()] })).toEqual([]);
    expect((f.provider.calls.at(-1)!.resultSchema as any).properties).not.toHaveProperty('outputs');
    expect(progressOutput(f.store.get(f.id))?.provenance).toMatchObject({ kind: 'committed-progress', sequence: 1 });
  });

  it('retains progress revision 1 and its host display after writer failure/restart, recovers without allocating again, and advances/hides completed tasks only on subsequent enabled commits', async () => {
    const f = await fixture(); f.provider.world = () => result([create('main', 'FIRST_MAIN_TASK'), create('side', 'SIDE_TASK')]); f.provider.failWriter = true;
    const request = await f.turn(), committed = clone(f.store.get(f.id).storyProgress!);
    expect(f.store.get(f.id).turns.at(-1)).toMatchObject({ status: 'failed', phase: 'compose-failed' });
    expect(committed).toMatchObject({ sequence: 1, nextMainIndex: 2, nextSideIndex: 2, before: { time: '春·午后', location: 'Public archive' }, after: { time: '春·午后', location: 'Public archive' } });
    expect(committed.tasks.map(task => task.id)).toEqual(['MQ.I', 'SQ.1']);
    const publicEvent = f.store.get(f.id).events.find(event => event.kind === 'world-event')!;
    expect(committed.tasks.every(task => JSON.stringify(task.evidence) === JSON.stringify({ eventIds: [publicEvent.id] }))).toBe(true);
    const retainedHost = clone(f.store.get(f.id).events.find(event => (event.data as any)?.output?.provenance?.kind === 'committed-progress')!);
    expect((retainedHost.data as any).output.value).toContain('进展修订：1');
    expect(f.engine.submit(f.id, request)).toMatchObject({ duplicate: true, status: 'failed' });
    expect(f.store.get(f.id).storyProgress).toEqual(committed);
    await f.engine.close();
    const store = new SessionStore(f.root), provider = new Provider(), engine = new TurnEngine(store, provider); cleanups.push(() => engine.close());
    let number = 0;
    const turn = async (mode: 'author' | 'action') => { engine.submit(f.id, { requestId: `restart-progress-${++number}`, expectedRevision: store.get(f.id).revision, mode, action: 'Use committed public material only.' }); await engine.idle(f.id); expect(store.get(f.id).turns.at(-1)?.status).toBe('completed'); };
    await turn('author');
    expect(provider.calls.map(call => call.kind)).toEqual(['prose']); expect(store.get(f.id).storyProgress).toEqual(committed);
    expect(store.get(f.id).events.find(event => event.id === retainedHost.id)).toEqual(retainedHost);
    expect(progressOutput(store.get(f.id))?.value).toContain('MQ.I');
    provider.world = () => result([{ op: 'update', taskId: 'MQ.I', status: 'completed', evidence: { factIndexes: [0], eventIds: [] } }, create('main', 'SECOND_MAIN_TASK')]);
    await turn('action'); const pg2 = clone(store.get(f.id).storyProgress!);
    expect(pg2.sequence).toBe(2); expect(pg2.tasks.map(task => task.id)).toEqual(['MQ.I', 'SQ.1', 'MQ.II']);
    expect(pg2.tasks[0]).toMatchObject({ status: 'completed', completedAtSequence: 2 });
    expect(progressOutput(store.get(f.id))?.value).toContain('FIRST_MAIN_TASK');
    expect(progressOutput(store.get(f.id))?.value).toContain('SECOND_MAIN_TASK');
    provider.world = () => result(); await turn('action');
    expect(store.get(f.id).storyProgress?.sequence).toBe(3);
    expect(store.get(f.id).storyProgress?.tasks).toEqual(pg2.tasks);
    expect(progressOutput(store.get(f.id))?.value).not.toContain('FIRST_MAIN_TASK');
    expect(progressOutput(store.get(f.id))?.value).toContain('SECOND_MAIN_TASK');
    const history = clone(store.get(f.id).prose), held = clone(store.get(f.id).storyProgress);
    updateRuntimeConfiguration(store, f.id, { expectedRevision: store.get(f.id).revision, reason: 'Stop new progress without deleting the archive', cardOutputs: [{ ...contract(), enabled: false }] });
    provider.world = () => ({ summary: 'Ordinary story continues.', changes: [], acceptedBehaviorIds: [], facts: [publicFact('A new ordinary scene detail.')] });
    await turn('action');
    const offWorld = provider.calls.filter(call => call.kind === 'world').at(-1)!;
    expect((offWorld.resultSchema as any).properties).not.toHaveProperty('storyProgress');
    expect(store.get(f.id).storyProgress).toEqual(held); expect(store.get(f.id).prose.slice(0, history.length)).toEqual(history);
    expect(progressOutput(store.get(f.id))).toBeUndefined();
    const revision = store.get(f.id).revision;
    provider.world = () => result([create('side', 'FORBIDDEN_OFF_TASK')]);
    engine.submit(f.id, { requestId: 'off-cannot-patch', expectedRevision: revision, mode: 'action', action: 'Continue.' }); await engine.idle(f.id);
    expect(store.get(f.id).turns.at(-1)?.status).toBe('failed'); expect(store.get(f.id).revision).toBe(revision); expect(store.get(f.id).storyProgress).toEqual(held);
  });

  it.each(['progress reference', 'fact reference'] as const)('rolls back state, public facts and held progress together for an invalid %s', async failure => {
    const f = await fixture(); f.provider.world = () => result([create('main', 'Retained task')]); await f.turn();
    const before = clone(f.store.get(f.id));
    f.provider.world = () => ({ ...result([failure === 'progress reference' ? { ...create('side', 'Invalid evidence'), evidence: { factIndexes: [1], eventIds: [] } } : create('side', 'Otherwise valid')],
      failure === 'fact reference' ? [{ text: 'Unsupported claim.', sources: [{ kind: 'behavior', id: 'not-approved' }] }] : [publicFact('Must not persist.')]),
      changes: [{ roleId: 'world', key: 'counter', value: 99 }] });
    const request = await f.turn(), after = f.store.get(f.id);
    expect(after.turns.at(-1)?.status).toBe('failed'); expect(after.revision).toBe(before.revision); expect(after.world).toEqual(before.world);
    expect(after.storyProgress).toEqual(before.storyProgress); expect(after.prose).toEqual(before.prose);
    for (const kind of ['world-event', 'world-adjudication', 'state-commit', 'state-transaction', 'story-progress-commit', 'host-output'])
      expect(after.events.filter(event => event.kind === kind)).toEqual(before.events.filter(event => event.kind === kind));
    expect(f.provider.calls.at(-1)!.kind).toBe('world');
    expect(f.engine.submit(f.id, request)).toMatchObject({ duplicate: true, status: 'failed' });
  });

  it('keeps the raw registry private while exposing only its host rendering to readers and canonical facts to role models', async () => {
    const f = await fixture({ role: true }); f.provider.world = () => result([create('main', 'REGISTRY_TASK_TITLE')]); await f.turn();
    f.provider.world = () => result(); await f.turn();
    expect(f.store.get(f.id).turns.at(-1)?.status).toBe('completed');
    const held = f.store.get(f.id); expect(held.storyProgress?.sequence).toBe(2);
    for (const perspective of ['author', 'player', 'npc']) {
      const view = project(held, perspective);
      expect(view).not.toHaveProperty('storyProgress');
      expect(progressOutput(view as any)?.value).toContain('REGISTRY_TASK_TITLE');
      expect(view.events.some(event => event.kind === 'host-output' && (event.data as any)?.output?.provenance?.kind === 'committed-progress')).toBe(true);
    }
    expect(f.contexts).toHaveLength(2);
    for (const context of f.contexts) {
      expect(context.view).not.toHaveProperty('storyProgress');
      expect(context.view.prose.every(entry => !Object.hasOwn(entry, 'attachments'))).toBe(true);
      expect(JSON.stringify(context.view)).not.toContain('REGISTRY_TASK_TITLE');
    }
    const actors = f.provider.calls.filter(call => call.kind === 'role' || call.kind === 'prose');
    for (const request of actors) {
      expect(request.input).not.toHaveProperty('storyProgress');
      expect(JSON.stringify(request.input)).not.toContain('REGISTRY_TASK_TITLE');
    }
    const role = f.provider.calls.filter(call => call.kind === 'role').at(-1)!;
    expect((role.input as any).continuity.some((event: any) => event.kind === 'world-event' && event.text === publicFact().text)).toBe(true);
    expect((f.provider.calls.filter(call => call.kind === 'world').at(-1)!.input as any).storyProgress.sequence).toBe(1);
  });
});
