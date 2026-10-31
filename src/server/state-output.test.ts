import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, OutputContract, OutputValueSource, Preset } from '../shared/types';
import { acceptOutputs, compileOutputPlan, outputInstructions, outputPlanTrace, outputResultSchema, type CommittedOutputMaterial } from './output-runtime';
import { compilePromptPlan, publicPromptView, runtimeFingerprint } from './prompt-compiler';
import { clone, event, project, SessionStore, type StoredSession } from './store';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { createApp } from './app';
import type { AgentModule } from './agent-modules';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function output(id: string, extra: Partial<OutputContract> = {}): OutputContract {
  return { id, title: id, type: 'text', instruction: 'MODEL_SUMMARY_INSTRUCTION', enabled: true, required: true, priority: 10,
    audience: 'public', display: { placement: 'after-prose' }, ...extra };
}
function host(id: string, valueFrom: OutputValueSource, extra: Partial<OutputContract> = {}): OutputContract {
  return output(id, { valueFrom, instruction: `HOST_ONLY_INSTRUCTION_${id}`, display: { placement: 'side-panel', renderer: 'plain' }, ...extra });
}
const state = (key: string, roleId = 'npc'): OutputValueSource => ({ kind: 'state', roleId, key });
function documents() {
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.id = 'state-output-card'; preset.id = 'state-output-preset';
  card.world = { location: 'PUBLIC_DOCK', time: '08:00', variables: { count: 7, flag: false, tags: ['world'], unknown: null, empty: '', secret: 'PRIVATE_WORLD_SECRET' } };
  card.fields = [
    { key: 'count', label: 'Count', type: 'number', audience: 'public', editable: true },
    { key: 'flag', label: 'Flag', type: 'boolean', audience: 'public', editable: true },
    { key: 'tags', label: 'Tags', type: 'list', audience: 'public', editable: true },
    { key: 'unknown', label: 'Unknown', type: 'number', audience: 'public', editable: true },
    { key: 'empty', label: 'Empty', type: 'string', audience: 'public', editable: true },
    { key: 'secret', label: 'Secret', type: 'string', audience: 'author', editable: true },
  ];
  card.roles[0].state = { count: 0, flag: false, tags: [], unknown: null, empty: '  ', secret: 'PRIVATE_PLAYER_SECRET' };
  card.roles[0].peers = ['npc'];
  card.roles.push({ id: 'npc', name: 'NPC', persona: '', goals: [], peers: ['player'], phase: 'active', presence: 'present',
    state: { count: 3, flag: true, tags: ['npc'], unknown: null, empty: '', secret: 'PRIVATE_NPC_SECRET' }, knowledge: [] });
  return { card, preset };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rp-state-output-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const docs = documents(), store = new SessionStore(root), id = store.create(docs.card, docs.preset).id;
  return { root, store, id, session: store.get(id), ...docs };
}
function planFor(session: StoredSession, snapshot: unknown = publicPromptView(session), material?: CommittedOutputMaterial) {
  const prompt = compilePromptPlan(session, 'prose', 'compose', { snapshot, text: '' });
  expect(prompt.valid).toBe(true);
  return compileOutputPlan(session, prompt, snapshot, material);
}
const schema = () => ({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false });

