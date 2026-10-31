import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate } from '../shared/native';
import type { AuxiliaryOutput, CharacterCard, Preset, WorldEvent } from '../shared/types';
import { AgentModuleRegistry, type AgentModule, type AgentModuleContext } from './agent-modules';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { clone, project, SessionStore } from './store';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

it('keeps archived model artifacts in the UI but out of role conditions and tools while retaining canonical facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rp-model-artifacts-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.roles.push({ id: 'npc', name: 'Keeper', persona: 'A keeper.', goals: [], peers: ['player'], phase: 'active', presence: 'present', state: {}, knowledge: [] });
  card.roles[0].peers = ['npc'];
  const attachments: AuxiliaryOutput[] = [
    { key: 'preset:summary', title: 'Summary', type: 'text', value: 'PUBLIC_SUMMARY_CANARY', audience: 'public', placement: 'after-prose' },
    { key: 'preset:parallel-events', title: 'Parallel events', type: 'text', value: 'PUBLIC_PARALLEL_CANARY', audience: 'public', placement: 'after-prose' },
    { key: 'preset:media', title: 'Media', type: 'text', value: '<p>PUBLIC_MEDIA_CANARY</p>', audience: 'public', placement: 'after-prose', display: { placement: 'after-prose', renderer: 'sandbox-html' } },
    { key: 'preset:commentary', title: 'Author commentary', type: 'text', value: 'AUTHOR_OUTPUT_CANARY', audience: 'author', placement: 'side-panel' },
    { key: 'card:scene', title: 'Host scene', type: 'text', value: 'HOST_STATE_ARTIFACT_CANARY', audience: 'public', placement: 'before-prose', provenance: { kind: 'state', selector: { kind: 'world-location' }, known: true, worldRevision: 0 } },
  ];
  // No live output contracts are needed for historical attachments to remain in
  // the reading UI. They must not reactivate role instructions after shutdown.
  card.outputs = []; preset.outputs = [];
  card.modules = attachments.map((output, index) => ({ id: `artifact-trigger-${index}`, title: output.title, category: 'supplement', content: `ARTIFACT_TRIGGER_${index}`,
    enabled: true, targets: ['role'], phase: 'decide', priority: index, condition: { path: `prose.0.attachments.${index}.value`, equals: output.value } }));
  card.modules.push({ id: 'canonical-trigger', title: 'Canonical continuity', category: 'supplement', content: 'CANONICAL_FACT_TRIGGER', enabled: true,
    targets: ['role'], phase: 'decide', priority: 10, condition: { path: 'events.0.text', equals: 'CANONICAL_APPROVED_PUBLIC_FACT' } });
  const store = new SessionStore(root), id = store.create(card, preset).id;
  const archived = clone(store.get(id));
  archived.prose = [{ id: 'archived-prose', turnId: 'archived-turn', title: 'Earlier passage', text: 'PUBLIC_BODY_CONTINUITY', worldRevision: 0, attachments: clone(attachments) }];
  const canonical: WorldEvent = { id: 'approved-public-fact', at: '', turnId: 'archived-turn', kind: 'world-event', actor: 'world', audience: 'public', text: 'CANONICAL_APPROVED_PUBLIC_FACT',
    data: { fact: { text: 'CANONICAL_APPROVED_PUBLIC_FACT', sources: [{ kind: 'world-development' }] } } };
  archived.events.unshift(canonical);
  archived.events.push({ id: 'host-display', at: '', kind: 'host-output', actor: 'host', audience: 'public', text: 'HOST_DISPLAY_CANARY' });
  archived.agentRuntime = { profile: 'compact', modules: { 'test.reader': true } };
  store.save(archived);
  const contexts: AgentModuleContext[] = [], toolResults: unknown[] = [], calls: AgentRequest[] = [];
  const reader: AgentModule = {
    meta: { id: 'test.reader', title: 'Reader', version: '1', apiVersion: 'rp.agent-module/0.1', requires: ['rp.role-agents'] },
    roleTools: context => {
      contexts.push(context);
      return [{ name: 'read_scene', description: 'Read permitted scene.', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: () => context.view }];
    },
  };
  const provider: ModelProvider = { configured: () => true, async run(request): Promise<any> {
    calls.push(request);
    if (request.kind === 'role') {
      toolResults.push(await request.tools.find(tool => tool.name === 'read_scene')!.execute({}));
      return { public: { summary: '', speech: [], actions: [] }, proposals: [] };
    }
    if (request.kind === 'world') return { summary: 'No new public development.', changes: [], acceptedBehaviorIds: [], facts: [] };
    if (request.kind === 'prose') return { title: 'Continuation', text: 'The scene remains quiet.', person: 'third', pov: 'limited' };
    throw new Error('Unexpected creator request');
  } };
  const engine = new TurnEngine(store, provider, undefined, { modules: new AgentModuleRegistry([reader]) });
  cleanups.push(() => engine.close());
  const preview = await engine.preview(id, { target: 'role', roleId: 'npc' });
  expect(preview.valid).toBe(true);
  expect(preview.modules.map(module => module.ref.moduleId)).toContain('canonical-trigger');
  for (let index = 0; index < attachments.length; ++index) expect(preview.modules.some(module => module.ref.moduleId === `artifact-trigger-${index}`)).toBe(false);
  engine.submit(id, { requestId: 'artifact-boundary', expectedRevision: store.get(id).revision, mode: 'action', action: 'Listen.' });
  await engine.idle(id);
  expect(store.get(id).turns.at(-1)?.status).toBe('completed');
  expect(calls.map(call => call.kind)).toEqual(['role', 'world', 'prose']);
  expect(contexts).toHaveLength(1); expect(toolResults).toHaveLength(1);
  const role = calls[0];
  expect(role.system).toContain('CANONICAL_FACT_TRIGGER');
  expect(role.system).not.toContain('ARTIFACT_TRIGGER_');
  expect((role.input as any).continuity).toContainEqual(canonical);
  for (const view of [contexts[0].view, toolResults[0]]) {
    expect((view as any).prose[0]).not.toHaveProperty('attachments');
    expect((view as any).prose[0].text).toBe('PUBLIC_BODY_CONTINUITY');
    expect((view as any).events).toContainEqual(canonical);
  }
  expect(JSON.stringify([role.input, contexts[0].view, toolResults[0]])).not.toMatch(/PUBLIC_SUMMARY_CANARY|PUBLIC_PARALLEL_CANARY|PUBLIC_MEDIA_CANARY|AUTHOR_OUTPUT_CANARY|HOST_STATE_ARTIFACT_CANARY|HOST_DISPLAY_CANARY/);
  expect(Object.isFrozen(contexts[0].view.prose[0])).toBe(true);
  // Neither author nor role reading projections lose their permitted archive.
  expect(store.get(id).prose[0]).toEqual(archived.prose[0]);
  expect(project(store.get(id), 'author').prose[0].attachments).toEqual(attachments);
  expect(project(store.get(id), 'npc').prose[0].attachments).toEqual(attachments.filter(output => output.audience === 'public'));
});
