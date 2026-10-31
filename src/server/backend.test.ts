import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CharacterCard, Preset } from '../shared/types';
import cardJson from '../../content/cards/harbor.json';
import presetJson from '../../content/presets/basic.json';
import { createApp } from './app';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { clone, project, SessionStore } from './store';

const card = cardJson as CharacterCard, preset = presetJson as Preset;
const roots: string[] = [], cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'rp-backend-test-')); roots.push(root); const store = new SessionStore(root), session = store.create(card, preset); return { root, store, session }; }
const roleId = (request: AgentRequest): string | undefined => (request.input as any)?.delivery?.to;
const submit = (revision = 0) => ({ requestId: 'test-only-request', expectedRevision: revision, action: '问一问今晚的船期。', mode: 'dialogue' as const });
/** Deterministic provider exists only in this test module; production never falls back to it. */
class TestOnlyProvider implements ModelProvider {
  calls: AgentRequest[] = [];
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request);
    if (request.kind === 'role') return { summary: '询问船期。', expression: '今晚还来得及吗？', proposals: [] };
    if (request.kind === 'world') return { summary: '双方确认仍须等待船归港。', changes: [], events: ['信件尚未交出。'] };
    return { title: '等船', text: '潮水拍着栈桥。他们继续等候归船。', person: 'third', pov: 'limited' };
  }
}

describe('host state, projections and lifecycle', () => {
  it('validates compare-and-swap, types, field range and editability before persistence', async () => {
    const { store, session } = await fixture();
    expect(() => store.edit(session.id, { expectedRevision: 1, roleId: 'cen-deng', key: 'energy', value: 50, reason: 'test' })).toThrow('refresh');
    expect(() => store.edit(session.id, { expectedRevision: 0, roleId: 'cen-deng', key: 'energy', value: 500, reason: 'test' })).toThrow('range');
    expect(() => store.edit(session.id, { expectedRevision: 0, roleId: 'cen-deng', key: 'energy', value: '50', reason: 'test' })).toThrow('wrong type');
    expect(store.get(session.id).revision).toBe(0);
    store.edit(session.id, { expectedRevision: 0, roleId: 'cen-deng', key: 'energy', value: 50, reason: 'author correction' });
    expect(store.get(session.id).revision).toBe(1);
  });
  it('omits private personas, goals, state and mail from a different role perspective', async () => {
    const { store, session } = await fixture();
    const stored = store.get(session.id);
    stored.events.push({ id: 'private', at: '', kind: 'peer-mail', actor: 'liang-du', text: 'PRIVATE_MAIL', audience: ['liang-du', 'song-you'] });
    const view = project(stored, 'cen-deng');
    expect(view.roles.find(r => r.id === 'liang-du')?.persona).toBe('');
    expect(view.roles.find(r => r.id === 'liang-du')?.state).not.toHaveProperty('trust');
    expect(JSON.stringify(view)).not.toContain('PRIVATE_MAIL');
    expect(JSON.stringify(view)).not.toContain('检修，不能安排');
    expect(project(stored).roles.find(r => r.id === 'liang-du')?.persona).toBeTruthy();
  });
  it('keeps presence separate, does not run retired/dormant roles, and archives context on fade', async () => {
    const { store, session } = await fixture(), provider = new TestOnlyProvider(), engine = new TurnEngine(store, provider);
    store.lifecycle(session.id, { expectedRevision: 0, roleId: 'liang-du', phase: 'faded', presence: 'present' });
    expect(store.get(session.id).roleContexts?.['liang-du'].generation).toBe(1);
    engine.submit(session.id, submit(1)); await engine.idle(session.id);
    expect(provider.calls.filter(r => r.kind === 'role')).toHaveLength(0);
    expect(provider.calls.some(r => r.sessionId.includes('passing-visitor'))).toBe(false);
    store.lifecycle(session.id, { expectedRevision: 2, roleId: 'liang-du', phase: 'active', presence: 'present' });
    engine.submit(session.id, { ...submit(3), requestId: 'again' }); await engine.idle(session.id);
    expect(provider.calls.some(r => r.sessionId.includes('-role-liang-du-g1-p'))).toBe(true);
  });
  it('marks incomplete jobs interrupted on restart, preserves committed revision and never dispatches them', async () => {
    const { root, store, session } = await fixture();
    const value = clone(store.get(session.id)); value.revision = 3;
    value.turns.push({ id: 'unfinished', requestId: 'old', action: 'old action', mode: 'action', status: 'committed', phase: 'compose', startedAt: '' });
    store.save(value);
    const recovered = new SessionStore(root), provider = new TestOnlyProvider(); new TurnEngine(recovered, provider);
    expect(recovered.get(session.id).turns[0].status).toBe('interrupted');
    expect(recovered.get(session.id).revision).toBe(3);
    expect(provider.calls).toHaveLength(0);
  });
});

