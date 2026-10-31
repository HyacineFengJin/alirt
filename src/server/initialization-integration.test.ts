import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, InitializationSelection, Preset } from '../shared/types';
import type { StateChange } from '../shared/state-rules';
import { createApp } from './app';
import type { AgentRequest, ModelProvider } from './engine';
import { clone, project, SessionStore } from './store';
import { initializationContext } from './initialization-runtime';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** The real engine and loopback HTTP, with deterministic results and no external model. */
class RecordingProvider implements ModelProvider {
  calls: AgentRequest[] = [];
  changes: StateChange[] = [];
  failWorldOnce = false;
  failProseOnce = false;
  roleResult: any = { summary: 'The keeper listens.', expression: 'Welcome back.', proposals: [] };
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request);
    if (request.kind === 'role') return clone(this.roleResult);
    if (request.kind === 'world') {
      if (this.failWorldOnce) { this.failWorldOnce = false; throw new Error('Deterministic pre-commit world failure'); }
      return { summary: 'The station remains quiet.', changes: clone(this.changes), events: ['A public bell sounds.'], acceptedBehaviorIds: (request.input as any).behaviorCandidates.map((candidate: { id: string }) => candidate.id) };
    }
    if (request.kind === 'prose') {
      if (this.failProseOnce) { this.failProseOnce = false; throw new Error('Deterministic post-commit prose failure'); }
      return { title: 'The station', text: 'The keeper hears a distant bell.', person: 'third', pov: 'limited' };
    }
    throw new Error('Creator models are outside this test');
  }
}

function documents() {
  const card = createNativeTemplate('card') as CharacterCard;
  const preset = createNativeTemplate('preset') as Preset;
  card.id = 'initialization-card'; preset.id = 'initialization-preset';
  card.opening = 'The legacy opening.';
  card.fields = [
    { key: 'score', label: 'Score', type: 'number', min: 0, max: 10, editable: true, audience: 'public' },
    { key: 'presence', label: 'Presence', type: 'boolean', editable: true, audience: 'public' },
    { key: 'secret', label: 'Private note', type: 'string', editable: true, audience: 'author' },
  ];
  card.world = { location: 'Old square', time: 'Morning', variables: {} };
  card.roles[0].state = { score: 1, presence: true, secret: 'BASE_PRIVATE_NOTE' };
  card.roles[0].peers = ['keeper', 'distant'];
  card.roles.push(
    { id: 'keeper', name: 'Keeper', persona: 'A patient station keeper.', goals: [], peers: ['player'], phase: 'active', presence: 'present', state: { score: 2, presence: true, secret: 'KEEPER_PRIVATE_NOTE' }, knowledge: [] },
    { id: 'distant', name: 'Distant visitor', persona: 'A quiet visitor.', goals: [], peers: ['player'], phase: 'active', presence: 'present', state: { score: 3, presence: true, secret: 'DISTANT_PRIVATE_NOTE' }, knowledge: [] },
  );
  card.roles.forEach(role => role.stateMirrors = { presence: 'presence' });
  card.initialization = {
    schema: 'rp.initialization/0.1',
    openings: [
      { id: 'station', title: 'Station arrival', text: 'Rain taps against the station window.', instruction: 'PRIVATE_STATION_PREMISE: the lost parcel is still sealed.',
        world: { location: 'Station', time: 'Evening' },
        cast: [{ roleId: 'player', phase: 'active', presence: 'present' }, { roleId: 'keeper', phase: 'active', presence: 'present' }, { roleId: 'distant', phase: 'dormant', presence: 'absent' }],
        state: [{ roleId: 'player', key: 'score', value: 7 }] },
      { id: 'garden', title: 'Garden arrival', text: 'Sunlight falls over a quiet garden.', instruction: 'PRIVATE_GARDEN_PREMISE: keep the seed packet closed.',
        world: { location: 'Garden', time: 'Noon' },
        cast: [{ roleId: 'player', phase: 'active', presence: 'present' }, { roleId: 'keeper', phase: 'dormant', presence: 'absent' }, { roleId: 'distant', phase: 'active', presence: 'present' }],
        state: [{ roleId: 'player', key: 'score', value: 8 }] },
    ],
    playerProfiles: [
      { id: 'traveler', title: 'Traveler', name: 'Aster', persona: 'PRIVATE_TRAVELER_PERSONA: an archivist returning to find an old friend.', state: [{ roleId: 'player', key: 'score', value: 4 }, { roleId: 'player', key: 'secret', value: 'PRIVATE_TRAVELER_NOTE' }] },
      { id: 'gardener', title: 'Gardener', name: 'Robin', persona: 'PRIVATE_GARDENER_PERSONA: a botanist seeking a borrowed field guide.', state: [{ roleId: 'player', key: 'score', value: 5 }, { roleId: 'player', key: 'secret', value: 'PRIVATE_GARDENER_NOTE' }] },
    ],
  };
  return { card, preset };
}
const chosen: InitializationSelection = { openingId: 'station', playerProfileId: 'gardener' };

