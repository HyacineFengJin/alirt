import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Knowledge, Preset, RoleDefinition } from '../shared/types';
import { createApp } from './app';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { publicPromptView } from './prompt-compiler';
import { project, SessionStore, type StoredSession } from './store';

const roots: string[] = [], cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const npc = (id: string, knowledge: Knowledge[] = []): RoleDefinition => ({ id, name: id, persona: '', goals: [], peers: ['player', 'alice', 'bob', 'cara'].filter(peer => peer !== id), phase: 'active', presence: 'present', state: {}, knowledge });
function documents() {
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.id = 'knowledge-integration-card'; preset.id = 'knowledge-integration-preset';
  card.roles.push(npc('alice', [
    { id: 'root', text: 'ROOT_PRIVATE_SOURCE_TEXT', audience: ['alice'], status: 'known' },
    { id: 'unsent', text: 'UNSENT_PRIVATE_MEMORY', audience: ['alice'], status: 'known' },
    { id: 'author', text: 'AUTHOR_ONLY_CARD_SECRET', audience: 'author', status: 'known' },
  ]), npc('bob'), npc('cara'));
  card.roles[0].peers = ['alice', 'bob', 'cara'];
  return { card, preset };
}
class KnowledgeTestProvider implements ModelProvider {
  calls: AgentRequest[] = [];
  onRole?: (request: AgentRequest) => Promise<void>;
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request);
    if (request.kind === 'role') {
      await this.onRole?.(request);
      return { summary: 'A permitted public report.', expression: 'The scene continues.', proposals: [] };
    }
    if (request.kind === 'world') return { summary: 'Public outcome.', changes: [], events: ['Public scene event.'] };
    return { title: 'Scene', text: 'PRIOR_PROSE_FOR_BOUNDARY_CHECK', person: 'third', pov: 'limited' };
  }
}
const input = (request: AgentRequest): any => request.input;
const sourceId = (session: StoredSession, roleId: string, knowledgeId: string) => session.roles.find(role => role.id === roleId)!.knowledge.find(knowledge => knowledge.id === knowledgeId)!.provenance!.sourceId;
const knowledge = (session: StoredSession, roleId: string) => session.roles.find(role => role.id === roleId)!.knowledge;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rp-knowledge-integration-')); roots.push(root);
  const { card, preset } = documents(), store = new SessionStore(root), provider = new KnowledgeTestProvider();
  const id = store.create(card, preset).id, engine = new TurnEngine(store, provider);
  cleanups.push(() => engine.close());
  let request = 0;
  const turn = async () => {
    engine.submit(id, { requestId: `knowledge-turn-${++request}`, expectedRevision: store.get(id).revision, action: 'Ask about the scene.', mode: 'action' });
    await engine.idle(id);
  };
  return { root, store, provider, id, turn };
}

