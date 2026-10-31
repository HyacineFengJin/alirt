import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate, validateNativeDocument } from '../shared/native';
import { PUBLICATION_KINDS } from '../shared/world-facts';
import type { CharacterCard, OutputContract, Preset } from '../shared/types';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { SessionStore, clone, project } from './store';
import { compileResultValidator } from './result-schema.mjs';
import { compileWorldFacts, publicWorldFact } from './world-facts-runtime';
import { publicPromptView } from './prompt-compiler';
import { updateRuntimeConfiguration } from './runtime-config';
import { worldPublicationsEnabled } from './output-runtime';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const contract = (): OutputContract => ({ id: 'native-world-publications', title: 'Public world information', type: 'object',
  instruction: 'Host-derived committed world facts only.', enabled: true, required: false, priority: 0, audience: 'public',
  display: { placement: 'hidden' }, valueFrom: { kind: 'world-publications' } });
const fact = (kind: typeof PUBLICATION_KINDS[number] = 'news') => ({ text: `Independent ${kind} bulletin.`, sources: [{ kind: 'world-development' }], publication: { kind, sourceLabel: 'Public rehearsal bulletin' } });
class Provider implements ModelProvider {
  calls: AgentRequest[] = [];
  failWriter = false;
  world: (request: AgentRequest) => any = () => ({ summary: 'Audit', changes: [], acceptedBehaviorIds: [], facts: [] });
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request);
    if (request.kind === 'world') return this.world(request);
    if (request.kind !== 'prose') throw new Error('Publication production must not add role/model calls');
    if (this.failWriter) throw new Error('Controlled writer failure');
    return { title: 'Rehearsal', text: 'The rehearsal remains quiet.', person: 'third', pov: 'limited' };
  }
}
async function fixture(enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'rp-world-publications-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.world.time = '春·周末午后'; card.world.variables = { allowNews: true };
  card.fields = [{ key: 'allowNews', label: 'News enabled', type: 'boolean', audience: 'public', editable: true }];
  if (enabled) card.outputs = [contract()];
  const store = new SessionStore(root), id = store.create(card, preset).id, provider = new Provider(), engine = new TurnEngine(store, provider);
  cleanups.push(() => engine.close()); let sequence = 0;
  const command = (mode: 'author' | 'action' = 'action') => ({ requestId: `publication-${++sequence}`, expectedRevision: store.get(id).revision, mode, action: 'Use only independently available public information.' });
  const turn = async (mode: 'author' | 'action' = 'action') => { const input = command(mode); engine.submit(id, input); await engine.idle(id); return input; };
  const publications = () => store.get(id).events.filter(event => event.kind === 'world-event' && (event.data as any)?.fact?.publication);
  return { root, store, id, card, preset, provider, engine, command, turn, publications };
}

