import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate, validateNativeDocument } from '../shared/native';
import type { RoleStageTemplate } from '../shared/role-stage';
import type { CharacterCard, Preset, SessionSnapshot } from '../shared/types';
import type { WorldbookBinding } from '../shared/worldbook';
import type { AgentModuleContext } from './agent-modules';
import { createApp } from './app';
import type { AgentRequest, ModelProvider } from './engine';
import { updateRuntimeConfiguration } from './runtime-config';
import { clone, project } from './store';

const roots: string[] = [], cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const COMMON = 'OWNER_COMMON_PROFILE. PRIVATE_SEED_TOKEN.\n';
const NEW = 'STAGE_NEW_VISITOR: Keep a courteous distance.\n';
const FAMILIAR = 'STAGE_FAMILIAR_VISITOR: Offer a familiar greeting.\n';
const TRUSTED = 'STAGE_TRUSTED_VISITOR: Speak with long-standing confidence.\n';

/** Deliberately inert EJS-shaped control text: it is sliced, never evaluated. */
function template() {
  let body = '';
  const parts: RoleStageTemplate['parts'] = [], controlRanges: NonNullable<RoleStageTemplate['controlRanges']> = [];
  const append = (text: string, stageId?: string, control = false) => {
    const start = body.length; body += text;
    if (control) controlRanges.push({ start, end: body.length });
    else parts.push({ start, end: body.length, ...(stageId ? { stageId } : {}) });
  };
  append(COMMON);
  append('<% if (affinity < 350) { %>', undefined, true); append(NEW, 'new');
  append('<% } else if (affinity < 900) { %>', undefined, true); append(FAMILIAR, 'familiar');
  append('<% } else { %>', undefined, true); append(TRUSTED, 'trusted');
  append('<% } %>', undefined, true);
  const roleStage: RoleStageTemplate = { schema: 'rp.role-stage/0.1', roleId: 'owner', field: 'affinity',
    stages: [{ id: 'new', max: 350 }, { id: 'familiar', min: 350, max: 900 }, { id: 'trusted', min: 900 }], parts, controlRanges };
  return { body, roleStage };
}

function documents(value: number | null = 0) {
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  const { body, roleStage } = template();
  card.id = 'stage-card'; preset.id = 'stage-preset';
  card.fields = [{ key: 'affinity', label: 'Author relationship value', type: 'number', min: -100, max: 1000, audience: 'author', writableBy: 'author', editable: true }];
  card.roles.push(
    { id: 'owner', name: 'Owner', persona: body, personaSourcePointer: '/source/owner/profile', goals: [], peers: [], phase: 'active', presence: 'present', state: { affinity: value }, knowledge: [] },
    { id: 'other', name: 'Other', persona: 'OTHER_INDEPENDENT_PERSONA', goals: [], peers: [], phase: 'active', presence: 'present', state: { affinity: 900 }, knowledge: [] },
  );
  card.modules = [{ id: 'owner-profile', title: 'Owner stage profile', category: 'supplement', content: body, sourcePointer: '/source/owner/profile',
    enabled: true, targets: ['role'], phase: 'decide', priority: 0, lifetime: { stickyTurns: 10 } }];
  const binding: WorldbookBinding & { roleStage: RoleStageTemplate } = { id: 'owner-profile-binding', moduleId: 'owner-profile', purpose: 'entity-profile',
    audience: ['owner'], contentHash: digest(body), roleStage };
  card.worldbook = { schema: 'rp.worldbook/0.1', bindings: [binding] };
  return { card, preset, body };
}