function subsetDocuments() {
  const input = documents(), opening = input.card.initialization!.openings[0];
  opening.id = 'custom-message'; opening.text = '';
  opening.instruction = 'Message senders: [[sender-names]].';
  opening.delivery = { world: 'Messages from [[sender-names]].', prose: 'Present messages from [[sender-names]].' };
  opening.cast = opening.cast.map(member => member.roleId === 'player' ? member
    : { roleId: member.roleId, phase: 'dormant', presence: 'absent', interaction: { mode: 'remote', channel: 'audio' } });
  opening.roleSelection = { kind: 'role-subset', roleIds: ['keeper', 'distant'], min: 1, max: 2,
    nameToken: '[[sender-names]]', nameSeparator: ', ', selected: { phase: 'active', presence: 'absent', interaction: { mode: 'remote', channel: 'message' } },
    unselected: { phase: 'dormant', presence: 'absent' }, selectedState: [{ key: 'score', value: 9 }] };
  return input;
}

async function fixture(input = documents(), existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'rp-initialization-integration-'));
  if (!existingRoot) cleanups.push(() => rm(root, { recursive: true, force: true }));
  const provider = new RecordingProvider(), { card, preset } = input;
  const service = await createApp({ dataRoot: root, provider, catalog: async () => ({ cards: [card], presets: [preset] }) });
  cleanups.push(service.close);
  let server: Server | undefined, base = '', sequence = 0;
  const api = async (path: string, body?: unknown) => {
    if (!server) {
      server = service.app.listen(0, '127.0.0.1');
      await new Promise<void>(resolve => server!.once('listening', resolve));
      cleanups.push(() => new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected loopback address');
      base = `http://127.0.0.1:${address.port}`;
    }
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const turn = async (id: string, action = 'Look at the station clock.') => {
    service.engine.submit(id, { requestId: `initialization-turn-${++sequence}-${randomUUID()}`, expectedRevision: service.store.get(id).revision, mode: 'action', action });
    await service.engine.idle(id);
    expect(service.store.get(id).turns.at(-1)?.status).toBe('completed');
  };
  const files = async () => (await readdir(root)).filter(name => name.startsWith('session-'));
  return { ...service, root, card, preset, provider, api, turn, files };
}
const worlds = (provider: RecordingProvider) => provider.calls.filter(call => call.kind === 'world');
const player = (session: ReturnType<SessionStore['get']>) => session.roles.find(role => role.id === session.playerRoleId)!;

describe('explicit story initialization across HTTP, engine and persisted sessions', () => {
  it('creates a typed role subset over HTTP and retains resolved setup across first turn and restart without replaying state', async () => {
    const f = await fixture(subsetDocuments()), original = clone(f.card);
    const created = await f.api('/api/sessions', { cardId: f.card.id, presetId: f.preset.id, openingId: 'custom-message', playerProfileId: 'gardener', selectedRoleIds: ['distant'] });
    expect(created.status).toBe(201);
    const id = created.body.id, current = f.store.get(id), receipt = clone(current.initialization!);
    expect(current.roles.filter(role => role.presence === 'present').map(role => role.id)).toEqual(['player']);
    expect(current.roles.find(role => role.id === 'distant')).toMatchObject({ phase: 'active', presence: 'absent', interaction: { mode: 'remote', channel: 'message' }, state: { score: 9, presence: false } });
    expect(current.roles.find(role => role.id === 'keeper')).toMatchObject({ phase: 'dormant', presence: 'absent', state: { score: 2, presence: false } });
    expect(current.roles.find(role => role.id === 'keeper')).not.toHaveProperty('interaction');
    expect(receipt.selectedRoleIds).toEqual(['distant']);
    expect(receipt.resolvedOpening?.instruction).toBe('Message senders: Distant visitor.');
    expect(receipt.resolvedOpening).not.toHaveProperty('roleSelection');
    expect(f.card).toEqual(original); expect(current.card).toEqual(original); expect(f.provider.calls).toHaveLength(0);
    const persisted = JSON.parse(await readFile(join(f.root, `session-${id}.json`), 'utf8'));
    expect(persisted.initialization).toEqual(receipt);
    const reopened = new SessionStore(f.root), beforeRead = await readFile(join(f.root, `session-${id}.json`), 'utf8');
    expect(initializationContext(reopened.get(id))?.opening.instruction).toBe('Message senders: Distant visitor.');
    expect(await readFile(join(f.root, `session-${id}.json`), 'utf8')).toBe(beforeRead);
    f.provider.roleResult = { public: { summary: '', speech: [], actions: [], transmission: { channel: 'message', content: [] } }, proposals: [] };
    await f.turn(id);
    expect((worlds(f.provider)[0].input as any).openingSetup).toEqual({ openingId: 'custom-message', instruction: 'Messages from Distant visitor.' });
    expect((f.provider.calls.find(call => call.kind === 'prose')!.input as any).openingDelivery.instruction).toBe('Present messages from Distant visitor.');
    f.store.edit(id, { expectedRevision: f.store.get(id).revision, roleId: 'distant', key: 'score', value: 6, reason: 'Retain a later author correction.' });
    const resumed = await fixture({ card: f.card, preset: f.preset }, f.root);
    expect(resumed.store.get(id).initialization).toEqual(receipt); expect(resumed.provider.calls).toHaveLength(0);
    expect(resumed.store.get(id).roles.find(role => role.id === 'distant')!.state.score).toBe(6);
    resumed.provider.roleResult = f.provider.roleResult;
    await resumed.turn(id);
    expect(worlds(resumed.provider)[0].input).not.toHaveProperty('openingSetup');
    expect(resumed.provider.calls.at(-1)!.input).not.toHaveProperty('openingDelivery');
    expect(resumed.store.get(id).roles.find(role => role.id === 'distant')!.state.score).toBe(6);
  });

  it('rejects missing, empty, duplicate, unavailable, out-of-set and malformed subsets before creating any file', async () => {
    const f = await fixture(subsetDocuments());
    for (const extra of [{}, ...[[], ['keeper', 'keeper'], ['missing'], ['player'], ['keeper', 'distant', 'missing'], ['keeper', 2], 'keeper', null, {}].map(selectedRoleIds => ({ selectedRoleIds }))]) {
      const response = await f.api('/api/sessions', { cardId: f.card.id, presetId: f.preset.id, openingId: 'custom-message', playerProfileId: 'gardener', ...extra });
      expect(response.status).toBe(400);
    }
    const ordinary = await f.api('/api/sessions', { cardId: f.card.id, presetId: f.preset.id, openingId: 'garden', playerProfileId: 'gardener', selectedRoleIds: ['keeper'] });
    expect(ordinary.status).toBe(400); expect(await f.files()).toEqual([]); expect(f.provider.calls).toHaveLength(0);
    for (const mutate of [
      (card: CharacterCard) => { card.initialization!.openings[0].roleSelection!.min = 0; },
      (card: CharacterCard) => { card.initialization!.openings[0].roleSelection!.max = 3; },
      (card: CharacterCard) => { card.initialization!.openings[0].roleSelection!.min = 2; card.initialization!.openings[0].roleSelection!.max = 1; },
      (card: CharacterCard) => { card.initialization!.openings[0].roleSelection!.roleIds.push('keeper'); },
      (card: CharacterCard) => { card.roles.find(role => role.id === 'keeper')!.phase = 'retired'; },
      (card: CharacterCard) => { card.initialization!.openings[0].roleSelection!.roleIds[0] = 'player'; },
      (card: CharacterCard) => { card.initialization!.openings[0].roleSelection!.nameToken = ''; },
      (card: CharacterCard) => { card.initialization!.openings[0].roleSelection!.selectedState = [{ key: 'undeclared', value: 1 }]; },
      (card: CharacterCard) => { card.initialization!.openings[0].roleSelection!.selectedState = [{ key: 'score', value: 'wrong' }]; },
    ]) {
      const original = clone(f.card); mutate(f.card);
      expect((await f.api('/api/sessions', { cardId: f.card.id, presetId: f.preset.id, openingId: 'custom-message', playerProfileId: 'gardener', selectedRoleIds: ['keeper'] })).status).toBe(400);
      Object.assign(f.card, original);
    }
    expect(await f.files()).toEqual([]);
  });

  it('preserves requested subset order and rejects tampered subset receipts or template definitions without writing', async () => {
    const f = await fixture(subsetDocuments());
    const id = f.store.create(f.card, f.preset, { openingId: 'custom-message', playerProfileId: 'gardener', selectedRoleIds: ['distant', 'keeper'] }).id;
    const session = f.store.get(id);
    expect(session.initialization!.selectedRoleIds).toEqual(['distant', 'keeper']);
    expect(initializationContext(session)!.opening.instruction).toBe('Message senders: Distant visitor, Keeper.');
    const unchanged = JSON.stringify(session);
    for (const mutate of [
      (value: typeof session) => { value.initialization!.selectedRoleIds = ['keeper']; },
      (value: typeof session) => { value.initialization!.resolvedOpening!.instruction = 'Forged sender.'; },
      (value: typeof session) => { value.card.initialization!.openings[0].roleSelection!.nameSeparator = ' / '; },
      (value: typeof session) => { (value.initialization as any).selectedRoleIds = ['keeper', null]; },
    ]) { const copy = clone(session); mutate(copy); expect(() => initializationContext(copy)).toThrow(); }
    expect(JSON.stringify(session)).toBe(unchanged); expect(f.provider.calls).toHaveLength(0);
  });

  it('combines independent choices, applies profile defaults before opening overrides, and records the unchanged definition', async () => {
    const f = await fixture(), original = clone(f.card);
    const created = await f.api('/api/sessions', { cardId: f.card.id, presetId: f.preset.id, ...chosen });
    expect(created.status).toBe(201);
    const current = f.store.get(created.body.id);
    expect(player(current)).toMatchObject({ id: 'player', name: 'Robin', persona: f.card.initialization!.playerProfiles[1].persona, state: { score: 7, secret: 'PRIVATE_GARDENER_NOTE', presence: true } });
    expect(current.world).toEqual({ location: 'Station', time: 'Evening', variables: {} });
    expect(current.prose[0].text).toBe(f.card.initialization!.openings[0].text);
    expect(current.roles.map(role => [role.id, role.phase, role.presence, role.state.presence])).toEqual([
      ['player', 'active', 'present', true], ['keeper', 'active', 'present', true], ['distant', 'dormant', 'absent', false],
    ]);
    expect(current.initialization).toMatchObject({ schema: 'rp.initialization-receipt/0.1', ...chosen, definitionHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(f.card).toEqual(original); expect(current.card).toEqual(original);
    expect(f.provider.calls).toHaveLength(0);
    const second = f.store.create(f.card, f.preset, { openingId: 'garden', playerProfileId: 'traveler' });
    expect(player(f.store.get(second.id))).toMatchObject({ name: 'Aster', state: { score: 8, secret: 'PRIVATE_TRAVELER_NOTE' } });
  });

  it('accepts valid explicit defaults and unique options while refusing ambiguous or null selections', async () => {
    const f = await fixture();
    expect(() => f.store.create(f.card, f.preset)).toThrow();
    expect(() => f.store.create(f.card, f.preset, { openingId: 'station' })).toThrow();
    f.card.initialization!.defaultOpeningId = 'garden'; f.card.initialization!.defaultPlayerProfileId = 'traveler';
    const defaults = f.store.create(f.card, f.preset);
    expect(f.store.get(defaults.id).initialization).toMatchObject({ openingId: 'garden', playerProfileId: 'traveler' });
    const nulls = await f.api('/api/sessions', { cardId: f.card.id, presetId: f.preset.id, openingId: null, playerProfileId: null });
    expect(nulls.status).toBe(400);
    f.card.initialization!.openings = [f.card.initialization!.openings[0]];
    f.card.initialization!.playerProfiles = [f.card.initialization!.playerProfiles[0]];
    delete f.card.initialization!.defaultOpeningId; delete f.card.initialization!.defaultPlayerProfileId;
    expect(f.store.get(f.store.create(f.card, f.preset).id).initialization).toMatchObject({ openingId: 'station', playerProfileId: 'traveler' });
  });

  it('rejects unknown IDs, incomplete casts, conflicting values and final invariant failures before any session is saved', async () => {
    const f = await fixture(), original = clone(f.card);
    const unknownProfile = await f.api('/api/sessions', { cardId: f.card.id, presetId: f.preset.id, ...chosen, playerProfileId: 'unknown' });
    expect(unknownProfile.status).toBe(400); expect(await f.files()).toEqual([]);
    const attempts: (() => void)[] = [
      () => {},
      () => { f.card.initialization!.openings[0].cast.pop(); },
      () => { f.card.initialization!.openings[0].state!.push({ roleId: 'player', key: 'presence', value: false }); },
      () => { f.card.initialization!.playerProfiles[1].state!.push({ roleId: 'player', key: 'presence', value: false }); },
      () => { f.card.initialization!.openings[0].state![0].value = 99; },
      () => { f.card.stateRules = [{ id: 'score-floor', type: 'invariant', condition: { path: 'roles.player.state.score', op: 'gte', value: 8 }, message: 'Initial score must be at least eight.' }]; },
    ];
    for (const [index, mutate] of attempts.entries()) {
      Object.assign(f.card, clone(original)); mutate();
      const response = await f.api('/api/sessions', { cardId: f.card.id, presetId: f.preset.id, ...chosen, ...(index === 0 ? { openingId: 'unknown' } : {}) });
      expect(response.status).toBe(400); expect(f.store.list()).toEqual([]); expect(await f.files()).toEqual([]);
    }
    expect(f.provider.calls).toHaveLength(0);
    Object.assign(f.card, clone(original)); delete f.card.stateRules;
    f.card.initialization!.playerProfiles[1].state!.push({ roleId: 'player', key: 'presence', value: false });
    f.card.initialization!.openings[0].state!.push({ roleId: 'player', key: 'presence', value: true });
    const overridden = await f.api('/api/sessions', { cardId: f.card.id, presetId: f.preset.id, ...chosen });
    expect(overridden.status).toBe(201);
    expect(player(f.store.get(overridden.body.id))).toMatchObject({ presence: 'present', state: { presence: true } });
    expect(f.store.list()).toHaveLength(1); expect(await f.files()).toHaveLength(1);
  });

  it('preserves legacy creation and rejects selection IDs when the card has no initialization definition', async () => {
    const input = documents(); delete input.card.initialization;
    const f = await fixture(input), original = clone(input.card);
    const accepted = await f.api('/api/sessions', { cardId: f.card.id, presetId: f.preset.id });
    expect(accepted.status).toBe(201);
    const current = f.store.get(accepted.body.id);
    expect(current.initialization).toBeUndefined(); expect(current.world).toEqual(original.world);
    expect(current.roles).toEqual(original.roles); expect(current.prose[0].text).toBe(original.opening);
    const rejected = await f.api('/api/sessions', { cardId: f.card.id, presetId: f.preset.id, ...chosen });
    expect(rejected.status).toBe(400); expect(f.store.list()).toHaveLength(1); expect(await f.files()).toHaveLength(1);
  });

  it('gives only the first uncommitted world turn the opening premise, rebinds world context and never resets edited state', async () => {
    const f = await fixture(), id = f.store.create(f.card, f.preset, chosen).id;
    f.provider.changes = [{ roleId: 'player', key: 'score', value: 4 }];
    await f.turn(id);
    const first = worlds(f.provider)[0], firstInput = first.input as any;
    expect(firstInput.playerProfile).toEqual({ name: 'Robin', persona: f.card.initialization!.playerProfiles[1].persona });
    expect(JSON.stringify(firstInput.openingPremise)).toContain('PRIVATE_STATION_PREMISE');
    expect(firstInput.playerControl).toEqual({ kind: 'user', roleId: 'player', authorizedAction: 'Look at the station clock.' });
    expect((f.provider.calls.find(call => call.kind === 'prose')!.input as any).playerControl).toMatchObject({ kind: 'user', roleId: 'player', authorizedAction: 'Look at the station clock.' });
    expect(player(f.store.get(id)).state.score).toBe(4);
    f.provider.changes = [];
    await f.turn(id, 'Read the public timetable.');
    const second = worlds(f.provider)[1];
    expect(second.input).not.toHaveProperty('openingPremise'); expect(second.sessionId).not.toBe(first.sessionId);
    expect(player(f.store.get(id)).state.score).toBe(4);
    const edited = await f.api(`/api/sessions/${id}/state`, { expectedRevision: f.store.get(id).revision, roleId: 'player', key: 'score', value: 6, reason: 'Author adjusts the current score.' });
    expect(edited.status).toBe(200);
    await f.turn(id);
    expect(worlds(f.provider)[2].input).not.toHaveProperty('openingPremise'); expect(player(f.store.get(id)).state.score).toBe(6);
    expect(f.provider.calls.filter(call => call.kind === 'role')).toHaveLength(3);
    for (const call of f.provider.calls.filter(call => call.kind === 'role')) {
      expect(call.sessionId).toContain('-role-keeper');
      expect(JSON.stringify(call.input)).toContain('Keeper');
    }
  });

  it('retains the opening premise after a failed world request until a world transaction actually commits', async () => {
    const f = await fixture(), id = f.store.create(f.card, f.preset, chosen).id;
    f.provider.failWorldOnce = true;
    f.engine.submit(id, { requestId: 'failed-first-world', expectedRevision: 0, mode: 'action', action: 'Look at the station clock.' });
    await f.engine.idle(id);
    expect(f.store.get(id).turns.at(-1)?.status).toBe('failed');
    expect(f.store.get(id).revision).toBe(0);
    expect(f.store.get(id).events.some(event => event.kind === 'world-adjudication')).toBe(false);
    await f.turn(id);
    expect(worlds(f.provider)).toHaveLength(2);
    for (const call of worlds(f.provider)) expect(JSON.stringify((call.input as any).openingPremise)).toContain('PRIVATE_STATION_PREMISE');
    await f.turn(id);
    expect(worlds(f.provider)[2].input).not.toHaveProperty('openingPremise');
  });

  it('retains the receipt and live edits across restart without replaying initialization or a model request', async () => {
    const f = await fixture(), id = f.store.create(f.card, f.preset, chosen).id;
    await f.turn(id);
    f.store.edit(id, { expectedRevision: f.store.get(id).revision, roleId: 'player', key: 'score', value: 6, reason: 'Keep this later value.' });
    const before = clone(f.store.get(id));
    await f.close();
    const reopened = await fixture({ card: f.card, preset: f.preset }, f.root);
    expect(reopened.store.get(id)).toEqual(before); expect(reopened.provider.calls).toHaveLength(0);
    const disk = JSON.parse(await readFile(join(f.root, `session-${id}.json`), 'utf8'));
    expect(disk.initialization).toEqual(before.initialization);
    await reopened.turn(id);
    expect(worlds(reopened.provider)[0].input).not.toHaveProperty('openingPremise');
    expect(player(reopened.store.get(id)).state.score).toBe(6);
  });

  it('keeps author-only initialization data and receipts outside role projections and prose dispatch', async () => {
    const f = await fixture(), id = f.store.create(f.card, f.preset, chosen).id;
    const roleView = project(f.store.get(id), 'keeper');
    expect(roleView).not.toHaveProperty('initialization'); expect(JSON.stringify(roleView)).not.toMatch(/PRIVATE_GARDENER|PRIVATE_STATION_PREMISE|definitionHash/);
    await f.turn(id);
    for (const call of f.provider.calls.filter(call => call.kind !== 'world')) {
      expect(call.input).not.toHaveProperty('playerProfile'); expect(call.input).not.toHaveProperty('openingPremise');
      expect(JSON.stringify({ input: call.input, system: call.system, layout: call.promptLayout })).not.toMatch(/PRIVATE_GARDENER|PRIVATE_STATION_PREMISE|definitionHash|rp\.initialization/);
    }
    expect(JSON.stringify(f.store.get(id).prose)).not.toMatch(/PRIVATE_GARDENER|PRIVATE_STATION_PREMISE|definitionHash/);
    expect(project(f.store.get(id))).toHaveProperty('initialization');
  });

  it('routes only explicit selected instructions, preserves source text and consumes opening delivery once', async () => {
    const input = documents(), opening = input.card.initialization!.openings[0];
    opening.delivery = { world: 'WORLD_SELECTED: establish only the sealed parcel.', prose: 'PROSE_SELECTED: describe the committed scene in restrained third person.' };
    opening.source = { importId: 'private-original', sourceHash: 'a'.repeat(64), pointer: '/PRIVATE_UNSELECTED_SOURCE' };
    const original = clone(opening), f = await fixture(input), id = f.store.create(f.card, f.preset, chosen).id;
    await f.turn(id);
    const world = worlds(f.provider)[0], prose = f.provider.calls.find(call => call.kind === 'prose')!;
    expect((world.input as any).openingSetup).toEqual({ openingId: 'station', instruction: opening.delivery.world });
    expect(world.input).not.toHaveProperty('openingPremise');
    expect(JSON.stringify(world.input)).not.toMatch(/PRIVATE_STATION_PREMISE|PROSE_SELECTED|PRIVATE_UNSELECTED_SOURCE/);
    expect((prose.input as any).openingDelivery).toEqual({ id: expect.any(String), openingId: 'station', instruction: opening.delivery.prose });
    expect(JSON.stringify(prose.input)).not.toMatch(/WORLD_SELECTED|PRIVATE_STATION_PREMISE|PRIVATE_UNSELECTED_SOURCE/);
    for (const call of f.provider.calls.filter(call => call.kind === 'role')) expect(JSON.stringify(call.input)).not.toMatch(/WORLD_SELECTED|PROSE_SELECTED|PRIVATE_STATION_PREMISE/);
    expect(f.store.get(id).card.initialization!.openings[0]).toEqual(original);
    expect(project(f.store.get(id), 'keeper').events.some(event => event.kind.startsWith('opening-deliver'))).toBe(false);
    await f.turn(id);
    expect(worlds(f.provider)[1].input).not.toHaveProperty('openingSetup');
    const secondProse = f.provider.calls.filter(call => call.kind === 'prose')[1];
    expect(secondProse.input).not.toHaveProperty('openingDelivery');
    expect(secondProse.sessionId).not.toBe(prose.sessionId);
    f.engine.submit(id, { requestId: 'consumed-author', expectedRevision: f.store.get(id).revision, mode: 'author', action: 'Describe the latest scene again.' });
    await f.engine.idle(id);
    expect(f.provider.calls.at(-1)!.input).not.toHaveProperty('openingDelivery');
  });

  it('resumes a failed opening writer after restart with the same delivery and committed world, then consumes it', async () => {
    const input = documents();
    input.card.initialization!.openings[0].delivery = { world: 'Setup selected.', prose: 'Writing selected.' };
    const f = await fixture(input), id = f.store.create(f.card, f.preset, chosen).id;
    f.provider.failProseOnce = true;
    f.engine.submit(id, { requestId: 'fail-opening-prose', expectedRevision: 0, mode: 'action', action: 'Read the public clock.' });
    await f.engine.idle(id);
    expect(f.store.get(id).turns.at(-1)).toMatchObject({ status: 'failed', phase: 'compose-failed' });
    expect(f.store.get(id).revision).toBe(1);
    const failedWriter = f.provider.calls.find(call => call.kind === 'prose')!;
    const delivery = (failedWriter.input as any).openingDelivery;
    await f.close();
    const resumed = await fixture(input, f.root);
    resumed.engine.submit(id, { requestId: 'recover-opening-prose', expectedRevision: 1, mode: 'author', action: 'Write the committed scene.' });
    await resumed.engine.idle(id);
    expect(resumed.store.get(id).turns.at(-1)?.status).toBe('completed');
    expect(resumed.provider.calls.map(call => call.kind)).toEqual(['prose']);
    expect((resumed.provider.calls[0].input as any).openingDelivery).toEqual(delivery);
    expect((resumed.provider.calls[0].input as any).playerControl.authorizedAction).toBe('Read the public clock.');
    expect(resumed.store.get(id).revision).toBe(1);
    resumed.engine.submit(id, { requestId: 'repeat-author-after-consumption', expectedRevision: 1, mode: 'author', action: 'Write it again.' });
    await resumed.engine.idle(id);
    expect(resumed.provider.calls.at(-1)!.input).not.toHaveProperty('openingDelivery');
  });

  it('does not reuse a failed opening delivery after newer world material commits', async () => {
    const input = documents(); input.card.initialization!.openings[0].delivery = { prose: 'ONLY_FIRST_SCENE' };
    const f = await fixture(input), id = f.store.create(f.card, f.preset, chosen).id;
    f.provider.failProseOnce = true;
    f.engine.submit(id, { requestId: 'obsolete-opening', expectedRevision: 0, mode: 'action', action: 'Read the clock.' });
    await f.engine.idle(id);
    await f.turn(id, 'Look at the platform.');
    expect(f.provider.calls.filter(call => call.kind === 'prose')[1].input).not.toHaveProperty('openingDelivery');
    f.engine.submit(id, { requestId: 'latest-only-author', expectedRevision: 2, mode: 'author', action: 'Describe the latest material.' });
    await f.engine.idle(id);
    expect(f.provider.calls.at(-1)!.input).not.toHaveProperty('openingDelivery');
    expect(worlds(f.provider)).toHaveLength(2);
  });

  it('treats an empty explicit delivery as deliberate isolation and retries setup only before commit', async () => {
    const input = documents(); input.card.initialization!.openings[0].delivery = {};
    const f = await fixture(input), id = f.store.create(f.card, f.preset, chosen).id;
    await f.turn(id);
    expect(worlds(f.provider)[0].input).not.toHaveProperty('openingPremise');
    expect(worlds(f.provider)[0].input).not.toHaveProperty('openingSetup');
    expect(f.provider.calls.at(-1)!.input).not.toHaveProperty('openingDelivery');
    const retryInput = documents(); retryInput.card.initialization!.openings[0].delivery = { world: 'EXPLICIT_SETUP_RETRY' };
    const retry = await fixture(retryInput), retryId = retry.store.create(retry.card, retry.preset, chosen).id;
    retry.provider.failWorldOnce = true;
    retry.engine.submit(retryId, { requestId: 'first-failed-setup', expectedRevision: 0, mode: 'action', action: 'Look around.' });
    await retry.engine.idle(retryId);
    expect(retry.store.get(retryId).events.some(event => event.kind === 'opening-delivery')).toBe(false);
    await retry.turn(retryId);
    expect(worlds(retry.provider).map(call => (call.input as any).openingSetup.instruction)).toEqual(['EXPLICIT_SETUP_RETRY', 'EXPLICIT_SETUP_RETRY']);
  });

  it('routes explicit public role behavior to world/prose and keeps private memo and legacy internals author-only during recovery', async () => {
    const f = await fixture(), id = f.store.create(f.card, f.preset, chosen).id;
    f.provider.roleResult = { summary: 'PRIVATE_LEGACY_SUMMARY', expression: 'PRIVATE_LEGACY_EXPRESSION', decisionMemo: 'PRIVATE_OPERATIONAL_NOTE',
      public: { summary: 'Keeper points at the timetable.', speech: ['The next train is at dusk.'], actions: ['Points at the timetable.'] }, proposals: [{ roleId: 'keeper', key: 'score', value: 2, privateExtra: 'PRIVATE_OPERATIONAL_PROPOSAL_EXTRA' }] };
    f.provider.failProseOnce = true;
    f.engine.submit(id, { requestId: 'public-role-first', expectedRevision: 0, mode: 'action', action: 'Read the clock.' });
    await f.engine.idle(id);
    const world = worlds(f.provider)[0], firstProse = f.provider.calls.find(call => call.kind === 'prose')!;
    expect((world.input as any).results[0]).toEqual({ roleId: 'keeper', proposals: [{ roleId: 'keeper', key: 'score', value: 2 }] });
    expect((firstProse.input as any).expressions[0]).toMatchObject({ speech: ['The next train is at dusk.'], actions: ['Points at the timetable.'] });
    for (const call of [world, firstProse]) expect(JSON.stringify(call.input)).not.toMatch(/PRIVATE_LEGACY|PRIVATE_OPERATIONAL/);
    expect(f.store.get(id).events.find(event => event.kind === 'role-result')).toMatchObject({ text: 'Keeper points at the timetable.',
      data: { decisionMemo: 'PRIVATE_OPERATIONAL_NOTE', legacy: { summary: 'PRIVATE_LEGACY_SUMMARY', expression: 'PRIVATE_LEGACY_EXPRESSION' } } });
    f.engine.submit(id, { requestId: 'public-role-recovery', expectedRevision: 1, mode: 'author', action: 'Compose the current scene.' });
    await f.engine.idle(id);
    const recovered = f.provider.calls.at(-1)!;
    expect((recovered.input as any).expressions).toEqual((firstProse.input as any).expressions);
    expect(JSON.stringify(recovered.input)).not.toMatch(/PRIVATE_LEGACY|PRIVATE_OPERATIONAL/);
    expect(JSON.stringify(project(f.store.get(id), 'keeper'))).not.toMatch(/PRIVATE_LEGACY|PRIVATE_OPERATIONAL/);
    // Even empty explicit public channels never fall back to private legacy text.
    f.provider.roleResult.public = { summary: '', speech: [], actions: [] };
    await f.turn(id);
    expect((worlds(f.provider).at(-1)!.input as any).results[0]).toEqual({ roleId: 'keeper', proposals: [{ roleId: 'keeper', key: 'score', value: 2 }] });
  });

  it('requests only public behavior and accepts public-only output while retaining legacy-provider compatibility', async () => {
    const f = await fixture(), id = f.store.create(f.card, f.preset, chosen).id;
    f.provider.roleResult = { public: { summary: 'The keeper listens.', speech: ['Welcome back.'], actions: [] }, proposals: [] };
    await f.turn(id);
    const roleRequest = f.provider.calls.find(call => call.kind === 'role')!, schema = roleRequest.resultSchema as any;
    expect(schema.required).toEqual(['public', 'proposals']);
    expect(schema.properties).not.toHaveProperty('decisionMemo');
    expect(schema.properties).not.toHaveProperty('summary');
    expect(schema.properties).not.toHaveProperty('expression');
    expect(f.store.get(id).events.find(event => event.kind === 'role-result')).toMatchObject({ text: 'The keeper listens.' });
    expect((worlds(f.provider)[0].input as any).results[0]).toEqual({ roleId: 'keeper', proposals: [] });
    expect((f.provider.calls.at(-1)!.input as any).expressions[0].speech).toEqual(['Welcome back.']);
    f.provider.roleResult = { summary: 'Legacy keeper listens.', expression: 'Legacy welcome.', proposals: [] };
    await f.turn(id);
    expect((worlds(f.provider)[1].input as any).results[0]).toEqual({ roleId: 'keeper', proposals: [] });
    expect((f.provider.calls.at(-1)!.input as any).expressions[0]).toEqual({ roleId: 'keeper', text: 'Legacy welcome.', speech: ['Legacy welcome.'], actions: [] });
  });

  it('rejects malformed explicit public results instead of falling back to legacy text', async () => {
    const f = await fixture(), id = f.store.create(f.card, f.preset, chosen).id;
    f.provider.roleResult.public = { summary: 'Public', speech: 'invalid', actions: [] };
    f.engine.submit(id, { requestId: 'invalid-public-result', expectedRevision: 0, mode: 'action', action: 'Look around.' });
    await f.engine.idle(id);
    expect(f.store.get(id).turns.at(-1)?.status).toBe('failed');
    expect(worlds(f.provider)).toHaveLength(0);
    expect(f.store.get(id).revision).toBe(0);
  });

  it('blocks tampered receipt or bound definition hashes before any later model dispatch', async () => {
    const f = await fixture();
    for (const target of ['receipt', 'definition'] as const) {
      const id = f.store.create(f.card, f.preset, chosen).id, changed = clone(f.store.get(id));
      if (target === 'receipt') changed.initialization!.definitionHash = '0'.repeat(64);
      else changed.card.initialization!.openings[0].instruction = 'A silently changed private premise.';
      f.store.save(changed);
      let rejected = false;
      try {
        f.engine.submit(id, { requestId: `tampered-${target}`, expectedRevision: changed.revision, mode: 'action', action: 'Read the public clock.' });
        await f.engine.idle(id);
        rejected = f.store.get(id).turns.at(-1)?.status === 'failed';
      } catch { rejected = true; }
      expect(rejected).toBe(true); expect(f.provider.calls).toHaveLength(0); expect(f.store.get(id).revision).toBe(0);
    }
  });
});
