import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, OutputContract, Preset } from '../shared/types';
import { createApp } from './app';
import type { AgentModule, AgentModuleContext } from './agent-modules';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { readRuntimeConfiguration } from './runtime-config';
import { clone, project, SessionStore, type PeerMail } from './store';

const roots: string[] = [], cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** All requests terminate in this recorder; no external model or production fallback. */
class ModuleTestProvider implements ModelProvider {
  calls: AgentRequest[] = [];
  outputs?: unknown;
  roleHook?: (request: AgentRequest) => Promise<void>;
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request);
    if (request.kind === 'role') {
      await this.roleHook?.(request);
      return { summary: 'The keeper replies.', expression: 'The bell is ringing.', proposals: [] };
    }
    if (request.kind === 'world') return { summary: 'The scene continues.', changes: [], events: ['A bell rings.'] };
    if (request.kind === 'prose') return { title: 'At the harbor', text: 'The keeper listens to the bell.', person: 'third', pov: 'limited',
      ...(this.outputs === undefined ? {} : { outputs: this.outputs }) };
    throw new Error('Creator requests are outside this fixture');
  }
}
const contract: OutputContract = { id: 'recap', title: 'Scene recap', type: 'text', instruction: 'UNIQUE_AUXILIARY_CONTRACT_INSTRUCTION',
  enabled: true, required: true, priority: 0, audience: ['npc'], display: { placement: 'side-panel' } };

async function fixture(options: { outputs?: boolean; agentModules?: AgentModule[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rp-agent-module-integration-')); roots.push(root);
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.id = 'agent-module-card'; preset.id = 'agent-module-preset';
  card.roles.push({ id: 'npc', name: 'Keeper', persona: 'A harbor keeper.', goals: [], peers: ['player'], phase: 'active', presence: 'present', state: {}, knowledge: [] });
  card.roles[0].peers = ['npc'];
  if (options.outputs) card.outputs = [clone(contract)];
  const provider = new ModuleTestProvider();
  const service = await createApp({ dataRoot: root, provider, agentModules: options.agentModules, catalog: async () => ({ cards: [card], presets: [preset] }) });
  cleanups.push(service.close);
  const id = service.store.create(card, preset).id;
  const server: Server = await new Promise(resolve => { const listening = service.app.listen(0, '127.0.0.1', () => resolve(listening)); });
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected a loopback server');
  const api = `http://127.0.0.1:${address.port}/api`, runtime = `${api}/sessions/${id}/runtime`;
  const configure = (agentRuntime: unknown, expectedRevision = service.store.get(id).revision) => fetch(runtime, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision, reason: 'Choose agent capabilities', agentRuntime }) });
  let index = 0;
  const submit = () => service.engine.submit(id, { requestId: `modules-${++index}`, expectedRevision: service.store.get(id).revision, action: 'Listen to the bell.', mode: 'action' });
  const turn = async () => { submit(); await service.engine.idle(id); };
  return { ...service, provider, id, root, api, runtime, configure, submit, turn };
}
const writers = (provider: ModuleTestProvider) => provider.calls.filter(call => call.kind === 'prose');