class RecordingProvider implements ModelProvider {
  calls: AgentRequest[] = [];
  viewResults: unknown[] = [];
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request);
    if (request.kind === 'role') {
      const view = request.tools.find(tool => tool.name === 'read_permitted_view');
      if (view) this.viewResults.push(await view.execute({}));
      return { summary: 'A visitor listens.', expression: 'Good morning.', proposals: [] };
    }
    if (request.kind === 'world') return { summary: 'The room stays quiet.', changes: [], events: ['A clock ticks.'] };
    if (request.kind === 'prose') return { title: 'Morning', text: 'Sunlight falls across the table.', person: 'third', pov: 'limited' };
    throw new Error('Creator models are outside this test');
  }
}
async function fixture(input = documents(), observeViews = false) {
  const root = await mkdtemp(join(tmpdir(), 'rp-role-stage-')); roots.push(root);
  const provider = new RecordingProvider(), contexts: AgentModuleContext[] = [];
  const { card, preset } = input;
  const service = await createApp({ dataRoot: root, provider, catalog: async () => ({ cards: [card], presets: [preset] }),
    agentModules: observeViews ? [{ meta: { id: 'test.stage-view', title: 'Permitted view', version: '1', apiVersion: 'rp.agent-module/0.1', requires: ['rp.role-agents'] },
      roleTools: context => { contexts.push(context); return [{ name: 'read_permitted_view', description: 'Read the permitted role view.',
        parameters: { type: 'object', properties: {} }, execute: () => context.view }]; } }] : [] });
  cleanups.push(service.close);
  const id = service.store.create(card, preset).id;
  if (observeViews) {
    const session = clone(service.store.get(id)); session.agentRuntime = { profile: 'compact', modules: { 'test.stage-view': true } }; service.store.save(session);
  }
  let index = 0;
  const turn = async () => {
    service.engine.submit(id, { requestId: `stage-${++index}`, expectedRevision: service.store.get(id).revision, action: 'Greet the visitors.', mode: 'action' });
    await service.engine.idle(id);
  };
  const affinity = (value: number) => service.store.stateTransaction(id, { expectedRevision: service.store.get(id).revision,
    reason: 'Choose a relationship baseline for this test.', changes: [{ roleId: 'owner', key: 'affinity', value }] });
  return { ...service, id, provider, contexts, turn, affinity };
}
const roleCalls = (provider: RecordingProvider, id: string) => provider.calls.filter(call => call.kind === 'role' && call.sessionId.includes(`-role-${id}-`));
const prompt = (call: AgentRequest) => call.system + '\n' + JSON.stringify(call.promptLayout);
const ownerView = (snapshot: SessionSnapshot) => snapshot.roles.find(role => role.id === 'owner')!;