describe('optional world publication producer, atomic commit and host snapshot', () => {
  it('creates no publication rows without admitted facts and never accepts a model-authored host snapshot', async () => {
    const f = await fixture(); await f.turn();
    expect(f.publications()).toEqual([]);
    expect((f.store.get(f.id).prose.at(-1)!.attachments![0].value as any).publications).toEqual([]);
    expect(f.store.get(f.id).roles).toEqual(f.card.roles);
    const prose = f.provider.calls.at(-1)!;
    expect(compileResultValidator(prose.resultSchema)({ title: 'Forged', text: 'No authority.', person: 'third', pov: 'limited',
      outputs: { 'card:native-world-publications': { publications: [{ text: 'Fake bulletin' }] } } }).length).toBeGreaterThan(0);
  });

  it('has no producer by default, opts in through the actual host contract, stamps all five kinds, and binds world context to the capability', async () => {
    const f = await fixture(false); expect(f.provider.calls).toEqual([]); await f.turn();
    const initialWorld = f.provider.calls.find(call => call.kind === 'world')!;
    expect((initialWorld.resultSchema as any).properties.facts.items.properties).not.toHaveProperty('publication');
    expect(initialWorld.system).not.toContain('World publication production is enabled');
    updateRuntimeConfiguration(f.store, f.id, { expectedRevision: 1, reason: 'Explicitly adopt public information', cardOutputs: [contract()] });
    f.provider.world = () => ({ summary: 'Independent bulletins', changes: [], acceptedBehaviorIds: [], facts: PUBLICATION_KINDS.map(kind => fact(kind)) });
    await f.turn(); const held = f.store.get(f.id), world = f.provider.calls.filter(call => call.kind === 'world').at(-1)!, prose = f.provider.calls.at(-1)!;
    expect(held.turns.at(-1)?.status).toBe('completed'); expect(world.sessionId).not.toBe(initialWorld.sessionId);
    expect(world.system).toContain('World publication production is enabled');
    expect(compileResultValidator(world.resultSchema)(f.provider.world(world))).toEqual([]);
    expect(compileResultValidator(world.resultSchema)({ ...f.provider.world(world), facts: [{ ...fact(), publication: { ...fact().publication, worldTime: 'fabricated' } }] }).length).toBeGreaterThan(0);
    expect(compileResultValidator(world.resultSchema)({ ...f.provider.world(world), facts: [{ ...fact(), sources: [{ kind: 'player-action' }] }] }).length).toBeGreaterThan(0);
    expect(f.provider.calls.map(call => call.kind)).toEqual(['world', 'prose', 'world', 'prose']);
    expect(f.publications().map(event => (event.data as any).fact.publication)).toEqual(PUBLICATION_KINDS.map(kind => ({ kind, sourceLabel: 'Public rehearsal bulletin', worldTime: '春·周末午后', worldRevision: 3 })));
    const snapshot = held.prose.at(-1)!.attachments![0];
    expect(snapshot.provenance).toEqual({ kind: 'committed-facts', materialTurnId: held.turns.at(-1)!.id, factIds: f.publications().map(event => event.id), worldRevision: 3 });
    expect(snapshot.value).toMatchObject({ schema: 'rp.world-publications/0.1', publications: f.publications().map(event => ({ factId: event.id, text: event.text, publication: (event.data as any).fact.publication })) });
    expect((prose.resultSchema as any).properties).not.toHaveProperty('outputs');
    expect((prose.input as any).events.filter((event: any) => event.kind === 'world-event')).toEqual(f.publications());
    expect(project(held, 'player').events.filter(event => event.kind === 'world-event')).toEqual(f.publications());
  });

  it('honors conditions and the auxiliary switch, rejects module association explicitly, and never deletes committed information when disabled', async () => {
    const f = await fixture(), conditional = { ...contract(), condition: { path: 'world.variables.allowNews', equals: false } };
    updateRuntimeConfiguration(f.store, f.id, { expectedRevision: 0, reason: 'Conditional publications', cardOutputs: [conditional] });
    await f.turn(); expect((f.provider.calls[0].resultSchema as any).properties.facts.items.properties).not.toHaveProperty('publication');
    expect(worldPublicationsEnabled({ card: { ...f.card, outputs: [{ ...contract(), module: 'unadmitted' }] }, preset: f.preset }, publicPromptView(f.store.get(f.id)))).toBe(false);
    expect(validateNativeDocument('card', { ...f.card, outputs: [{ ...contract(), module: 'unadmitted' }] }).some(issue => issue.message.includes('do not support module'))).toBe(true);
    updateRuntimeConfiguration(f.store, f.id, { expectedRevision: f.store.get(f.id).revision, reason: 'Enable publications', cardOutputs: [contract()] });
    f.provider.world = () => ({ summary: 'Bulletin', changes: [], acceptedBehaviorIds: [], facts: [fact()] }); await f.turn();
    const committed = clone(f.publications());
    f.provider.world = () => ({ summary: 'Legacy ordinary world', changes: [], acceptedBehaviorIds: [], facts: [{ text: 'Ordinary public scene.', sources: [{ kind: 'world-development' }] }] });
    updateRuntimeConfiguration(f.store, f.id, { expectedRevision: f.store.get(f.id).revision, reason: 'Disable only the publication contract', cardOutputs: [{ ...contract(), enabled: false }] });
    await f.turn(); expect(f.publications()).toEqual(committed);
    expect((f.provider.calls.filter(call => call.kind === 'world').at(-1)!.resultSchema as any).properties.facts.items.properties).not.toHaveProperty('publication');
    updateRuntimeConfiguration(f.store, f.id, { expectedRevision: f.store.get(f.id).revision, reason: 'Disable auxiliary capability', cardOutputs: [contract()], agentRuntime: { profile: 'full', modules: { 'rp.auxiliary-outputs': false } } });
    await f.turn(); expect(f.publications()).toEqual(committed);
    expect((f.provider.calls.filter(call => call.kind === 'world').at(-1)!.resultSchema as any).properties.facts.items.properties).not.toHaveProperty('publication');
    expect(f.store.get(f.id).prose.at(-1)!.attachments).toBeUndefined();
  });

  it('rejects forged publication while off and rolls back every publication and state write if any world fact is invalid', async () => {
    const off = await fixture(false); off.provider.world = () => ({ summary: 'Not allowed', changes: [], acceptedBehaviorIds: [], facts: [fact()] }); await off.turn();
    expect(off.store.get(off.id).turns.at(-1)?.status).toBe('failed'); expect(off.publications()).toEqual([]); expect(off.store.get(off.id).revision).toBe(0);
    const f = await fixture(); f.provider.world = () => ({ summary: 'Bad mixed batch', changes: [{ roleId: 'world', key: 'allowNews', value: false }], acceptedBehaviorIds: [], facts: [fact(),
      { ...fact('forum'), sources: [{ kind: 'state', roleId: 'world', key: 'allowNews' }] }] });
    const request = await f.turn(); expect(f.store.get(f.id).turns.at(-1)?.status).toBe('failed');
    expect(f.store.get(f.id).revision).toBe(0); expect(f.store.get(f.id).world.variables.allowNews).toBe(true); expect(f.publications()).toEqual([]);
    expect(f.store.get(f.id).events.some(event => event.kind === 'host-output')).toBe(false);
    expect(f.engine.submit(f.id, request)).toMatchObject({ duplicate: true, status: 'failed' }); expect(f.provider.calls.map(call => call.kind)).toEqual(['world']);
  });

  it('retains publication commit and host snapshot through writer failure, restart and author recovery without duplicating canonical feed facts', async () => {
    const f = await fixture(); f.provider.world = () => ({ summary: 'Notice', changes: [], acceptedBehaviorIds: [], facts: [fact('notice')] }); f.provider.failWriter = true;
    const request = await f.turn(); const before = clone(f.publications());
    expect(f.store.get(f.id).turns.at(-1)).toMatchObject({ status: 'failed', phase: 'compose-failed' }); expect(before).toHaveLength(1);
    expect(f.store.get(f.id).events.some(event => (event.data as any)?.output?.provenance?.kind === 'committed-facts')).toBe(true);
    expect(f.engine.submit(f.id, request)).toMatchObject({ duplicate: true, status: 'failed' }); expect(f.publications()).toEqual(before);
    await f.engine.close(); const store = new SessionStore(f.root), provider = new Provider(), engine = new TurnEngine(store, provider); cleanups.push(() => engine.close());
    engine.submit(f.id, { requestId: 'explicit-publication-prose-recovery', expectedRevision: 1, mode: 'author', action: 'Rewrite the committed notice only.' }); await engine.idle(f.id);
    expect(provider.calls.map(call => call.kind)).toEqual(['prose']); expect(store.get(f.id).events.filter(event => event.kind === 'world-event')).toEqual(before);
    expect((store.get(f.id).prose.at(-1)!.attachments![0].value as any).publications.map((row: any) => row.factId)).toEqual(before.map(event => event.id));
  });
});