describe('host outputs from committed public state', () => {
  it('reads world labels and declared public role/world values with committed revision provenance', async () => {
    const { session } = await fixture(); session.revision = 9;
    session.card.outputs = [host('time', { kind: 'world-time' }), host('location', { kind: 'world-location' }),
      host('role-count', state('count')), host('world-count', state('count', 'world')), host('world-list', state('tags', 'world'), { type: 'list' })];
    const before = runtimeFingerprint(session), plan = planFor(session), accepted = acceptOutputs(undefined, plan);
    expect(plan.valid).toBe(true);
    expect(accepted.map(item => [item.key, item.value])).toEqual([
      ['card:time', '08:00'], ['card:location', 'PUBLIC_DOCK'], ['card:role-count', '3'], ['card:world-count', '7'], ['card:world-list', ['world']],
    ]);
    expect(accepted.every(item => item.provenance?.kind === 'state' && item.provenance.known && item.provenance.worldRevision === 9)).toBe(true);
    expect(accepted[2].provenance?.kind === 'state' && accepted[2].provenance.selector).toEqual(state('count'));
    expect(runtimeFingerprint(session)).toBe(before);
  });

  it('blocks required private/missing selectors and excludes optional ones without widening public disclosure', async () => {
    const { session } = await fixture();
    const selectors = [state('secret'), state('secret', 'world'), state('missing'), state('count', 'missing-owner')];
    for (const selector of selectors) for (const required of [true, false]) {
      session.card.outputs = [host('selected', selector, { required })];
      // Public views omit private values; full author data also cannot override the declared audience check.
      for (const snapshot of [publicPromptView(session), session]) {
        const plan = planFor(session, snapshot);
        expect(plan.valid).toBe(!required); expect(plan.contracts.length).toBe(0); expect(plan.hostOutputs?.length).toBe(0);
        expect(plan.decisions.map(decision => [decision.status, decision.reason])).toEqual([[required ? 'error' : 'excluded', 'output-state-unavailable']]);
        expect(plan.diagnostics.map(diagnostic => diagnostic.severity)).toEqual([required ? 'error' : 'warning']);
        expect(JSON.stringify(plan)).not.toContain('PRIVATE_NPC_SECRET');
        expect(JSON.stringify(plan)).not.toContain('PRIVATE_WORLD_SECRET');
      }
    }
  });

  it('distinguishes unknown null or blank text from known zero, false and empty lists', async () => {
    const { session } = await fixture();
    session.card.outputs = [host('unknown', state('unknown')), host('empty', state('empty', 'player')),
      host('zero', state('count', 'player')), host('false', state('flag', 'player')),
      host('empty-list', state('tags', 'player'), { type: 'list' }), host('empty-list-text', state('tags', 'player'))];
    const plan = planFor(session), accepted = acceptOutputs(undefined, plan);
    expect(plan.valid).toBe(true);
    expect(accepted.map(item => [item.key, item.value, item.provenance?.kind === 'state' ? item.provenance.known : undefined])).toEqual([
      ['card:unknown', '未设定', false], ['card:empty', '未设定', false], ['card:zero', '0', true], ['card:false', 'false', true],
      ['card:empty-list', [], true], ['card:empty-list-text', '[]', true],
    ]);
    session.world.time = ''; session.world.location = '   ';
    session.card.outputs = [host('time', { kind: 'world-time' }), host('location', { kind: 'world-location' })];
    expect(acceptOutputs(undefined, planFor(session)).map(item => [item.value, item.provenance?.kind === 'state' ? item.provenance.known : undefined])).toEqual([['未设定', false], ['未设定', false]]);
  });

  it('rejects list/object mismatches and never fabricates unknown structured values', async () => {
    const { session } = await fixture();
    const cases: [OutputContract['type'], OutputValueSource][] = [
      ['list', { kind: 'world-time' }], ['list', state('count')], ['list', state('unknown')],
      ['object', state('tags')], ['object', state('count')], ['object', state('unknown')],
    ];
    for (const [type, selector] of cases) for (const required of [true, false]) {
      session.card.outputs = [host('structured', selector, { type, required })];
      const plan = planFor(session);
      expect(plan.valid).toBe(!required); expect(plan.contracts.length).toBe(0); expect(plan.hostOutputs?.length).toBe(0);
      expect(plan.diagnostics[0].code).toBe('output-state-unavailable');
    }
    // Valid JSON is still not a list of text entries.
    session.roles[1].state.tags = ['valid', { invalidForTextList: true }];
    session.card.outputs = [host('structured', state('tags'), { type: 'list' })];
    expect(planFor(session).valid).toBe(false);
  });

  it('keeps host-only values out of model instructions/schema and produces them when the model returns no outputs', async () => {
    const { session } = await fixture();
    session.card.outputs = [host('time', { kind: 'world-time' }), host('tags', state('tags'), { type: 'list' })];
    const plan = planFor(session), base = schema();
    expect(plan.valid).toBe(true); expect(outputInstructions(plan)).toBe('');
    expect(outputResultSchema(base, plan)).toBe(base); expect(base.properties).not.toHaveProperty('outputs');
    expect(acceptOutputs(undefined, plan).map(item => item.key)).toEqual(['card:time', 'card:tags']);
    expect(acceptOutputs({}, plan).map(item => item.key)).toEqual(['card:time', 'card:tags']);
    expect(() => acceptOutputs({ 'card:time': 'forged' }, plan)).toThrow('Undeclared auxiliary output');
  });

  it('merges model and host attachments in contract priority order and rejects forged host keys atomically', async () => {
    const { session } = await fixture();
    session.card.outputs = [host('location', { kind: 'world-location' }, { priority: 30 }), output('summary', { priority: 10 }), host('time', { kind: 'world-time' }, { priority: 20 })];
    session.preset.outputs = [host('tags', state('tags'), { priority: 5, type: 'list' }), output('notes', { priority: 40, type: 'object', required: false })];
    const plan = planFor(session), before = runtimeFingerprint({ session, plan });
    const returned = { 'card:summary': 'MODEL_PUBLIC_SUMMARY', 'preset:notes': { detail: ['model note'] } };
    const accepted = acceptOutputs(returned, plan);
    expect(accepted.map(item => item.key)).toEqual(['preset:tags', 'card:summary', 'card:time', 'card:location', 'preset:notes']);
    expect((outputResultSchema(schema(), plan).properties.outputs as any).properties).toEqual({ 'card:summary': { type: 'string', minLength: 1 }, 'preset:notes': { type: 'object', additionalProperties: true } });
    expect(outputInstructions(plan)).toContain('MODEL_SUMMARY_INSTRUCTION');
    expect(outputInstructions(plan)).not.toContain('HOST_ONLY_INSTRUCTION');
    expect(() => acceptOutputs({ ...returned, 'card:time': 'forged' }, plan)).toThrow('Undeclared auxiliary output');
    expect(runtimeFingerprint({ session, plan })).toBe(before);
    expect(() => acceptOutputs(undefined, plan)).toThrow('required auxiliary outputs');
    const optional = clone(plan); optional.contracts.find(item => item.key === 'card:summary')!.required = false;
    expect(acceptOutputs(undefined, optional).map(item => item.key)).toEqual(['preset:tags', 'card:time', 'card:location']);
  });

  it('returns detached values, selectors and display metadata without mutating snapshots, plans or provider results', async () => {
    const { session } = await fixture();
    session.card.outputs = [host('tags', state('tags'), { type: 'list', display: { placement: 'side-panel', renderer: 'folded', history: { maxEntriesAgo: 2 } } }),
      output('notes', { type: 'object' })];
    const plan = planFor(session), provider = { 'card:notes': { nested: ['model note'] } }, before = runtimeFingerprint({ session, plan, provider });
    const accepted = acceptOutputs(provider, plan);
    (accepted[0].value as string[]).push('caller edit');
    if (accepted[0].provenance?.kind === 'state') (accepted[0].provenance.selector as Extract<OutputValueSource, { kind: 'state' }>).key = 'caller edit';
    accepted[0].display!.history!.maxEntriesAgo = 999;
    ((accepted[1].value as { nested: string[] }).nested).push('caller edit');
    expect(runtimeFingerprint({ session, plan, provider })).toBe(before);
    session.roles[1].state.tags = ['snapshot changed after planning'];
    const repeated = acceptOutputs(provider, plan);
    expect(repeated[0].value).toEqual(['npc']); expect(repeated[0].display?.history?.maxEntriesAgo).toBe(2);
    expect(repeated[1].value).toEqual({ nested: ['model note'] });
  });

  it('changes resolved values/revisions without changing static output contracts or prose contract fingerprints', async () => {
    const { session } = await fixture();
    session.card.outputs = [host('time', { kind: 'world-time' }), host('count', state('count')), output('summary')];
    const first = planFor(session);
    const firstContractFingerprint = runtimeFingerprint({ instructions: outputInstructions(first), outputs: first.contracts });
    const sourceFingerprint = runtimeFingerprint({ card: session.card, preset: session.preset });
    session.revision += 1; session.world.time = '09:15'; session.roles[1].state.count = 4;
    const second = planFor(session);
    expect(first.contracts).toEqual(second.contracts);
    expect(runtimeFingerprint({ instructions: outputInstructions(second), outputs: second.contracts })).toBe(firstContractFingerprint);
    expect(runtimeFingerprint(outputPlanTrace(first))).toBe(runtimeFingerprint(outputPlanTrace(second)));
    expect(runtimeFingerprint(first.hostOutputs)).not.toBe(runtimeFingerprint(second.hostOutputs));
    expect(second.hostOutputs?.map(item => [item.value, item.provenance?.worldRevision])).toEqual([['09:15', 1], ['4', 1]]);
    expect(runtimeFingerprint({ card: session.card, preset: session.preset })).toBe(sourceFingerprint);
  });
});

