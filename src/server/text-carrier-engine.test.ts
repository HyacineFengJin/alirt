import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset, SubmitTurn } from '../shared/types';
import { TEXT_CARRIER_VIEW_MODULE_ID } from '../shared/text-carriers';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { SessionStore, project } from './store';
import { AgentModuleRegistry } from './agent-modules';
import { applyTextCarrierCommand, readTextCarrierState } from './text-carriers';
import { compileResultValidator } from './result-schema.mjs';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const BODY = 'PRIVATE_CARRIER_LITERAL_CANARY: a printed assertion, not verified truth.';
async function fixture(options: { registered?: boolean; createCarrier?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rp-carrier-engine-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.opening = ''; card.modules = []; preset.modules = []; card.world = { location: 'Hall', time: 'After class', variables: {} };
  for (const roleId of ['a', 'b']) card.roles.push({ id: roleId, name: roleId, persona: '', goals: [], peers: [], phase: 'active', presence: 'present', state: {}, knowledge: [] });
  preset.outputs = [{ id: 'carrier', title: 'Actually viewed text', type: 'object', instruction: 'Host-only immutable carrier receipts.',
    enabled: true, required: true, priority: 1, audience: 'public', valueFrom: { kind: 'viewed-carriers' }, display: { placement: 'after-prose', renderer: 'viewed-carriers' } }];
  const store = new SessionStore(root), id = store.create(card, preset).id, configured = structuredClone(store.get(id));
  configured.agentRuntime = { profile: 'full', ...(options.registered === false ? {} : { modules: { [TEXT_CARRIER_VIEW_MODULE_ID]: true } }) }; store.save(configured);
  const created = options.createCarrier === false ? undefined : applyTextCarrierCommand(store, id, { requestId: 'author-create', expectedRevision: store.get(id).revision,
    reason: 'Author explicitly registers a physical notice.', operation: 'create', content: { medium: 'paper', title: 'Notice', text: BODY, location: 'Hall', available: true } });
  const requests: AgentRequest[] = [], pending: unknown[] = [];
  let stage = true, blocked = false, failWorld = false, failProse = false, onWorld: ((request: AgentRequest) => Promise<void>) | undefined;
  const provider: ModelProvider = { configured: () => true, async run(request): Promise<any> {
    requests.push(request); const input = request.input as any; let result: unknown;
    if (request.kind === 'role') {
      if (stage && input.delivery.to === 'a') {
        const tool = request.tools?.find(tool => tool.name === 'propose_carrier_view');
        if (tool) {
          const target = input.viewableCarriers[0], args = { carrierId: target.carrierId, version: target.version };
          expect(compileResultValidator(tool.parameters)(args)).toEqual([]);
          const before = store.get(id), revision = before.revision, knowledge = structuredClone(before.roles);
          const reply = await tool.execute(args); pending.push(reply);
          expect(store.get(id).revision).toBe(revision); expect(store.get(id).roles).toEqual(knowledge);
          expect(readTextCarrierState(store.get(id)).views).toEqual([]); expect(JSON.stringify(reply)).not.toContain(BODY);
        }
      }
      result = { public: { summary: '', speech: [], actions: [] }, proposals: [] };
    } else if (request.kind === 'world') {
      await onWorld?.(request); if (failWorld) throw new Error('Offline world failure');
      result = { summary: 'World adjudicated only the current attempts.', changes: [], facts: [], acceptedBehaviorIds: input.behaviorCandidates.map((candidate: any) => candidate.id),
        ...(input.carrierViewIntents ? { carrierViews: input.carrierViewIntents.map((intent: any) => ({ intentId: intent.id, outcome: blocked ? 'blocked' : 'viewed' })) } : {}) };
    } else if (request.kind === 'prose') {
      if (failProse) throw new Error('Offline writer failure');
      result = { title: 'Ordinary prose', text: 'The hall remains quiet.', person: 'third', pov: 'limited' };
    } else throw new Error('No creator calls in this fixture');
    expect(compileResultValidator(request.resultSchema)(result)).toEqual([]); return result;
  } };
  const engine = new TurnEngine(store, provider, undefined, options.registered === false ? { modules: new AgentModuleRegistry() } : undefined);
  cleanup.push(() => engine.close()); let sequence = 0;
  const run = async (extra: Partial<SubmitTurn> = {}) => {
    const input: SubmitTurn = { requestId: `ordinary-${++sequence}`, expectedRevision: store.get(id).revision, mode: 'action', action: 'Remain in the hall.', ...extra };
    const accepted = engine.submit(id, input); await engine.idle(id); return { input, accepted, session: store.get(id) };
  };
  return { store, id, root, engine, requests, pending, created, run, file: join(root, `session-${id}.json`),
    set: (values: { stage?: boolean; blocked?: boolean; failWorld?: boolean; failProse?: boolean; onWorld?: typeof onWorld }) => {
      if (values.stage !== undefined) stage = values.stage; if (values.blocked !== undefined) blocked = values.blocked;
      if (values.failWorld !== undefined) failWorld = values.failWorld; if (values.failProse !== undefined) failProse = values.failProse;
      if (values.onWorld !== undefined) onWorld = values.onWorld;
    } };
}

it('runs the real NPC tool→world approval→owner occurrence→host output path with no body in world or writer', async () => {
  const f = await fixture(), before = f.store.get(f.id).revision, first = await f.run();
  expect(first.session.turns.at(-1)?.status).toBe('completed'); expect(first.session.revision).toBe(before + 1); expect(f.pending).toHaveLength(1);
  const views = readTextCarrierState(first.session).views; expect(views).toHaveLength(1); expect(views[0].readerRoleId).toBe('a');
  expect(views[0].carrier.text).toBe(BODY);
  const artifact = first.session.prose.at(-1)!.attachments!.find(output => output.provenance?.kind === 'committed-carrier-views')!;
  expect((artifact.value as any).views).toEqual(views);
  expect(JSON.stringify(project(first.session, 'b'))).not.toContain(BODY);
  expect(JSON.stringify(project(first.session, first.session.playerRoleId))).not.toContain(BODY);
  expect(JSON.stringify(project(first.session, 'a'))).toContain(BODY); expect((project(first.session, 'author') as any).textCarriers).toBeUndefined();
  for (const request of f.requests) expect(JSON.stringify({ input: request.input, system: request.system, schema: request.resultSchema })).not.toContain(BODY);
  f.set({ stage: false }); const count = f.requests.length; const second = await f.run();
  expect(second.session.turns.at(-1)?.status).toBe('completed'); expect(readTextCarrierState(second.session).views).toHaveLength(1);
  const next = f.requests.slice(count), owner = next.find(request => request.kind === 'role' && (request.input as any).delivery.to === 'a')!;
  expect(JSON.stringify(owner.input)).toContain(BODY);
  for (const request of next.filter(request => request !== owner)) expect(JSON.stringify(request.input)).not.toContain(BODY);
});

it('commits an explicit player selection once and rejects changed reuse without model calls or state changes', async () => {
  const f = await fixture({ registered: false });
  const selection = { carrierId: f.created!.carrierId, version: 1 };
  const first = await f.run({ viewCarrier: selection, action: 'Explicitly view this registered notice.' });
  expect(first.session.turns.at(-1)?.status).toBe('completed');
  expect(readTextCarrierState(first.session).views).toMatchObject([{ readerRoleId: first.session.playerRoleId, origin: { kind: 'player' } }]);
  const count = f.requests.length, bytes = await readFile(f.file, 'utf8');
  expect(f.engine.submit(f.id, first.input)).toMatchObject({ turnId: first.accepted.turnId, duplicate: true }); await f.engine.idle(f.id);
  expect(f.requests).toHaveLength(count); expect(await readFile(f.file, 'utf8')).toBe(bytes);
  expect(() => f.engine.submit(f.id, { ...first.input, action: 'Changed same request.' })).toThrow('different carrier');
  expect(() => f.engine.submit(f.id, { ...first.input, requestId: 'wrong-mode', expectedRevision: first.session.revision, mode: 'author' })).toThrow('player action');
  expect(await readFile(f.file, 'utf8')).toBe(bytes);
});

it('keeps blocked, no-intent, and uninstalled NPC capabilities from producing viewed text', async () => {
  const blocked = await fixture(); blocked.set({ blocked: true }); const result = await blocked.run();
  expect(result.session.turns.at(-1)?.status).toBe('completed'); expect(readTextCarrierState(result.session).views).toEqual([]);
  expect(JSON.stringify(result.session.prose)).not.toContain(BODY);
  const unregistered = await fixture({ registered: false }), plain = await unregistered.run();
  expect(plain.session.turns.at(-1)?.status).toBe('completed'); expect(unregistered.pending).toEqual([]); expect(readTextCarrierState(plain.session).views).toEqual([]);
  expect(unregistered.requests.filter(request => request.kind === 'role').every(request => !request.tools?.some(tool => tool.name === 'propose_carrier_view'))).toBe(true);
  const world = unregistered.requests.find(request => request.kind === 'world')!;
  expect((world.input as any).carrierViewIntents).toBeUndefined(); expect((world.resultSchema as any).properties.carrierViews).toBeUndefined();
  const empty = await fixture({ createCarrier: false }), legacy = await empty.run();
  expect(legacy.session.turns.at(-1)?.status).toBe('completed'); expect(legacy.session.textCarriers).toBeUndefined();
  expect((empty.requests.find(request => request.kind === 'world')!.resultSchema as any).properties.carrierViews).toBeUndefined();
});

it('leaves no active receipt or knowledge when world adjudication fails or the turn is cancelled', async () => {
  const failed = await fixture(); failed.set({ failWorld: true }); const revision = failed.store.get(failed.id).revision;
  const first = await failed.run(); expect(first.session.turns.at(-1)?.status).toBe('failed'); expect(first.session.revision).toBe(revision);
  expect(readTextCarrierState(first.session).views).toEqual([]); expect(first.session.roles.every(role => !JSON.stringify(role.knowledge).includes(BODY))).toBe(true);
  expect(first.session.events.some(event => event.kind === 'text-carrier-view-aborted')).toBe(true);
  const cancelled = await fixture(); let ready!: () => void; const waiting = new Promise<void>(resolve => { ready = resolve; });
  cancelled.set({ onWorld: async request => { ready(); await new Promise<void>((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('Offline cancellation')), { once: true })); } });
  const submission = cancelled.run(); await waiting; cancelled.engine.cancel(cancelled.id); const result = await submission;
  expect(['failed', 'interrupted']).toContain(result.session.turns.at(-1)?.status); expect(readTextCarrierState(result.session).views).toEqual([]);
  expect(result.session.roles.every(role => !JSON.stringify(role.knowledge).includes(BODY))).toBe(true);
});

