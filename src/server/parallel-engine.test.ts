import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Json, Preset, SubmitTurn } from '../shared/types';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { applyParallelScenes, parallelScenesService } from './parallel-scenes';
import { SessionServiceRegistry } from './session-services';
import { clone, project, SessionStore, type StoredSession } from './store';
import { compileResultValidator } from './result-schema.mjs';
import { updateRuntimeConfiguration } from './runtime-config';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const sceneRole = (request: AgentRequest) => request.kind === 'role' && (request.input as any)?.scope?.kind === 'parallel';
const sceneWorld = (request: AgentRequest) => request.kind === 'world' && (request.input as any)?.scope?.kind === 'parallel';
const sceneWriter = (request: AgentRequest) => request.kind === 'prose' && typeof (request.input as any)?.runId === 'string';
class Provider implements ModelProvider {
  calls: AgentRequest[] = [];
  failure?: 'actor' | 'scene-world' | 'main-world' | 'scene-writer';
  mainRoleHook?: (request: AgentRequest) => Promise<void>;
  mainChanges?: { roleId: string; key: string; value: Json }[];
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request);
    if (request.kind === 'role' && !sceneRole(request)) await this.mainRoleHook?.(request);
    if (this.failure === 'actor' && sceneRole(request) && (request.input as any).actor.roleId === 'actor'
      || this.failure === 'scene-world' && sceneWorld(request) || this.failure === 'main-world' && request.kind === 'world' && !sceneWorld(request)
      || this.failure === 'scene-writer' && sceneWriter(request)) throw new Error(`Controlled ${this.failure} failure`);
    let result: unknown;
    if (sceneRole(request)) result = { public: { summary: 'PRIVATE_PROVISIONAL_SUMMARY', speech: [`PRIVATE_APPROVED_SPEECH_${(request.input as any).actor.roleId}`], actions: [] }, proposals: [] };
    else if (request.kind === 'role') result = { public: { summary: '', speech: [], actions: [] }, proposals: [] };
    else if (sceneWorld(request)) {
      const candidates = (request.input as any).behaviorCandidates as { id: string; roleId: string }[];
      const actor = candidates.find(candidate => candidate.roleId === 'actor')!;
      result = { summary: 'PRIVATE_SCENE_WORLD_AUDIT', changes: [], acceptedBehaviorIds: candidates.map(candidate => candidate.id), facts: [
        { text: 'PRIVATE_ACTOR_OBSERVATION', sources: [{ kind: 'behavior', id: actor.id }], observedBy: ['actor'] },
        { text: 'PRIVATE_READER_ONLY_FACT', sources: [{ kind: 'world-development' }], observedBy: [] },
      ] };
    } else if (request.kind === 'world') result = { summary: 'Main public audit.', changes: this.mainChanges ?? [{ roleId: 'world', key: 'counter', value: 1 }], acceptedBehaviorIds: [],
      facts: [{ text: 'MAIN_PUBLIC_COMMITTED_FACT', sources: [{ kind: 'world-development' }] }] };
    else if (sceneWriter(request)) result = { title: 'Private scene', text: 'PRIVATE_SCENE_PROSE', person: 'third', pov: 'limited' };
    else if (request.kind === 'prose') result = { title: 'Main scene', text: 'Only the main public scene continues.', person: 'third', pov: 'limited' };
    else throw new Error('Creator calls are outside this fixture');
    expect(compileResultValidator(request.resultSchema)(result)).toEqual([]); return result;
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rp-parallel-engine-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.world.location = 'Main square'; card.world.time = 'Known afternoon'; card.world.variables = { counter: 0 };
  card.fields = [{ key: 'counter', label: 'Counter', type: 'number', audience: 'public', editable: true },
    { key: 'location', label: 'Own known location', type: 'string', audience: ['actor', 'partner'], editable: true }];
  card.roles.push(...['main', 'spectator', 'actor', 'partner'].map(roleId => ({ id: roleId, name: roleId, persona: `Existing ${roleId}.`, goals: [], peers: roleId === 'main' ? ['actor'] : roleId === 'actor' ? ['main'] : [], phase: 'active' as const, presence: 'present' as const,
    state: (roleId === 'actor' || roleId === 'partner' ? { location: 'Remote archive' } : {}) as Record<string, Json>, knowledge: [] })));
  card.initialization = { schema: 'rp.initialization/0.1', defaultOpeningId: 'opening', defaultPlayerProfileId: 'player-profile',
    openings: [{ id: 'opening', title: 'Declared cast', text: 'The existing cast has appeared.', cast: card.roles.map(role => ({ roleId: role.id, phase: 'active', presence: 'present' })) }],
    playerProfiles: [{ id: 'player-profile', title: 'Player', name: 'Player', persona: '' }] };
  card.modules = []; card.outputs = [];
  preset.modules = [{ id: 'parallel-source', title: 'Reviewed parallel presentation', category: 'supplement', content: 'Render only approved parallel material; host owns this artifact.', enabled: true,
    targets: ['prose'], phase: 'compose', priority: 1, sourcePointer: '/prompts/133/content' }];
  preset.outputs = [{ id: 'parallel', title: 'Author parallel scenes', type: 'object', enabled: true, required: true, priority: 0, audience: 'author',
    instruction: 'Host supplies committed parallel scenes only.', module: 'parallel-source', valueFrom: { kind: 'parallel-scenes' }, display: { placement: 'after-prose', renderer: 'parallel-scenes' } }];
  const store = new SessionStore(root), id = store.create(card, preset).id;
  for (const roleId of ['actor', 'partner']) store.lifecycle(id, { expectedRevision: store.get(id).revision, roleId, phase: 'active', presence: 'absent', reason: 'Existing actor explicitly leaves the main scene.' });
  applyParallelScenes(store, id, { requestId: 'grant', expectedRevision: store.get(id).revision, reason: 'Explicit scene grant.', operation: 'upsert',
    scene: { id: 'scene', title: 'Remote archive', enabled: true, participantRoleIds: ['actor', 'partner'], locationKey: 'location', goal: 'PRIVATE_SCENE_GOAL: inspect only existing local labels.' } });
  applyParallelScenes(store, id, { requestId: 'select', expectedRevision: store.get(id).revision, reason: 'Explicit selection.', operation: 'select', selectedSceneIds: ['scene'] });
  const provider = new Provider();
  const open = (held: SessionStore, model: Provider) => {
    const engine = new TurnEngine(held, model, undefined, { sessionServices: new SessionServiceRegistry([parallelScenesService]) }); cleanups.push(() => engine.close()); return engine;
  };
  const engine = open(store, provider); let sequence = 0;
  const turn = async (extra: Partial<SubmitTurn> = {}) => {
    const input: SubmitTurn = { requestId: `parallel-turn-${++sequence}`, expectedRevision: store.get(id).revision, mode: 'action', action: 'MAIN_PLAYER_ACTION: inspect only the main square.', ...extra };
    engine.submit(id, input); await engine.idle(id); return input;
  };
  return { root, store, id, provider, engine, open, turn };
}
const privateEvents = (session: StoredSession) => session.events.filter(event => ['parallel-behavior', 'parallel-world-event'].includes(event.kind));
const immutableRun = ({ render: _render, ...run }: NonNullable<StoredSession['parallelRuns']>[number]) => run;

