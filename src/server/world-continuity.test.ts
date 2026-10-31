import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset, WorldEvent } from '../shared/types';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { SessionStore, clone } from './store';
import { publicFactEvent } from './world-facts-runtime';
import { updateRuntimeConfiguration } from './runtime-config';
import { proposeKnowledgeEdit } from './knowledge-runtime';
import { knowledgeBoundary } from './knowledge-context';
import { runtimeFingerprint } from './prompt-compiler';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
it('delivers canonical public history through publication off/rebind and ordinary off turns, with old full evidence and non-fact/private copies excluded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rp-world-continuity-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.roles.push({ ...clone(card.roles[0]), id: 'npc', name: 'Remote witness', phase: 'dormant', presence: 'absent',
    knowledge: [{ id: 'withdrawn-claim', text: 'WITHDRAWN_KNOWLEDGE_CANARY', audience: 'author', status: 'known' }] });
  card.modules = [{ id: 'old-source', title: 'Disabled source', content: 'DISABLED_SOURCE_PROMPT_CANARY', enabled: false, targets: ['world'], phase: 'coordinate', category: 'supplement', priority: 1 }];
  card.outputs = [{ id: 'publications', title: 'Information', type: 'object', instruction: 'Host-derived only.', enabled: true, required: false, priority: 1,
    audience: 'public', valueFrom: { kind: 'world-publications' }, display: { placement: 'hidden' } }];
  const store = new SessionStore(root), id = store.create(card, preset).id;
  const old = proposeKnowledgeEdit(store.get(id), { operation: 'retract', roleId: 'npc', id: 'withdrawn-claim' });
  old.turns.push({ id: 'legacy-turn', requestId: 'legacy-request', action: 'An earlier action.', mode: 'action', status: 'completed', phase: 'completed', startedAt: '' });
  const legacy: WorldEvent = { id: 'legacy-public-event', at: '', turnId: 'legacy-turn', kind: 'world-event', actor: 'world', audience: 'public', text: 'An earlier stage result was recorded.',
    data: { fact: { text: 'An earlier stage result was recorded.', sources: [{ kind: 'host-input', id: 'historical-host', evidence: {
      schema: 'rp.world-input/0.1', id: 'historical-host', serviceId: 'old-stage', referenceId: 'old-result', kind: 'result', title: 'Recorded result', payload: { marker: 'FULL_HOST_PAYLOAD_CANARY' },
    } }] } } };
  old.events.push(legacy,
    { id: 'private-world', at: '', turnId: 'legacy-turn', kind: 'world-event', actor: 'world', audience: 'author', text: 'PRIVATE_WORLD_EVENT_CANARY' },
    { id: 'summary', at: '', turnId: 'legacy-turn', kind: 'world-adjudication', actor: 'world', audience: 'author', text: 'RAW_WORLD_SUMMARY_CANARY' },
    { id: 'display', at: '', turnId: 'legacy-turn', kind: 'host-output', actor: 'host', audience: 'public', text: 'HOST_DISPLAY_CANARY' },
    { id: 'role-summary', at: '', turnId: 'legacy-turn', kind: 'role-result', actor: 'npc', audience: 'public', text: 'RAW_ROLE_REPORT_CANARY' });
  old.hostServices = { unused: { value: 'PRIVATE_SERVICE_CANARY' } }; store.save(old);
  const calls: AgentRequest[] = []; let worlds = 0;
  const provider: ModelProvider = { configured: () => true, async run(request): Promise<any> {
    calls.push(request);
    if (request.kind === 'world') return { summary: 'Current public audit only.', changes: [], acceptedBehaviorIds: [], facts: ++worlds === 1 ? [{
      text: 'A public notice has rain-smudged contact details.', sources: [{ kind: 'world-development' }], publication: { kind: 'notice', sourceLabel: 'Public noticeboard' },
    }] : [] };
    if (request.kind !== 'prose') throw new Error('Continuity must not add role dispatches');
    return { title: 'Notice', text: 'The public notice remains in place.', person: 'third', pov: 'limited' };
  } };
  const engine = new TurnEngine(store, provider); cleanups.push(() => engine.close()); let sequence = 0;
  const turn = async () => { engine.submit(id, { requestId: `continuity-${++sequence}`, expectedRevision: store.get(id).revision, mode: 'action', action: 'Continue with currently authorized material only.' }); await engine.idle(id); expect(store.get(id).turns.at(-1)?.status).toBe('completed'); };
  await turn(); const firstWorld = calls.find(call => call.kind === 'world')!;
  expect((firstWorld.input as any).continuity).toEqual([publicFactEvent(legacy)]);
  const notice = clone(store.get(id).events.find(event => (event.data as any)?.fact?.publication)!);
  expect(notice).toBeDefined();
  updateRuntimeConfiguration(store, id, { expectedRevision: store.get(id).revision, reason: 'Disable new publications without deleting history',
    cardOutputs: [{ ...card.outputs[0], enabled: false }] });
  await turn(); await turn();
  const deliveries = calls.filter(call => call.kind === 'world'), second = deliveries[1], third = deliveries[2];
  expect(second.sessionId).not.toBe(firstWorld.sessionId); expect(third.sessionId).toBe(second.sessionId);
  for (const request of [second, third]) {
    expect((request.input as any).continuity).toEqual([publicFactEvent(legacy), notice]);
    expect((request.resultSchema as any).properties.facts.items.properties).not.toHaveProperty('publication');
    expect((request.input as any).continuityPolicy).toContain('does not independently verify');
    expect((request.input as any).continuityPolicy).toContain('Disabling a producer retains');
    expect(JSON.stringify(request.input)).not.toMatch(/FULL_HOST_PAYLOAD_CANARY|WITHDRAWN_KNOWLEDGE_CANARY|PRIVATE_WORLD_EVENT_CANARY|RAW_WORLD_SUMMARY_CANARY|HOST_DISPLAY_CANARY|RAW_ROLE_REPORT_CANARY|PRIVATE_SERVICE_CANARY|DISABLED_SOURCE_PROMPT_CANARY/);
    expect(JSON.stringify(request.system)).not.toContain('DISABLED_SOURCE_PROMPT_CANARY');
  }
  expect(store.get(id).promptContexts!.world.fingerprint).toBe(runtimeFingerprint({ system: third.system, layout: third.promptLayout, refs: [], fields: store.get(id).fields,
    knowledgeBoundary: knowledgeBoundary(store.get(id), 'author'), stateRules: [], publicFactsContract: 'rp.world-facts/public-references-0.1', behaviorReferencesContract: 'rp.current-behavior-enum/0.1' }));
  expect(store.get(id).events.filter(event => event.kind === 'world-event' && event.audience === 'public')).toEqual([legacy, notice]);
  expect(store.get(id).events.find(event => event.id === legacy.id)).toEqual(legacy);
  expect(calls.map(call => call.kind)).toEqual(['world', 'prose', 'world', 'prose', 'world', 'prose']);
});
