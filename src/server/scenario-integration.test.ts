import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createNativeTemplate } from '../shared/native';
import type { AgentKind, CharacterCard, Condition, Preset, ScenarioCommand } from '../shared/types';
import { createApp } from './app';
import type { AgentRequest, ModelProvider } from './engine';
import { readScenario, ScenarioError } from './scenario-runtime';
import { project, SessionStore, type StoredSession } from './store';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

/** Real dispatch and local HTTP only; no external model or compatibility script. */
class RecordingProvider implements ModelProvider {
  calls: AgentRequest[] = [];
  onRole?: () => Promise<void>;
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request);
    if (request.kind === 'role') {
      await this.onRole?.();
      return { summary: 'The keeper listens.', expression: 'I am listening.', proposals: [] };
    }
    if (request.kind === 'world') return { summary: 'The scene continues.', changes: [], events: ['The room remains quiet.'] };
    if (request.kind === 'prose') return { title: 'Scene', text: 'A quiet public scene.', person: 'third', pov: 'limited' };
    throw new Error('Creator models are outside this test');
  }
}

function documents(completion?: Condition) {
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.id = 'scenario-test-card'; preset.id = 'scenario-test-preset';
  card.fields = [
    { key: 'ready', label: 'Ready', type: 'boolean', editable: true, audience: 'public' },
    { key: 'score', label: 'Score', type: 'number', editable: true, audience: 'public' },
  ];
  card.world.variables = { ready: false, score: 2 };
  card.roles[0].state = { score: 3 }; card.roles[0].peers = ['npc'];
  card.roles.push({ id: 'npc', name: 'Keeper', persona: 'A patient keeper.', goals: [], peers: ['player'], phase: 'active', presence: 'present',
    state: { score: 4 }, knowledge: [{ id: 'known-place', text: 'A familiar public room.', audience: 'public', status: 'known' }] });
  card.modules = ['one', 'two', 'side'].map(chapter => ({
    id: `plan-${chapter}`, title: `Plan ${chapter}`, category: 'supplement', content: `PRIVATE_PLAN_${chapter.toUpperCase()}`,
    enabled: true, targets: ['world'], phase: 'coordinate', priority: 0, audience: 'author',
    activation: { keys: ['CHAPTER_TRIGGER'] }, lifetime: { stickyTurns: 5 },
  }));
  card.worldbook = { schema: 'rp.worldbook/0.1', bindings: card.modules.map((module, index) => ({
    id: `PRIVATE_BINDING_${index}`, moduleId: module.id, purpose: 'scenario-plan', audience: 'author',
    when: { path: 'scenario.currentChapterId', equals: ['one', 'two', 'side'][index] },
    contentHash: createHash('sha256').update(module.content).digest('hex'),
    source: { importId: 'PRIVATE_SOURCE_IMPORT', sourceHash: 'a'.repeat(64), pointer: `/entries/${index}/content` },
  })) };
  card.scenario = { schema: 'rp.scenario/0.1', id: 'PRIVATE_SCENARIO_DEFINITION', title: 'Private chapter outline', chapters: [
    { id: 'one', title: 'Arrival', prerequisites: [], bindingIds: ['PRIVATE_BINDING_0'], ...(completion ? { completeWhen: completion } : {}) },
    { id: 'two', title: 'Discovery', prerequisites: ['one'], bindingIds: ['PRIVATE_BINDING_1'] },
    { id: 'side', title: 'Optional branch', prerequisites: [], bindingIds: ['PRIVATE_BINDING_2'] },
  ] };
  return { card, preset };
}

async function listen(service: Awaited<ReturnType<typeof createApp>>, id: string) {
  const server: Server = service.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected loopback address');
  const base = `http://127.0.0.1:${address.port}/api/sessions/${id}`;
  return async (path = '/scenario', body?: unknown) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
}