describe('session agent capability modules', () => {
  it('keeps legacy sessions on full behavior, including durable passive peer mail', async () => {
    const f = await fixture();
    // A session without an explicit setting is the persisted pre-module format.
    expect(readRuntimeConfiguration(f.store, f.id).agentRuntime.profile).toBe('full');
    f.provider.roleHook = async request => {
      const tool = request.tools.find(tool => tool.name === 'peer_send'); expect(tool).toBeDefined();
      await tool!.execute({ to: 'player', key: 'bell-notice', kind: 'notice', replyTo: null, body: 'The bell is audible.' });
    };
    await f.turn();
    expect(f.provider.calls.map(call => call.kind)).toEqual(['role', 'world', 'prose']);
    expect(f.store.get(f.id).turns.at(-1)?.status).toBe('completed');
    expect(f.store.get(f.id).mailbox).toEqual([expect.objectContaining({ to: 'player', kind: 'notice', state: 'pending', key: 'bell-notice' })]);
  });

  it('minimal skips every role activation while preserving world adjudication and prose', async () => {
    const f = await fixture({ outputs: true });
    expect((await f.configure({ profile: 'minimal' })).status).toBe(200);
    await f.turn();
    expect(f.provider.calls.map(call => call.kind)).toEqual(['world', 'prose']);
    expect((f.provider.calls[0].input as any).results).toEqual([]);
    expect(f.store.get(f.id).turns.at(-1)?.status).toBe('completed');
    expect(f.store.get(f.id).events.some(event => event.kind === 'world-adjudication')).toBe(true);
    expect(writers(f.provider)[0].system).not.toContain(contract.instruction);
    expect((writers(f.provider)[0].resultSchema as any).properties).not.toHaveProperty('outputs');
  });

  it('compact removes peer tools and leaves existing notices undisclosed and pending until re-enabled', async () => {
    const f = await fixture();
    const notice: PeerMail = { id: 'pending-notice', at: new Date().toISOString(), turnId: 'older-turn', from: 'player', to: 'npc',
      key: 'old-notice', kind: 'notice', replyTo: null, body: 'PENDING_NOTICE_UNIQUE_KNOWLEDGE', causeId: 'old-input', state: 'pending' };
    const current = clone(f.store.get(f.id)); current.mailbox = [notice]; f.store.save(current);
    expect((await f.configure({ profile: 'compact' })).status).toBe(200);
    await f.turn();
    const firstRole = f.provider.calls.find(call => call.kind === 'role')!;
    expect(firstRole.tools.some(tool => tool.name === 'peer_send')).toBe(false);
    expect(JSON.stringify(firstRole.input)).not.toContain(notice.body);
    expect(f.store.get(f.id).mailbox![0]).toEqual(notice);
    expect(JSON.stringify(f.store.get(f.id).roles[1].knowledge)).not.toContain(notice.body);
    expect((await f.configure({ profile: 'full' })).status).toBe(200);
    await f.turn();
    const roles = f.provider.calls.filter(call => call.kind === 'role');
    expect(roles[1].tools.some(tool => tool.name === 'peer_send')).toBe(true);
    expect(JSON.stringify(roles[1].input)).toContain(notice.body);
    expect(f.store.get(f.id).mailbox![0].state).toBe('consumed');
  });

  it('disables auxiliary contracts without accepting rogue outputs, then restores definitions and a fresh prose context', async () => {
    const f = await fixture({ outputs: true });
    f.provider.outputs = { 'card:recap': 'A private recap for the keeper.' }; await f.turn();
    const initialWriter = writers(f.provider)[0], historical = clone(f.store.get(f.id).prose.at(-1)!);
    expect(historical.attachments).toHaveLength(1);
    expect((await f.configure({ profile: 'full', modules: { 'rp.auxiliary-outputs': false } })).status).toBe(200);
    f.provider.outputs = undefined; await f.turn();
    const disabledWriter = writers(f.provider).at(-1)!;
    expect(disabledWriter.system).not.toContain(contract.instruction);
    expect((disabledWriter.resultSchema as any).properties).not.toHaveProperty('outputs');
    expect(disabledWriter.sessionId).not.toBe(initialWriter.sessionId);
    const proseCount = f.store.get(f.id).prose.length, revision = f.store.get(f.id).revision;
    f.provider.outputs = { 'card:recap': 'An undeclared attempt.' }; await f.turn();
    expect(f.store.get(f.id).turns.at(-1)).toMatchObject({ status: 'failed', phase: 'compose-failed' });
    expect(f.store.get(f.id).turns.at(-1)?.error).toMatch(/undeclared/i);
    expect(f.store.get(f.id).revision).toBe(revision + 1);
    expect(f.store.get(f.id).prose).toHaveLength(proseCount);
    expect((await f.configure({ profile: 'full' })).status).toBe(200);
    f.provider.outputs = { 'card:recap': 'Restored valid recap.' }; await f.turn();
    const restoredWriter = writers(f.provider).at(-1)!;
    expect(restoredWriter.system).toContain(contract.instruction);
    expect((restoredWriter.resultSchema as any).properties.outputs.required).toEqual(['card:recap']);
    expect(restoredWriter.sessionId).not.toBe(disabledWriter.sessionId);
    expect(f.store.get(f.id).prose.find(entry => entry.id === historical.id)).toEqual(historical);
    expect(f.store.get(f.id).card.outputs).toEqual([contract]);
    expect(f.store.get(f.id).turns.at(-1)?.status).toBe('completed');
  });

  it('rejects stale and running capability changes without altering durable configuration', async () => {
    const f = await fixture();
    expect((await f.configure({ profile: 'compact' })).status).toBe(200);
    const filename = join(f.root, `session-${f.id}.json`), before = await readFile(filename, 'utf8');
    const stale = await f.configure({ profile: 'minimal' }, 0);
    expect(stale.status).toBe(409); expect((await stale.json()).error.code).toBe('REVISION_CONFLICT');
    expect(await readFile(filename, 'utf8')).toBe(before);
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.provider.roleHook = async () => { entered(); await blocked; };
    f.submit();
    try {
      await started;
      const activeConfig = readRuntimeConfiguration(f.store, f.id), activeSnapshot = await readFile(filename, 'utf8');
      const busy = await f.configure({ profile: 'minimal' });
      expect(busy.status).toBe(409); expect((await busy.json()).error.code).toBe('TURN_BUSY');
      expect(readRuntimeConfiguration(f.store, f.id)).toEqual(activeConfig);
      expect(await readFile(filename, 'utf8')).toBe(activeSnapshot);
    } finally { release(); await f.engine.idle(f.id); }
    expect(f.store.get(f.id).turns.at(-1)?.status).toBe('completed');
  });

  it('persists capability settings and historical private attachments without regenerating them on restart', async () => {
    const f = await fixture({ outputs: true });
    f.provider.outputs = { 'card:recap': 'HISTORICAL_PRIVATE_AUXILIARY' }; await f.turn();
    expect((await f.configure({ profile: 'minimal' })).status).toBe(200);
    const beforeCalls = f.provider.calls.length, before = clone(f.store.get(f.id));
    const reopened = new SessionStore(f.root);
    expect(readRuntimeConfiguration(reopened, f.id).agentRuntime.profile).toBe('minimal');
    expect(reopened.get(f.id).prose).toEqual(before.prose);
    expect(reopened.get(f.id).card.outputs).toEqual([contract]);
    expect(f.provider.calls).toHaveLength(beforeCalls);
    expect(project(reopened.get(f.id), 'player').prose.at(-1)?.attachments).toEqual([]);
    expect(project(reopened.get(f.id), 'npc').prose.at(-1)?.attachments).toEqual(before.prose.at(-1)?.attachments);
    const restartedProvider = new ModuleTestProvider(), restartedEngine = new TurnEngine(reopened, restartedProvider);
    cleanups.push(() => restartedEngine.close());
    expect(restartedProvider.calls).toEqual([]);
    restartedEngine.submit(f.id, { requestId: 'after-restart', expectedRevision: reopened.get(f.id).revision, action: 'Listen again.', mode: 'action' });
    await restartedEngine.idle(f.id);
    expect(restartedProvider.calls.map(call => call.kind)).toEqual(['world', 'prose']);
    expect(reopened.get(f.id).prose.slice(0, before.prose.length)).toEqual(before.prose);
  });

  it('exposes the module catalog and resolved plan while rejecting unknown modules and disabled dependencies atomically', async () => {
    const f = await fixture();
    const catalogResponse = await fetch(`${f.api}/runtime/modules`);
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json();
    expect(catalog.modules.map((module: any) => module.id)).toEqual(['rp.role-agents', 'rp.peer-mail', 'rp.auxiliary-outputs', 'rp.derived-memory', 'rp.prose-review', 'rp.carrier-view']);
    expect(f.engine.runtime(f.id).enabled).not.toContain('rp.carrier-view');
    expect(f.engine.runtime(f.id).enabled).not.toContain('rp.derived-memory');
    expect(f.engine.runtime(f.id).enabled).not.toContain('rp.prose-review');
    expect(catalog.modules.find((module: any) => module.id === 'rp.peer-mail').requires).toEqual(['rp.role-agents']);
    const before = await readFile(join(f.root, `session-${f.id}.json`), 'utf8');
    for (const [config, code] of [
      [{ profile: 'minimal', modules: { 'rp.peer-mail': true } }, 'AGENT_MODULE_DEPENDENCY'],
      [{ profile: 'full', modules: { 'file:///untrusted-module.js': true } }, 'AGENT_MODULE_UNKNOWN'],
    ] as const) {
      const response = await f.configure(config);
      expect(response.status).toBe(400); expect((await response.json()).error.code).toBe(code);
      expect(await readFile(join(f.root, `session-${f.id}.json`), 'utf8')).toBe(before);
    }
    expect((await f.configure({ profile: 'compact' })).status).toBe(200);
    const planResponse = await fetch(`${f.runtime}/modules`); expect(planResponse.status).toBe(200);
    expect(await planResponse.json()).toMatchObject({ profile: 'compact', enabled: ['rp.role-agents'], disabled: ['rp.peer-mail', 'rp.auxiliary-outputs', 'rp.derived-memory', 'rp.prose-review', 'rp.carrier-view'] });
    expect(f.provider.calls).toEqual([]);
    expect(f.store.get(f.id).turns).toEqual([]);
  });

  it('enables a trusted local role tool through the API with only a frozen permitted view', async () => {
    const contexts: AgentModuleContext[] = [], toolResults: unknown[] = [];
    const custom: AgentModule = {
      meta: { id: 'test.scene-reader', title: 'Scene reader', version: '1.0.0', apiVersion: 'rp.agent-module/0.1', requires: ['rp.role-agents'] },
      roleTools: context => {
        contexts.push(context);
        return [{ name: 'read_scene', description: 'Read permitted scene location.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
          execute: () => ({ roleId: context.roleId, location: context.view.world.location }) }];
      },
    };
    const f = await fixture({ agentModules: [custom] });
    f.provider.roleHook = async request => { const tool = request.tools.find(tool => tool.name === 'read_scene'); if (tool) toolResults.push(await tool.execute({})); };
    await f.turn();
    expect(contexts).toEqual([]); expect(toolResults).toEqual([]);
    expect((await f.configure({ profile: 'compact', modules: { 'test.scene-reader': true } })).status).toBe(200);
    await f.turn();
    expect(contexts).toHaveLength(1);
    expect(toolResults).toEqual([{ roleId: 'npc', location: f.store.get(f.id).world.location }]);
    expect(Object.keys(contexts[0]).sort()).toEqual(['roleId', 'signal', 'view']);
    expect(contexts[0]).not.toHaveProperty('store'); expect(contexts[0]).not.toHaveProperty('provider');
    expect(contexts[0].view).not.toHaveProperty('card'); expect(contexts[0].view).not.toHaveProperty('mailbox');
    const location = f.store.get(f.id).world.location;
    expect(() => { contexts[0].view.world.location = 'Mutated by a tool'; }).toThrow();
    expect(f.store.get(f.id).world.location).toBe(location);
    const roles = f.provider.calls.filter(call => call.kind === 'role');
    expect(roles[1].tools.map(tool => tool.name)).toEqual(['read_scene']);
  });

  it('retains role context when only an unrelated output capability changes with a custom tool installed', async () => {
    const f = await fixture({ agentModules: [{
      meta: { id: 'test.reader', title: 'Reader', version: '1', apiVersion: 'rp.agent-module/0.1', requires: ['rp.role-agents'] },
      roleTools: () => [{ name: 'read_scene', description: 'Read permitted scene.', parameters: { type: 'object', properties: {} }, execute: () => ({ ok: true }) }],
    }] });
    expect((await f.configure({ profile: 'compact', modules: { 'test.reader': true } })).status).toBe(200);
    await f.turn();
    expect((await f.configure({ profile: 'compact', modules: { 'test.reader': true, 'rp.auxiliary-outputs': true } })).status).toBe(200);
    await f.turn();
    const roles = f.provider.calls.filter(call => call.kind === 'role');
    expect(roles[1].sessionId).toBe(roles[0].sessionId);
  });

  it('keeps private module-factory error details out of public turn status', async () => {
    const f = await fixture({ agentModules: [{
      meta: { id: 'test.failing', title: 'Failing tool', version: '1', apiVersion: 'rp.agent-module/0.1', requires: ['rp.role-agents'] },
      roleTools: () => { throw new Error('PRIVATE_ROLE_TOOL_DETAILS'); },
    }] });
    expect((await f.configure({ profile: 'compact', modules: { 'test.failing': true } })).status).toBe(200);
    await f.turn();
    expect(f.provider.calls).toEqual([]);
    expect(f.store.get(f.id).turns.at(-1)?.status).toBe('failed');
    expect(f.store.get(f.id).turns.at(-1)?.error).toContain('test.failing');
    expect(JSON.stringify(project(f.store.get(f.id), 'player'))).not.toContain('PRIVATE_ROLE_TOOL_DETAILS');
  });
});