describe('knowledge through engine dispatch and author HTTP APIs', () => {
  it('tracks actual three-NPC relays and invalidates dependent knowledge and native contexts on withdrawal', async () => {
    const service = await fixture(), { store, provider, id } = service;
    let sent = false, laterNoticeSent = false;
    provider.onRole = async request => {
      const material = input(request), delivery = material.delivery, send = request.tools.find(tool => tool.name === 'peer_send')!.execute;
      expect(material.knowledge.some((entry: Knowledge) => entry.text === 'AUTHOR_ONLY_CARD_SECRET')).toBe(false);
      expect(material.knowledge.every((entry: Knowledge) => !entry.provenance)).toBe(true);
      if (delivery.to === 'alice' && delivery.kind === 'host' && !sent) {
        sent = true;
        const root = material.knowledgeReferences.find((ref: any) => ref.text === 'ROOT_PRIVATE_SOURCE_TEXT').id;
        await send({ to: 'bob', key: 'relay-ab', kind: 'request', replyTo: null, body: 'EXACT_PRIVATE_A_TO_B_BODY', sourceRefs: [root] });
        await send({ to: 'player', key: 'passive-user', kind: 'request', replyTo: null, body: 'PLAYER_PASSIVE_BODY', sourceRefs: [root] });
      }
      if (delivery.kind === 'request' && delivery.to === 'bob') {
        const received = knowledge(store.get(id), 'bob').find(entry => entry.text === 'EXACT_PRIVATE_A_TO_B_BODY')!;
        expect(received).toMatchObject({ status: 'uncertain', lifecycle: 'active' });
        expect(store.get(id).mailbox!.find(mail => mail.id === delivery.id)!.state).toBe('pending');
        const currentReceipt = material.knowledgeReferences.find((ref: any) => ref.text === received.text);
        expect(currentReceipt.id).toBe(received.provenance!.sourceId);
        expect(JSON.stringify(material)).not.toMatch(/ROOT_PRIVATE_SOURCE_TEXT|UNSENT_PRIVATE_MEMORY|AUTHOR_ONLY_CARD_SECRET/);
        await send({ to: 'cara', key: 'relay-bc', kind: 'request', replyTo: null, body: 'EXACT_PRIVATE_B_TO_C_BODY', sourceRefs: [currentReceipt.id] });
        await send({ to: 'alice', key: 'pending-notice', kind: 'notice', replyTo: null, body: 'LATER_WITHDRAWN_NOTICE', sourceRefs: [currentReceipt.id] });
      }
      if (delivery.to === 'cara' && delivery.kind === 'host' && !laterNoticeSent) {
        const receipt = material.knowledgeReferences.find((ref: any) => ref.text === 'EXACT_PRIVATE_B_TO_C_BODY');
        if (receipt) {
          laterNoticeSent = true;
          await send({ to: 'alice', key: 'pending-withdrawn-notice', kind: 'notice', replyTo: null, body: 'STALE_PENDING_NOTICE_BODY', sourceRefs: [receipt.id] });
        }
      }
      if (delivery.kind === 'request' && delivery.to === 'cara') {
        expect(knowledge(store.get(id), 'cara')).toEqual([expect.objectContaining({ text: 'EXACT_PRIVATE_B_TO_C_BODY', status: 'uncertain' })]);
        expect(JSON.stringify(material)).not.toMatch(/ROOT_PRIVATE_SOURCE_TEXT|EXACT_PRIVATE_A_TO_B_BODY|UNSENT_PRIVATE_MEMORY/);
      }
    };
    await service.turn();
    expect(store.get(id).turns.at(-1)!.status).toBe('completed');
    expect(knowledge(store.get(id), 'player')).toEqual([]);
    expect(provider.calls.filter(call => call.kind === 'role').every(call => input(call).delivery.to !== 'player')).toBe(true);
    expect(store.get(id).mailbox!.find(mail => mail.key === 'passive-user')!.state).toBe('pending');
    expect(store.get(id).mailbox!.find(mail => mail.key === 'relay-ab')!.state).toBe('consumed');
    expect(store.get(id).mailbox!.find(mail => mail.key === 'relay-bc')!.state).toBe('consumed');
    for (const call of provider.calls.filter(call => call.kind !== 'role')) expect(JSON.stringify(call.input)).not.toMatch(/ROOT_PRIVATE_SOURCE_TEXT|EXACT_PRIVATE_A_TO_B_BODY|EXACT_PRIVATE_B_TO_C_BODY|UNSENT_PRIVATE_MEMORY/);
    const firstBindings = structuredClone(store.get(id).promptContexts!);
    const caraClaim = knowledge(store.get(id), 'cara')[0];
    store.knowledge(id, { expectedRevision: store.get(id).revision, reason: 'Add an explicitly linked summary', operation: 'upsert', roleId: 'cara', id: 'derived-summary', text: 'PUBLIC_DERIVED_SUMMARY', audience: 'public', status: 'known', sourceRefs: [caraClaim.provenance!.sourceId] });
    expect(knowledge(store.get(id), 'cara').find(entry => entry.id === 'derived-summary')!.status).toBe('uncertain');
    await service.turn();
    expect(store.get(id).turns.at(-1)!.status).toBe('completed');
    for (const key of ['role:alice', 'role:bob', 'role:cara', 'world', 'prose']) expect(store.get(id).promptContexts![key].sessionId).toBe(firstBindings[key].sessionId);
    expect(input(provider.calls.filter(call => call.kind === 'prose').at(-1)!).previousProse).toBe('PRIOR_PROSE_FOR_BOUNDARY_CHECK');
    // A fresh pending notice tests withdrawal before the recipient's next activation.
    const notice = store.get(id).mailbox!.find(mail => mail.key === 'pending-notice')!;
    expect(notice.state).toBe('consumed');
    const pendingNotice = store.get(id).mailbox!.find(mail => mail.key === 'pending-withdrawn-notice')!;
    expect(pendingNotice.state).toBe('pending');
    store.knowledge(id, { expectedRevision: store.get(id).revision, reason: 'Withdraw the original source', operation: 'retract', roleId: 'alice', id: 'root' });
    expect(knowledge(store.get(id), 'alice').find(entry => entry.id === 'root')!.lifecycle).toBe('withdrawn');
    for (const role of ['bob', 'cara']) expect(knowledge(store.get(id), role).every(entry => entry.lifecycle === 'stale')).toBe(true);
    expect(JSON.stringify(publicPromptView(store.get(id)))).not.toContain('PUBLIC_DERIVED_SUMMARY');
    const start = provider.calls.length;
    await service.turn();
    expect(store.get(id).turns.at(-1)!.status).toBe('completed');
    for (const key of ['role:alice', 'role:bob', 'role:cara', 'world', 'prose']) {
      const bound = store.get(id).promptContexts![key];
      expect(bound.sessionId).not.toBe(firstBindings[key].sessionId); expect(bound.generation).toBe(firstBindings[key].generation + 1);
    }
    for (const call of provider.calls.slice(start)) {
      if (call.kind === 'role') {
        expect(input(call).context.rebuilt).toBe(true);
        expect(JSON.stringify(input(call).knowledge)).not.toMatch(/ROOT_PRIVATE_SOURCE_TEXT|EXACT_PRIVATE_A_TO_B_BODY|EXACT_PRIVATE_B_TO_C_BODY|PUBLIC_DERIVED_SUMMARY/);
        expect(input(call).notifications).toEqual([]);
      }
      if (call.kind === 'prose') expect(input(call).previousProse).toBe('');
      expect(JSON.stringify(call.input)).not.toContain('STALE_PENDING_NOTICE_BODY');
    }
    expect(store.get(id).mailbox!.find(mail => mail.id === pendingNotice.id)!.state).toBe('pending');
    expect(store.get(id).knowledgeRegistry!.history.some(entry => entry.knowledge.text === 'PUBLIC_DERIVED_SUMMARY')).toBe(true);
  });

  it('retains durable uncertain inbox knowledge and a pending acknowledgement when recipient reasoning fails', async () => {
    const service = await fixture(), { store, provider, id } = service;
    provider.onRole = async request => {
      const delivery = input(request).delivery;
      if (delivery.to === 'alice' && delivery.kind === 'host') await request.tools[0].execute({ to: 'bob', key: 'failed-reasoning', kind: 'request', replyTo: null, body: 'DURABLE_UNCERTAIN_INBOX', sourceRefs: [sourceId(store.get(id), 'alice', 'root')] });
      if (delivery.to === 'bob' && delivery.kind === 'request') {
        expect(knowledge(store.get(id), 'bob')[0]).toMatchObject({ text: 'DURABLE_UNCERTAIN_INBOX', status: 'uncertain' });
        throw new Error('Recipient reasoning failed intentionally');
      }
    };
    await service.turn();
    const stored = store.get(id), mail = stored.mailbox!.find(mail => mail.key === 'failed-reasoning')!;
    expect(stored.turns.at(-1)!.status).toBe('failed'); expect(stored.turns.at(-1)!.error).toContain('Recipient reasoning failed intentionally');
    expect(mail.state).toBe('pending'); expect(mail.consumedAt).toBeUndefined();
    expect(knowledge(stored, 'bob')).toEqual([expect.objectContaining({ text: mail.body, status: 'uncertain', provenance: expect.objectContaining({ deliveryId: mail.id }) })]);
    expect(provider.calls.some(call => call.kind === 'world' || call.kind === 'prose')).toBe(false);
    const recovered = new SessionStore(service.root);
    expect(knowledge(recovered.get(id), 'bob')).toEqual(knowledge(stored, 'bob'));
    expect(recovered.get(id).mailbox!.find(item => item.id === mail.id)!.state).toBe('pending');
    expect(recovered.get(id).knowledgeRegistry!.sources.filter(source => source.deliveryId === mail.id)).toHaveLength(1);
  });

  it('enforces author HTTP revision/reason/source validation and keeps projections free of private lineage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-knowledge-http-')); roots.push(root);
    const { card, preset } = documents(), provider = new KnowledgeTestProvider();
    const service = await createApp({ dataRoot: root, provider, catalog: async () => ({ cards: [card], presets: [preset] }) });
    cleanups.push(service.close);
    const id = service.store.create(card, preset).id;
    const server: Server = await new Promise(resolve => { const listening = service.app.listen(0, '127.0.0.1', () => resolve(listening)); });
    cleanups.unshift(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected loopback server');
    const base = `http://127.0.0.1:${address.port}/api/sessions/${id}`;
    const post = (body: unknown) => fetch(base + '/knowledge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const read = await fetch(base + '/knowledge'); expect(read.status).toBe(200);
    const original = await read.json(); expect(original.revision).toBe(0); expect(original.registry.schema).toBe('rp.knowledge/0.1');
    const edit = { expectedRevision: 0, reason: 'An author claim', operation: 'upsert', roleId: 'bob', id: 'manual', text: 'PUBLIC_MANUAL_CLAIM', audience: 'public', status: 'known' };
    expect((await post({ ...edit, expectedRevision: 99 })).status).toBe(409);
    expect((await post({ ...edit, reason: '' })).status).toBe(400);
    expect((await post({ ...edit, sourceRefs: ['unknown-source'] })).status).toBe(400);
    expect((await post({ ...edit, unexpected: true })).status).toBe(400);
    expect(await (await fetch(base + '/knowledge')).json()).toEqual(original);
    const updated = await post(edit); expect(updated.status).toBe(200); expect((await updated.json()).revision).toBe(1);
    expect((await post(edit)).status).toBe(409);
    const learned = service.store.get(id).roles.find(role => role.id === 'bob')!.knowledge[0];
    const roleView = await (await fetch(base + '?perspective=player')).json();
    expect(roleView).not.toHaveProperty('knowledgeRegistry'); expect(roleView).not.toHaveProperty('registry');
    expect(JSON.stringify(roleView)).not.toMatch(/provenance|sourceRefs|ROOT_PRIVATE_SOURCE_TEXT|UNSENT_PRIVATE_MEMORY|AUTHOR_ONLY_CARD_SECRET/);
    expect(JSON.stringify(roleView)).not.toContain(learned.provenance!.sourceId);
    const withdrawn = await post({ expectedRevision: 1, reason: 'Withdraw the manual claim', operation: 'retract', roleId: 'bob', id: 'manual' });
    expect(withdrawn.status).toBe(200); expect((await withdrawn.json()).revision).toBe(2);
    const author = await (await fetch(base + '/knowledge')).json();
    expect(author.registry.history.some((entry: any) => entry.knowledge.text === 'PUBLIC_MANUAL_CLAIM')).toBe(true);
    expect(author.roles.find((role: any) => role.id === 'bob').knowledge[0].lifecycle).toBe('withdrawn');
    const projected = await (await fetch(base + '?perspective=player')).json();
    expect(JSON.stringify(projected)).not.toContain('PUBLIC_MANUAL_CLAIM');
    expect(project(service.store.get(id), 'player').roles.flatMap(role => role.knowledge)).toEqual([]);
    expect(provider.calls).toEqual([]);
  });
});
