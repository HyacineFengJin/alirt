import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset, WorldEvent } from '../shared/types';
import type { WorldInputEvidence } from '../shared/world-input';
import type { AgentModule } from './agent-modules';
import { AgentModuleRegistry } from './agent-modules';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { knowledgeBoundary } from './knowledge-context';
import { publicWorldFact } from './world-facts-runtime';
import { runtimeFingerprint } from './prompt-compiler';
import { clone, SessionStore } from './store';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('abandons an exact pre-gate role transcript while retaining raw author evidence and filtering new role inputs and tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rp-role-evidence-boundary-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.roles.push({ id: 'npc', name: 'Neutral witness', persona: 'A witness.', goals: [], peers: [], phase: 'active', presence: 'present', state: {}, knowledge: [] });
  const toolViews: unknown[] = [], toolResults: unknown[] = [], calls: AgentRequest[] = [];
  const tool = { name: 'read_scene', description: 'Read the permitted scene.', parameters: { type: 'object', properties: {}, additionalProperties: false } };
  const module: AgentModule = { meta: { id: 'test.scene', title: 'Scene reader', version: '1.0.0', apiVersion: 'rp.agent-module/0.1', requires: ['rp.role-agents'] },
    roleTools: context => { toolViews.push(context.view); return [{ ...tool, execute: () => clone(context.view) }]; } };
  const provider: ModelProvider = { configured: () => true, async run(request): Promise<any> {
    calls.push(request);
    if (request.kind === 'role') {
      toolResults.push(await request.tools.find(candidate => candidate.name === tool.name)!.execute({}));
      return { public: { summary: 'The witness is silent.', speech: [], actions: [] }, proposals: [] };
    }
    if (request.kind === 'world') return { summary: 'No new consequences.', changes: [], facts: [], acceptedBehaviorIds: [] };
    return { title: 'Quiet scene', text: 'The studio is quiet.', person: 'third', pov: 'limited' };
  } };
  const store = new SessionStore(root), id = store.create(card, preset).id;
  const configured = clone(store.get(id)); configured.agentRuntime = { profile: 'full', modules: { 'test.scene': true } }; store.save(configured);
  const engine = new TurnEngine(store, provider, undefined, { modules: new AgentModuleRegistry([module]) }); cleanups.push(() => engine.close());
  const turn = async (requestId: string) => { engine.submit(id, { requestId, expectedRevision: store.get(id).revision, action: 'Observe the studio.', mode: 'action' }); await engine.idle(id); };
  await turn('warmup');
  const first = calls.find(request => request.kind === 'role')!, previous = clone(store.get(id));
  const legacyDefinition = { system: first.system, layout: first.promptLayout, refs: [],
    disclosure: { fields: previous.fields, knowledgeBoundary: knowledgeBoundary(previous, 'npc') },
    agentTools: [tool], agentModules: [{ id: module.meta.id, version: module.meta.version }] };
  const legacyFingerprint = runtimeFingerprint(legacyDefinition);
  expect(previous.promptContexts!['role:npc'].fingerprint).toBe(runtimeFingerprint({ ...legacyDefinition, publicFactsContract: 'rp.world-facts/public-references-0.1' }));
  expect(legacyFingerprint).not.toBe(previous.promptContexts!['role:npc'].fingerprint);
  const canary = 'PRIVATE_ROUND_SKILL_CANARY_47381';
  const evidence: WorldInputEvidence = { schema: 'rp.world-input/0.1', id: 'old-result', serviceId: 'local-stage', referenceId: 'battle-old',
    kind: 'stage-result', title: 'Completed stage', payload: { roundLog: [{ skill: canary }] } };
  const fact = { text: 'The terminal stage result was recorded.', sources: [{ kind: 'host-input' as const, id: evidence.id, evidence }] };
  const oldEvent: WorldEvent = { id: 'historical-world-fact', at: '', turnId: 'historical-turn', kind: 'world-event', actor: 'world', audience: 'public', text: fact.text, data: { fact: fact as any } };
  previous.events.push(oldEvent);
  previous.worldInputTurns = [{ turnId: 'historical-turn', reference: { serviceId: evidence.serviceId, referenceId: evidence.referenceId, parameters: { private: canary } },
    evidence, requestFingerprint: 'old-private-fingerprint', committed: true }];
  previous.hostServices = { private: { roundLog: [canary] } };
  const oldBinding = previous.promptContexts!['role:npc']; oldBinding.fingerprint = legacyFingerprint;
  store.save(previous);
  const archivedTranscript = join(root, 'archived-native-role-transcript.json');
  await writeFile(archivedTranscript, JSON.stringify({ sessionId: oldBinding.sessionId, historicalInput: { continuity: [oldEvent] } }));
  const archivedBytes = await readFile(archivedTranscript, 'utf8');
  const callOffset = calls.length, toolOffset = toolViews.length;
  await turn('post-gate');
  expect(store.get(id).turns.at(-1)?.status).toBe('completed');
  const role = calls.slice(callOffset).find(request => request.kind === 'role')!, updated = store.get(id).promptContexts!['role:npc'];
  expect(role.sessionId).not.toBe(oldBinding.sessionId); expect(updated.generation).toBe(oldBinding.generation + 1);
  expect((role.input as any).context).toMatchObject({ rebuilt: true, generation: updated.generation });
  expect((role.input as any).continuity).toContainEqual({ ...oldEvent, data: { fact: publicWorldFact(fact) } });
  for (const value of [role.input, ...toolViews.slice(toolOffset), ...toolResults.slice(toolOffset)])
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE_ROUND_SKILL_CANARY_47381|"payload"|worldInputTurns|hostServices|old-private-fingerprint/);
  expect(store.get(id).events.find(event => event.id === oldEvent.id)).toEqual(oldEvent);
  expect(store.get(id).worldInputTurns![0].evidence).toEqual(evidence);
  expect(await readFile(archivedTranscript, 'utf8')).toBe(archivedBytes);
  expect(archivedBytes).toContain(canary);
});