const messageOutput = (extra: Partial<OutputContract> = {}) => host('messages', { kind: 'approved-messages' }, {
  type: 'object', display: { placement: 'after-prose', renderer: 'messages' }, ...extra,
});
async function messageFixture() {
  const f = await fixture(), { session } = f;
  session.revision = 4;
  session.roles[1].name = 'Morgan';
  const other = { ...clone(session.roles[1]), id: 'other', name: 'River' };
  session.roles.push(other); session.card.roles.push(clone(other));
  const material: CommittedOutputMaterial = { materialTurnId: 'material-turn', acceptedBehaviors: [
    { id: 'b1', roleId: 'npc', kind: 'speech', text: ' First exact message.\nSecond line. ', interaction: { mode: 'remote', channel: 'message' } },
    { id: 'b2', roleId: 'other', kind: 'action', text: 'A local public gesture.' },
    { id: 'b3', roleId: 'other', kind: 'speech', text: 'A reply with <literal> markup.', interaction: { mode: 'remote', channel: 'message' } },
    { id: 'b4', roleId: 'npc', kind: 'speech', text: 'Audio only.', interaction: { mode: 'remote', channel: 'audio' } },
    { id: 'b5', roleId: 'npc', kind: 'speech', text: 'Last exact message.', interaction: { mode: 'remote', channel: 'message' } },
    { id: 'b6', roleId: 'npc', kind: 'speech', text: 'Local speech only.' },
    { id: 'b7', roleId: 'other', kind: 'speech', text: 'Screen transmission only.', interaction: { mode: 'remote', channel: 'screen' } },
  ] };
  for (const behavior of material.acceptedBehaviors) event(session, { kind: 'role-behavior', actor: behavior.roleId, turnId: material.materialTurnId!, text: behavior.text, audience: 'public', data: clone(behavior) as any });
  event(session, { kind: 'role-result', actor: 'npc', turnId: material.materialTurnId!, text: 'PRIVATE_RAW_ROLE_RESULT', audience: 'author' });
  event(session, { kind: 'role-behavior', actor: 'npc', turnId: material.materialTurnId!, text: 'PRIVATE_MAIL_NOT_A_PUBLIC_MESSAGE', audience: ['npc'] });
  session.card.outputs = [messageOutput()];
  return { ...f, material };
}