it('preserves receipts and host output after writer failure, and author recovery uses the original version without rereading', async () => {
  const f = await fixture(); f.set({ failProse: true }); const failed = await f.run();
  expect(failed.session.turns.at(-1)?.status).toBe('failed'); const views = structuredClone(readTextCarrierState(failed.session).views), revision = failed.session.revision;
  expect(views).toHaveLength(1); expect(failed.session.events.some(event => event.kind === 'host-output' && JSON.stringify(event.data).includes(BODY))).toBe(true);
  applyTextCarrierCommand(f.store, f.id, { operation: 'update', requestId: 'revise-after-read', expectedRevision: revision, reason: 'Explicit new notice version.',
    carrierId: f.created!.carrierId, expectedVersion: 1, content: { medium: 'screen', title: 'Changed title', text: 'NEW_UNREAD_CARRIER_CANARY', location: 'Hall', available: true } });
  f.set({ failProse: false, stage: false }); const count = f.requests.length, afterAuthor = f.store.get(f.id).revision;
  const recovered = await f.run({ mode: 'author', action: 'Render only the previously committed material.' });
  expect(recovered.session.turns.at(-1)?.status).toBe('completed'); expect(recovered.session.revision).toBe(afterAuthor);
  expect(f.requests.slice(count).map(request => request.kind)).toEqual(['prose']);
  expect(readTextCarrierState(recovered.session).views).toEqual(views);
  const attachment = recovered.session.prose.at(-1)!.attachments!.find(output => output.provenance?.kind === 'committed-carrier-views')!;
  expect((attachment.value as any).views).toEqual(views); expect(JSON.stringify(attachment.value)).not.toContain('NEW_UNREAD_CARRIER_CANARY');
  expect(JSON.stringify(f.requests.at(-1)!.input)).not.toMatch(/PRIVATE_CARRIER_LITERAL_CANARY|NEW_UNREAD_CARRIER_CANARY/);
});
