import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Json, Preset } from '../shared/types';
import { createApp } from './app';
import type { AgentRequest, ModelProvider } from './engine';
import { publicPromptView } from './prompt-compiler';
import { SessionServiceRegistry, type SessionCommandService } from './session-services';
import { assertRevision, clone, project, SessionStore, type StoredSession } from './store';

const roots: string[] = [], cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const secret = 'HOST_SERVICE_PRIVATE_SENTINEL';
const counter = (): SessionCommandService => ({
  id: 'test.counter', title: 'Local counter',
  read: session => ({ revision: session.revision, held: session.hostServices?.['test.counter'] ?? null }),
  apply: (store, id, input) => {
    const command = input as { expectedRevision: number; value: Json };
    const next = clone(store.get(id)); assertRevision(next, command.expectedRevision);
    next.hostServices = { ...next.hostServices, 'test.counter': command.value };
    next.revision++; store.save(next);
    return { revision: next.revision, held: next.hostServices['test.counter'] };
  },
});
/** Every model request stays in this deterministic local recorder. */
class ServiceTestProvider implements ModelProvider {
  calls: AgentRequest[] = [];
  block?: () => Promise<void>;
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request); await this.block?.();
    if (request.kind === 'role') return { summary: 'The keeper replies.', expression: 'The bell rings.', proposals: [] };
    if (request.kind === 'world') return { summary: 'The scene continues.', changes: [], events: ['The bell rings.'] };
    if (request.kind === 'prose') return { title: 'The bell', text: 'The keeper hears the bell.', person: 'third', pov: 'limited' };
    throw new Error('Creator requests are outside this fixture');
  }
}
async function fixture(services: readonly SessionCommandService[] = [], reuse?: { root: string; id: string }) {
  const root = reuse?.root ?? await mkdtemp(join(tmpdir(), 'rp-session-services-')); if (!reuse) roots.push(root);
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.roles.push({ id: 'npc', name: 'Keeper', persona: 'A harbor keeper.', goals: [], peers: ['player'], phase: 'active', presence: 'present', state: {}, knowledge: [] });
  card.roles[0].peers = ['npc'];
  const provider = new ServiceTestProvider();
  const service = await createApp({ dataRoot: root, provider, sessionServices: services, catalog: async () => ({ cards: [card], presets: [preset] }) });
  cleanups.push(service.close);
  const id = reuse?.id ?? service.store.create(card, preset).id;
  const server: Server = await new Promise(resolve => { const listening = service.app.listen(0, '127.0.0.1', () => resolve(listening)); });
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected loopback server');
  const base = `http://127.0.0.1:${address.port}/api/sessions`, url = `${base}/${id}`;
  const command = (value: unknown, serviceId = 'test.counter') => fetch(`${url}/services/${serviceId}/commands`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  return { ...service, root, id, base, url, provider, command, filename: join(root, `session-${id}.json`) };
}

describe('trusted session command registry', () => {
  it('passes detached deeply frozen reads and detaches response JSON', async () => {
    const f = await fixture(); const held = f.store.get(f.id);
    held.hostServices = { private: { nested: [secret] } };
    let captured!: Readonly<StoredSession>;
    const result = { values: [1] };
    const registry = new SessionServiceRegistry([{ ...counter(), read: session => {
      captured = session;
      expect(Object.isFrozen(session)).toBe(true);
      expect(Object.isFrozen((session.hostServices!.private as any).nested)).toBe(true);
      expect(() => { (session.hostServices!.private as any).nested.push('changed'); }).toThrow();
      return result;
    } }]);
    const before = clone(held), output = registry.read('test.counter', held);
    expect(captured).not.toBe(held); expect(captured.hostServices).not.toBe(held.hostServices);
    expect(held).toEqual(before); expect(Object.isFrozen(held)).toBe(false);
    result.values.push(2); expect(output).toEqual({ values: [1] });
  });

  it('validates explicit definitions without invoking accessors or async handlers', () => {
    const getter = vi.fn(() => 'bad');
    const accessor = Object.defineProperty({ ...counter() }, 'id', { enumerable: true, get: getter });
    const asyncRead = vi.fn(async () => ({}));
    for (const definitions of [null, {}, [accessor], [Object.assign(Object.create({}), counter())],
      [{ ...counter(), id: '__proto__' }], [{ ...counter(), id: 'bad/path' }],
      [{ ...counter(), read: asyncRead }], [{ ...counter(), unknown: true }], [counter(), counter()]]) {
      expect(() => new SessionServiceRegistry(definitions as any)).toThrow();
    }
    expect(getter).not.toHaveBeenCalled(); expect(asyncRead).not.toHaveBeenCalled();
    const definition = counter(), registry = new SessionServiceRegistry([definition]);
    (definition as any).id = 'mutated';
    const catalog = registry.catalog(); catalog[0].title = 'mutated';
    expect(registry.catalog()).toEqual([{ id: 'test.counter', title: 'Local counter' }]);
  });

  it('rejects non-JSON inputs before dispatch and invalid or asynchronous results', async () => {
    const f = await fixture(); const apply = vi.fn(() => ({}));
    const registry = new SessionServiceRegistry([{ ...counter(), apply }]);
    const getter = vi.fn(() => 1), accessor = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
    const cycle: any = {}; cycle.self = cycle;
    for (const input of [null, [], 'text', { value: undefined }, { value: NaN }, { value: new Date() }, accessor, cycle, JSON.parse('{"__proto__":{}}')]) {
      expect(() => registry.apply('test.counter', f.store, f.id, input)).toThrow(/ordinary JSON/);
    }
    expect(apply).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
    for (const output of [undefined, { value: Infinity }, new Date(), new Map(), Promise.resolve({})]) {
      const invalid = new SessionServiceRegistry([{ ...counter(), read: () => output, apply: () => output }]);
      expect(() => invalid.read('test.counter', f.store.get(f.id))).toThrow(/JSON|synchronous/);
      expect(() => invalid.apply('test.counter', f.store, f.id, {})).toThrow(/JSON|synchronous/);
    }
    const input = { nested: [1] };
    const detached = new SessionServiceRegistry([{ ...counter(), apply: (_store, _id, command: any) => { command.nested.push(2); return command; } }]);
    expect(detached.apply('test.counter', f.store, f.id, input)).toEqual({ nested: [1, 2] });
    expect(input).toEqual({ nested: [1] });
  });
});

describe('optional session service HTTP routes', () => {
  it('defaults to no services and keeps unknown service failures local', async () => {
    const f = await fixture(); const before = await readFile(f.filename, 'utf8');
    expect(await (await fetch(`${f.url}/services`)).json()).toEqual({ services: [] });
    for (const response of [await fetch(`${f.url}/services/test.counter`), await f.command({})]) {
      expect(response.status).toBe(404); expect((await response.json()).error.code).toBe('SESSION_SERVICE_UNKNOWN');
    }
    expect((await fetch(f.url)).status).toBe(200);
    expect((await fetch(`${f.base}/missing/services`)).status).toBe(404);
    expect(await readFile(f.filename, 'utf8')).toBe(before); expect(f.provider.calls).toEqual([]);
  });

  it('dispatches installed services independently of agent runtime and preserves private data on removal', async () => {
    const f = await fixture([counter()]);
    const current = clone(f.store.get(f.id)); current.agentRuntime = { profile: 'minimal' }; f.store.save(current);
    expect(await (await fetch(`${f.url}/services`)).json()).toEqual({ services: [{ id: 'test.counter', title: 'Local counter' }] });
    const write = await f.command({ expectedRevision: 0, value: { private: secret } });
    expect(write.status).toBe(200); expect(await write.json()).toEqual({ revision: 1, held: { private: secret } });
    expect(await (await fetch(`${f.url}/services/test.counter`)).json()).toEqual({ revision: 1, held: { private: secret } });
    expect(f.store.get(f.id).agentRuntime).toEqual({ profile: 'minimal' });
    expect(f.provider.calls).toEqual([]); expect(f.store.get(f.id).turns).toEqual([]);
    const before = await readFile(f.filename, 'utf8');
    const stale = await f.command({ expectedRevision: 0, value: 'stale' });
    expect(stale.status).toBe(409); expect((await stale.json()).error.code).toBe('REVISION_CONFLICT');
    expect(await readFile(f.filename, 'utf8')).toBe(before);
    const removed = await fixture([], f);
    for (const response of [await fetch(`${removed.url}/services/test.counter`), await removed.command({ expectedRevision: 1, value: 'removed' })]) {
      expect(response.status).toBe(404); expect((await response.json()).error.code).toBe('SESSION_SERVICE_UNKNOWN');
    }
    expect(removed.store.get(f.id).hostServices).toEqual({ 'test.counter': { private: secret } });
    expect(await readFile(f.filename, 'utf8')).toBe(before); expect((await fetch(removed.url)).status).toBe(200);
    const restored = await fixture([counter()], f);
    expect(await (await fetch(`${restored.url}/services/test.counter`)).json()).toEqual({ revision: 1, held: { private: secret } });
  });

  it('excludes private held payloads from all session projections and actual model requests', async () => {
    const f = await fixture([counter()]);
    expect((await f.command({ expectedRevision: 0, value: { private: secret } })).status).toBe(200);
    const held = f.store.get(f.id);
    for (const view of [project(held), ...held.roles.map(role => project(held, role.id)), publicPromptView(held), f.store.list()]) {
      expect(JSON.stringify(view)).not.toContain(secret); expect(JSON.stringify(view)).not.toContain('hostServices');
    }
    for (const endpoint of [f.base, f.url, ...held.roles.map(role => `${f.url}?perspective=${role.id}`)]) {
      const response = await fetch(endpoint); expect(response.status).toBe(200);
      expect(await response.text()).not.toContain(secret);
    }
    const lifecycle = f.store.lifecycle(f.id, { expectedRevision: 1, roleId: 'npc', phase: 'active', presence: 'present' });
    expect(JSON.stringify(lifecycle)).not.toContain(secret); expect(lifecycle).not.toHaveProperty('hostServices');
    f.engine.submit(f.id, { requestId: 'service-private-turn', expectedRevision: 2, action: 'Listen.', mode: 'action' });
    await f.engine.idle(f.id);
    expect(f.store.get(f.id).turns.at(-1)?.status).toBe('completed');
    expect(f.provider.calls.map(request => request.kind)).toEqual(['role', 'world', 'prose']);
    for (const request of f.provider.calls) {
      expect(JSON.stringify(request)).not.toContain(secret); expect(JSON.stringify(request)).not.toContain('hostServices');
    }
    expect(f.store.get(f.id).hostServices).toEqual({ 'test.counter': { private: secret } });
    expect(new SessionStore(f.root).get(f.id).hostServices).toEqual(f.store.get(f.id).hostServices);
  });

  it('rejects commands during a running turn before dispatch while unknown services stay 404', async () => {
    const apply = vi.fn(counter().apply), f = await fixture([{ ...counter(), apply }]);
    let release!: () => void, entered!: () => void;
    const block = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.provider.block = async () => { entered(); await block; };
    f.engine.submit(f.id, { requestId: 'service-busy', expectedRevision: 0, action: 'Listen.', mode: 'action' });
    try {
      await started;
      const before = await readFile(f.filename, 'utf8');
      const busy = await f.command({ expectedRevision: 0, value: secret });
      expect(busy.status).toBe(409); expect((await busy.json()).error.code).toBe('TURN_BUSY');
      const unknown = await f.command({}, 'removed.service');
      expect(unknown.status).toBe(404); expect((await unknown.json()).error.code).toBe('SESSION_SERVICE_UNKNOWN');
      expect((await fetch(`${f.url}/services/test.counter`)).status).toBe(200);
      expect(apply).not.toHaveBeenCalled(); expect(await readFile(f.filename, 'utf8')).toBe(before);
    } finally { release(); await f.engine.idle(f.id); }
    expect(f.store.get(f.id).turns.at(-1)?.status).toBe('completed');
  });
});

describe('trusted service world input hooks', () => {
  const selection = () => ({ serviceId: 'test.counter', referenceId: 'completed-1', parameters: { actor: { id: 'player' } } });
  const evidence = () => ({ schema: 'rp.world-input/0.1' as const, id: 'current-input', serviceId: 'test.counter', referenceId: 'completed-1',
    kind: 'local-result', title: 'Completed local result', payload: { rounds: [1, 2] } });
  it('freezes detached session and parameters, detaches the exact matching JSON response', async () => {
    const f = await fixture(), held = f.store.get(f.id), supplied = selection(), output = evidence();
    const before = clone(held);
    const worldInput = vi.fn((session: Readonly<StoredSession>, selected: any) => {
      expect(session).not.toBe(held); expect(Object.isFrozen(session.world.variables)).toBe(true);
      expect(selected).toEqual({ referenceId: supplied.referenceId, parameters: supplied.parameters });
      expect(Object.isFrozen(selected)).toBe(true); expect(Object.isFrozen(selected.parameters.actor)).toBe(true);
      expect(() => { selected.parameters.actor.id = 'changed'; }).toThrow();
      expect(() => { (session.world as any).location = 'changed'; }).toThrow();
      return output;
    });
    const registry = new SessionServiceRegistry([{ ...counter(), worldInput }]);
    const result = registry.worldInput(supplied, held);
    output.payload.rounds.push(3); expect(result.payload).toEqual({ rounds: [1, 2] });
    expect(supplied).toEqual(selection()); expect(held).toEqual(before); expect(worldInput).toHaveBeenCalledTimes(1);
  });
  it('keeps absent and removed hooks local to this capability and rejects async or malformed hooks', async () => {
    const f = await fixture(), base = counter(), noHook = new SessionServiceRegistry([base]);
    expect(() => noHook.worldInput(selection(), f.store.get(f.id))).toThrow(/does not supply/);
    expect(noHook.read(base.id, f.store.get(f.id))).toEqual({ revision: 0, held: null });
    expect(() => new SessionServiceRegistry([]).worldInput(selection(), f.store.get(f.id))).toThrow(/not installed/);
    for (const worldInput of [true, async () => evidence(), function* () { yield evidence(); }])
      expect(() => new SessionServiceRegistry([{ ...counter(), worldInput } as any])).toThrow(/synchronous/);
    const callable = vi.fn(() => evidence()), registry = new SessionServiceRegistry([{ ...counter(), worldInput: callable }]);
    for (const selected of [{ ...selection(), payload: {} }, { ...selection(), referenceId: '' }, { ...selection(), parameters: undefined }])
      expect(() => registry.worldInput(selected as any, f.store.get(f.id))).toThrow(/exact service/);
    expect(callable).not.toHaveBeenCalled(); expect(f.provider.calls).toEqual([]);
  });
  it('rejects forged references, unsupported evidence shapes, and asynchronous or non-JSON results', async () => {
    const f = await fixture();
    for (const output of [
      { ...evidence(), referenceId: 'different' }, { ...evidence(), serviceId: 'different' },
      { ...evidence(), kind: '' }, { ...evidence(), extra: true }, { ...evidence(), payload: undefined }, Promise.resolve(evidence()),
    ]) {
      const registry = new SessionServiceRegistry([{ ...counter(), worldInput: (() => output) as any }]);
      expect(() => registry.worldInput(selection(), f.store.get(f.id))).toThrow();
    }
  });
  it('keeps turn evidence and retry bindings private in author, role, list and public prompt projections', async () => {
    const f = await fixture(), privateText = 'WORLD_INPUT_PRIVATE_EVIDENCE';
    const held = clone(f.store.get(f.id));
    held.worldInputTurns = [{ turnId: 'private-turn', reference: selection(), evidence: { ...evidence(), payload: { privateText } },
      requestFingerprint: 'PRIVATE_RETRY_FINGERPRINT', committed: false }];
    f.store.save(held);
    for (const view of [project(held), ...held.roles.map(role => project(held, role.id)), f.store.list(), publicPromptView(held)]) {
      expect(JSON.stringify(view)).not.toMatch(/worldInputTurns|WORLD_INPUT_PRIVATE_EVIDENCE|PRIVATE_RETRY_FINGERPRINT/);
    }
    for (const endpoint of [f.base, f.url, ...held.roles.map(role => `${f.url}?perspective=${role.id}`)])
      expect(await (await fetch(endpoint)).text()).not.toMatch(/worldInputTurns|WORLD_INPUT_PRIVATE_EVIDENCE|PRIVATE_RETRY_FINGERPRINT/);
    expect(new SessionStore(f.root).get(f.id).worldInputTurns).toEqual(held.worldInputTurns);
  });
});
