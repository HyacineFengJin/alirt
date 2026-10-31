import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset } from '../shared/types';
import { proseBodyText } from '../shared/prose-body';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { SessionStore } from './store';
import { updateRuntimeConfiguration } from './runtime-config';
import { compileResultValidator } from './result-schema.mjs';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const task of cleanup.splice(0).reverse()) await task(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rp-prose-body-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.opening = ''; preset.modules = []; card.modules = [{ id: 'speech-format', title: 'Native ordinary dialogue', category: 'protocol',
    content: 'SOURCE_DIALOGUE_PROTOCOL', enabled: true, targets: ['prose'], phase: 'compose', priority: 1 }];
  card.worldbook = { schema: 'rp.worldbook/0.1', bindings: [{ id: 'speech-format', moduleId: 'speech-format', purpose: 'output-contract',
    contentHash: createHash('sha256').update('SOURCE_DIALOGUE_PROTOCOL').digest('hex'), source: { importId: 'fixture', sourceHash: 'a'.repeat(64), pointer: '/entries/1' } }] };
  card.proseFormat = { schema: 'rp.prose-format/0.1', dialogue: { module: 'speech-format', renderer: 'character-dialogue' } };
  for (const id of ['a', 'b', 'remote']) card.roles.push({ id, name: id === 'remote' ? 'Remote' : 'Same name', persona: '', goals: [], peers: [],
    phase: 'active', presence: id === 'remote' ? 'absent' : 'present', ...(id === 'remote' ? { interaction: { mode: 'remote' as const, channel: 'message' as const } } : {}), state: {}, knowledge: [] });
  const store = new SessionStore(root), id = store.create(card, preset).id, requests: AgentRequest[] = [];
  let badRef = false;
  const provider: ModelProvider = { configured: () => true, async run(request): Promise<any> {
    requests.push(request); const input = request.input as any;
    if (request.kind === 'role') { const who = input.delivery.to; return { public: { summary: '', speech: [`${who} exact words\nsecond line`], actions: [] }, proposals: [] }; }
    if (request.kind === 'world') return { summary: 'Approved these exact proposals.', acceptedBehaviorIds: input.behaviorCandidates.map((x: any) => x.id), changes: [], facts: [] };
    if (input.proseBody) return { title: 'Typed scene', person: 'third', pov: 'limited', body: [
      { kind: 'narration', text: 'The conversation follows.' }, ...input.proseBody.references.map((x: any, index: number) => ({ kind: 'speech', ref: badRef && index === 0 ? 'other-turn-ref' : x.ref })),
    ] };
    return { title: 'Plain scene', text: 'Legacy writer remains available.', person: 'third', pov: 'limited' };
  } };
  const engine = new TurnEngine(store, provider); cleanup.push(() => engine.close());
  const turn = async (action: string, mode: 'dialogue' | 'action' | 'author' = 'dialogue') => {
    engine.submit(id, { requestId: `request-${store.get(id).turns.length}`, expectedRevision: store.get(id).revision, mode, action }); await engine.idle(id); return store.get(id);
  };
  return { store, engine, id, requests, turn, bad: (value: boolean) => { badRef = value; } };
}

