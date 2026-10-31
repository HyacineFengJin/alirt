import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from './app';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { SessionStore, project } from './store';
import { createNativeTemplate, validateNativeDocument } from '../shared/native';
import { initializeStory } from './initialization-runtime';
import type { CharacterCard, OpeningDefinition, Preset, RoleDefinition } from '../shared/types';
import type { BehaviorCandidate } from '../shared/behavior';

const roots: string[] = [], cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const input = (request: AgentRequest): any => request.input;
const actor = (request: AgentRequest) => input(request).delivery.to as string;
function documents() {
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.id = 'remote-scenes'; preset.id = 'remote-empty';
  card.fields = [{ key: 'presence', label: 'Presence', type: 'boolean', audience: 'public', editable: true }, { key: 'location', label: 'Location', type: 'string', audience: 'public', editable: true }];
  const role = (id: string, presence: RoleDefinition['presence'], phase: RoleDefinition['phase'] = 'active'): RoleDefinition => ({
    id, name: id, persona: `PRIVATE_PERSONA_${id}`, goals: [], peers: [], presence, phase, state: { presence: presence === 'present', location: presence === 'present' ? 'room' : 'elsewhere' }, knowledge: [],
  });
  card.roles.push(role('local', 'present'), ...['message', 'screen', 'audio'].map(channel => ({ ...role(channel, 'absent'), interaction: { mode: 'remote' as const, channel: channel as 'message' | 'screen' | 'audio' } })),
    role('ungranted', 'absent'), { ...role('dormant', 'absent', 'dormant'), interaction: { mode: 'remote', channel: 'message' } },
    { ...role('faded', 'absent', 'faded'), interaction: { mode: 'remote', channel: 'audio' } });
  card.roles.forEach(role => role.peers = card.roles.filter(other => other.id !== role.id).map(other => other.id));
  const cast: OpeningDefinition['cast'] = card.roles.map(role => ({ roleId: role.id, phase: role.phase, presence: role.presence, ...(role.interaction ? { interaction: structuredClone(role.interaction) } : {}) }));
  card.initialization = { schema: 'rp.initialization/0.1', defaultOpeningId: 'remote', defaultPlayerProfileId: 'player', playerProfiles: [{ id: 'player', title: 'Player', name: 'Player', persona: '' }], openings: [
    { id: 'remote', title: 'Remote channels', text: 'Devices are connected.', cast },
    { id: 'closed', title: 'No remote grants', text: 'Devices are idle.', cast: cast.map(({ interaction: _interaction, ...member }) => member) },
  ] };
  return { card, preset };
}
class RemoteProvider implements ModelProvider {
  calls: AgentRequest[] = []; failWriter = false; peer = false;
  configured() { return true; }
  async run(request: AgentRequest) {
    this.calls.push(request);
    if (request.kind === 'role') {
      if (this.peer && actor(request) === 'local' && input(request).delivery.kind === 'host') await request.tools.find(tool => tool.name === 'peer_send')!.execute({ to: 'ungranted', key: 'private-request', kind: 'request', replyTo: null, body: 'PRIVATE_PEER_MESSAGE' });
      return { public: { summary: 'Author audit only.', speech: [`SPEECH_${actor(request)}`], actions: [`PHYSICAL_${actor(request)}`] },
        proposals: actor(request) === 'screen' ? [{ roleId: 'screen', key: 'location', value: 'room' }, { roleId: 'screen', key: 'presence', value: true }] : [] };
    }
    if (request.kind === 'world') return { summary: 'Channels remain connected.', changes: [], facts: [], acceptedBehaviorIds: input(request).behaviorCandidates.map((item: BehaviorCandidate) => item.id) };
    if (this.failWriter) { this.failWriter = false; throw new Error('Offline writer failure'); }
    return { title: 'Channels', text: 'The connection remains open.', person: 'third', pov: 'limited' };
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rp-remote-scenes-')); roots.push(root);
  const docs = documents(), provider = new RemoteProvider();
  const app = await createApp({ dataRoot: root, provider, catalog: async () => ({ cards: [docs.card], presets: [docs.preset] }) });
  cleanups.push(app.close);
  const id = app.store.create(docs.card, docs.preset).id;
  let sequence = 0;
  const turn = async (mode: 'action' | 'author' = 'action') => { app.engine.submit(id, { requestId: `remote-${++sequence}`, expectedRevision: app.store.get(id).revision, action: 'Read the connected devices.', mode }); await app.engine.idle(id); };
  return { ...app, ...docs, root, provider, id, turn };
}

describe('explicit remote scene participation through host engine and local HTTP APIs', () => {
  it('validates typed channels, enforces physical absence and clears grants when another opening is selected', () => {
    const { card } = documents(); expect(validateNativeDocument('card', card)).toEqual([]);
    const before = JSON.stringify(card);
    const closed = initializeStory(card, { openingId: 'closed' });
    expect(closed.roles.every(role => role.interaction === undefined)).toBe(true);
    expect(JSON.stringify(card)).toBe(before);
    const invalid = structuredClone(card); invalid.roles.find(role => role.id === 'screen')!.presence = 'present';
    expect(validateNativeDocument('card', invalid).some(issue => issue.path.includes('/interaction'))).toBe(true);
    const malformed = structuredClone(card); (malformed.initialization!.openings[0].cast.find(member => member.roleId === 'screen')! as any).interaction = { mode: 'remote', channel: 'telepathy', allowActions: true };
    expect(validateNativeDocument('card', malformed).filter(issue => issue.path.includes('/interaction')).length).toBeGreaterThan(1);
  });
  it('schedules only explicitly granted active remote actors and carries host channel metadata through world approval and prose', async () => {
    const f = await fixture(); await f.turn();
    expect(f.provider.calls.filter(call => call.kind === 'role').map(actor)).toEqual(['local', 'message', 'screen', 'audio']);
    const world = f.provider.calls.find(call => call.kind === 'world')!, candidates: BehaviorCandidate[] = input(world).behaviorCandidates;
    expect(candidates.filter(candidate => candidate.kind === 'action').map(candidate => candidate.roleId)).toEqual(['local']);
    for (const channel of ['message', 'screen', 'audio']) {
      const candidate = candidates.find(candidate => candidate.roleId === channel)!;
      expect(candidate).toMatchObject({ kind: 'speech', interaction: { mode: 'remote', channel } });
      expect(f.store.get(f.id).roles.find(role => role.id === channel)).toMatchObject({ presence: 'absent', state: { presence: false, location: 'elsewhere' } });
    }
    const prose = input(f.provider.calls.find(call => call.kind === 'prose')!);
    expect(prose.acceptedBehaviors).toEqual(candidates);
    expect(prose.narrationBrief.scene.physicalRoleIds).toEqual(['player', 'local']);
    expect(prose.narrationBrief.scene.transmissions).toEqual(candidates.filter(candidate => candidate.interaction?.mode === 'remote').map(candidate => ({
      behaviorId: candidate.id, roleId: candidate.roleId, channel: (candidate.interaction as any).channel,
    })));
    expect(prose.playerIdentity).toEqual({ roleId: 'player', displayName: 'Player', sourceNotations: ['<user>', '{{user}}'] });
    expect(prose.previousProse).toBe('');
    expect(prose.narrationBrief.previousProse).toBeNull();
    expect(f.store.get(f.id).events.findLast(event => event.kind === 'narration-material')?.data).toEqual(prose.narrationBrief);
    expect(prose.expressions.find((expression: any) => expression.roleId === 'screen').interaction).toEqual({ mode: 'remote', channel: 'screen' });
    expect(JSON.stringify(prose)).not.toContain('PHYSICAL_screen');
    expect(JSON.stringify(prose)).not.toContain('PRIVATE_PERSONA');
    expect(f.store.get(f.id).events.filter(event => event.kind === 'behavior-rejected')).toHaveLength(3);
    expect(f.store.get(f.id).events.filter(event => event.kind === 'proposal-rejected')).toHaveLength(2);
    expect(project(f.store.get(f.id), 'local').roles.find(role => role.id === 'screen')!.interaction).toEqual({ mode: 'remote', channel: 'screen' });
  });
  it('retains private peer permissions without converting an ungranted absent peer into a public scene actor', async () => {
    const f = await fixture(); f.provider.peer = true; await f.turn();
    expect(f.provider.calls.filter(call => call.kind === 'role').map(actor)).toContain('ungranted');
    const world = input(f.provider.calls.find(call => call.kind === 'world')!);
    expect(world.behaviorCandidates.some((candidate: BehaviorCandidate) => candidate.roleId === 'ungranted')).toBe(false);
    const prose = input(f.provider.calls.find(call => call.kind === 'prose')!);
    expect(JSON.stringify(prose)).not.toContain('PRIVATE_PEER_MESSAGE');
    expect(JSON.stringify(prose)).not.toContain('SPEECH_ungranted');
    expect(f.store.get(f.id).events.some(event => event.kind === 'behavior-rejected' && event.actor === 'ungranted')).toBe(true);
  });
  it('persists remote channels across restart and writer recovery without replaying role or world calls', async () => {
    const f = await fixture(); f.provider.failWriter = true; await f.turn();
    expect(f.store.get(f.id).turns.at(-1)).toMatchObject({ status: 'failed', phase: 'compose-failed' });
    expect(f.store.get(f.id).revision).toBe(1);
    const store = new SessionStore(f.root), provider = new RemoteProvider(), engine = new TurnEngine(store, provider);
    cleanups.push(() => engine.close());
    expect(store.get(f.id).roles.find(role => role.id === 'screen')!.interaction).toEqual({ mode: 'remote', channel: 'screen' });
    expect(store.get(f.id).roles.find(role => role.id === 'ungranted')!.interaction).toBeUndefined();
    engine.submit(f.id, { requestId: 'recover-remote-writer', expectedRevision: store.get(f.id).revision, mode: 'author', action: 'Recover committed prose.' }); await engine.idle(f.id);
    expect(provider.calls.map(call => call.kind)).toEqual(['prose']);
    const prose = input(provider.calls[0]); expect(prose.acceptedBehaviors.find((candidate: BehaviorCandidate) => candidate.roleId === 'screen').interaction).toEqual({ mode: 'remote', channel: 'screen' });
    const original = input(f.provider.calls.find(call => call.kind === 'prose')!);
    expect(prose.narrationBrief.scene).toEqual(original.narrationBrief.scene);
    expect(prose.narrationBrief.evidence).toEqual(original.narrationBrief.evidence);
    expect(prose.narrationBrief.materialTurnId).toBe(store.get(f.id).turns[0].id);
    expect(store.get(f.id).events.filter(event => event.kind === 'narration-material').every(event => event.audience === 'author')).toBe(true);
    expect(prose.acceptedBehaviors.some((candidate: BehaviorCandidate) => candidate.roleId === 'screen' && candidate.kind === 'action')).toBe(false);
    expect(store.get(f.id).roles.find(role => role.id === 'screen')!.presence).toBe('absent');
  });
  it('exposes selected channel grants through local session APIs and ends a grant on explicit author arrival', async () => {
    const f = await fixture(); let server!: Server;
    await new Promise<void>(resolve => { server = f.app.listen(0, '127.0.0.1', () => resolve()); });
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected loopback address');
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cardId: f.card.id, presetId: f.preset.id, openingId: 'remote' }) });
    expect(response.status).toBe(201); const session = await response.json() as any;
    expect(session.roles.find((role: any) => role.id === 'screen')).toMatchObject({ presence: 'absent', interaction: { mode: 'remote', channel: 'screen' } });
    const view = await (await fetch(`${base}/api/sessions/${session.id}?perspective=local`)).json() as any;
    expect(view.roles.find((role: any) => role.id === 'screen').interaction.channel).toBe('screen');
    const turn = await fetch(`${base}/api/sessions/${session.id}/turns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'remote-http-turn', expectedRevision: session.revision, action: 'Read the screen.', mode: 'action' }) });
    expect(turn.status).toBe(202); await f.engine.idle(session.id);
    const updated = f.store.get(session.id);
    expect(updated.turns.at(-1)!.status).toBe('completed');
    expect(updated.events.some(event => event.kind === 'role-behavior' && event.actor === 'screen' && (event.data as any)?.interaction?.channel === 'screen')).toBe(true);
    const arrival = await fetch(`${base}/api/sessions/${session.id}/lifecycle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: updated.revision, roleId: 'screen', phase: 'active', presence: 'present' }) });
    expect(arrival.status).toBe(200); const arrived = await arrival.json() as any;
    expect(arrived.roles.find((role: any) => role.id === 'screen').interaction).toBeUndefined();
  });
  it('atomically starts, changes and ends author remote grants through lifecycle APIs with CAS and durable channel history', async () => {
    const f = await fixture(); let server!: Server;
    await new Promise<void>(resolve => { server = f.app.listen(0, '127.0.0.1', () => resolve()); });
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected loopback address');
    const base = `http://127.0.0.1:${address.port}`;
    const lifecycle = (extra: Record<string, unknown>, revision = f.store.get(f.id).revision) => fetch(`${base}/api/sessions/${f.id}/lifecycle`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision, roleId: 'ungranted', phase: 'active', presence: 'absent', ...extra }),
    });
    const before = JSON.stringify(f.store.get(f.id));
    for (const invalid of [
      { presence: 'present', interaction: { mode: 'remote', channel: 'screen' } },
      { interaction: { mode: 'remote', channel: 'telepathy' } },
      { interaction: { mode: 'remote', channel: 'message', allowActions: true } },
      { interaction: false }, { unknown: true },
    ]) {
      expect((await lifecycle(invalid)).status).toBe(400);
      expect(JSON.stringify(f.store.get(f.id))).toBe(before);
    }
    const initialRevision = f.store.get(f.id).revision;
    expect((await lifecycle({ interaction: { mode: 'remote', channel: 'message' }, reason: 'PRIVATE_CALL_REASON' })).status).toBe(200);
    const granted = f.store.get(f.id);
    expect(granted.roles.find(role => role.id === 'ungranted')).toMatchObject({ presence: 'absent', interaction: { mode: 'remote', channel: 'message' } });
    expect(granted.events.findLast(event => event.kind === 'lifecycle')!.data).toMatchObject({ previousInteraction: null, interaction: { mode: 'remote', channel: 'message' } });
    expect(JSON.stringify(project(granted, 'local'))).not.toContain('PRIVATE_CALL_REASON');
    const afterGrant = JSON.stringify(granted);
    expect((await lifecycle({ interaction: null }, initialRevision)).status).toBe(409);
    expect(JSON.stringify(f.store.get(f.id))).toBe(afterGrant);
    // Omission retains an existing grant; no caller is forced to pass the new field.
    expect((await lifecycle({})).status).toBe(200);
    expect(f.store.get(f.id).roles.find(role => role.id === 'ungranted')!.interaction).toEqual({ mode: 'remote', channel: 'message' });
    await f.turn();
    expect(f.provider.calls.filter(call => call.kind === 'role').map(actor)).toContain('ungranted');
    expect((await lifecycle({ interaction: { mode: 'remote', channel: 'audio' } })).status).toBe(200);
    const reopened = new SessionStore(f.root);
    expect(reopened.get(f.id).roles.find(role => role.id === 'ungranted')!.interaction).toEqual({ mode: 'remote', channel: 'audio' });
    expect(reopened.get(f.id).events.findLast(event => event.kind === 'lifecycle')!.data).toMatchObject({ previousInteraction: { mode: 'remote', channel: 'message' }, interaction: { mode: 'remote', channel: 'audio' } });
    expect((await lifecycle({ interaction: null })).status).toBe(200);
    expect(f.store.get(f.id).roles.find(role => role.id === 'ungranted')).toMatchObject({ presence: 'absent', state: { presence: false } });
    expect(f.store.get(f.id).roles.find(role => role.id === 'ungranted')!.interaction).toBeUndefined();
    expect(f.store.get(f.id).events.findLast(event => event.kind === 'lifecycle')!.data).toMatchObject({ previousInteraction: { mode: 'remote', channel: 'audio' }, interaction: null });
    f.provider.calls = []; await f.turn();
    expect(f.provider.calls.filter(call => call.kind === 'role').map(actor)).not.toContain('ungranted');
    expect(new SessionStore(f.root).get(f.id).roles.find(role => role.id === 'ungranted')!.interaction).toBeUndefined();
  });
});