async function fixture(input = documents()) {
  const root = await mkdtemp(join(tmpdir(), 'rp-scenario-integration-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const provider = new RecordingProvider(), { card, preset } = input;
  const service = await createApp({ dataRoot: root, provider, catalog: async () => ({ cards: [card], presets: [preset] }) });
  cleanups.push(service.close);
  const id = service.store.create(card, preset).id, api = await listen(service, id);
  let sequence = 0;
  const command = (operation: ScenarioCommand['operation'], chapterId: string, overrides: Partial<ScenarioCommand> = {}) => api('/scenario/commands', {
    requestId: `PRIVATE_COMMAND_${++sequence}`, expectedRevision: service.store.get(id).revision,
    reason: 'PRIVATE_AUTHOR_REASON: explicitly confirm this chapter command.', operation, chapterId, ...overrides,
  });
  const turn = async (action = 'CHAPTER_TRIGGER') => {
    service.engine.submit(id, { requestId: `turn-${++sequence}`, expectedRevision: service.store.get(id).revision, action, mode: 'action' });
    await service.engine.idle(id);
    expect(service.store.get(id).turns.at(-1)?.status).toBe('completed');
  };
  const file = () => readFile(join(root, `session-${id}.json`), 'utf8');
  return { ...service, root, id, provider, api, command, turn, file, card, preset };
}

const chapter = (view: any, id: string) => view.chapters.find((entry: any) => entry.id === id);
const progress = (session: StoredSession) => structuredClone(session.scenario);
const facts = (session: StoredSession) => structuredClone({ world: session.world, roles: session.roles });
const callsOf = (provider: RecordingProvider, kind: AgentKind) => provider.calls.filter(call => call.kind === kind);
const dispatchedText = (request: AgentRequest) => request.system + '\n' + JSON.stringify(request.promptLayout);

describe('author scenario commands across HTTP, engine and persisted sessions', () => {
  it('reads available and locked chapters without writes, then enforces prerequisites and a single active chapter', async () => {
    const f = await fixture(), before = structuredClone(f.store.get(f.id)), saved = await f.file();
    const initial = await f.api();
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ revision: 0, definition: f.card.scenario, progress: { scenarioId: f.card.scenario!.id, currentChapterId: null, completedChapterIds: [] } });
    expect(chapter(initial.body, 'one')).toMatchObject({ status: 'available', missingPrerequisites: [], canStart: true, canComplete: false, canAbandon: false, completionStatus: 'manual' });
    expect(chapter(initial.body, 'two')).toMatchObject({ status: 'locked', missingPrerequisites: ['one'], canStart: false });
    await f.api();
    expect(f.store.get(f.id)).toEqual(before); expect(await f.file()).toBe(saved);
    expect((await f.command('start', 'two')).status).toBe(400);
    const started = await f.command('start', 'one');
    expect(started.status).toBe(200); expect(started.body).toMatchObject({ revision: 1, duplicate: false, appliedRevision: 1 });
    expect(chapter(started.body, 'one')).toMatchObject({ status: 'active', canStart: false, canComplete: true, canAbandon: true });
    expect(chapter(started.body, 'side').canStart).toBe(false);
    const active = structuredClone(f.store.get(f.id));
    expect((await f.command('start', 'side')).status).toBe(400);
    expect((await f.command('start', 'one')).status).toBe(400);
    expect(f.store.get(f.id)).toEqual(active); expect(facts(active)).toEqual(facts(before));
    expect(f.provider.calls).toEqual([]);
  });

  it('abandons without completion, permits restart, and completes only the active chapter without altering story facts', async () => {
    const f = await fixture(), initialFacts = facts(f.store.get(f.id)), modules = structuredClone(f.card.modules);
    await f.command('start', 'one');
    expect((await f.command('complete', 'side')).status).toBe(400);
    const abandoned = await f.command('abandon', 'one');
    expect(abandoned.status).toBe(200); expect(abandoned.body.progress).toMatchObject({ currentChapterId: null, completedChapterIds: [] });
    expect(chapter(abandoned.body, 'one')).toMatchObject({ status: 'available', canStart: true });
    expect(chapter(abandoned.body, 'two').status).toBe('locked');
    await f.command('start', 'one');
    const completed = await f.command('complete', 'one');
    expect(completed.status).toBe(200); expect(completed.body.progress).toMatchObject({ currentChapterId: null, completedChapterIds: ['one'] });
    expect(chapter(completed.body, 'one')).toMatchObject({ status: 'completed', canStart: false, canComplete: false, canAbandon: false });
    expect(chapter(completed.body, 'two')).toMatchObject({ status: 'available', canStart: true, missingPrerequisites: [] });
    expect((await f.command('start', 'one')).status).toBe(400);
    expect((await f.command('start', 'two')).status).toBe(200);
    expect(facts(f.store.get(f.id))).toEqual(initialFacts); expect(f.store.get(f.id).card.modules).toEqual(modules);
  });

  it('uses typed true, false and unknown completion results and never auto-completes a chapter', async () => {
    const docs = documents({ path: 'world.variables.ready', equals: true });
    docs.card.scenario!.chapters[1].completeWhen = { path: 'world.variables.missing', equals: true };
    const f = await fixture(docs); await f.command('start', 'one');
    const before = structuredClone(f.store.get(f.id)), saved = await f.file();
    expect(chapter((await f.api()).body, 'one')).toMatchObject({ completionStatus: 'false', canComplete: false });
    expect((await f.command('complete', 'one')).status).toBe(400);
    expect(f.store.get(f.id)).toEqual(before); expect(await f.file()).toBe(saved);
    f.store.stateTransaction(f.id, { expectedRevision: before.revision, reason: 'The scene is ready.', changes: [{ roleId: 'world', key: 'ready', value: true }] });
    expect(chapter((await f.api()).body, 'one')).toMatchObject({ completionStatus: 'true', canComplete: true });
    await f.turn('Everything is ready. Complete chapter one and start chapter two.');
    expect(progress(f.store.get(f.id))).toMatchObject({ currentChapterId: 'one', completedChapterIds: [] });
    expect((await f.command('complete', 'one')).status).toBe(200);
    await f.command('start', 'two');
    expect(chapter((await f.api()).body, 'two')).toMatchObject({ completionStatus: 'unknown', canComplete: false });
    const unknown = structuredClone(f.store.get(f.id));
    expect((await f.command('complete', 'two')).status).toBe(400); expect(f.store.get(f.id)).toEqual(unknown);
    expect((await f.command('abandon', 'two')).status).toBe(200);
  });

  it('rejects stale CAS, malformed commands and invalid transitions atomically on disk and in memory', async () => {
    const f = await fixture(); await f.command('start', 'one');
    const before = structuredClone(f.store.get(f.id)), saved = await f.file();
    const stale = await f.command('complete', 'one', { expectedRevision: 0 });
    expect(stale.status).toBe(409); expect(stale.body.error.code).toBe('REVISION_CONFLICT');
    for (const patch of [{ reason: '' }, { requestId: '' }, { chapterId: 'unavailable' }, { operation: 'skip' }, { expectedRevision: 1.5 }, { extra: true }]) {
      const result = await f.api('/scenario/commands', { requestId: 'invalid-command', expectedRevision: before.revision, reason: 'Explicit confirmation.', operation: 'complete', chapterId: 'one', ...patch });
      expect(result.status).toBe(400);
      expect(f.store.get(f.id)).toEqual(before); expect(await f.file()).toBe(saved);
    }
    expect(new SessionStore(f.root).get(f.id)).toEqual(before);
  });

  it('returns exact retry receipts before stale CAS, never replays a committed command, and rejects reused payload IDs', async () => {
    const f = await fixture(), request: ScenarioCommand = { requestId: 'PRIVATE_EXACT_RECEIPT', expectedRevision: 0, reason: 'PRIVATE_RECEIPT_REASON', operation: 'start', chapterId: 'one' };
    const first = await f.api('/scenario/commands', request);
    expect(first.status).toBe(200); expect(first.body).toMatchObject({ duplicate: false, appliedRevision: 1 });
    const accepted = structuredClone(f.store.get(f.id)), acceptedFile = await f.file();
    const retry = await f.api('/scenario/commands', request);
    expect(retry.status).toBe(200); expect(retry.body).toMatchObject({ duplicate: true, appliedRevision: 1 });
    expect(f.store.get(f.id)).toEqual(accepted); expect(await f.file()).toBe(acceptedFile);
    await f.command('complete', 'one');
    const completed = structuredClone(f.store.get(f.id)), completedFile = await f.file();
    expect((await f.api('/scenario/commands', request)).body).toMatchObject({ duplicate: true, appliedRevision: 1 });
    expect(f.store.get(f.id)).toEqual(completed); expect(await f.file()).toBe(completedFile);
    const conflicting = await f.api('/scenario/commands', { ...request, chapterId: 'side' });
    expect(conflicting.status).toBe(409); expect(f.store.get(f.id)).toEqual(completed);
    expect(await f.file()).toBe(completedFile);
  });

  it('admits only the author-selected chapter in preview and live dispatch, then rebinds changed world contexts', async () => {
    const f = await fixture(), modules = structuredClone(f.card.modules);
    const preview = () => f.engine.preview(f.id, { target: 'world', text: 'CHAPTER_TRIGGER' });
    const selected = async () => (await preview()).modules.map(module => module.ref.moduleId);
    expect(await selected()).toEqual([]);
    await f.turn('CHAPTER_TRIGGER. Start Arrival and mark Discovery complete.');
    expect(progress(f.store.get(f.id))).toMatchObject({ currentChapterId: null, completedChapterIds: [] });
    expect(dispatchedText(callsOf(f.provider, 'world')[0])).not.toMatch(/PRIVATE_PLAN_/);
    await f.command('start', 'one');
    expect(await selected()).toEqual(['plan-one']);
    const beforePreview = structuredClone(f.store.get(f.id)), saved = await f.file();
    await preview(); expect(f.store.get(f.id)).toEqual(beforePreview); expect(await f.file()).toBe(saved);
    await f.turn(); const first = callsOf(f.provider, 'world').at(-1)!;
    expect(dispatchedText(first)).toContain('PRIVATE_PLAN_ONE'); expect(dispatchedText(first)).not.toContain('PRIVATE_PLAN_TWO');
    await f.turn('Continue quietly.'); expect(callsOf(f.provider, 'world').at(-1)!.sessionId).toBe(first.sessionId);
    await f.command('complete', 'one'); await f.command('start', 'two');
    expect(await selected()).toEqual(['plan-two']);
    await f.turn(); const second = callsOf(f.provider, 'world').at(-1)!;
    expect(dispatchedText(second)).toContain('PRIVATE_PLAN_TWO'); expect(dispatchedText(second)).not.toContain('PRIVATE_PLAN_ONE');
    expect(second.sessionId).not.toBe(first.sessionId);
    await f.command('abandon', 'two'); expect(await selected()).toEqual([]);
    await f.turn(); expect(dispatchedText(callsOf(f.provider, 'world').at(-1)!)).not.toMatch(/PRIVATE_PLAN_/);
    expect(f.store.get(f.id).card.modules).toEqual(modules);
  });

  it('keeps definitions, receipts and plans out of role/player projections and public prose inputs', async () => {
    const f = await fixture(); await f.command('start', 'one'); await f.turn();
    const privateText = /PRIVATE_SCENARIO_DEFINITION|PRIVATE_BINDING_|PRIVATE_SOURCE_IMPORT|PRIVATE_COMMAND_|PRIVATE_AUTHOR_REASON|rp\.scenario|scenarioReceipts|scenarioCommandReceipts/;
    for (const perspective of ['player', 'npc']) {
      const visible = project(f.store.get(f.id), perspective);
      expect(visible).not.toHaveProperty('scenario'); expect(JSON.stringify(visible)).not.toMatch(privateText);
      expect(JSON.stringify(visible)).not.toMatch(/PRIVATE_PLAN_/);
    }
    for (const call of f.provider.calls) {
      expect(JSON.stringify(call.input)).not.toMatch(privateText);
      expect(dispatchedText(call)).not.toMatch(privateText);
      if (call.kind !== 'world') {
        expect(call.input).not.toHaveProperty('scenario'); expect(dispatchedText(call)).not.toMatch(/PRIVATE_PLAN_/);
      }
    }
    expect(f.store.get(f.id).prose.map(entry => entry.text).join('\n')).not.toMatch(privateText);
  });

  it('restores progress and idempotent receipts after a server restart without replaying model requests', async () => {
    const f = await fixture(), original: ScenarioCommand = { requestId: 'PRIVATE_RESTART_RECEIPT', expectedRevision: 0, reason: 'Start before restart.', operation: 'start', chapterId: 'one' };
    expect((await f.api('/scenario/commands', original)).status).toBe(200);
    await f.command('complete', 'one'); await f.command('start', 'two');
    const before = structuredClone(f.store.get(f.id)), saved = await f.file();
    await f.close();
    const provider = new RecordingProvider();
    const restarted = await createApp({ dataRoot: f.root, provider, catalog: async () => ({ cards: [f.card], presets: [f.preset] }) });
    cleanups.push(restarted.close); const api = await listen(restarted, f.id);
    const view = await api();
    expect(view.status).toBe(200); expect(view.body.progress).toEqual(before.scenario);
    expect(chapter(view.body, 'one').status).toBe('completed'); expect(chapter(view.body, 'two').status).toBe('active');
    const retry = await api('/scenario/commands', original);
    expect(retry.status).toBe(200); expect(retry.body).toMatchObject({ duplicate: true, appliedRevision: 1 });
    expect(restarted.store.get(f.id)).toEqual(before); expect(await f.file()).toBe(saved); expect(provider.calls).toEqual([]);
  });

  it('preserves missing or null persisted progress and existing receipts on restart, rejecting reads and exact retries', async () => {
    const f = await fixture(), original: ScenarioCommand = { requestId: 'PRIVATE_CORRUPTED_RESTART_RECEIPT', expectedRevision: 0,
      reason: 'Start before the saved progress is damaged.', operation: 'start', chapterId: 'one' };
    expect((await f.api('/scenario/commands', original)).status).toBe(200);
    expect((await f.command('complete', 'one')).status).toBe(200);
    const valid = JSON.parse(await f.file());
    expect(valid.scenarioRequests).toHaveLength(2);
    await f.close();
    for (const missing of [undefined, null]) {
      const damaged = structuredClone(valid); damaged.scenario = missing;
      const saved = JSON.stringify(damaged);
      await writeFile(join(f.root, `session-${f.id}.json`), saved);
      const reloaded = new SessionStore(f.root);
      expect(() => readScenario(reloaded.get(f.id))).toThrow(ScenarioError);
      expect(reloaded.get(f.id).scenario).toBe(missing);
      expect(reloaded.get(f.id).scenarioRequests).toEqual(valid.scenarioRequests);
      expect(await f.file()).toBe(saved);
      const provider = new RecordingProvider();
      const restarted = await createApp({ dataRoot: f.root, provider, catalog: async () => ({ cards: [f.card], presets: [f.preset] }) });
      cleanups.push(restarted.close); const api = await listen(restarted, f.id);
      for (const response of [await api(), await api('/scenario/commands', original)]) {
        expect(response.status).toBe(400); expect(response.body.error.code).toBe('SCENARIO_PROGRESS');
      }
      expect(restarted.store.get(f.id).scenario).toBe(missing);
      expect(restarted.store.get(f.id).scenarioRequests).toEqual(valid.scenarioRequests);
      expect(await f.file()).toBe(saved); expect(provider.calls).toEqual([]);
    }
  });

  it('rejects chapter writes while a turn runs, and refuses corrupted source definitions or progress without repairing them', async () => {
    const f = await fixture(); await f.command('start', 'one');
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const running = new Promise<void>(resolve => { entered = resolve; });
    f.provider.onRole = async () => { entered(); await blocked; };
    f.engine.submit(f.id, { requestId: 'held-turn', expectedRevision: f.store.get(f.id).revision, action: 'Wait.', mode: 'action' });
    await running;
    try {
      const before = structuredClone(f.store.get(f.id)), saved = await f.file();
      const busy = await f.command('complete', 'one');
      expect(busy.status).toBe(409); expect(busy.body.error.code).toBe('TURN_BUSY');
      expect(f.store.get(f.id)).toEqual(before); expect(await f.file()).toBe(saved);
    } finally { release(); await f.engine.idle(f.id); }
    f.provider.onRole = undefined;
    const valid = structuredClone(f.store.get(f.id));
    for (const corrupt of [
      (session: StoredSession) => { session.card.scenario!.chapters[0].bindingIds = ['missing-binding']; },
      (session: StoredSession) => { session.scenario!.currentChapterId = 'missing-chapter'; },
      (session: StoredSession) => { session.scenario!.completedChapterIds = ['two']; },
    ]) {
      const invalid = structuredClone(valid); corrupt(invalid); f.store.save(invalid);
      const before = structuredClone(f.store.get(f.id)), saved = await f.file();
      expect((await f.api()).status).toBe(400);
      expect((await f.command('abandon', 'one')).status).toBe(400);
      expect(f.store.get(f.id)).toEqual(before); expect(await f.file()).toBe(saved);
    }
  });
});