describe('publication evidence and host stamp contract', () => {
  it('never relabels state, private state, NPC behavior, player input, setup or host evidence as independent publications', () => {
    const context = { allowPublications: true, acceptedBehaviors: [{ id: 'npc-approved', roleId: 'npc', kind: 'speech' as const, text: 'Ordinary local speech.' }],
      worldInputs: [{ schema: 'rp.world-input/0.1' as const, id: 'host-current', serviceId: 'trusted', referenceId: 'r1', kind: 'result', title: 'Trusted result', payload: { private: true } }],
      finalState: { revision: 8, world: { time: '', variables: { public: 1, private: 2 } }, roles: [], fields: [
        { key: 'public', label: 'Public', type: 'number' as const, audience: 'public' as const, editable: true },
        { key: 'private', label: 'Private', type: 'number' as const, audience: 'author' as const, editable: true }] }, hasPlayerAction: true, hasOpeningSetup: true };
    for (const source of [{ kind: 'state', roleId: 'world', key: 'public' }, { kind: 'state', roleId: 'world', key: 'private' },
      { kind: 'behavior', id: 'npc-approved' }, { kind: 'host-input', id: 'host-current' }, { kind: 'player-action' }, { kind: 'opening-setup' }]) {
      expect(() => compileWorldFacts({ facts: [{ ...fact(), sources: [source] }] }, context)).toThrow();
      expect(() => compileWorldFacts({ facts: [{ ...fact(), sources: [{ kind: 'world-development' }, source] }] }, context)).toThrow();
    }
    for (const publication of [{ kind: 'message', sourceLabel: 'Spoofed native message' }, { kind: 'news', sourceLabel: '  ' },
      { kind: 'news', sourceLabel: 'Channel', worldTime: 'Fake date' }, { kind: 'news', sourceLabel: 'Channel', worldRevision: 900 }])
      expect(() => compileWorldFacts({ facts: [{ ...fact(), publication }] }, context)).toThrow();
    const compiled = compileWorldFacts({ facts: [fact('team')] }, context).facts[0];
    expect(compiled.publication).toEqual({ kind: 'team', sourceLabel: 'Public rehearsal bulletin', worldTime: null, worldRevision: 9 });
    expect(publicWorldFact(compiled)).toEqual(compiled); expect(publicWorldFact(publicWorldFact(compiled))).toEqual(compiled);
    expect(() => publicWorldFact({ ...compiled, publication: { ...compiled.publication!, worldRevision: -1 } })).toThrow();
    expect(() => publicWorldFact({ ...compiled, sources: [{ kind: 'player-action' }] })).toThrow();
  });
});