describe('declarative role-stage templates in bound sessions', () => {
  it('selects author-only 0/350/900 stages, rebinds only the owner and preserves source and lifetime identity', async () => {
    const input = documents(), modules = structuredClone(input.card.modules), roles = structuredClone(input.card.roles);
    expect(validateNativeDocument('card', input.card)).toEqual([]);
    const service = await fixture(input);
    const identities: string[] = [];
    for (const [index, value] of [0, 350, 900].entries()) {
      if (index) service.affinity(value);
      const preview = await service.engine.preview(service.id, { target: 'role', roleId: 'owner' });
      expect(preview.valid).toBe(true); expect(preview.modules).toHaveLength(1);
      await service.turn();
      expect(service.store.get(service.id).turns.at(-1)?.status).toBe('completed');
      const call = roleCalls(service.provider, 'owner')[index];
      expect(prompt(call)).toContain(COMMON);
      expect(prompt(call)).toContain([NEW, FAMILIAR, TRUSTED][index]);
      for (const excluded of [NEW, FAMILIAR, TRUSTED].filter((_, stage) => stage !== index)) expect(prompt(call)).not.toContain(excluded);
      expect(prompt(call)).not.toContain('<%'); expect(prompt(call)).not.toContain(input.body);
      expect((call.input as any).ownState).not.toHaveProperty('affinity');
      expect((call.input as any).fields.some((field: { key: string }) => field.key === 'affinity')).toBe(false);
      const ledger = service.store.get(service.id).promptActivations?.['role:owner'];
      identities.push(Object.values(ledger ?? {})[0]?.identity ?? '');
    }
    const owner = roleCalls(service.provider, 'owner'), other = roleCalls(service.provider, 'other');
    expect(new Set(owner.map(call => call.sessionId)).size).toBe(3);
    expect(new Set(other.map(call => call.sessionId)).size).toBe(1);
    expect(owner.map(call => (call.input as any).context.generation)).toEqual([1, 2, 3]);
    expect(other.map(call => (call.input as any).context.rebuilt)).toEqual([true, false, false]);
    expect(identities.every(Boolean)).toBe(true); expect(new Set(identities).size).toBe(1);
    service.affinity(950); await service.turn();
    expect(roleCalls(service.provider, 'owner')[3].sessionId).toBe(owner[2].sessionId);
    expect(service.store.get(service.id).card.modules).toEqual(modules);
    expect(service.store.get(service.id).card.roles).toEqual(roles);
  });

  it('delivers common parts with a warning for null instead of guessing a stage', async () => {
    const service = await fixture(documents(null));
    const preview = await service.engine.preview(service.id, { target: 'role', roleId: 'owner' });
    expect(preview.valid).toBe(true); expect(preview.modules[0].content).toContain(COMMON);
    expect(preview.modules[0].content).not.toMatch(/STAGE_NEW_VISITOR|STAGE_FAMILIAR_VISITOR|STAGE_TRUSTED_VISITOR|<%/);
    expect(preview.diagnostics.some(item => item.severity === 'warning')).toBe(true);
    await service.turn();
    expect(service.store.get(service.id).turns.at(-1)?.status).toBe('completed');
    expect(prompt(roleCalls(service.provider, 'owner')[0])).toContain(COMMON);
    expect(prompt(roleCalls(service.provider, 'owner')[0])).not.toMatch(/STAGE_NEW_VISITOR|STAGE_FAMILIAR_VISITOR|STAGE_TRUSTED_VISITOR|<%/);
    expect(service.store.get(service.id).roles.find(role => role.id === 'owner')!.state.affinity).toBeNull();
  });

  it('blocks a stale body hash before owner dispatch and retains the exact source module', async () => {
    const input = documents(); input.card.worldbook!.bindings[0].contentHash = digest('Another source body');
    const service = await fixture(input);
    const preview = await service.engine.preview(service.id, { target: 'role', roleId: 'owner' });
    expect(preview.valid).toBe(false); expect(preview.modules).toEqual([]);
    expect(preview.diagnostics.some(item => item.severity === 'error' && item.code.includes('worldbook'))).toBe(true);
    await service.turn();
    expect(roleCalls(service.provider, 'owner')).toEqual([]);
    expect(service.store.get(service.id).turns.at(-1)?.status).toBe('failed');
    expect(service.store.get(service.id).card.modules[0].content).toBe(input.body);
    expect(service.store.get(service.id).card.modules[0].enabled).toBe(true);
  });

  it('keeps private owner material out of other roles and raw templates out of every role tool/view', async () => {
    const input = documents(), service = await fixture(input, true);
    const other = await service.engine.preview(service.id, { target: 'role', roleId: 'other' });
    expect(other.modules).toEqual([]);
    await service.turn();
    expect(prompt(roleCalls(service.provider, 'owner')[0])).toContain(NEW);
    for (const call of service.provider.calls.filter(call => call.kind !== 'role' || !call.sessionId.includes('-role-owner-'))) {
      expect(prompt(call)).not.toMatch(/OWNER_COMMON_PROFILE|STAGE_NEW_VISITOR|STAGE_FAMILIAR_VISITOR|STAGE_TRUSTED_VISITOR|PRIVATE_SEED_TOKEN|<%/);
      expect(JSON.stringify(call.input)).not.toMatch(/OWNER_COMMON_PROFILE|STAGE_NEW_VISITOR|STAGE_FAMILIAR_VISITOR|STAGE_TRUSTED_VISITOR|PRIVATE_SEED_TOKEN|<%/);
    }
    for (const perspective of ['player', 'owner', 'other']) {
      const visible = project(service.store.get(service.id), perspective);
      expect(ownerView(visible).persona).toBe('');
      expect(JSON.stringify(visible)).not.toMatch(/OWNER_COMMON_PROFILE|STAGE_NEW_VISITOR|STAGE_FAMILIAR_VISITOR|STAGE_TRUSTED_VISITOR|<%/);
    }
    expect(service.contexts).toHaveLength(2); expect(service.provider.viewResults).toHaveLength(2);
    for (const visible of [...service.contexts.map(context => context.view), ...service.provider.viewResults]) {
      expect(JSON.stringify(visible)).not.toMatch(/STAGE_NEW_VISITOR|STAGE_FAMILIAR_VISITOR|STAGE_TRUSTED_VISITOR|OWNER_COMMON_PROFILE|<%/);
    }
    expect(ownerView(project(service.store.get(service.id), 'author')).persona).toBe(input.body);
    expect(service.store.get(service.id).roles.find(role => role.id === 'owner')!.persona).toBe(input.body);
    for (const disabled of [true, false]) {
      const modules = clone(service.store.get(service.id).card.modules);
      modules[0].enabled = !disabled;
      if (!disabled) modules[0].condition = { path: 'world.location', equals: 'A different room' };
      updateRuntimeConfiguration(service.store, service.id, { expectedRevision: service.store.get(service.id).revision,
        reason: disabled ? 'Disable the profile module.' : 'Gate the profile outside this scene.', cardModules: modules });
      expect((await service.engine.preview(service.id, { target: 'role', roleId: 'owner' })).modules).toEqual([]);
      await service.turn();
      expect(service.store.get(service.id).turns.at(-1)?.status).toBe('completed');
      expect(prompt(roleCalls(service.provider, 'owner').at(-1)!)).not.toMatch(/OWNER_COMMON_PROFILE|STAGE_NEW_VISITOR|STAGE_FAMILIAR_VISITOR|STAGE_TRUSTED_VISITOR|<%/);
      expect(ownerView(project(service.store.get(service.id), 'owner')).persona).toBe('');
    }
  });

  it('never uses a private stage binding to seed public recursive keyword activation', async () => {
    const input = documents();
    input.card.modules.push({ id: 'recursive-receiver', title: 'Recursive receiver', category: 'supplement', content: 'PUBLIC_RECURSIVE_RECEIVER_BODY', enabled: true,
      targets: ['role'], phase: 'decide', priority: 1, activation: { keys: ['PRIVATE_SEED_TOKEN'] }, lifetime: { recursive: true } });
    const service = await fixture(input);
    const owner = await service.engine.preview(service.id, { target: 'role', roleId: 'owner' });
    expect(owner.valid).toBe(true); expect(owner.modules.map(module => module.ref.moduleId)).toEqual(['owner-profile']);
    await service.turn();
    for (const call of service.provider.calls) expect(prompt(call)).not.toContain('PUBLIC_RECURSIVE_RECEIVER_BODY');
    expect(service.store.get(service.id).turns.at(-1)?.status).toBe('completed');
  });

  it('keeps a removed linked template out of owner tools and views', async () => {
    const input = documents(), service = await fixture(input, true);
    updateRuntimeConfiguration(service.store, service.id, { expectedRevision: service.store.get(service.id).revision,
      reason: 'Remove the source profile from prompt delivery.', cardModules: [], cardWorldbook: null });
    expect(ownerView(project(service.store.get(service.id), 'owner')).persona).toBe('');
    await service.turn();
    expect(service.store.get(service.id).turns.at(-1)?.status).toBe('completed');
    for (const visible of [...service.contexts.map(context => context.view), ...service.provider.viewResults]) {
      expect(JSON.stringify(visible)).not.toMatch(/STAGE_NEW_VISITOR|STAGE_FAMILIAR_VISITOR|STAGE_TRUSTED_VISITOR|OWNER_COMMON_PROFILE|<%/);
    }
    expect(prompt(roleCalls(service.provider, 'owner')[0])).not.toContain(input.body);
    expect(ownerView(project(service.store.get(service.id), 'author')).persona).toBe(input.body);
  });
});
