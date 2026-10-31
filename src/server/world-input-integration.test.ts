import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset, SubmitTurn } from '../shared/types';
import type { WorldInputEvidence } from '../shared/world-input';
import { createApp } from './app';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import type { SessionCommandService } from './session-services';
import { clone, project, SessionStore } from './store';
import { publicPromptView } from './prompt-compiler';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const evidence: WorldInputEvidence = { schema: 'rp.world-input/0.1', id: 'fixed-result', serviceId: 'reviewed-game', referenceId: 'battle-1', kind: 'fixture-result', title: 'Completed stage', payload: { winner: 'self', score: 9 } };
const input = (request: AgentRequest) => request.input as any;
class Provider implements ModelProvider {
  calls: AgentRequest[] = [];
  enabled = true;
  world: (request: AgentRequest) => unknown = () => ({ summary: 'Private adjudication', changes: [], acceptedBehaviorIds: [],
    facts: [{ text: 'The completed stage has a winning score of nine.', sources: [{ kind: 'host-input', id: evidence.id }] }] });
  prose: (request: AgentRequest) => unknown = () => ({ title: 'Result', text: 'The winning score is nine.', person: 'third', pov: 'limited' });
  configured() { return this.enabled; }
  async run(request: AgentRequest): Promise<any> { this.calls.push(request); if (request.kind === 'world') return this.world(request); if (request.kind === 'prose') return this.prose(request); throw new Error('Host settlement must not schedule role agents'); }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rp-world-input-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.modules = []; preset.modules = [];
  card.roles.push({ id: 'npc', name: 'Performer', persona: 'A performer.', goals: [], peers: [], phase: 'active', presence: 'present', state: {}, knowledge: [] });
  let resolutions = 0;
  const service: SessionCommandService = { id: evidence.serviceId, title: 'Reviewed fixture', read: () => ({}), apply: () => ({}),
    worldInput: (session, selection) => { expect(Object.isFrozen(session)).toBe(true); expect(selection.referenceId).toBe(evidence.referenceId); resolutions++; return clone(evidence); } };
  const provider = new Provider();
  const app = await createApp({ dataRoot: root, provider, sessionServices: [service], catalog: async () => ({ cards: [card], presets: [preset] }) });
  cleanups.push(app.close);
  const id = app.store.create(card, preset).id;
  const command = (requestId = 'world-input'): SubmitTurn => ({ requestId, expectedRevision: app.store.get(id).revision, mode: 'author',
    action: 'PRIVATE_CONTEXT: confirm only the recorded stage result; no player gestures.', worldInput: { serviceId: evidence.serviceId, referenceId: evidence.referenceId, parameters: { bindings: [] } } });
  return { ...app, root, id, provider, command, resolutions: () => resolutions };
}
describe('immutable host evidence through world adjudication and prose', () => {
  it('dispatches world then prose with no player action or role call; commits the exact reference and consumption atomically', async () => {
    const f = await fixture(), before = clone(f.store.get(f.id)), commits: any[] = [], save = f.store.save.bind(f.store);
    vi.spyOn(f.store, 'save').mockImplementation(session => { if (session.revision > f.store.get(session.id).revision) commits.push(clone(session)); return save(session); });
    const submitted = f.engine.submit(f.id, f.command()); await f.engine.idle(f.id);
    const current = f.store.get(f.id), world = f.provider.calls[0], prose = f.provider.calls[1];
    expect(current.turns.at(-1)?.status).toBe('completed'); expect(f.provider.calls.map(c => c.kind)).toEqual(['world', 'prose']);
    expect(input(world)).toMatchObject({ action: '', mode: 'author', authorInstruction: f.command().action,
      playerControl: { authorizedAction: null }, worldInputs: [evidence], behaviorCandidates: [], results: [] });
    expect(JSON.stringify(world.resultSchema)).toContain('host-input');
    expect(input(prose).playerControl).toMatchObject({ authorizedAction: null, mode: 'author' });
    const fact = current.events.find(event => event.kind === 'world-event')!;
    expect(fact.data).toEqual({ fact: { text: 'The completed stage has a winning score of nine.', sources: [{ kind: 'host-input', id: evidence.id,
      evidenceRef: { schema: 'rp.world-input-reference/0.1', serviceId: evidence.serviceId, referenceId: evidence.referenceId, kind: evidence.kind, title: evidence.title,
        payloadSha256: createHash('sha256').update(JSON.stringify(evidence.payload)).digest('hex') } }] } });
    expect(input(prose).events).toContainEqual(fact); expect(JSON.stringify(input(prose).events)).not.toContain('PRIVATE_CONTEXT');
    expect(JSON.stringify(prose.input)).not.toContain('"payload"');
    const privateFacts = current.events.find(event => event.kind === 'world-facts')!.data as any;
    expect(privateFacts.facts[0].sources[0].evidence).toEqual(evidence);
    expect(commits).toHaveLength(1); expect(commits[0].worldInputTurns[0]).toMatchObject({ turnId: submitted.turnId, committed: true, evidence });
    expect(commits[0].events.some((event: any) => event.kind === 'world-event')).toBe(true);
    expect(current.roles).toEqual(before.roles); expect(current.world).toEqual(before.world);
    expect(project(current)).not.toHaveProperty('worldInputTurns'); expect(project(current, 'npc')).not.toHaveProperty('worldInputTurns');
    expect(new SessionStore(f.root).get(f.id).worldInputTurns).toEqual(current.worldInputTurns);
  });

  it('preserves postcommit prose failure, never consumes twice, and recovers prose after service removal without player agency', async () => {
    const f = await fixture(); f.provider.prose = () => { throw new Error('Controlled writer failure'); };
    const original = f.command(); f.engine.submit(f.id, original); await f.engine.idle(f.id);
    const failed = clone(f.store.get(f.id)); expect(failed.turns.at(-1)).toMatchObject({ status: 'failed', phase: 'compose-failed' });
    expect(failed.worldInputTurns![0].committed).toBe(true); expect(failed.turns.at(-1)!.error).toContain('already committed');
    expect(f.engine.submit(f.id, original)).toMatchObject({ duplicate: true, status: 'failed' });
    expect(() => f.engine.submit(f.id, { ...original, action: 'Different context' })).toThrow(/different world submission/);
    expect(() => f.engine.submit(f.id, f.command('new-id'))).toThrow(/already adjudicated/);
    expect(f.provider.calls).toHaveLength(2);
    // A snapshot written by the first bridge version held the full source in a
    // public event. Future model/role views must narrow it without rewriting it.
    const historical = failed.events.find(event => event.kind === 'world-event')!;
    (historical.data as any).fact.sources[0] = { kind: 'host-input', id: evidence.id, evidence: clone(evidence) };
    // An old native context may also contain the former raw evidence delivery.
    // A new disclosure contract must not continue that transcript.
    failed.promptContexts!.prose.fingerprint = 'pre-public-reference-contract';
    f.store.save(failed);
    expect(JSON.stringify(project(failed, 'npc'))).not.toContain('"payload"');
    expect(JSON.stringify(publicPromptView(failed))).not.toContain('"payload"');
    await f.engine.close();
    const store = new SessionStore(f.root), provider = new Provider(), resumed = new TurnEngine(store, provider); cleanups.push(() => resumed.close());
    resumed.submit(f.id, { requestId: 'rewrite', expectedRevision: store.get(f.id).revision, mode: 'author', action: 'Write only the committed result.' });
    await resumed.idle(f.id);
    expect(provider.calls.map(c => c.kind)).toEqual(['prose']); expect(input(provider.calls[0]).playerControl.authorizedAction).toBeNull();
    expect(provider.calls[0].sessionId).not.toBe(f.provider.calls.find(call => call.kind === 'prose')!.sessionId);
    expect(JSON.stringify(provider.calls[0].input)).not.toContain('"payload"');
    expect(JSON.stringify(input(provider.calls[0]).events)).toContain('fixed-result');
    expect(store.get(f.id).revision).toBe(failed.revision); expect(store.get(f.id).worldInputTurns).toEqual(failed.worldInputTurns);
    expect(store.get(f.id).turns.at(-1)?.status).toBe('completed');
    expect((store.get(f.id).events.find(event => event.id === historical.id)!.data as any).fact.sources[0].evidence).toEqual(evidence);
  });

  it('rejects invalid current evidence without a partial world commit, permits explicit retry, and checks mode and installation before dispatch', async () => {
    const f = await fixture(), first = f.command();
    expect(() => f.engine.submit(f.id, { ...first, mode: 'action' })).toThrow(/author mode/);
    expect(() => f.engine.submit(f.id, { ...first, worldInput: { ...first.worldInput!, serviceId: 'absent' } })).toThrow(/not installed/);
    expect(f.provider.calls).toHaveLength(0); expect(f.store.get(f.id).turns).toHaveLength(0);
    f.provider.world = () => ({ summary: 'Invalid source', changes: [], acceptedBehaviorIds: [], facts: [{ text: 'Wrong round.', sources: [{ kind: 'host-input', id: 'old-result' }] }] });
    f.engine.submit(f.id, first); await f.engine.idle(f.id);
    expect(f.store.get(f.id).revision).toBe(0); expect(f.store.get(f.id).worldInputTurns![0].committed).toBe(false);
    expect(f.store.get(f.id).events.some(event => event.kind === 'world-adjudication')).toBe(false);
    expect(f.provider.calls.map(call => call.kind)).toEqual(['world']);
    expect(f.engine.submit(f.id, first)).toMatchObject({ duplicate: true, status: 'failed' });
    f.provider.world = () => ({ summary: 'Accepted fixed result', changes: [], acceptedBehaviorIds: [], facts: [{ text: 'Nine points.', sources: [{ kind: 'host-input', id: evidence.id }] }] });
    f.engine.submit(f.id, f.command('explicit-retry')); await f.engine.idle(f.id);
    expect(f.provider.calls.map(call => call.kind)).toEqual(['world', 'world', 'prose']);
    expect(f.store.get(f.id).worldInputTurns!.map(record => record.committed)).toEqual([false, true]);
    expect(f.store.get(f.id).turns.map(turn => turn.status)).toEqual(['failed', 'completed']);
  });
});