it('composes exact local NPC and user-authorized dialogue in place without treating remote speech as local', async () => {
  const f = await fixture(), action = '玩家原句，保留“引号”。\n下一行'; const session = await f.turn(action);
  expect(session.turns.at(-1)?.status).toBe('completed');
  const writer = f.requests.find(x => x.kind === 'prose')!, input = writer.input as any;
  const world = f.requests.find(x => x.kind === 'world')!, candidates = (world.input as any).behaviorCandidates;
  const checkWorld = compileResultValidator(world.resultSchema);
  expect(checkWorld({ summary: '', changes: [], facts: [], acceptedBehaviorIds: [candidates[0].id] })).toEqual([]);
  expect(checkWorld({ summary: '', changes: [], facts: [], acceptedBehaviorIds: [candidates[0].id.slice(0, 8)] }).length).toBeGreaterThan(0);
  expect(checkWorld({ summary: '', changes: [], acceptedBehaviorIds: [candidates[0].id], facts: [{ text: 'A claim.', sources: [{ kind: 'behavior', id: 'other-turn' }] }] }).length).toBeGreaterThan(0);
  const refs = input.proseBody.references;
  expect(refs.map((x: any) => x.roleId)).toEqual([session.playerRoleId, 'a', 'b']);
  expect(refs[0]).toMatchObject({ ref: `player:${session.turns.at(-1)!.id}`, speaker: 'player', text: action });
  expect(refs.slice(1).map((x: any) => x.text)).toEqual(['a exact words\nsecond line', 'b exact words\nsecond line']);
  expect((writer.resultSchema as any).properties.text).toBeUndefined();
  expect((writer.resultSchema as any).required).toContain('body');
  const entry = session.prose.at(-1)!;
  expect(entry.body?.blocks.filter(x => x.kind === 'speech').map(x => x.roleId)).toEqual([session.playerRoleId, 'a', 'b']);
  expect(entry.text).toBe(proseBodyText(entry.body!));
  expect(entry.body?.blocks.filter(x => x.kind === 'speech').map(x => x.name)).toEqual([session.roles.find(x => x.id === session.playerRoleId)!.name, 'Same name', 'Same name']);
  expect(session.events.some(x => x.kind === 'role-behavior' && x.actor === 'remote' && x.text.startsWith('remote exact'))).toBe(true);
  expect(entry.text).not.toContain('remote exact');
});

it('retains the committed world on an invalid body and uses those original sources in an explicit prose-only recovery', async () => {
  const f = await fixture(); f.bad(true); const failed = await f.turn('Exact player words.');
  expect(failed.turns.at(-1)?.status).toBe('failed'); expect(failed.prose).toHaveLength(0);
  expect(failed.events.some(x => x.kind === 'world-adjudication')).toBe(true);
  const materialTurnId = failed.turns.at(-1)!.id, revision = failed.revision, oldCalls = f.requests.length;
  f.bad(false); const recovered = await f.turn('只补写原先已提交的素材，不增加新对白。', 'author');
  expect(recovered.turns.at(-1)?.status).toBe('completed'); expect(recovered.revision).toBe(revision);
  expect(f.requests.slice(oldCalls).map(x => x.kind)).toEqual(['prose']);
  const input = f.requests.at(-1)!.input as any;
  expect(input.proseBody.materialTurnId).toBe(materialTurnId);
  expect(input.proseBody.references[0].text).toBe('Exact player words.');
  expect(recovered.prose.at(-1)!.text).not.toContain('只补写');
});

it('turns the format off through its source module without rewriting historical bodies', async () => {
  const f = await fixture(); const first = await f.turn('First exact player words.'); const entry = structuredClone(first.prose.at(-1)!);
  const modules = structuredClone(first.card.modules); modules[0].enabled = false;
  updateRuntimeConfiguration(f.store, f.id, { expectedRevision: first.revision, reason: 'Explicit source dialogue protocol off.', cardModules: modules });
  const second = await f.turn('行动里的“引号”不是获准对白。', 'action');
  expect(second.turns.at(-1)?.status).toBe('completed'); expect(second.prose[0]).toEqual(entry);
  expect(second.prose.at(-1)?.body).toBeUndefined(); expect((f.requests.at(-1)!.input as any).proseBody).toBeUndefined();
  expect((f.requests.at(-1)!.resultSchema as any).properties.text).toEqual({ type: 'string' });
});

it('keeps fresh author narration available without pretending a world turn or dialogue happened', async () => {
  const f = await fixture(); const initialRevision = f.store.get(f.id).revision;
  const session = await f.turn('先按当前已知场景试写一小段，不添加角色对白。', 'author');
  expect(session.turns.at(-1)?.status).toBe('completed'); expect(session.revision).toBe(initialRevision);
  expect(f.requests.map(request => request.kind)).toEqual(['prose']);
  expect((f.requests[0].input as any).proseBody).toMatchObject({ materialTurnId: null, references: [] });
  expect(session.prose.at(-1)?.body).toMatchObject({ materialTurnId: null, blocks: [{ kind: 'narration', text: 'The conversation follows.' }] });
  expect(session.events.some(event => event.kind === 'world-adjudication')).toBe(false);
});