describe('host message transcripts from committed approved behavior', () => {
  it('uses exact remote message speech in interleaved approval order with public names and committed-behaviors provenance', async () => {
    const { session, material } = await messageFixture();
    // The actors have since moved locally: their historical transmission stamps still own the message channel.
    session.roles[1].presence = 'present'; session.roles[1].interaction = { mode: 'local' };
    session.roles[2].phase = 'dormant'; session.roles[2].interaction = { mode: 'remote', channel: 'screen' };
    const before = runtimeFingerprint({ session, material }), plan = planFor(session, publicPromptView(session), material);
    expect(plan.valid).toBe(true);
    const attachment = acceptOutputs(undefined, plan)[0];
    expect(attachment.value).toEqual({ schema: 'rp.approved-messages/0.1', materialTurnId: 'material-turn', worldRevision: 4, messages: [
      { behaviorId: 'b1', roleId: 'npc', name: 'Morgan', text: ' First exact message.\nSecond line. ', channel: 'message' },
      { behaviorId: 'b3', roleId: 'other', name: 'River', text: 'A reply with <literal> markup.', channel: 'message' },
      { behaviorId: 'b5', roleId: 'npc', name: 'Morgan', text: 'Last exact message.', channel: 'message' },
    ] });
    expect(attachment.provenance).toEqual({ kind: 'committed-behaviors', materialTurnId: 'material-turn', behaviorIds: ['b1', 'b3', 'b5'], worldRevision: 4 });
    expect(runtimeFingerprint({ session, material })).toBe(before);
    expect(JSON.stringify(attachment)).not.toContain('PRIVATE_');
    const retained = runtimeFingerprint(attachment);
    session.roles[1].name = 'Later public name'; (material.acceptedBehaviors[0] as any).text = 'Later caller mutation';
    expect(runtimeFingerprint(acceptOutputs(undefined, plan)[0])).toBe(retained);
  });

  it('distinguishes explicit empty current material from unavailable material and never falls back to older messages', async () => {
    const { session } = await messageFixture();
    for (const material of [{ materialTurnId: 'new-empty-turn', acceptedBehaviors: [] }, { materialTurnId: null, acceptedBehaviors: [] }]) {
      const plan = planFor(session, publicPromptView(session), material);
      expect(plan.valid).toBe(true);
      expect(acceptOutputs(undefined, plan)[0].value).toEqual({ schema: 'rp.approved-messages/0.1', materialTurnId: material.materialTurnId, worldRevision: 4, messages: [] });
    }
    for (const required of [true, false]) {
      session.card.outputs = [messageOutput({ required })];
      const plan = planFor(session);
      expect(plan.valid).toBe(!required); expect(plan.contracts).toHaveLength(0);
      expect(plan.diagnostics.map(item => [item.code, item.severity])).toEqual([['output-material-unavailable', required ? 'error' : 'warning']]);
    }
  });

  it('rejects stale, rejected, private, forged, player and malformed material instead of reconstructing it from role results or prose', async () => {
    const { session, material } = await messageFixture(), snapshot = publicPromptView(session);
    const cases: { material: any; snapshot?: any }[] = [
      { material: { materialTurnId: 'material-turn' } },
      { material: { ...clone(material), materialTurnId: null } },
      { material: { ...clone(material), materialTurnId: 'wrong-turn' } },
      { material: { ...clone(material), acceptedBehaviors: [] } },
      { material: { ...clone(material), acceptedBehaviors: [...material.acceptedBehaviors].reverse() } },
      { material: { ...clone(material), acceptedBehaviors: [{ ...material.acceptedBehaviors[0], id: 'unapproved' }, ...material.acceptedBehaviors.slice(1)] } },
    ];
    for (const mutate of [
      (value: any) => { value.acceptedBehaviors[0].text = 'Invented prose text'; },
      (value: any) => { value.acceptedBehaviors[1].id = value.acceptedBehaviors[0].id; },
      (value: any) => { value.acceptedBehaviors[0].roleId = 'player'; },
      (value: any) => { value.acceptedBehaviors[0].roleId = 'unknown'; },
      (value: any) => { value.acceptedBehaviors[0].kind = 'action'; },
      (value: any) => { value.acceptedBehaviors[0].interaction.channel = 'private-mail'; },
      (value: any) => { value.acceptedBehaviors[0].text = 7; },
      (value: any) => { value.acceptedBehaviors[0].privateResult = 'PRIVATE_ROLE_RESULT'; },
    ]) { const value = clone(material); mutate(value); cases.push({ material: value }); }
    for (const mutate of [
      (value: any) => { value.events.find((event: any) => event.kind === 'role-behavior').audience = 'author'; },
      (value: any) => { value.events.find((event: any) => event.kind === 'role-behavior').actor = 'other'; },
      (value: any) => { value.events.find((event: any) => event.kind === 'role-behavior').text = 'Forged event text'; },
      (value: any) => { value.events.find((event: any) => event.kind === 'role-behavior').data.text = 'Forged event data'; },
      (value: any) => { value.events.find((event: any) => event.kind === 'role-behavior').data = null; },
      (value: any) => { value.roles[1].name = null; },
      (value: any) => { value.roles = value.roles.filter((role: any) => role.id !== 'npc'); },
    ]) { const value = clone(snapshot); mutate(value); cases.push({ material: clone(material), snapshot: value }); }
    for (const test of cases) for (const required of [true, false]) {
      session.card.outputs = [messageOutput({ required })];
      const plan = planFor(session, test.snapshot ?? snapshot, test.material);
      expect(plan.valid).toBe(!required); expect(plan.contracts).toHaveLength(0); expect(plan.hostOutputs).toHaveLength(0);
      expect(plan.diagnostics[0].code).toBe('output-material-unavailable');
      expect(JSON.stringify(plan)).not.toMatch(/PRIVATE_|Invented prose text|Forged event/);
    }
  });

  it('keeps transcripts outside model schemas, rejects model overrides and leaves existing model/state outputs unchanged', async () => {
    const { session, material } = await messageFixture();
    const only = planFor(session, publicPromptView(session), material), base = schema();
    expect(outputResultSchema(base, only)).toBe(base); expect(outputInstructions(only)).toBe('');
    expect(() => acceptOutputs({ 'card:messages': {} }, only)).toThrow('Undeclared auxiliary output');
    session.card.outputs = [messageOutput({ priority: 20 }), output('summary', { priority: 30 })];
    session.preset.outputs = [host('time', { kind: 'world-time' }, { priority: 10 })];
    const plan = planFor(session, publicPromptView(session), material);
    expect(acceptOutputs({ 'card:summary': 'Neutral summary.' }, plan).map(item => item.key)).toEqual(['preset:time', 'card:messages', 'card:summary']);
    expect(Object.keys((outputResultSchema(base, plan).properties.outputs as any).properties)).toEqual(['card:summary']);
    expect(outputInstructions(plan)).not.toContain('HOST_ONLY_INSTRUCTION');
    expect(() => acceptOutputs({ 'card:summary': 'Neutral summary.', 'card:messages': {} }, plan)).toThrow('Undeclared auxiliary output');
  });

  it('persists transcript snapshots and provenance across restart and applies output audiences to projections', async () => {
    const { root, store, id, session, material } = await messageFixture();
    session.card.outputs = [messageOutput({ audience: ['player'] })];
    const attachments = acceptOutputs(undefined, planFor(session, publicPromptView(session), material));
    session.prose.push({ id: 'message-entry', turnId: 'composition-turn', title: 'Messages', text: 'Neutral surrounding prose.', worldRevision: session.revision, attachments });
    store.save(session);
    const recovered = new SessionStore(root).get(id), prior = runtimeFingerprint(attachments);
    expect(runtimeFingerprint(recovered.prose.at(-1)!.attachments)).toBe(prior);
    expect(project(recovered, 'player').prose.at(-1)!.attachments).toHaveLength(1);
    expect(project(recovered, 'npc').prose.at(-1)!.attachments).toHaveLength(0);
    expect(project(recovered, 'author').prose.at(-1)!.attachments).toHaveLength(1);
    // Recomposition uses the explicit material turn, not the new composition turn or latest prose.
    expect(runtimeFingerprint(acceptOutputs(undefined, planFor(recovered, publicPromptView(recovered), material)))).toBe(prior);
  });
});