describe('role mail, adjudication and single writer', () => {
  it('sends private author style instructions only to prose and leaves world state and revision unchanged', async () => {
    const { store, session } = await fixture(), provider = new TestOnlyProvider(), engine = new TurnEngine(store, provider);
    const before = clone(store.get(session.id));
    const instruction = 'PRIVATE_AUTHOR_STYLE: 保留已发生的事实，用短句重写上一段。';
    engine.submit(session.id, { ...submit(), mode: 'author', action: instruction }); await engine.idle(session.id);
    const after = store.get(session.id);
    expect(provider.calls.map(r => r.kind)).toEqual(['prose']);
    expect((provider.calls[0].input as any).authorInstruction).toBe(instruction);
    expect(after.revision).toBe(before.revision); expect(after.world).toEqual(before.world); expect(after.roles).toEqual(before.roles);
    expect(after.events.some(e => e.kind === 'state-commit' || e.kind === 'world-adjudication')).toBe(false);
    expect(JSON.stringify(project(after, 'cen-deng'))).not.toContain('PRIVATE_AUTHOR_STYLE');
    expect(after.turns[0].status).toBe('completed'); expect(after.prose).toHaveLength(before.prose.length + 1);
  });
  it('resolves imported activation metadata without replacing the bound native text', async () => {
    const { store, session } = await fixture(), provider = new TestOnlyProvider();
    const stored = store.get(session.id);
    stored.preset.compatibility = { importId: 'bound-preset', status: 'native', warnings: [] };
    stored.preset.modules = [{ id: 'bound-style', title: '', category: 'style', content: 'BOUND_SNAPSHOT_TEXT', enabled: true, targets: ['prose'], phase: 'compose', priority: 1 }];
    const seen: string[] = [];
    const engine = new TurnEngine(store, provider, async (id, modules) => { seen.push(id); return modules; });
    engine.submit(session.id, submit()); await engine.idle(session.id);
    expect(seen).toEqual(['bound-preset']);
    expect(provider.calls.find(r => r.kind === 'prose')!.system).toContain('BOUND_SNAPSHOT_TEXT');
    expect(provider.calls.filter(r => r.kind === 'role').every(r => !r.system.includes('BOUND_SNAPSHOT_TEXT'))).toBe(true);
  });
  it('admits linked persona once and preserves equal unrelated card and preset text', async () => {
    const { store, session } = await fixture(), provider = new TestOnlyProvider();
    const stored = store.get(session.id), role = stored.roles.find(r => r.id === 'liang-du')!;
    role.persona = 'EXACT_SOURCE_PERSONA'; role.personaSourcePointer = '/data/entries/1/content';
    const module = { id: 'designated', title: '', category: 'supplement' as const, content: role.persona, enabled: true, targets: ['role' as const], phase: 'decide' as const, priority: 1, sourcePointer: role.personaSourcePointer };
    stored.card.modules = [module]; stored.preset.modules = [];
    const engine = new TurnEngine(store, provider);
    engine.submit(session.id, submit()); await engine.idle(session.id);
    expect(provider.calls.find(r => r.kind === 'role')!.system.split(role.persona)).toHaveLength(2);
    const current = store.get(session.id);
    current.card.modules.push({ ...module, id: 'unrelated', sourcePointer: '/data/entries/99/content' });
    current.preset.modules.push({ ...module, id: 'distinct-preset-same-pointer' });
    engine.submit(session.id, { ...submit(1), requestId: 'source-scope-second-turn' }); await engine.idle(session.id);
    const second = provider.calls.filter(r => r.kind === 'role')[1];
    expect(second.system.split(role.persona)).toHaveLength(4);
    const selection = store.get(session.id).events.filter(e => e.kind === 'prompt-selection' && e.actor === 'role').at(-1)!;
    expect(selection.audience).toBe('author');
    expect((selection.data as any).plan.modules.map((module: any) => module.ref.key)).toEqual(['card:designated', 'card:unrelated', 'preset:distinct-preset-same-pointer']);
    expect(store.get(session.id).roles.find(r => r.id === role.id)!.persona).toBe('EXACT_SOURCE_PERSONA');
  });
  it('deduplicates stable sender operation keys, rejects conflicting payloads, and retains equal text under new keys', async () => {
    const { root, store, session } = await fixture(), provider = new TestOnlyProvider(), base = provider.run.bind(provider);
    provider.run = async request => {
      if (request.kind === 'role') {
        const send = request.tools[0].execute;
        const args = { to: 'song-you', key: 'notice-one', kind: 'notice', replyTo: null, body: 'SAME_TEXT_TWO_EFFECTS' };
        const first = await send(args), repeated = await send(args);
        expect(first.messageId).toBe(repeated.messageId); expect(repeated.duplicate).toBe(true);
        expect(() => send({ ...args, body: 'CONFLICTING_CONTENT' })).toThrow('different mail effect');
        expect((await send({ ...args, key: 'notice-two' })).messageId).not.toBe(first.messageId);
      }
      return base(request);
    };
    const engine = new TurnEngine(store, provider); engine.submit(session.id, submit()); await engine.idle(session.id);
    expect(provider.calls.filter(r => r.kind === 'role')).toHaveLength(1);
    expect(store.get(session.id).mailbox).toHaveLength(2);
    expect(store.get(session.id).mailbox?.every(m => m.state === 'pending')).toBe(true);
    const recovered = new SessionStore(root), nextProvider = new TestOnlyProvider(), nextEngine = new TurnEngine(recovered, nextProvider);
    expect(nextProvider.calls).toHaveLength(0); // Constructing the runtime does not replay a notification.
    recovered.lifecycle(session.id, { expectedRevision: 1, roleId: 'song-you', phase: 'active', presence: 'present' });
    nextEngine.submit(session.id, { ...submit(2), requestId: 'explicit-next-activation' }); await nextEngine.idle(session.id);
    const song = nextProvider.calls.find(r => roleId(r) === 'song-you')!;
    expect((song.input as any).notifications.map((m: any) => m.key)).toEqual(['notice-one', 'notice-two']);
    expect(recovered.get(session.id).mailbox?.every(m => m.state === 'consumed')).toBe(true);
  });
  it('retains notifications and direct requests when delivery fails, without replaying them on restart', async () => {
    const { root, store, session } = await fixture(), provider = new TestOnlyProvider(), base = provider.run.bind(provider);
    provider.run = async request => {
      if (request.kind === 'role' && roleId(request) === 'liang-du') {
        await request.tools[0].execute({ to: 'song-you', key: 'saved-notice', kind: 'notice', replyTo: null, body: 'PRIVATE_SAVED_NOTICE' });
        await request.tools[0].execute({ to: 'song-you', key: 'unanswered-request', kind: 'request', replyTo: null, body: 'PRIVATE_UNANSWERED_REQUEST' });
      }
      if (request.kind === 'role' && roleId(request) === 'song-you') {
        expect((request.input as any).notifications).toHaveLength(1);
        return { summary: 'Invalid result missing expression/proposals' };
      }
      return base(request);
    };
    const engine = new TurnEngine(store, provider); engine.submit(session.id, submit()); await engine.idle(session.id);
    expect(store.get(session.id).turns[0].status).toBe('failed');
    expect(store.get(session.id).mailbox?.every(m => m.state === 'pending')).toBe(true);
    const recovered = new SessionStore(root), nextProvider = new TestOnlyProvider(); new TurnEngine(recovered, nextProvider);
    expect(recovered.get(session.id).mailbox).toHaveLength(2); expect(nextProvider.calls).toHaveLength(0);
    expect(JSON.stringify(project(recovered.get(session.id), 'cen-deng'))).not.toContain('PRIVATE_SAVED_NOTICE');
    expect(project(recovered.get(session.id))).not.toHaveProperty('mailbox');
  });
  it('accepts one correlated reply per request and rejects attempts to reply to unrelated delivery IDs', async () => {
    const { store, session } = await fixture(), provider = new TestOnlyProvider(), base = provider.run.bind(provider);
    provider.run = async request => {
      const mail = (request.input as any).delivery;
      if (request.kind === 'role' && mail.kind === 'host') await request.tools[0].execute({ to: 'song-you', key: 'question', kind: 'request', replyTo: null, body: 'Question' });
      if (request.kind === 'role' && roleId(request) === 'song-you') {
        const reply = { to: 'liang-du', key: 'answer', kind: 'reply', replyTo: mail.id, body: 'Answer' };
        expect(() => request.tools[0].execute({ ...reply, replyTo: 'unrelated-mail' })).toThrow('current direct request');
        const first = await request.tools[0].execute(reply), repeated = await request.tools[0].execute(reply);
        expect(repeated.messageId).toBe(first.messageId);
        expect(() => request.tools[0].execute({ ...reply, key: 'second-answer' })).toThrow('already has its correlated reply');
      }
      return base(request);
    };
    const engine = new TurnEngine(store, provider); engine.submit(session.id, submit()); await engine.idle(session.id);
    expect(store.get(session.id).turns[0].status).toBe('completed');
    expect(store.get(session.id).mailbox?.filter(m => m.kind === 'reply')).toHaveLength(1);
    expect(provider.calls.some(r => roleId(r) === 'cen-deng')).toBe(false);
  });
  it('keeps request/reply direct between NPCs while player mail and acknowledgements never wake a model', async () => {
    const { store, session } = await fixture();
    const provider = new TestOnlyProvider(), fallback = provider.run.bind(provider);
    provider.run = async request => {
      const delivery = (request.input as any).delivery;
      if (request.kind === 'role' && roleId(request) === 'liang-du' && delivery.kind === 'host') {
        await request.tools[0].execute({ to: 'song-you', key: 'check-ferry', kind: 'request', replyTo: null, body: 'PRIVATE_DIRECT_MAIL' });
        await request.tools[0].execute({ to: 'cen-deng', key: 'player-update', kind: 'request', replyTo: null, body: 'PLAYER_PASSIVE_MAIL' });
      }
      if (request.kind === 'role' && roleId(request) === 'song-you') {
        expect(delivery.kind).toBe('request');
        await request.tools[0].execute({ to: 'liang-du', key: 'ferry-answer', kind: 'reply', replyTo: delivery.id, body: 'PRIVATE_DIRECT_REPLY' });
      }
      if (request.kind === 'role' && delivery.kind === 'reply') {
        await request.tools[0].execute({ to: 'song-you', key: 'ferry-ack', kind: 'notice', replyTo: null, body: 'PRIVATE_ACK' });
      }
      return fallback(request);
    };
    const engine = new TurnEngine(store, provider); engine.submit(session.id, submit()); await engine.idle(session.id);
    const stored = store.get(session.id);
    expect(stored.turns[0].status).toBe('completed'); expect(stored.revision).toBe(1); expect(stored.prose).toHaveLength(2);
    expect(provider.calls.filter(r => r.kind === 'role')).toHaveLength(3);
    expect(provider.calls.some(r => roleId(r) === 'cen-deng')).toBe(false);
    expect((provider.calls.find(r => r.kind === 'role')!.input as any).allowedPeers).toEqual(card.roles[1].peers);
    expect(JSON.stringify(provider.calls.find(r => r.kind === 'world')?.input)).not.toContain('PRIVATE_DIRECT_MAIL');
    expect((provider.calls.find(r => r.kind === 'world')!.input as any).playerRoleId).toBe('cen-deng');
    expect((provider.calls.find(r => r.kind === 'world')!.input as any).playerControl.authorizedAction).toBe(submit().action);
    const writer = provider.calls.find(r => r.kind === 'prose')!;
    expect(writer.tools).toHaveLength(0); expect((writer.input as any).revision).toBe(1);
    expect(JSON.stringify(writer.input)).not.toContain('信尚未交出，收件人的名字只有岑灯知道');
    expect(stored.events.some(e => e.kind === 'peer-mail' && e.audience instanceof Array)).toBe(true);
    expect(stored.mailbox?.find(m => m.key === 'check-ferry')?.state).toBe('consumed');
    expect(stored.mailbox?.find(m => m.key === 'ferry-answer')?.state).toBe('consumed');
    expect(stored.mailbox?.find(m => m.key === 'ferry-ack')?.state).toBe('pending');
    expect(stored.mailbox?.find(m => m.key === 'player-update')?.state).toBe('pending');
    expect(project(stored, 'cen-deng')).not.toHaveProperty('mailbox');
    expect(JSON.stringify(project(stored, 'cen-deng'))).not.toContain('PRIVATE_DIRECT_REPLY');
    expect(stored.roles[0].state).toEqual(card.roles[0].state);
  });
  it('rejects role proposals that target another owner before presenting them to world', async () => {
    const { store, session } = await fixture(), provider = new TestOnlyProvider(), base = provider.run.bind(provider);
    provider.run = async request => request.kind === 'role' ? (provider.calls.push(request), { summary: 'proposal', expression: '', proposals: [{ roleId: 'world', key: 'tide', value: 'low' }] }) : base(request);
    const engine = new TurnEngine(store, provider); engine.submit(session.id, submit()); await engine.idle(session.id);
    const world = provider.calls.find(r => r.kind === 'world')!;
    expect((world.input as any).results.every((r: any) => r.proposals.length === 0)).toBe(true);
    expect(store.get(session.id).events.filter(e => e.kind === 'proposal-rejected')).toHaveLength(1);
  });
  it('rejects a world batch atomically when any value is invalid; a writer never runs', async () => {
    const { store, session } = await fixture(), provider = new TestOnlyProvider(), base = provider.run.bind(provider);
    provider.run = async request => request.kind === 'world' ? { summary: 'invalid', events: [], changes: [{ roleId: 'cen-deng', key: 'energy', value: 51 }, { roleId: 'liang-du', key: 'energy', value: 999 }] } : base(request);
    const engine = new TurnEngine(store, provider); engine.submit(session.id, submit()); await engine.idle(session.id);
    expect(store.get(session.id).revision).toBe(0); expect(store.get(session.id).roles[0].state.energy).toBe(68);
    expect(store.get(session.id).turns[0].status).toBe('failed'); expect(provider.calls.some(r => r.kind === 'prose')).toBe(false);
  });
  it('enforces card-declared item uniqueness against the prospective whole batch', async () => {
    const { store, session } = await fixture(), provider = new TestOnlyProvider(), base = provider.run.bind(provider);
    const state = store.get(session.id);
    (state.card as any).stateRules = [{ id: 'single-letter', type: 'unique-item', field: 'equipment', item: '密封信件' }];
    provider.run = async request => request.kind === 'world' ? { summary: 'invalid transfer', events: [], changes: [{ roleId: 'liang-du', key: 'equipment', value: ['旧册子', '渡船钥匙', '密封信件'] }] } : base(request);
    const engine = new TurnEngine(store, provider); engine.submit(session.id, submit()); await engine.idle(session.id);
    expect(store.get(session.id).revision).toBe(0); expect(store.get(session.id).roles[1].state.equipment).not.toContain('密封信件');
    expect(store.get(session.id).turns[0].error).toContain('only one holder');
  });
  it('retains an already committed world if prose fails and deduplicates user request IDs', async () => {
    const { store, session } = await fixture(), provider = new TestOnlyProvider(), base = provider.run.bind(provider);
    provider.run = async request => { if (request.kind === 'prose') throw new Error('test-only provider failure'); return base(request); };
    const engine = new TurnEngine(store, provider), first = engine.submit(session.id, submit()); await engine.idle(session.id);
    expect(store.get(session.id).revision).toBe(1); expect(store.get(session.id).prose).toHaveLength(1);
    expect(store.get(session.id).turns[0].error).toContain('already committed');
    expect(engine.submit(session.id, submit()).turnId).toBe(first.turnId);
    expect(engine.submit(session.id, submit()).duplicate).toBe(true);
    provider.run = base;
    const before = provider.calls.length;
    engine.submit(session.id, { ...submit(1), requestId: 'explicit-prose-recovery', mode: 'author', action: '按已提交事实重新成文。' });
    await engine.idle(session.id);
    const recovery = provider.calls.slice(before);
    expect(recovery.map(r => r.kind)).toEqual(['prose']);
    expect((recovery[0].input as any).events.some((e: any) => e.kind === 'world-event')).toBe(true);
    expect((recovery[0].input as any).playerControl.authorizedAction).toBe(submit().action);
    expect(store.get(session.id).revision).toBe(1);
    expect(store.get(session.id).turns.map(t => t.status)).toEqual(['failed', 'completed']);
  });
  it('cancels without committing state and preserves a truthful interrupted status', async () => {
    const { store, session } = await fixture(), provider = new TestOnlyProvider();
    let began!: () => void; const ready = new Promise<void>(resolve => { began = resolve; });
    provider.run = async request => new Promise((_resolve, reject) => { began(); request.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
    const engine = new TurnEngine(store, provider); engine.submit(session.id, submit()); await ready; engine.cancel(session.id); await engine.idle(session.id);
    expect(store.get(session.id).turns[0].status).toBe('interrupted'); expect(store.get(session.id).revision).toBe(0);
  });
});

describe('HTTP boundary', () => {
  it('rejects cross-origin mutations and unconfigured generation without fake prose', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-api-test-')); roots.push(root);
    const service = await createApp({ dataRoot: root, catalog: async () => ({ cards: [card], presets: [preset] }), provider: { configured: () => false, run: async () => { throw new Error('must not run'); } } });
    const listener = service.app.listen(0, '127.0.0.1'); await new Promise<void>(done => listener.once('listening', done));
    cleanups.push(async () => { await service.close(); await new Promise<void>(done => listener.close(() => done())); });
    const port = (listener.address() as any).port, url = `http://127.0.0.1:${port}`;
    const response = await fetch(url + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.invalid' }, body: '{}' });
    expect(response.status).toBe(403);
    const created = await fetch(url + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId: card.id, presetId: preset.id }) }).then(r => r.json());
    const turn = await fetch(`${url}/api/sessions/${created.id}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submit()) });
    expect(turn.status).toBe(503); expect((await turn.json()).error.code).toBe('PROVIDER_UNCONFIGURED');
    expect(service.store.get(created.id).turns).toHaveLength(0); expect(service.store.get(created.id).prose).toHaveLength(1);
  });
});
