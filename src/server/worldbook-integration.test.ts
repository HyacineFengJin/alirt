import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate } from '../shared/native';
import type { PromptPlan } from '../shared/prompt-runtime';
import type { AgentKind, Audience, CharacterCard, Condition, Preset, PromptModule } from '../shared/types';
import { createApp } from './app';
import type { AgentRequest, ModelProvider } from './engine';
import { readRuntimeConfiguration, updateRuntimeConfiguration } from './runtime-config';
import { project, SessionStore } from './store';

const roots: string[] = [], cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** Local deterministic results exercise real dispatch without any external model. */
class RecordingProvider implements ModelProvider {
  calls: AgentRequest[] = [];
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request);
    if (request.kind === 'role') return { summary: 'The visitor listens.', expression: 'Good morning.', proposals: [] };
    if (request.kind === 'world') return { summary: 'The quiet scene continues.', changes: [], events: ['The room remains quiet.'] };
    if (request.kind === 'prose') return { title: 'Morning', text: 'Sunlight falls across the table.', person: 'third', pov: 'limited' };
    throw new Error('Creator models are outside this test');
  }
}

type Binding = {
  id: string; moduleId: string;
  purpose: 'reference' | 'entity-profile' | 'scenario-plan' | 'state-rule' | 'initialization' | 'output-contract' | 'ui-data';
  when?: Condition; audience?: Audience; contentHash?: string;
  source?: { importId: string; sourceHash: string; pointer: string; entryId?: number };
};
type TestWorldbook = { schema: 'rp.worldbook/0.1'; bindings: Binding[] };
const worldbook = (...bindings: Binding[]): TestWorldbook => ({ schema: 'rp.worldbook/0.1', bindings });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const moduleFor = (id: string, target: AgentKind, content = `${id}_BODY`): PromptModule => ({
  id, title: id, category: 'supplement', content, enabled: true, targets: [target],
  phase: target === 'role' ? 'decide' : target === 'world' ? 'coordinate' : 'compose', priority: 0,
});
const chapterIs = (chapter: string): Condition => ({ path: 'world.variables.chapter', equals: chapter });
function documents() {
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.id = 'worldbook-card'; preset.id = 'worldbook-preset';
  card.fields = [
    { key: 'chapter', label: 'Author chapter', type: 'string', audience: 'author', writableBy: 'author', editable: true },
    { key: 'ready', label: 'Scene ready', type: 'boolean', audience: 'public', editable: true },
  ];
  card.world.variables = { chapter: '', ready: false };
  card.roles.push({ id: 'npc', name: 'Visitor', persona: 'A patient visitor.', goals: [], peers: ['player'], phase: 'active', presence: 'present', state: {}, knowledge: [] });
  card.roles[0].peers = ['npc'];
  return { card, preset };
}
async function fixture(card: CharacterCard, preset: Preset) {
  const root = await mkdtemp(join(tmpdir(), 'rp-worldbook-integration-')); roots.push(root);
  const provider = new RecordingProvider();
  const service = await createApp({ dataRoot: root, provider, catalog: async () => ({ cards: [card], presets: [preset] }) });
  cleanups.push(service.close);
  const id = service.store.create(card, preset).id;
  let request = 0;
  const turn = async (action = 'CHAPTER_TRIGGER') => {
    service.engine.submit(id, { requestId: `worldbook-test-${++request}`, expectedRevision: service.store.get(id).revision, action, mode: 'action' });
    await service.engine.idle(id);
    expect(service.store.get(id).turns.at(-1)?.status).toBe('completed');
  };
  const chapter = (value: string) => service.store.stateTransaction(id, {
    expectedRevision: service.store.get(id).revision, reason: `Select chapter ${value || 'none'}`,
    changes: [{ roleId: 'world', key: 'chapter', value }],
  });
  return { ...service, root, id, provider, turn, chapter };
}
const callsOf = (provider: RecordingProvider, kind: AgentKind) => provider.calls.filter(call => call.kind === kind);
const dispatchedText = (request: AgentRequest) => request.system + '\n' + JSON.stringify(request.promptLayout);
const moduleIds = (plan: PromptPlan) => plan.modules.map(module => module.ref.moduleId);