class StateOutputProvider implements ModelProvider {
  calls: AgentRequest[] = [];
  worldCalls = 0;
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request);
    if (request.kind === 'role') return { public: { summary: '', speech: [], actions: [] }, proposals: [] };
    if (request.kind === 'world') return { summary: 'Committed the public count.', changes: [{ roleId: 'world', key: 'count', value: 7 + ++this.worldCalls }], facts: [], acceptedBehaviorIds: [] };
    return { title: 'Quiet dock', text: 'The dock remains quiet.', person: 'third', pov: 'limited', outputs: { 'card:summary': 'The public count changed.' } };
  }
}

describe('state-derived outputs at the actual engine boundary', () => {
  it('uses the post-world public snapshot, combines host time with model summary, and persists output provenance across restart and projections', async () => {
    const { root, store, session, id } = await fixture();
    session.card.outputs = [host('time', { kind: 'world-time' }, { priority: 0, display: { placement: 'before-prose', renderer: 'plain' } }), output('summary', { priority: 10 })];
    store.save(session);
    const provider = new StateOutputProvider(), engine = new TurnEngine(store, provider);
    cleanups.push(() => engine.close());
    for (let turn = 1; turn <= 2; turn++) {
      engine.submit(id, { requestId: `host-output-${turn}`, expectedRevision: store.get(id).revision, action: 'Continue.', mode: 'action' });
      await engine.idle(id);
      const current = store.get(id);
      expect(current.turns.at(-1)?.status).toBe('completed'); expect(current.revision).toBe(turn);
      expect(current.world.variables.count).toBe(7 + turn);
      const attachments = current.prose.at(-1)!.attachments!;
      expect(attachments.map(item => [item.key, item.value])).toEqual([['card:time', '08:00'], ['card:summary', 'The public count changed.']]);
      expect(attachments[0].provenance).toEqual({ kind: 'state', selector: { kind: 'world-time' }, known: true, worldRevision: turn });
      expect(attachments[1].provenance).toBeUndefined();
    }
    expect(provider.calls.map(call => call.kind)).toEqual(['role', 'world', 'prose', 'role', 'world', 'prose']);
    const prose = provider.calls.filter(call => call.kind === 'prose');
    expect(prose[1].sessionId).toBe(prose[0].sessionId);
    expect((prose[0].input as any).revision).toBe(1); expect((prose[0].input as any).world.variables.count).toBe(8);
    expect(JSON.stringify(prose.map(call => call.input))).not.toContain('PRIVATE_');
    expect(prose.every(call => !call.system.includes('HOST_ONLY_INSTRUCTION') && Object.keys((call.resultSchema as any).properties.outputs.properties).join() === 'card:summary')).toBe(true);
    const retained = runtimeFingerprint(store.get(id).prose);
    await engine.close();
    const reopened = new SessionStore(root), recovered = reopened.get(id);
    expect(runtimeFingerprint(recovered.prose)).toBe(retained);
    for (const perspective of ['author', 'player', 'npc']) {
      const view = project(recovered, perspective);
      expect(view.prose.every(entry => entry.attachments?.map(output => output.key).join() === 'card:time,card:summary')).toBe(true);
      expect(view.prose.at(-1)!.attachments![0].provenance?.worldRevision).toBe(2);
    }
    const resumed = new TurnEngine(reopened, provider); cleanups.push(() => resumed.close());
    const preview = await resumed.preview(id, { target: 'prose' });
    expect(preview.valid).toBe(true); expect(provider.calls.length).toBe(6);
    const traces = recovered.events.filter(event => event.kind === 'output-selection');
    expect(traces.length).toBe(2); expect(runtimeFingerprint(traces[0].data)).toBe(runtimeFingerprint(traces[1].data));
  });
});

