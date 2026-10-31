import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createImportService } from '../importer';
import { createNativeTemplate } from '../shared/native';
import type { AgentKind, CharacterCard, Preset, PromptModule } from '../shared/types';
import { createApp, type ImportService } from './app';
import type { AgentRequest, ModelProvider } from './engine';
import { updateRuntimeConfiguration } from './runtime-config';
import { clone, event } from './store';

const roots: string[] = [], cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** A deterministic recorder used only by these tests; no production or external model fallback. */
class RecordingTestOnlyProvider implements ModelProvider {
  calls: AgentRequest[] = [];
  worldChanges: { roleId: string; key: string; value: number }[] = [];
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request);
    if (request.kind === 'role') return { summary: 'ARCHIVED_ROLE_SUMMARY', expression: 'A public reply.', proposals: [] };
    if (request.kind === 'world') return { summary: 'A public world consequence.', changes: this.worldChanges, events: ['Public scene continues.'] };
    if (request.kind === 'prose') return { title: 'Scene', text: 'ARCHIVED_PROSE_PASSAGE', person: 'third', pov: 'limited' };
    throw new Error('Creator models are outside this test');
  }
}
const moduleFor = (id: string, target: AgentKind, content = `${id}_CONTENT`): PromptModule => ({
  id, title: id, category: 'supplement', content, enabled: true, targets: [target],
  phase: target === 'role' ? 'decide' : target === 'world' ? 'coordinate' : 'compose', priority: 0,
});
function documents() {
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.id = 'runtime-integration-card'; preset.id = 'runtime-integration-preset';
  card.roles.push({ id: 'npc', name: 'NPC', persona: 'Independent NPC persona.', goals: [], peers: ['player'], phase: 'active', presence: 'present', state: {}, knowledge: [] });
  card.roles[0].peers = ['npc'];
  return { card, preset };
}
async function fixture(options: { card?: CharacterCard; preset?: Preset; importService?: ImportService } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rp-runtime-integration-')); roots.push(root);
  const defaults = documents(), card = options.card ?? defaults.card, preset = options.preset ?? defaults.preset;
  const provider = new RecordingTestOnlyProvider();
  const service = await createApp({ dataRoot: root, provider, importService: options.importService, catalog: async () => ({ cards: [card], presets: [preset] }) });
  cleanups.push(service.close);
  const id = service.store.create(card, preset).id;
  let request = 0;
  const turn = async () => {
    service.engine.submit(id, { requestId: `runtime-test-${++request}`, expectedRevision: service.store.get(id).revision, action: 'Ask about the scene.', mode: 'action' });
    await service.engine.idle(id);
  };
  return { ...service, id, provider, turn };
}
const callsOf = (provider: RecordingTestOnlyProvider, target: AgentKind) => provider.calls.filter(call => call.kind === target);
const dispatchedText = (request: AgentRequest) => request.system + '\n' + JSON.stringify(request.promptLayout);