function scenarioDocuments() {
  const { card, preset } = documents();
  card.modules = ['one', 'two'].map(name => ({
    ...moduleFor(`chapter-${name}`, 'world', `AUTHOR_PLAN_${name.toUpperCase()}`), audience: 'author',
    activation: { keys: ['CHAPTER_TRIGGER'] }, lifetime: { stickyTurns: 5 },
  }));
  const bindings = card.modules.map((module, index): Binding => ({
    id: `PRIVATE_BINDING_${index + 1}`, moduleId: module.id, purpose: 'scenario-plan', when: chapterIs(index ? 'two' : 'one'),
    audience: 'author', contentHash: digest(module.content),
    source: { importId: 'PRIVATE_IMPORT_ID', sourceHash: 'a'.repeat(64), pointer: `/entries/${index}/content`, entryId: index },
  }));
  return { card: Object.assign(card, { worldbook: worldbook(...bindings) }), preset };
}

describe('worldbook contracts in bound engine sessions', () => {
  it('uses author chapter transactions in preview and live dispatch without keyword or sticky escape, and rebinds changed contexts', async () => {
    const { card, preset } = scenarioDocuments(), originalModules = structuredClone(card.modules);
    const service = await fixture(card, preset);
    const preview = () => service.engine.preview(service.id, { target: 'world', text: 'CHAPTER_TRIGGER' });
    expect(moduleIds(await preview())).toEqual([]);
    await service.turn();
    expect(dispatchedText(callsOf(service.provider, 'world')[0])).not.toMatch(/AUTHOR_PLAN_/);

    service.chapter('one');
    expect(moduleIds(await preview())).toEqual(['chapter-one']);
    const beforePreview = structuredClone(service.store.get(service.id).promptActivations);
    await preview();
    expect(service.store.get(service.id).promptActivations).toEqual(beforePreview);
    await service.turn();
    const first = callsOf(service.provider, 'world')[1];
    expect(dispatchedText(first)).toContain('AUTHOR_PLAN_ONE');
    expect(dispatchedText(first)).not.toContain('AUTHOR_PLAN_TWO');
    await service.turn('Continue quietly.');
    const recalled = callsOf(service.provider, 'world')[2];
    expect(dispatchedText(recalled)).toContain('AUTHOR_PLAN_ONE');
    expect(recalled.sessionId).toBe(first.sessionId);

    service.chapter('two');
    expect(moduleIds(await service.engine.preview(service.id, { target: 'world', text: 'Continue quietly.' }))).toEqual([]);
    await service.turn('Continue quietly.');
    const changed = callsOf(service.provider, 'world')[3];
    expect(dispatchedText(changed)).not.toMatch(/AUTHOR_PLAN_/);
    expect(changed.sessionId).not.toBe(first.sessionId);
    expect(moduleIds(await preview())).toEqual(['chapter-two']);
    await service.turn();
    const second = callsOf(service.provider, 'world')[4];
    expect(dispatchedText(second)).toContain('AUTHOR_PLAN_TWO');
    expect(dispatchedText(second)).not.toContain('AUTHOR_PLAN_ONE');
    expect(second.sessionId).not.toBe(changed.sessionId);

    service.chapter('');
    expect(moduleIds(await preview())).toEqual([]);
    await service.turn();
    expect(dispatchedText(callsOf(service.provider, 'world')[5])).not.toMatch(/AUTHOR_PLAN_/);
    expect(service.store.get(service.id).card.modules).toEqual(originalModules);
    expect(project(service.store.get(service.id), 'player').world.variables).not.toHaveProperty('chapter');
  });

  it('only narrows original conditions, audiences, targets and dependencies', async () => {
    const { card, preset } = documents();
    card.modules = [
      { ...moduleFor('conditioned', 'world'), condition: { path: 'world.variables.ready', equals: true } },
      { ...moduleFor('private-original', 'world'), audience: ['npc'] },
      moduleFor('role-only', 'role'),
      { ...moduleFor('dependency', 'world'), enabled: false },
      { ...moduleFor('dependent', 'world'), dependsOn: ['dependency'] },
      moduleFor('binding-private', 'prose'),
    ];
    Object.assign(card, { worldbook: worldbook(
      { id: 'condition', moduleId: 'conditioned', purpose: 'reference', when: chapterIs('one') },
      { id: 'no-audience-widening', moduleId: 'private-original', purpose: 'reference', audience: 'public' },
      { id: 'no-target-widening', moduleId: 'role-only', purpose: 'entity-profile' },
      { id: 'no-dependency-widening', moduleId: 'dependent', purpose: 'reference' },
      { id: 'narrow-public', moduleId: 'binding-private', purpose: 'reference', audience: 'author' },
    ) });
    const service = await fixture(card, preset);
    service.chapter('one');
    expect(moduleIds(await service.engine.preview(service.id, { target: 'world' }))).toEqual([]);
    expect(moduleIds(await service.engine.preview(service.id, { target: 'prose' }))).toEqual([]);
    await service.turn();
    expect(dispatchedText(callsOf(service.provider, 'world')[0])).not.toMatch(/conditioned_BODY|private-original_BODY|role-only_BODY|dependent_BODY/);
    expect(dispatchedText(callsOf(service.provider, 'prose')[0])).not.toContain('binding-private_BODY');
    service.store.stateTransaction(service.id, { expectedRevision: service.store.get(service.id).revision, reason: 'Scene is ready', changes: [{ roleId: 'world', key: 'ready', value: true }] });
    expect(moduleIds(await service.engine.preview(service.id, { target: 'world' }))).toEqual(['conditioned']);
    service.chapter('two');
    expect(moduleIds(await service.engine.preview(service.id, { target: 'world' }))).toEqual([]);
  });

  it('keeps UI data and unadapted executable protocols out of model prompts with diagnostics', async () => {
    const { card, preset } = documents();
    const purposes = ['ui-data', 'state-rule', 'initialization', 'output-contract'] as const;
    card.modules = purposes.map(purpose => moduleFor(purpose, 'world', `UNADAPTED_${purpose}`));
    Object.assign(card, { worldbook: worldbook(...purposes.map(purpose => ({ id: `binding-${purpose}`, moduleId: purpose, purpose }))) });
    const service = await fixture(card, preset);
    const plan = await service.engine.preview(service.id, { target: 'world' });
    expect(moduleIds(plan)).toEqual([]);
    for (const purpose of purposes) {
      const decision = plan.decisions.find(item => item.ref.moduleId === purpose)!;
      expect(decision.status).not.toBe('included');
      expect(decision.reasons.some(reason => reason.code.includes('worldbook'))).toBe(true);
    }
    expect(plan.diagnostics.length).toBeGreaterThan(0);
    await service.turn();
    for (const call of service.provider.calls) expect(dispatchedText(call)).not.toContain('UNADAPTED_');
  });

  it('blocks stale content hashes before dispatch while retaining the edited module body', async () => {
    const { card, preset } = scenarioDocuments();
    card.modules[0].content = 'EDITED_AUTHOR_BODY_WITH_STALE_BINDING_HASH';
    const service = await fixture(card, preset);
    service.chapter('one');
    const plan = await service.engine.preview(service.id, { target: 'world', text: 'CHAPTER_TRIGGER' });
    expect(plan.valid).toBe(false);
    expect(moduleIds(plan)).toEqual([]);
    expect(plan.diagnostics.some(diagnostic => diagnostic.severity === 'error' && diagnostic.code.includes('worldbook'))).toBe(true);
    service.engine.submit(service.id, { requestId: 'stale-hash', expectedRevision: service.store.get(service.id).revision, action: 'CHAPTER_TRIGGER', mode: 'action' });
    await service.engine.idle(service.id);
    expect(callsOf(service.provider, 'world')).toEqual([]);
    expect(service.store.get(service.id).turns.at(-1)?.status).toBe('failed');
    expect(service.store.get(service.id).card.modules[0].content).toBe('EDITED_AUTHOR_BODY_WITH_STALE_BINDING_HASH');
  });

  it('does not disclose bindings, source provenance, prompt traces or author plans in player and role projections', async () => {
    const { card, preset } = scenarioDocuments();
    const service = await fixture(card, preset);
    service.chapter('one'); await service.turn();
    for (const perspective of ['player', 'npc']) {
      const visible = JSON.stringify(project(service.store.get(service.id), perspective));
      expect(visible).not.toMatch(/PRIVATE_BINDING_|PRIVATE_IMPORT_ID|rp\.worldbook|AUTHOR_PLAN_|prompt-plan|promptActivations|sourceHash/);
    }
    for (const call of service.provider.calls) {
      expect(JSON.stringify(call.input)).not.toMatch(/PRIVATE_BINDING_|PRIVATE_IMPORT_ID|rp\.worldbook|sourceHash/);
      expect(dispatchedText(call)).not.toMatch(/PRIVATE_BINDING_|PRIVATE_IMPORT_ID|rp\.worldbook|sourceHash/);
      if (call.kind !== 'world') expect(dispatchedText(call)).not.toMatch(/AUTHOR_PLAN_/);
    }
    expect(service.store.get(service.id).card.modules[0].content).toBe('AUTHOR_PLAN_ONE');
  });

  it('atomically configures card and preset bindings, rejects invalid contracts and persists removal through restart', async () => {
    const { card, preset } = documents();
    card.modules = [moduleFor('card-reference', 'world')]; preset.modules = [moduleFor('preset-reference', 'prose')];
    const service = await fixture(card, preset);
    const cardWorldbook = worldbook({ id: 'card-binding', moduleId: 'card-reference', purpose: 'reference' });
    const presetWorldbook = worldbook({ id: 'preset-binding', moduleId: 'preset-reference', purpose: 'reference' });
    const replacementPreset = Object.assign(structuredClone(preset), { worldbook: presetWorldbook });
    updateRuntimeConfiguration(service.store, service.id, { expectedRevision: 0, reason: 'Bind both worldbooks', cardWorldbook, preset: replacementPreset });
    const configured = readRuntimeConfiguration(service.store, service.id);
    expect(configured.card).toHaveProperty('worldbook', cardWorldbook);
    expect(configured.preset).toHaveProperty('worldbook', presetWorldbook);
    expect(readRuntimeConfiguration(new SessionStore(service.root), service.id)).toEqual(configured);
    const filename = join(service.root, `session-${service.id}.json`), saved = await readFile(filename, 'utf8');
    const before = structuredClone(service.store.get(service.id));
    const invalid = [
      worldbook({ id: 'missing', moduleId: 'missing-module', purpose: 'reference' }),
      worldbook({ id: 'first', moduleId: 'card-reference', purpose: 'reference' }, { id: 'second', moduleId: 'card-reference', purpose: 'reference' }),
      worldbook({ id: 'unguarded', moduleId: 'card-reference', purpose: 'scenario-plan' }),
      worldbook({ id: 'hash', moduleId: 'card-reference', purpose: 'reference', contentHash: 'invalid-sha256' }),
      worldbook({ id: 'stale-hash', moduleId: 'card-reference', purpose: 'reference', contentHash: digest('A different module body') }),
    ];
    for (const invalidWorldbook of invalid) {
      expect(() => updateRuntimeConfiguration(service.store, service.id, { expectedRevision: before.revision, reason: 'Must not commit', cardWorldbook: invalidWorldbook, roles: [{ id: 'npc', goals: ['MUST_NOT_COMMIT'] }] })).toThrow();
      expect(service.store.get(service.id)).toEqual(before);
      expect(await readFile(filename, 'utf8')).toBe(saved);
    }
    const invalidPreset = Object.assign(structuredClone(replacementPreset), { worldbook: worldbook({ id: 'bad-preset', moduleId: 'missing', purpose: 'reference' }) });
    expect(() => updateRuntimeConfiguration(service.store, service.id, { expectedRevision: before.revision, reason: 'Invalid preset must not delete card binding', cardWorldbook: null, preset: invalidPreset })).toThrow();
    expect(service.store.get(service.id)).toEqual(before);
    expect(await readFile(filename, 'utf8')).toBe(saved);

    updateRuntimeConfiguration(service.store, service.id, { expectedRevision: before.revision, reason: 'Remove the card binding contract', cardWorldbook: null });
    const reloaded = readRuntimeConfiguration(new SessionStore(service.root), service.id);
    expect(reloaded.card).not.toHaveProperty('worldbook');
    expect(reloaded.card.modules).toEqual(card.modules);
    expect(reloaded.preset).toHaveProperty('worldbook', presetWorldbook);
    expect(moduleIds(await service.engine.preview(service.id, { target: 'prose' }))).toEqual(['preset-reference']);
    await service.turn();
    expect(dispatchedText(callsOf(service.provider, 'prose')[0])).toContain('preset-reference_BODY');
  });

  it('reads disabled UI data over HTTP without consuming activations, injecting prompts or persisting invalid runtime edits', async () => {
    const { card, preset } = documents();
    const content = '  <div>Quiet harbor map: the lighthouse is north.</div>\n';
    card.modules = [{ ...moduleFor('harbor-map', 'world', content), enabled: false,
      activation: { keys: ['MAP_TRIGGER'] }, lifetime: { once: true, stickyTurns: 3 } }];
    Object.assign(card, { worldbook: worldbook({ id: 'map-data', moduleId: 'harbor-map', purpose: 'ui-data', contentHash: digest(content) }) });
    const service = await fixture(card, preset), listener = service.app.listen(0, '127.0.0.1');
    await new Promise<void>(done => listener.once('listening', done));
    cleanups.push(() => new Promise<void>((done, reject) => listener.close(error => error ? reject(error) : done())));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Expected an HTTP listening address');
    const base = `http://127.0.0.1:${address.port}/api/sessions/${service.id}`;
    const api = async (path: string, body?: unknown) => {
      const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const before = structuredClone(service.store.get(service.id));
    const filename = join(service.root, `session-${service.id}.json`), saved = await readFile(filename, 'utf8');
    for (let read = 0; read < 2; read++) {
      const data = await api('/runtime/worldbook/data');
      expect(data.status).toBe(200);
      expect(data.body).toMatchObject({ schema: 'rp.worldbook-data/0.1', valid: true, items: [{
        source: 'card', documentId: card.id, bindingId: 'map-data', moduleId: 'harbor-map', content, promptEnabled: false,
      }] });
      expect(data.body.items).toHaveLength(1);
      const preview = await api('/runtime/preview', { target: 'world', text: 'MAP_TRIGGER' });
      expect(preview.status).toBe(200);
      expect(preview.body.valid).toBe(true);
      expect(moduleIds(preview.body)).toEqual([]);
      expect(JSON.stringify(preview.body)).not.toContain(content);
      expect(service.store.get(service.id)).toEqual(before);
      expect(await readFile(filename, 'utf8')).toBe(saved);
    }
    const invalidWorldbooks = [
      worldbook({ id: 'missing', moduleId: 'unavailable-map', purpose: 'ui-data' }),
      worldbook({ id: 'stale-map', moduleId: 'harbor-map', purpose: 'ui-data', contentHash: digest('Different map body') }),
    ];
    for (const cardWorldbook of invalidWorldbooks) {
      const result = await api('/runtime', { expectedRevision: before.revision, reason: 'Must reject atomically', cardWorldbook,
        roles: [{ id: 'npc', goals: ['MUST_NOT_COMMIT'] }] });
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe('RUNTIME_CONFIG_INVALID');
      expect(service.store.get(service.id)).toEqual(before);
      expect(await readFile(filename, 'utf8')).toBe(saved);
      expect(new SessionStore(service.root).get(service.id)).toEqual(before);
    }
    expect(service.provider.calls).toEqual([]);
  });
});