class MessageOutputProvider implements ModelProvider {
  calls: AgentRequest[] = [];
  forgeHostKeyOnce = false;
  failWriterOnce = false;
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request);
    if (request.kind === 'role') return { public: { summary: 'Summary is not a message.',
      speech: (request.input as any).delivery.to === 'npc' ? ['Morgan first.', 'Rejected candidate.', 'Morgan last.'] : ['River middle.'], actions: [] }, proposals: [] };
    if (request.kind === 'world') {
      const candidates = (request.input as any).behaviorCandidates as { id: string; text: string }[];
      return { summary: 'Messages approved.', changes: [{ roleId: 'world', key: 'count', value: 8 }], facts: [],
        acceptedBehaviorIds: ['Morgan first.', 'River middle.', 'Morgan last.'].map(text => candidates.find(candidate => candidate.text === text)!.id) };
    }
    if (this.failWriterOnce) { this.failWriterOnce = false; throw new Error('Deterministic writer failure'); }
    const result = { title: 'Quiet inbox', text: 'The inbox remains open.', person: 'third', pov: 'limited' };
    if (this.forgeHostKeyOnce) { this.forgeHostKeyOnce = false; return { ...result, outputs: { 'card:messages': { forged: true } } }; }
    return result;
  }
}
async function engineMessageFixture(audience: OutputContract['audience'] = 'public') {
  const f = await fixture(), { session } = f;
  session.roles[1].name = 'Morgan'; session.roles[1].presence = 'absent'; session.roles[1].interaction = { mode: 'remote', channel: 'message' };
  session.roles.push({ ...clone(session.roles[1]), id: 'other', name: 'River' });
  session.roles[0].peers = ['npc', 'other']; session.card.roles = clone(session.roles);
  session.card.outputs = [messageOutput({ audience })];
  event(session, { kind: 'role-result', actor: 'npc', audience: 'author', text: 'PRIVATE_NON_MESSAGE_SOURCE' });
  f.store.save(session);
  const provider = new MessageOutputProvider(), engine = new TurnEngine(f.store, provider);
  cleanups.push(() => engine.close());
  return { ...f, provider, engine };
}
const transcript = (session: StoredSession) => session.prose.at(-1)!.attachments!.find(item => item.key === 'card:messages')!;
const hostMessageEvents = (session: StoredSession) => session.events.filter(item => item.kind === 'host-output');