describe('bound runtime compiler dispatch and APIs', () => {
  it('admits linked current persona only through its enabled module and injects it once after an atomic update', async () => {
    const { card, preset } = documents(), persona = 'LINKED_CURRENT_PERSONA_UNIQUE';
    card.roles[1].persona = persona; card.roles[1].personaSourcePointer = '/source/npc/persona';
    card.modules = [{ ...moduleFor('linked-persona', 'role', persona), sourcePointer: '/source/npc/persona', enabled: false }];
    const service = await fixture({ card, preset });
    await service.turn();
    expect(dispatchedText(callsOf(service.provider, 'role')[0])).not.toContain(persona);
    const modules = clone(service.store.get(service.id).card.modules); modules[0].enabled = true;
    updateRuntimeConfiguration(service.store, service.id, { expectedRevision: service.store.get(service.id).revision, reason: 'Enable the bound persona', cardModules: modules });
    await service.turn();
    expect(dispatchedText(callsOf(service.provider, 'role')[1]).split(persona)).toHaveLength(2);
    expect(service.store.get(service.id).turns.every(turn => turn.status === 'completed')).toBe(true);
  });

  it('uses edited imported snapshot text while excluding an imported module assigned to the wrong phase', async () => {
    const importRoot = await mkdtemp(join(tmpdir(), 'rp-runtime-integration-import-')); roots.push(importRoot);
    const imports = createImportService({ root: importRoot, metadataRoot: false });
    const source = { prompts: [
      { identifier: 'style', content: 'ORIGINAL_ARTIFACT_TEXT', enabled: true },
      { identifier: 'wrong-stage', content: 'WRONG_PHASE_IMPORTED_TEXT', enabled: true },
    ] };
    const imported = (await imports.importBytes(Buffer.from(JSON.stringify(source)), 'preset.json')).nativePreset!;
    imported.modules[0].content = 'EDITED_BOUND_IMPORTED_TEXT'; imported.modules[1].phase = 'decide';
    const service = await fixture({ preset: imported, importService: { ...imports, selectModules: async () => { throw new Error('Live import selection must never replace bound snapshots'); } } });
    await service.turn();
    const writer = callsOf(service.provider, 'prose')[0];
    expect(dispatchedText(writer)).toContain('EDITED_BOUND_IMPORTED_TEXT');
    expect(dispatchedText(writer)).not.toMatch(/ORIGINAL_ARTIFACT_TEXT|WRONG_PHASE_IMPORTED_TEXT/);
    expect(service.store.get(service.id).preset.modules[0].content).toBe('EDITED_BOUND_IMPORTED_TEXT');
    const preview = await service.engine.preview(service.id, { target: 'prose' });
    expect(preview.decisions.find(decision => decision.ref.moduleId === imported.modules[1].id)?.reasons.some(reason => reason.code === 'phase')).toBe(true);
  });

  it('evaluates prose conditions against the committed public state after world adjudication', async () => {
    const { card, preset } = documents();
    card.fields = [{ key: 'stage', label: 'Stage', type: 'number', editable: true, audience: 'public' }];
    card.world.variables.stage = 0;
    card.modules = [{ ...moduleFor('committed-scene', 'prose', 'COMMITTED_PUBLIC_STATE_RULE'), condition: { path: 'world.variables.stage', equals: 1 } }];
    const service = await fixture({ card, preset }); service.provider.worldChanges = [{ roleId: 'world', key: 'stage', value: 1 }];
    expect((await service.engine.preview(service.id, { target: 'prose' })).modules).toEqual([]);
    await service.turn();
    const writer = callsOf(service.provider, 'prose')[0];
    expect(dispatchedText(writer)).toContain('COMMITTED_PUBLIC_STATE_RULE');
    expect((writer.input as any).world.variables.stage).toBe(1); expect(service.store.get(service.id).revision).toBe(1);
  });

  it('keeps player-private event text out of prose keyword activation and actual prose material', async () => {
    const { card, preset } = documents(), secret = 'PLAYER_PRIVATE_TRIGGER_UNIQUE';
    card.modules = [{ ...moduleFor('private-trigger', 'prose', 'SHOULD_NOT_BE_ACTIVATED'), activation: { keys: [secret] } }];
    const service = await fixture({ card, preset });
    const current = clone(service.store.get(service.id));
    event(current, { kind: 'peer-mail', actor: 'npc', text: secret, audience: ['player'] }); service.store.save(current);
    await service.turn();
    const writer = callsOf(service.provider, 'prose')[0];
    expect(dispatchedText(writer)).not.toContain('SHOULD_NOT_BE_ACTIVATED');
    expect(JSON.stringify(writer.input)).not.toContain(secret);
    expect((await service.engine.preview(service.id, { target: 'prose' })).modules).toEqual([]);
  });

  it('reuses unchanged native sessions, then replaces affected sessions without copied summaries or previous prose after disabling modules', async () => {
    const { card, preset } = documents();
    card.modules = [moduleFor('role-rule', 'role', 'REMOVABLE_ROLE_RULE'), moduleFor('prose-rule', 'prose', 'REMOVABLE_PROSE_RULE')];
    const service = await fixture({ card, preset });
    await service.turn(); await service.turn();
    const roles = callsOf(service.provider, 'role'), writers = callsOf(service.provider, 'prose');
    expect(roles[1].sessionId).toBe(roles[0].sessionId); expect(writers[1].sessionId).toBe(writers[0].sessionId);
    expect((roles[1].input as any).context.rebuilt).toBe(false); expect((writers[1].input as any).previousProse).toBe('ARCHIVED_PROSE_PASSAGE');
    const modules = clone(service.store.get(service.id).card.modules).map(module => ({ ...module, enabled: false }));
    updateRuntimeConfiguration(service.store, service.id, { expectedRevision: service.store.get(service.id).revision, reason: 'Disable the two bound rules', cardModules: modules });
    await service.turn();
    const role = callsOf(service.provider, 'role')[2], writer = callsOf(service.provider, 'prose')[2];
    expect(role.sessionId).not.toBe(roles[1].sessionId); expect(writer.sessionId).not.toBe(writers[1].sessionId);
    expect((role.input as any).context.rebuilt).toBe(true); expect((writer.input as any).previousProse).toBe('');
    expect(dispatchedText(role)).not.toContain('REMOVABLE_ROLE_RULE'); expect(dispatchedText(writer)).not.toContain('REMOVABLE_PROSE_RULE');
    expect(JSON.stringify(role.input)).not.toMatch(/ARCHIVED_ROLE_SUMMARY|ARCHIVED_PROSE_PASSAGE/);
    expect(JSON.stringify(writer.input)).not.toMatch(/ARCHIVED_ROLE_SUMMARY|ARCHIVED_PROSE_PASSAGE/);
  });

  it('serves runtime reads, atomic edits and compiler preview through HTTP without dispatching a model', async () => {
    const service = await fixture();
    const server: Server = await new Promise(resolve => { const listening = service.app.listen(0, '127.0.0.1', () => resolve(listening)); });
    cleanups.unshift(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected a loopback server');
    const base = `http://127.0.0.1:${address.port}/api/sessions/${service.id}/runtime`;
    const read = await fetch(base); expect(read.status).toBe(200); expect((await read.json()).revision).toBe(0);
    const updated = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 0, reason: 'Add a local rule', cardModules: [moduleFor('preview-rule', 'role', 'PREVIEW_ONLY_RULE')] }) });
    expect(updated.status).toBe(200); expect((await updated.json()).revision).toBe(1);
    const preview = await fetch(base + '/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'role', roleId: 'npc', text: 'Preview action' }) });
    expect(preview.status).toBe(200);
    const plan = await preview.json(); expect(plan.valid).toBe(true); expect(plan.modules[0].content).toBe('PREVIEW_ONLY_RULE'); expect(plan.snapshotRevision).toBe(1);
    expect(service.provider.calls).toEqual([]); expect(service.store.get(service.id).turns).toEqual([]);
    expect(service.store.get(service.id).promptContexts).toBeUndefined();
  });

  it('blocks an unresolved required plan before each affected target model request', async () => {
    for (const target of ['role', 'world', 'prose'] as const) {
      const { card, preset } = documents();
      card.modules = [{ ...moduleFor('required-unresolved', target), required: true, condition: { path: 'world.variables.unknownCondition', equals: true } }];
      const service = await fixture({ card, preset });
      await service.turn();
      expect(callsOf(service.provider, target)).toEqual([]);
      expect(service.provider.calls.map(call => call.kind)).toEqual(target === 'role' ? [] : target === 'world' ? ['role'] : ['role', 'world']);
      const stored = service.store.get(service.id);
      expect(stored.turns[0].status).toBe('failed'); expect(stored.turns[0].error).toContain('unknownCondition');
      const preview = await service.engine.preview(service.id, { target, ...(target === 'role' ? { roleId: 'npc' } : {}) });
      expect(preview.valid).toBe(false); expect(preview.diagnostics.some(diagnostic => diagnostic.severity === 'error' && diagnostic.code === 'condition-unknown')).toBe(true);
    }
  });
});
