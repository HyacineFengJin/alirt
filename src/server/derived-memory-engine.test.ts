import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset } from '../shared/types';
import type { ProvenancedKnowledge } from '../shared/knowledge';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { DERIVED_MEMORY_MODULE_ID, derivedMemoryModule } from './derived-memory';
import { AgentModuleRegistry } from './agent-modules';
import { applyParallelScenes, parallelScenesService } from './parallel-scenes';
import { SessionServiceRegistry } from './session-services';
import { clone, project, SessionStore, type StoredSession } from './store';
import { updateRuntimeConfiguration } from './runtime-config';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const actorOf = (request: AgentRequest) => (request.input as any).actor?.roleId ?? (request.input as any).delivery?.to;
const privateScene = (request: AgentRequest) => (request.input as any).scope?.kind === 'parallel';
const aliases = (session: StoredSession) => session.roles.find(role => role.id === 'actor')!.knowledge.filter(entry => entry.id.startsWith('derived-memory:')) as ProvenancedKnowledge[];

async function fixture(mode: 'main' | 'parallel') {
  const root = await mkdtemp(join(tmpdir(), 'rp-derived-engine-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.fields = [{ key: 'location', label: 'Known local location', type: 'string', audience: ['actor'], editable: true }];
  card.roles.push({ id: 'actor', name: 'Actor', persona: '', goals: [], peers: [], phase: 'active', presence: 'present', state: { location: 'Local archive' }, knowledge: [] },
    { id: 'other', name: 'Other', persona: '', goals: [], peers: [], phase: 'active', presence: 'present', state: {}, knowledge: [] });
  card.initialization = { schema: 'rp.initialization/0.1', defaultOpeningId: 'opening', defaultPlayerProfileId: 'player',
    openings: [{ id: 'opening', title: 'Author-defined cast', text: 'The declared cast has appeared.', cast: card.roles.map(role => ({ roleId: role.id, phase: 'active', presence: 'present' })) }],
    playerProfiles: [{ id: 'player', title: 'Player', name: 'Player', persona: '' }] };
  card.modules = []; preset.modules = [];
  preset.outputs = [{ id: 'parallel', title: 'Private scenes', type: 'object', instruction: 'Render committed scene material only.', enabled: true, required: true, priority: 0, audience: 'author',
    valueFrom: { kind: 'parallel-scenes' }, display: { placement: 'after-prose', renderer: 'parallel-scenes' } }];
  const store = new SessionStore(root), id = store.create(card, preset).id;
  store.lifecycle(id, { expectedRevision: store.get(id).revision, roleId: 'actor', phase: 'active', presence: 'absent', reason: 'Explicit departure after opening appearance.' });
  applyParallelScenes(store, id, { requestId: 'grant', expectedRevision: store.get(id).revision, reason: 'Explicit observation scene.', operation: 'upsert',
    scene: { id: 'scene', title: 'Local archive', enabled: true, participantRoleIds: ['actor'], locationKey: 'location', goal: 'Only existing local material is available.' } });
  applyParallelScenes(store, id, { requestId: 'select', expectedRevision: store.get(id).revision, reason: 'Explicit selection.', operation: 'select', selectedSceneIds: ['scene'] });
  const modules = new AgentModuleRegistry([derivedMemoryModule]);
  updateRuntimeConfiguration(store, id, { expectedRevision: store.get(id).revision, reason: 'Explicitly enable private source-linked inference.',
    agentRuntime: { profile: 'full', modules: { [DERIVED_MEMORY_MODULE_ID]: true, 'rp.peer-mail': false } } }, modules);
  const calls: AgentRequest[] = [], prepared: { id: string; phase: string; source: string }[] = [];
  let phase: 'observe' | 'one' | 'two' | 'quiet' = 'observe', failWorld = false, failMainWriter = false;
  const provider: ModelProvider = { configured: () => true, async run(request): Promise<any> {
    calls.push(request);
    if (request.kind === 'role') {
      if (actorOf(request) === 'actor' && ['one', 'two'].includes(phase)) {
        const tool = request.tools.find(tool => tool.name === 'derive_memory'); expect(tool).toBeDefined();
        if (privateScene(request)) expect(request.tools.map(tool => tool.name)).toEqual(['derive_memory']);
        const references = (request.input as any).knowledgeReferences as { id: string; text: string; status: string }[];
        const reference = references.find(reference => reference.text === (phase === 'one' ? 'CURRENT_PRIVATE_BELIEF_P' : 'PRIVATE_ALIAS_ONE'));
        expect(reference).toBeDefined();
        const argument = { key: `alias-${phase}`, kind: phase === 'one' ? 'inference' : 'summary', text: phase === 'one' ? 'PRIVATE_ALIAS_ONE' : 'PRIVATE_ALIAS_TWO', sourceRefs: [reference!.id] };
        const result = await tool!.execute(argument); expect(result).toMatchObject({ prepared: true, committed: false, duplicate: false });
        expect(aliases(store.get(id)).some(entry => entry.id === result.knowledgeId)).toBe(false);
        expect(await tool!.execute(argument)).toMatchObject({ knowledgeId: result.knowledgeId, duplicate: true });
        let rejected = false; try { await tool!.execute({ ...argument, key: 'pending-is-not-a-reference', sourceRefs: [result.knowledgeId] }); } catch { rejected = true; }
        expect(rejected).toBe(true);
        prepared.push({ id: result.knowledgeId, phase, source: reference!.id });
      }
      return { public: { summary: '', speech: phase === 'observe' && actorOf(request) === 'actor' ? ['X said P.'] : [], actions: [] }, proposals: [] };
    }
    if (request.kind === 'world' && privateScene(request)) {
      const candidates = (request.input as any).behaviorCandidates;
      return { summary: 'Only an observation occurred.', acceptedBehaviorIds: candidates.map((candidate: any) => candidate.id), changes: [],
        facts: phase === 'observe' ? [{ text: 'X said P.', sources: [{ kind: 'behavior', id: candidates[0].id }], observedBy: ['actor'] }] : [] };
    }
    if (request.kind === 'world') {
      if (failWorld) throw new Error('Controlled main-world failure after memory preparation');
      return { summary: 'Main scene unchanged.', changes: [], acceptedBehaviorIds: [], facts: [] };
    }
    if (request.kind === 'prose') {
      if (failMainWriter && !(request.input as any).runId) throw new Error('Controlled writer failure after memory commit');
      return { title: 'Scene', text: 'Only approved material is rendered.', person: 'third', pov: 'limited' };
    }
    throw new Error('Unexpected creator request');
  } };
  const engine = new TurnEngine(store, provider, undefined, { modules, sessionServices: new SessionServiceRegistry([parallelScenesService]) }); cleanups.push(() => engine.close());
  let sequence = 0;
  const turn = async () => { const request = { requestId: `derived-engine-${++sequence}`, expectedRevision: store.get(id).revision, mode: 'action' as const, action: 'Continue without adding player choices.' };
    engine.submit(id, request); await engine.idle(id); return request; };
  await turn(); expect(store.get(id).turns.at(-1)?.status).toBe('completed');
  const observation = store.get(id).events.find(event => event.kind === 'parallel-world-event')!;
  const occurrence = store.get(id).roles.find(role => role.id === 'actor')!.knowledge.find(entry => (entry as ProvenancedKnowledge).provenance?.observation?.eventId === observation.id) as ProvenancedKnowledge;
  store.knowledge(id, { operation: 'upsert', roleId: 'actor', id: 'current-claim', text: 'CURRENT_PRIVATE_BELIEF_P', status: 'known', sourceRefs: [occurrence.provenance!.sourceId],
    expectedRevision: store.get(id).revision, reason: 'Author explicitly supplies a current belief separate from the recorded occurrence.' });
  if (mode === 'main') {
    applyParallelScenes(store, id, { requestId: 'stop-scene', expectedRevision: store.get(id).revision, reason: 'Explicitly stop independent scene deliveries.', operation: 'select', selectedSceneIds: [] });
    store.lifecycle(id, { expectedRevision: store.get(id).revision, roleId: 'actor', phase: 'active', presence: 'present', reason: 'Actor explicitly returns with its own approved observations.' });
  }
  return { store, id, engine, calls, prepared, turn, observation: clone(observation), occurrenceId: occurrence.id,
    phase: (value: typeof phase) => { phase = value; }, failWorld: (value: boolean) => { failWorld = value; }, failWriter: (value: boolean) => { failMainWriter = value; } };
}

it.each(['main', 'parallel'] as const)('commits actual %s actor tool drafts with world, links two uncertain aliases, and withdraws their claim dependency while preserving historical observation', async mode => {
  const f = await fixture(mode), before = clone(f.store.get(f.id)), commits: StoredSession[] = [], save = f.store.save.bind(f.store);
  f.store.save = value => { if (value.revision > before.revision) commits.push(clone(value)); return save(value); };
  f.phase('one'); const count = f.calls.length; await f.turn();
  expect(f.store.get(f.id).turns.at(-1)?.status).toBe('completed'); expect(aliases(f.store.get(f.id))).toHaveLength(1);
  expect(aliases(commits[0])).toHaveLength(1); expect(commits[0].events.some(event => event.kind === 'world-adjudication' && event.turnId === commits[0].turns.at(-1)!.id)).toBe(true);
  const first = aliases(f.store.get(f.id))[0]; expect(first).toMatchObject({ status: 'uncertain', audience: ['actor'], provenance: { kind: 'derived', sourceRefs: [f.prepared[0].source] } });
  expect(first.provenance).not.toHaveProperty('observation');
  for (const request of f.calls.slice(count).filter(request => request.kind !== 'role' || actorOf(request) !== 'actor')) expect(JSON.stringify(request.input)).not.toContain('PRIVATE_ALIAS_ONE');
  f.phase('two'); await f.turn(); const after = clone(f.store.get(f.id)), second = aliases(after).find(entry => entry.text === 'PRIVATE_ALIAS_TWO')!;
  expect(second.status).toBe('uncertain'); expect(second.provenance!.sourceRefs).toEqual([first.provenance!.sourceId]);
  expect(after.events.filter(event => event.kind === 'derived-memory-prepared')).toHaveLength(2); expect(after.events.filter(event => event.kind === 'derived-memory-committed')).toHaveLength(2);
  expect(JSON.stringify(project(after, 'other'))).not.toMatch(/CURRENT_PRIVATE_BELIEF_P|PRIVATE_ALIAS_ONE|PRIVATE_ALIAS_TWO/);
  f.store.knowledge(f.id, { operation: 'retract', roleId: 'actor', id: 'current-claim', expectedRevision: after.revision, reason: 'Withdraw this current claim, not the historical occurrence.' });
  const withdrawn = f.store.get(f.id), own = withdrawn.roles.find(role => role.id === 'actor')!.knowledge as ProvenancedKnowledge[];
  expect(aliases(withdrawn).map(entry => entry.lifecycle)).toEqual(['stale', 'stale']);
  expect(own.find(entry => entry.id === f.occurrenceId)).toMatchObject({ lifecycle: 'active', status: 'known', text: '场外已观察事件：X said P.' });
  expect(withdrawn.events.find(event => event.id === f.observation.id)).toEqual(f.observation);
  f.phase('quiet'); const previous = f.calls.length; await f.turn();
  const actor = f.calls.slice(previous).find(request => request.kind === 'role' && actorOf(request) === 'actor')!;
  expect(JSON.stringify(actor.input)).not.toMatch(/CURRENT_PRIVATE_BELIEF_P|PRIVATE_ALIAS_ONE|PRIVATE_ALIAS_TWO/);
  expect(JSON.stringify(actor.input)).toContain('场外已观察事件：X said P.');
});

it.each(['main', 'parallel'] as const)('does not activate a %s draft when world fails, quarantines that failed native attempt, and does not replay an exact failed request', async mode => {
  const f = await fixture(mode); f.phase('one'); f.failWorld(true); const before = clone(f.store.get(f.id)), firstCall = f.calls.length;
  const request = await f.turn(), failed = clone(f.store.get(f.id));
  expect(failed.turns.at(-1)?.status).toBe('failed'); expect(failed.revision).toBe(before.revision); expect(failed.world).toEqual(before.world); expect(failed.roles).toEqual(before.roles);
  expect(aliases(failed)).toEqual([]); expect(failed.events.filter(event => event.kind === 'derived-memory-prepared')).toHaveLength(1);
  expect(failed.events.filter(event => event.kind === 'derived-memory-aborted')).toHaveLength(1); expect(failed.events.filter(event => event.kind === 'derived-memory-committed')).toEqual([]);
  const oldActor = f.calls.slice(firstCall).find(request => request.kind === 'role' && actorOf(request) === 'actor')!, count = f.calls.length;
  expect(f.engine.submit(f.id, request)).toMatchObject({ duplicate: true, status: 'failed' }); expect(f.calls).toHaveLength(count);
  f.failWorld(false); await f.turn(); const after = f.store.get(f.id), newActor = f.calls.slice(count).find(request => request.kind === 'role' && actorOf(request) === 'actor')!;
  expect(after.turns.at(-1)?.status).toBe('completed'); expect(newActor.sessionId).not.toBe(oldActor.sessionId);
  expect(aliases(after)).toHaveLength(1); expect(aliases(after)[0].id).not.toBe(f.prepared[0].id);
  expect((newActor.input as any).knowledgeReferences.some((reference: any) => reference.text === 'PRIVATE_ALIAS_ONE')).toBe(false);
});

it('retains an already world-committed private memory through writer failure and a prose-only author recovery', async () => {
  const f = await fixture('main'); f.phase('one'); f.failWriter(true); await f.turn(); const failed = clone(f.store.get(f.id));
  expect(failed.turns.at(-1)).toMatchObject({ status: 'failed', phase: 'compose-failed' }); expect(aliases(failed)).toHaveLength(1);
  expect(failed.events.filter(event => event.kind === 'derived-memory-aborted')).toEqual([]);
  f.phase('quiet'); f.failWriter(false); const count = f.calls.length;
  f.engine.submit(f.id, { requestId: 'memory-prose-recovery', expectedRevision: failed.revision, mode: 'author', action: 'Rewrite only the committed public scene.' }); await f.engine.idle(f.id);
  expect(f.calls.slice(count).map(request => request.kind)).toEqual(['prose']); expect(f.store.get(f.id).revision).toBe(failed.revision);
  expect(aliases(f.store.get(f.id))).toEqual(aliases(failed));
});