describe('approved-message outputs at the actual engine boundary', () => {
  it('keeps UI transcripts visible through the API while excluding their events and attachments from later model material, conditions and role tools', async () => {
    const f = await engineMessageFixture(), sentinel = 'UI_HOST_MESSAGE_SENTINEL';
    f.session.card.outputs![0].title = sentinel; f.store.save(f.session);
    f.engine.submit(f.id, { requestId: 'ui-record-first', expectedRevision: 0, mode: 'action', action: 'Read the inbox.' });
    await f.engine.idle(f.id);
    const first = f.store.get(f.id), uiEvent = clone(hostMessageEvents(first)[0]), uiAttachment = clone(transcript(first));
    expect(first.turns.at(-1)!.status).toBe('completed');
    const behaviors = clone(first.events.filter(item => item.kind === 'role-behavior').map(item => item.data));
    // These guards would match the API view. They must not match any model-facing view.
    expect(project(first, 'player').events).toContainEqual(uiEvent);
    expect(project(first, 'npc').prose[0].attachments).toContainEqual(uiAttachment);
    const changed = clone(first);
    changed.card.outputs![0].required = false; // Preview has no committed-material context; its optional host output is out of scope.
    changed.card.modules = (['role', 'world', 'prose'] as const).map(target => ({ id: `ui-event-guard-${target}`, title: 'UI event guard',
      category: 'supplement', content: `UI_EVENT_GUARD_DELIVERED_${target}`, enabled: true, targets: [target],
      phase: target === 'role' ? 'decide' : target === 'world' ? 'coordinate' : 'compose', priority: 1,
      condition: { path: 'events', op: 'contains', value: uiEvent as any } }));
    changed.card.modules.push({ id: 'ui-attachment-guard-role', title: 'UI attachment guard', category: 'supplement', content: 'UI_ATTACHMENT_GUARD_DELIVERED',
      enabled: true, targets: ['role'], phase: 'decide', priority: 2,
      condition: { path: 'prose.0.attachments', op: 'contains', value: uiAttachment as any } });
    changed.card.modules.push({ id: 'ui-keyword-guard-prose', title: 'UI keyword guard', category: 'supplement', content: 'UI_KEYWORD_GUARD_DELIVERED',
      enabled: true, targets: ['prose'], phase: 'compose', priority: 3, activation: { keys: [sentinel] } });
    changed.agentRuntime = { profile: 'full', modules: { 'test.filtered-ui-reader': true } };
    f.store.save(changed); await f.engine.close();
    const toolViews: unknown[] = [];
    const reader: AgentModule = { meta: { id: 'test.filtered-ui-reader', title: 'Filtered view reader', version: '1.0.0', apiVersion: 'rp.agent-module/0.1', requires: ['rp.role-agents'] },
      roleTools: context => [{ name: 'read_filtered_view', description: 'Read the permitted role view.',
        parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: () => clone(context.view) }] };
    const provider = new MessageOutputProvider(), run = provider.run.bind(provider);
    provider.run = async request => {
      if (request.kind === 'role') {
        const tool = request.tools.find(tool => tool.name === 'read_filtered_view');
        if (tool) toolViews.push(await tool.execute({}));
      }
      return run(request);
    };
    const service = await createApp({ dataRoot: f.root, provider, agentModules: [reader], catalog: async () => ({ cards: [f.card], presets: [f.preset] }) });
    cleanups.push(service.close);
    const server = service.app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected loopback listener');
    const base = `http://127.0.0.1:${address.port}`;
    const api = await fetch(`${base}/api/sessions/${f.id}?perspective=player`), apiView = await api.json() as any;
    expect(api.status).toBe(200);
    expect(apiView.events).toContainEqual(uiEvent); expect(apiView.prose[0].attachments).toContainEqual(uiAttachment);
    expect(JSON.stringify(publicPromptView(service.store.get(f.id)))).not.toMatch(/host-output|rp\.host-output\/0\.1|card:messages|rp\.approved-messages\/0\.1/);
    for (const target of ['role', 'world', 'prose'] as const) {
      const preview = await service.engine.preview(f.id, { target, ...(target === 'role' ? { roleId: 'npc' } : {}) });
      expect(preview.valid).toBe(true);
      expect(preview.modules.some(item => item.ref.moduleId.startsWith('ui-'))).toBe(false);
    }
    service.engine.submit(f.id, { requestId: 'ui-record-recompose', expectedRevision: service.store.get(f.id).revision, mode: 'author', action: 'Recompose the committed inbox.' });
    await service.engine.idle(f.id);
    expect(service.store.get(f.id).turns.at(-1)!.status).toBe('completed');
    const recompose = provider.calls.find(call => call.kind === 'prose')!;
    expect((recompose.input as any).acceptedBehaviors).toEqual(behaviors);
    expect((recompose.input as any).events.filter((item: any) => item.kind === 'role-behavior').map((item: any) => item.data)).toEqual(behaviors);
    service.engine.submit(f.id, { requestId: 'ui-record-next-world', expectedRevision: service.store.get(f.id).revision, mode: 'action', action: 'Check the inbox again.' });
    await service.engine.idle(f.id);
    expect(service.store.get(f.id).turns.at(-1)!.status).toBe('completed');
    expect(provider.calls.filter(call => call.kind === 'world')).toHaveLength(1);
    expect(toolViews).toHaveLength(2);
    for (const call of provider.calls) {
      expect(JSON.stringify(call.input)).not.toMatch(/host-output|rp\.host-output\/0\.1|card:messages|rp\.approved-messages\/0\.1|UI_HOST_MESSAGE_SENTINEL/);
      expect(JSON.stringify({ system: call.system, layout: call.promptLayout })).not.toMatch(/UI_EVENT_GUARD_DELIVERED|UI_ATTACHMENT_GUARD_DELIVERED|UI_KEYWORD_GUARD_DELIVERED/);
    }
    for (const view of toolViews) {
      expect(JSON.stringify(view)).not.toMatch(/host-output|rp\.host-output\/0\.1|card:messages|rp\.approved-messages\/0\.1|UI_HOST_MESSAGE_SENTINEL/);
      expect((view as any).events.some((item: any) => item.kind === 'role-behavior')).toBe(true);
    }
    const finalApi = await fetch(`${base}/api/sessions/${f.id}?perspective=player`), finalView = await finalApi.json() as any;
    expect(finalView.events.filter((item: any) => item.kind === 'host-output')).toHaveLength(3);
    expect(finalView.prose.every((entry: any) => entry.attachments.some((output: any) => output.key === 'card:messages'))).toBe(true);
  });

  it('enables a host-only messages contract without rebinding the prose context or changing model instructions, schema or committed actors', async () => {
    const f = await engineMessageFixture();
    f.session.card.outputs = []; f.store.save(f.session);
    f.engine.submit(f.id, { requestId: 'before-host-message-contract', expectedRevision: 0, mode: 'action', action: 'Read the inbox.' });
    await f.engine.idle(f.id);
    const before = f.store.get(f.id), firstProse = f.provider.calls.find(call => call.kind === 'prose')!;
    expect(before.turns.at(-1)!.status).toBe('completed'); expect(before.prose.at(-1)!.attachments ?? []).toHaveLength(0);
    const actors = runtimeFingerprint({ world: before.world, roles: before.roles }), context = clone(before.promptContexts!.prose);
    const roleCalls = f.provider.calls.filter(call => call.kind === 'role').length, worldCalls = f.provider.calls.filter(call => call.kind === 'world').length;
    const withMessages = clone(before); withMessages.card.outputs = [messageOutput()]; f.store.save(withMessages);
    f.engine.submit(f.id, { requestId: 'enable-host-message-contract', expectedRevision: withMessages.revision, mode: 'author', action: 'Recompose the same committed messages.' });
    await f.engine.idle(f.id);
    const after = f.store.get(f.id), secondProse = f.provider.calls.filter(call => call.kind === 'prose')[1];
    expect(after.turns.at(-1)!.status).toBe('completed');
    expect(after.promptContexts!.prose).toEqual(context);
    expect(secondProse.sessionId).toBe(firstProse.sessionId);
    expect(secondProse.system).toBe(firstProse.system);
    expect(secondProse.promptLayout).toEqual(firstProse.promptLayout);
    expect(secondProse.resultSchema).toEqual(firstProse.resultSchema);
    expect(runtimeFingerprint({ world: after.world, roles: after.roles })).toBe(actors);
    expect(f.provider.calls.filter(call => call.kind === 'role')).toHaveLength(roleCalls);
    expect(f.provider.calls.filter(call => call.kind === 'world')).toHaveLength(worldCalls);
    expect((transcript(after).value as any).messages).toHaveLength(3); expect(hostMessageEvents(after)).toHaveLength(1);
  });

  it('snapshots interleaved current approved messages before prose and recomposes the same material after actors move and the store restarts', async () => {
    const f = await engineMessageFixture();
    f.engine.submit(f.id, { requestId: 'message-first', expectedRevision: 0, mode: 'action', action: 'Read the inbox.' });
    await f.engine.idle(f.id);
    const first = f.store.get(f.id), materialTurnId = first.turns.at(-1)!.id, attachment = transcript(first);
    expect(first.turns.at(-1)!.status).toBe('completed'); expect(first.world.variables.count).toBe(8);
    expect((attachment.value as any).messages.map((item: any) => [item.name, item.text])).toEqual([['Morgan', 'Morgan first.'], ['River', 'River middle.'], ['Morgan', 'Morgan last.']]);
    expect(attachment.provenance).toMatchObject({ kind: 'committed-behaviors', materialTurnId, worldRevision: 1 });
    expect(runtimeFingerprint((hostMessageEvents(first)[0].data as any).output)).toBe(runtimeFingerprint(attachment));
    expect(hostMessageEvents(first)[0]).toMatchObject({ actor: 'host', turnId: materialTurnId, audience: 'public', data: { schema: 'rp.host-output/0.1' } });
    expect(JSON.stringify(attachment)).not.toMatch(/Rejected|PRIVATE_|Summary is not/);
    expect(f.provider.calls.filter(call => call.kind === 'prose').every(call => !(call.resultSchema as any).properties.outputs)).toBe(true);
    const messages = clone((attachment.value as any).messages);
    f.store.lifecycle(f.id, { expectedRevision: first.revision, roleId: 'npc', phase: 'active', presence: 'present' });
    await f.engine.close();
    const reopened = new SessionStore(f.root), provider = new MessageOutputProvider(), resumed = new TurnEngine(reopened, provider);
    cleanups.push(() => resumed.close());
    expect(runtimeFingerprint(transcript(reopened.get(f.id)))).toBe(runtimeFingerprint(attachment));
    resumed.submit(f.id, { requestId: 'message-recompose', expectedRevision: reopened.get(f.id).revision, mode: 'author', action: 'Recompose the committed inbox.' });
    await resumed.idle(f.id);
    const recovered = reopened.get(f.id), recomposed = transcript(recovered);
    expect(recovered.turns.at(-1)!.status).toBe('completed'); expect(provider.calls.map(call => call.kind)).toEqual(['prose']);
    expect((recomposed.value as any).messages).toEqual(messages);
    expect(recomposed.provenance).toMatchObject({ kind: 'committed-behaviors', materialTurnId, worldRevision: recovered.revision });
    expect(hostMessageEvents(recovered)).toHaveLength(2);
    expect(runtimeFingerprint((hostMessageEvents(recovered)[1].data as any).output)).toBe(runtimeFingerprint(recomposed));
    expect(runtimeFingerprint(transcript(first))).toBe(runtimeFingerprint(attachment));
  });

  it('keeps world and public messages committed on writer failure or forged output, then recovers after restart without another role/world run', async () => {
    for (const failure of ['throw', 'forged-key'] as const) {
      const f = await engineMessageFixture();
      f.provider.failWriterOnce = failure === 'throw'; f.provider.forgeHostKeyOnce = failure === 'forged-key';
      f.engine.submit(f.id, { requestId: `message-failed-${failure}`, expectedRevision: 0, mode: 'action', action: 'Read the inbox.' });
      await f.engine.idle(f.id);
      const failed = f.store.get(f.id), materialTurnId = failed.turns.at(-1)!.id;
      expect(failed.turns.at(-1)!.status).toBe('failed'); expect(failed.revision).toBe(1); expect(failed.world.variables.count).toBe(8);
      expect(failed.prose).toHaveLength(0); expect(hostMessageEvents(failed)).toHaveLength(1);
      const pending = clone((hostMessageEvents(failed)[0].data as any).output);
      expect((pending.value as any).messages).toHaveLength(3);
      expect(project(failed, 'player').events.filter(item => item.kind === 'host-output')).toHaveLength(1);
      await f.engine.close();
      const reopened = new SessionStore(f.root), provider = new MessageOutputProvider(), resumed = new TurnEngine(reopened, provider);
      cleanups.push(() => resumed.close());
      resumed.submit(f.id, { requestId: `message-recovered-${failure}`, expectedRevision: reopened.get(f.id).revision, mode: 'author', action: 'Recover prose from committed material.' });
      await resumed.idle(f.id);
      const recovered = reopened.get(f.id);
      expect(recovered.turns.at(-1)!.status).toBe('completed'); expect(provider.calls.map(call => call.kind)).toEqual(['prose']);
      expect(runtimeFingerprint(transcript(recovered))).toBe(runtimeFingerprint(pending));
      expect(transcript(recovered).provenance).toMatchObject({ kind: 'committed-behaviors', materialTurnId });
      expect(hostMessageEvents(recovered)).toHaveLength(2); expect(recovered.revision).toBe(1);
    }
  });

  it('retains author-only output audiences on prewriter events and emits no host output when the capability is disabled', async () => {
    const privateOutput = await engineMessageFixture('author'); privateOutput.provider.failWriterOnce = true;
    privateOutput.engine.submit(privateOutput.id, { requestId: 'author-message-output', expectedRevision: 0, mode: 'action', action: 'Read the inbox.' });
    await privateOutput.engine.idle(privateOutput.id);
    const failed = privateOutput.store.get(privateOutput.id);
    expect(hostMessageEvents(failed)[0].audience).toBe('author');
    expect(project(failed, 'author').events.filter(item => item.kind === 'host-output')).toHaveLength(1);
    expect(project(failed, 'player').events.filter(item => item.kind === 'host-output')).toHaveLength(0);
    const disabled = await engineMessageFixture();
    disabled.session.agentRuntime = { profile: 'full', modules: { 'rp.auxiliary-outputs': false } }; disabled.store.save(disabled.session);
    disabled.engine.submit(disabled.id, { requestId: 'disabled-message-output', expectedRevision: 0, mode: 'action', action: 'Read the inbox.' });
    await disabled.engine.idle(disabled.id);
    const current = disabled.store.get(disabled.id);
    expect(current.turns.at(-1)!.status).toBe('completed'); expect(hostMessageEvents(current)).toHaveLength(0);
    expect(current.prose.at(-1)!.attachments ?? []).toHaveLength(0);
  });
});