describe('TurnEngine parallel scene isolation, commit and recovery', () => {
  it('keeps clean role/world native sessions persistent while isolating each new immutable run from the previous scene writer transcript', async () => {
    const f = await fixture(); await f.turn(); const first = f.provider.calls.slice(), count = first.length;
    await f.turn(); const second = f.provider.calls.slice(count), runs = f.store.get(f.id).parallelRuns!;
    expect(f.store.get(f.id).turns.at(-1)?.status).toBe('completed'); expect(runs).toHaveLength(2);
    expect(runs[1].id).not.toBe(runs[0].id); expect(runs[1].grantGeneration).toBe(runs[0].grantGeneration);
    expect(runs[1].attemptEpoch).toBe(runs[0].attemptEpoch);
    for (const roleId of ['actor', 'partner']) {
      const request = (calls: AgentRequest[]) => calls.find(call => sceneRole(call) && (call.input as any).actor.roleId === roleId)!;
      expect(request(second).sessionId).toBe(request(first).sessionId);
    }
    expect(second.find(sceneWorld)!.sessionId).toBe(first.find(sceneWorld)!.sessionId);
    for (const roleId of ['main', 'spectator']) {
      const request = (calls: AgentRequest[]) => calls.find(call => call.kind === 'role' && !sceneRole(call) && (call.input as any).delivery.to === roleId)!;
      expect(request(second).sessionId).toBe(request(first).sessionId);
    }
    expect(second.find(call => call.kind === 'world' && !sceneWorld(call))!.sessionId).toBe(first.find(call => call.kind === 'world' && !sceneWorld(call))!.sessionId);
    const writer1 = first.find(sceneWriter)!, writer2 = second.find(sceneWriter)!;
    expect(writer2.sessionId).not.toBe(writer1.sessionId);
    expect((writer1.input as any).runId).toBe(runs[0].id); expect((writer2.input as any).runId).toBe(runs[1].id);
    expect(writer2.input).not.toHaveProperty('previousProse');
    expect(JSON.stringify(writer2.input)).not.toContain('PRIVATE_SCENE_PROSE');
    // Stable rendering instructions/schema remain available for prefix caching;
    // this does not assert a provider cache hit or copy old assistant output.
    expect(writer2.system).toBe(writer1.system); expect(writer2.resultSchema).toEqual(writer1.resultSchema);
  });

  it('commits main and private approved material in one revision without sending private material to main agents or granting bystander knowledge', async () => {
    const f = await fixture(), before = clone(f.store.get(f.id)), changedRevisionSnapshots: StoredSession[] = [];
    const save = f.store.save.bind(f.store);
    f.store.save = session => { if (session.revision > before.revision) changedRevisionSnapshots.push(clone(session)); return save(session); };
    await f.turn(); const after = f.store.get(f.id), run = after.parallelRuns?.[0];
    expect(after.turns.at(-1)?.status).toBe('completed'); expect(run).toBeDefined();
    expect(after.revision).toBe(before.revision + 1); expect(after.world.variables.counter).toBe(1);
    expect(run!.worldRevision).toBe(after.revision); expect(run!.render.status).toBe('completed');
    expect(changedRevisionSnapshots[0].parallelRuns).toHaveLength(1);
    expect(changedRevisionSnapshots[0].events.some(event => event.kind === 'world-event' && event.text === 'MAIN_PUBLIC_COMMITTED_FACT')).toBe(true);
    expect(changedRevisionSnapshots[0].parallelAttempts?.[0].status).toBe('committed');
    expect(f.provider.calls.filter(sceneRole)).toHaveLength(2); expect(f.provider.calls.filter(sceneWorld)).toHaveLength(1); expect(f.provider.calls.filter(sceneWriter)).toHaveLength(1);
    const mainCalls = f.provider.calls.filter(request => !sceneRole(request) && !sceneWorld(request) && !sceneWriter(request));
    expect(mainCalls.map(call => call.kind).sort()).toEqual(['prose', 'role', 'role', 'world']);
    expect(JSON.stringify(mainCalls.map(({ system, input }) => ({ system, input })))).not.toMatch(/PRIVATE_SCENE_GOAL|PRIVATE_APPROVED_SPEECH|PRIVATE_PROVISIONAL_SUMMARY|PRIVATE_ACTOR_OBSERVATION|PRIVATE_READER_ONLY_FACT|PRIVATE_SCENE_WORLD_AUDIT|PRIVATE_SCENE_PROSE/);
    expect(privateEvents(after)).toHaveLength(4); expect(privateEvents(after).every(event => event.audience === 'author')).toBe(true);
    const knowledge = (roleId: string) => JSON.stringify(after.roles.find(role => role.id === roleId)!.knowledge);
    expect(knowledge('actor')).toContain('PRIVATE_APPROVED_SPEECH_actor'); expect(knowledge('actor')).toContain('PRIVATE_ACTOR_OBSERVATION');
    expect(knowledge('partner')).toContain('PRIVATE_APPROVED_SPEECH_partner'); expect(knowledge('partner')).not.toContain('PRIVATE_ACTOR_OBSERVATION');
    for (const roleId of ['player', 'main', 'spectator', 'actor', 'partner']) expect(knowledge(roleId)).not.toContain('PRIVATE_READER_ONLY_FACT');
    expect(knowledge('main')).not.toContain('PRIVATE_'); expect(knowledge('spectator')).not.toContain('PRIVATE_');
    expect(after.roles.map(({ knowledge: _knowledge, ...role }) => role)).toEqual(before.roles.map(({ knowledge: _knowledge, ...role }) => role));
    expect(after.prose).toHaveLength(before.prose.length + 1);
    const host = after.prose.at(-1)!.attachments?.find(output => output.provenance?.kind === 'committed-parallel');
    expect(host?.audience).toBe('author'); expect((host?.value as any).scenes[0].prose.text).toBe('PRIVATE_SCENE_PROSE');
    expect(JSON.stringify(project(after, 'main'))).not.toMatch(/PRIVATE_SCENE_|PRIVATE_ACTOR_OBSERVATION|PRIVATE_READER_ONLY_FACT|PRIVATE_APPROVED_SPEECH/);
    expect(project(after, 'author')).not.toHaveProperty('parallelRuns'); expect(project(after, 'author')).not.toHaveProperty('parallelAttempts');
  });

  it('keeps main prose successful when the scene writer fails, and explicitly recovers only that immutable run after restart', async () => {
    const f = await fixture(); f.provider.failure = 'scene-writer'; const originalRequest = await f.turn(), failed = clone(f.store.get(f.id));
    expect(failed.turns.at(-1)?.status).toBe('completed'); expect(failed.parallelRuns).toHaveLength(1); expect(failed.parallelRuns![0].render.status).toBe('failed');
    expect(failed.prose.at(-1)?.text).toBe('Only the main public scene continues.');
    const run = failed.parallelRuns![0], beforeCalls = f.provider.calls.length;
    expect(f.engine.submit(f.id, originalRequest)).toMatchObject({ duplicate: true }); expect(f.provider.calls).toHaveLength(beforeCalls);
    await f.engine.close();
    const store = new SessionStore(f.root), provider = new Provider(), engine = f.open(store, provider);
    const recovery: SubmitTurn = { requestId: 'explicit-parallel-recovery', expectedRevision: failed.revision, mode: 'author', action: 'Rerender this committed scene only.', parallelRecovery: { runId: run.id } };
    engine.submit(f.id, recovery); await engine.idle(f.id); const recovered = store.get(f.id);
    expect(recovered.turns.at(-1)?.status).toBe('completed'); expect(provider.calls).toHaveLength(1); expect(sceneWriter(provider.calls[0])).toBe(true);
    expect(recovered.revision).toBe(failed.revision); expect(recovered.prose).toEqual(failed.prose); expect(recovered.world).toEqual(failed.world); expect(recovered.roles).toEqual(failed.roles);
    expect(recovered.parallelAttempts).toEqual(failed.parallelAttempts); expect(immutableRun(recovered.parallelRuns![0])).toEqual(immutableRun(run));
    expect(recovered.parallelRuns![0].render.attempts.map(attempt => attempt.status)).toEqual(['failed', 'completed']);
    expect(privateEvents(recovered)).toEqual(privateEvents(failed));
    expect(engine.submit(f.id, recovery)).toMatchObject({ duplicate: true }); expect(provider.calls).toHaveLength(1);
    expect(() => engine.submit(f.id, { ...recovery, action: 'Different request body.' })).toThrow();
  });

  it('supplies the returning actor only its confirmed observations without restoring private scene history to main bystanders or writer', async () => {
    const f = await fixture(); await f.turn();
    const sceneActor = f.provider.calls.find(call => sceneRole(call) && (call.input as any).actor.roleId === 'actor')!;
    const count = f.provider.calls.length;
    applyParallelScenes(f.store, f.id, { requestId: 'stop-scene', expectedRevision: f.store.get(f.id).revision, reason: 'Explicitly stop the parallel selection before returning.', operation: 'select', selectedSceneIds: [] });
    f.store.lifecycle(f.id, { expectedRevision: f.store.get(f.id).revision, roleId: 'actor', phase: 'active', presence: 'present', reason: 'The existing actor explicitly returns to the main scene.' });
    await f.turn(); expect(f.store.get(f.id).turns.at(-1)?.status).toBe('completed');
    const calls = f.provider.calls.slice(count), actor = calls.find(call => call.kind === 'role' && (call.input as any).delivery.to === 'actor')!;
    expect(actor).toBeDefined(); expect(actor.sessionId).not.toBe(sceneActor.sessionId);
    expect(JSON.stringify((actor.input as any).knowledge)).toContain('PRIVATE_ACTOR_OBSERVATION');
    expect(JSON.stringify((actor.input as any).knowledge)).toContain('PRIVATE_APPROVED_SPEECH_actor');
    expect(JSON.stringify(actor.input)).not.toMatch(/PRIVATE_READER_ONLY_FACT|PRIVATE_SCENE_PROSE|PRIVATE_SCENE_WORLD_AUDIT|PRIVATE_PROVISIONAL_SUMMARY|PRIVATE_APPROVED_SPEECH_partner/);
    for (const request of calls.filter(call => call !== actor))
      expect(JSON.stringify(request.input)).not.toMatch(/PRIVATE_ACTOR_OBSERVATION|PRIVATE_APPROVED_SPEECH|PRIVATE_READER_ONLY_FACT|PRIVATE_SCENE_PROSE/);
    expect(calls.some(call => sceneRole(call) || sceneWorld(call) || sceneWriter(call))).toBe(false);
    expect(f.store.get(f.id).parallelRuns).toHaveLength(1);
  });

  it('rejects a main peer tool request to its declared peer in a selected private scene before any mailbox or knowledge mutation', async () => {
    const f = await fixture(); let attempts = 0;
    f.provider.mainRoleHook = async request => {
      if ((request.input as any).delivery.to !== 'main') return;
      const tool = request.tools.find(tool => tool.name === 'peer_send'); expect(tool).toBeDefined();
      expect(f.store.get(f.id).roles.find(role => role.id === 'main')!.peers).toContain('actor');
      const before = clone(f.store.get(f.id)); let rejected = false;
      try { await tool!.execute({ to: 'actor', key: 'cross-scene', kind: 'request', replyTo: null, body: 'CROSS_SCENE_PEER_CANARY' }); }
      catch { rejected = true; }
      ++attempts; expect(rejected).toBe(true);
      expect(f.store.get(f.id)).toEqual(before);
      expect(f.store.get(f.id).mailbox ?? []).toEqual(before.mailbox ?? []);
      expect(f.store.get(f.id).knowledgeRegistry).toEqual(before.knowledgeRegistry);
    };
    await f.turn(); expect(attempts).toBe(1); expect(f.store.get(f.id).turns.at(-1)?.status).toBe('completed');
    expect(JSON.stringify(f.store.get(f.id).mailbox ?? [])).not.toContain('CROSS_SCENE_PEER_CANARY');
    expect(JSON.stringify(f.store.get(f.id).knowledgeRegistry)).not.toContain('CROSS_SCENE_PEER_CANARY');
    expect(f.provider.calls.filter(call => call.kind === 'role' && !sceneRole(call)).map(call => (call.input as any).delivery.to).sort()).toEqual(['main', 'spectator']);
    expect(f.provider.calls.filter(call => sceneRole(call) && (call.input as any).actor.roleId === 'actor')).toHaveLength(1);
  });

  it('rejects a main-world write to a private actor location and rolls back main state plus all private material together', async () => {
    const f = await fixture(), before = clone(f.store.get(f.id));
    f.provider.mainChanges = [{ roleId: 'world', key: 'counter', value: 99 }, { roleId: 'actor', key: 'location', value: 'An unauthorized other place' }];
    await f.turn(); const after = f.store.get(f.id);
    expect(after.turns.at(-1)?.status).toBe('failed'); expect(after.revision).toBe(before.revision);
    expect(after.world).toEqual(before.world); expect(after.roles).toEqual(before.roles); expect(after.prose).toEqual(before.prose);
    expect(after.parallelRuns ?? []).toEqual([]); expect(privateEvents(after)).toEqual([]);
    expect(after.parallelAttempts).toHaveLength(1); expect(after.parallelAttempts![0].status).toBe('aborted');
    expect(after.events.filter(event => ['world-event', 'state-commit', 'state-transaction', 'world-adjudication'].includes(event.kind))).toEqual(
      before.events.filter(event => ['world-event', 'state-commit', 'state-transaction', 'world-adjudication'].includes(event.kind)));
    expect(f.provider.calls.filter(sceneWorld)).toHaveLength(1); expect(f.provider.calls.filter(sceneWriter)).toHaveLength(0);
  });

  it('dispatches no parallel models with either its contract or linked module disabled, retaining committed archives', async () => {
    const f = await fixture(); await f.turn(); const archive = clone(f.store.get(f.id).parallelRuns);
    for (const switchOff of ['contract', 'module']) {
      const preset = clone(f.store.get(f.id).preset);
      preset.outputs![0].enabled = switchOff !== 'contract'; preset.modules[0].enabled = switchOff !== 'module';
      updateRuntimeConfiguration(f.store, f.id, { expectedRevision: f.store.get(f.id).revision, reason: `Explicitly disable the parallel ${switchOff}.`, preset });
      const count = f.provider.calls.length; await f.turn(); const after = f.store.get(f.id), calls = f.provider.calls.slice(count);
      expect(after.turns.at(-1)?.status).toBe('completed');
      expect(calls.some(call => sceneRole(call) || sceneWorld(call) || sceneWriter(call))).toBe(false);
      expect(after.parallelRuns).toEqual(archive);
      expect(after.prose.at(-1)!.attachments?.some(output => output.provenance?.kind === 'committed-parallel') ?? false).toBe(false);
    }
  });

  it.each(['actor', 'scene-world', 'main-world'] as const)('aborts leases with no scene or main world commit on %s failure and starts a fresh explicit attempt epoch', async failure => {
    const f = await fixture(), before = clone(f.store.get(f.id)); f.provider.failure = failure;
    const request = await f.turn(), failed = clone(f.store.get(f.id));
    expect(failed.turns.at(-1)?.status).toBe('failed'); expect(failed.revision).toBe(before.revision); expect(failed.world).toEqual(before.world);
    expect(failed.parallelRuns ?? []).toEqual([]); expect(privateEvents(failed)).toEqual([]); expect(failed.prose).toEqual(before.prose);
    expect(failed.roles).toEqual(before.roles); expect(failed.parallelAttempts?.length).toBeGreaterThan(0);
    expect(failed.parallelAttempts!.every(attempt => attempt.status === 'aborted')).toBe(true);
    const count = f.provider.calls.length; expect(f.engine.submit(f.id, request)).toMatchObject({ duplicate: true, status: 'failed' }); expect(f.provider.calls).toHaveLength(count);
    const oldActor = f.provider.calls.find(sceneRole); f.provider.failure = undefined; await f.turn();
    const after = f.store.get(f.id); expect(after.turns.at(-1)?.status).toBe('completed');
    expect(after.parallelAttempts!.at(-1)!.epoch).toBeGreaterThan(failed.parallelAttempts!.at(-1)!.epoch);
    const nextActor = f.provider.calls.slice(count).find(sceneRole); expect(nextActor).toBeDefined();
    if (oldActor) expect(nextActor!.sessionId).not.toBe(oldActor.sessionId);
  });
});
