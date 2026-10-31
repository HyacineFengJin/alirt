import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset } from '../shared/types';
import type { StateChange, StateRule } from '../shared/state-rules';
import { createApp } from './app';
import type { AgentRequest, ModelProvider } from './engine';
import { clone, project } from './store';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** Records real engine dispatch while keeping these integration tests entirely local. */
class StateTestProvider implements ModelProvider {
  calls: AgentRequest[] = [];
  changes: StateChange[] = [];
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request);
    if (request.kind === 'role') return { summary: 'The keeper waits.', expression: 'A public reply.', proposals: [] };
    if (request.kind === 'world') return { summary: 'The scene continues.', changes: this.changes, events: ['A bell sounds.'] };
    return { title: 'Scene', text: 'A bell rings in the room.', person: 'third', pov: 'limited' };
  }
}
const transferRules: StateRule[] = [
  { id: 'one-key', type: 'unique-item', field: 'items', item: 'key' },
  { id: 'reveal', type: 'transition', trigger: { roleId: 'player', key: 'secret' }, when: { path: 'trigger.after', equals: 'PRIVATE_AFTER' }, effects: [{ type: 'set', roleId: '$trigger', key: 'flag', value: true }] },
];
const healthRule: StateRule = { id: 'healthy', type: 'invariant', condition: { path: 'roles.npc.state.health', op: 'gte', value: 3 }, message: 'The keeper must remain healthy.' };
function documents(rules: StateRule[] = []) {
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.fields = [
    { key: 'health', label: 'Health', type: 'number', min: 0, max: 10, audience: 'public', editable: true },
    { key: 'items', label: 'Items', type: 'list', audience: 'public', editable: true },
    { key: 'secret', label: 'Secret', type: 'string', audience: 'author', editable: true },
    { key: 'flag', label: 'Flag', type: 'boolean', audience: 'public', editable: true, writableBy: 'derived' },
    { key: 'authorNote', label: 'Author note', type: 'string', audience: 'author', editable: true, writableBy: 'author' },
  ];
  card.world.variables = {};
  card.roles[0].state = { health: 5, items: ['key'], secret: 'PRIVATE_BEFORE', flag: false, authorNote: '' };
  card.roles[0].peers = ['npc'];
  card.roles.push({ id: 'npc', name: 'Keeper', persona: 'A keeper.', goals: [], peers: ['player'], phase: 'active', presence: 'present', state: { health: 5, items: [], secret: 'NPC_PRIVATE', flag: false, authorNote: '' }, knowledge: [] });
  card.stateRules = clone(rules);
  return { card, preset };
}
async function fixture(rules: StateRule[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'rp-state-integration-'));
  const { card, preset } = documents(rules), provider = new StateTestProvider();
  const service = await createApp({ dataRoot: root, provider, catalog: async () => ({ cards: [card], presets: [preset] }) });
  let listener: Server | undefined;
  cleanups.push(async () => {
    await service.close();
    if (listener) await new Promise<void>((resolve, reject) => listener!.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const id = service.store.create(card, preset).id;
  let index = 0;
  const turn = async () => {
    service.engine.submit(id, { requestId: `state-test-${++index}`, expectedRevision: service.store.get(id).revision, action: 'Continue the scene.', mode: 'action' });
    await service.engine.idle(id);
  };
  const api = async () => {
    listener = service.app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => listener!.once('listening', resolve));
    const base = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
    return async (path: string, body: unknown) => {
      const response = await fetch(`${base}/api/sessions/${id}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
  };
  return { ...service, id, provider, turn, api };
}

describe('state transactions at engine and HTTP boundaries', () => {
  it('rolls back the complete world batch and revision when a final invariant fails', async () => {
    const f = await fixture([healthRule]), before = clone(f.store.get(f.id));
    f.provider.changes = [{ roleId: 'player', key: 'health', value: 4 }, { roleId: 'npc', key: 'health', value: 2 }];
    await f.turn();
    const current = f.store.get(f.id);
    expect(current.revision).toBe(before.revision);
    expect(current.world).toEqual(before.world); expect(current.roles.map(role => role.state)).toEqual(before.roles.map(role => role.state));
    expect(current.turns.at(-1)).toMatchObject({ status: 'failed', error: expect.stringContaining(healthRule.message) });
    expect(current.events.some(event => ['state-commit', 'state-transaction', 'world-adjudication'].includes(event.kind))).toBe(false);
    expect(f.provider.calls.some(call => call.kind === 'prose')).toBe(false);
  });

  it('commits a multi-field unique transfer and derived consequence with private causal audit', async () => {
    const f = await fixture(transferRules);
    f.provider.changes = [
      { roleId: 'npc', key: 'items', value: ['key'] },
      { roleId: 'player', key: 'items', value: [] },
      { roleId: 'player', key: 'secret', value: 'PRIVATE_AFTER' },
    ];
    await f.turn();
    const current = f.store.get(f.id);
    expect(current.turns.at(-1)?.status).toBe('completed'); expect(current.revision).toBe(1);
    expect(current.roles[0].state).toMatchObject({ items: [], secret: 'PRIVATE_AFTER', flag: true });
    expect(current.roles[1].state.items).toEqual(['key']);
    const audit = current.events.find(event => event.kind === 'state-transaction')!;
    expect(audit.audience).toBe('author');
    expect((audit.data as any).audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleId: 'player', key: 'secret', before: 'PRIVATE_BEFORE', after: 'PRIVATE_AFTER', origin: 'proposal' }),
      expect.objectContaining({ roleId: 'player', key: 'flag', after: true, origin: 'rule', ruleId: 'reveal', causeId: expect.any(String), trigger: { roleId: 'player', key: 'secret', before: 'PRIVATE_BEFORE', after: 'PRIVATE_AFTER' } }),
    ]));
    const visible = project(current, 'player');
    expect(visible.events.some(event => event.kind === 'state-transaction')).toBe(false);
    const commits = visible.events.filter(event => event.kind === 'state-commit');
    expect(commits).toHaveLength(3);
    for (const event of commits) expect(Object.keys(event.data as object).sort()).toEqual(['key', 'roleId', 'value']);
    expect(commits.find(event => (event.data as any).key === 'flag')?.data).toEqual({ roleId: 'player', key: 'flag', value: true });
    expect(JSON.stringify(visible)).not.toMatch(/PRIVATE_BEFORE|PRIVATE_AFTER|NPC_PRIVATE/);
    expect(JSON.stringify(f.provider.calls.find(call => call.kind === 'prose')?.input)).not.toMatch(/PRIVATE_BEFORE|PRIVATE_AFTER|NPC_PRIVATE/);
  });

  it.each(['authorNote', 'flag'] as const)('rejects direct model writes to the %s field atomically', async key => {
    const f = await fixture(), before = clone(f.store.get(f.id));
    f.provider.changes = [{ roleId: 'player', key: 'health', value: 4 }, { roleId: 'player', key, value: key === 'flag' ? true : 'forbidden' }];
    await f.turn();
    const current = f.store.get(f.id);
    expect(current.revision).toBe(0); expect(current.roles.map(role => role.state)).toEqual(before.roles.map(role => role.state));
    expect(current.turns.at(-1)?.status).toBe('failed');
    expect(f.provider.calls.some(call => call.kind === 'prose')).toBe(false);
  });

  it('runs rules for a manual author edit, rejects stale revision CAS and keeps trigger audit private', async () => {
    const f = await fixture(transferRules), post = await f.api();
    const accepted = await post('/state', { expectedRevision: 0, roleId: 'player', key: 'secret', value: 'PRIVATE_AFTER', reason: 'Advance the hidden trigger.' });
    expect(accepted.status).toBe(200); expect(accepted.body.revision).toBe(1);
    expect(f.store.get(f.id).roles[0].state.flag).toBe(true);
    const events = f.store.get(f.id).events;
    expect(events.find(event => event.kind === 'state-transaction')).toMatchObject({ audience: 'author', actor: 'author' });
    expect(events.find(event => event.kind === 'state-commit')?.data).toEqual({ roleId: 'player', key: 'flag', value: true });
    const before = clone(f.store.get(f.id));
    const stale = await post('/state', { expectedRevision: 0, roleId: 'player', key: 'secret', value: 'stale', reason: 'Stale editor.' });
    expect(stale.status).toBe(409); expect(stale.body.error.code).toBe('REVISION_CONFLICT');
    expect(f.store.get(f.id)).toEqual(before);
    expect(JSON.stringify(project(f.store.get(f.id), 'player'))).not.toMatch(/PRIVATE_BEFORE|PRIVATE_AFTER/);
    expect(f.provider.calls).toHaveLength(0);
  });

  it('returns typed transaction failures as HTTP 400 and rolls back manual state edits', async () => {
    const f = await fixture([healthRule]), post = await f.api(), before = clone(f.store.get(f.id));
    const invalid = await post('/state', { expectedRevision: 0, roleId: 'npc', key: 'health', value: 2, reason: 'Invalid invariant.' });
    expect(invalid.status).toBe(400); expect(invalid.body.error.code).toBe('STATE_RULE_VIOLATION');
    expect(f.store.get(f.id)).toEqual(before);
    const derived = await post('/state', { expectedRevision: 0, roleId: 'player', key: 'flag', value: true, reason: 'Direct derived edit.' });
    expect(derived.status).toBe(400); expect(derived.body.error.code).toBe('STATE_AUTHORITY');
    expect(f.store.get(f.id)).toEqual(before);
  });

  it('installs state rules through the runtime endpoint and applies them on the next explicit edit', async () => {
    const f = await fixture(), post = await f.api();
    const configured = await post('/runtime', { expectedRevision: 0, reason: 'Install native state rules.', stateRules: transferRules });
    expect(configured.status).toBe(200); expect(f.store.get(f.id).card.stateRules).toEqual(transferRules);
    const revision = f.store.get(f.id).revision;
    expect(f.store.get(f.id).roles[0].state.flag).toBe(false); expect(f.provider.calls).toHaveLength(0);
    const edited = await post('/state', { expectedRevision: revision, roleId: 'player', key: 'secret', value: 'PRIVATE_AFTER', reason: 'Trigger the configured rule.' });
    expect(edited.status).toBe(200); expect(f.store.get(f.id).roles[0].state.flag).toBe(true);
  });
});
