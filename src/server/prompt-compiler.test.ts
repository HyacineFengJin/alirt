import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CharacterCard, Preset, PromptModule } from '../shared/types';
import cardJson from '../../content/cards/harbor.json';
import presetJson from '../../content/presets/basic.json';
import { compilePromptPlan, promptLayout, promptPlanTrace, publicPromptView, runtimeFingerprint, systemModules } from './prompt-compiler';
import { clone, project, SessionStore } from './store';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rp-prompt-compiler-test-')); roots.push(root);
  const store = new SessionStore(root), created = store.create(cardJson as CharacterCard, presetJson as Preset);
  return store.get(created.id);
}
const module = (id: string, extra: Partial<PromptModule> = {}): PromptModule => ({
  id, title: id, category: 'supplement', content: `SOURCE_BODY_${id}`, enabled: true,
  targets: ['prose'], phase: 'compose', priority: 10, ...extra,
});

describe('prompt plan compilation', () => {
  it('scopes equal card/preset IDs and preserves source order for equal placement ranks', async () => {
    const session = await fixture();
    const before = clone(session);
    const plan = compilePromptPlan(session, 'prose', 'compose', { snapshot: publicPromptView(session), text: '',
      cardModules: [module('z'), module('same'), module('a')], presetModules: [module('same'), module('b')] });
    expect(plan.valid).toBe(true);
    expect(plan.modules.map(item => item.ref.key)).toEqual(['card:z', 'card:same', 'card:a', 'preset:same', 'preset:b']);
    expect(plan.modules.filter(item => item.ref.moduleId === 'same').map(item => [item.ref.source, item.ref.documentId])).toEqual([
      ['card', session.card.id], ['preset', session.preset.id],
    ]);
    expect(session).toEqual(before);
  });

  it('uses priority to choose exclusive winners and slot/order to place admitted text', async () => {
    const session = await fixture();
    const plan = compilePromptPlan(session, 'prose', 'compose', { snapshot: publicPromptView(session), text: '', presetModules: [], cardModules: [
      module('winner', { priority: 1, exclusiveGroup: 'voice', inject: { slot: 'after-context', order: 80 } }),
      module('loser', { priority: 2, exclusiveGroup: 'voice', inject: { slot: 'system', order: -100 } }),
      module('head', { priority: 100, inject: { slot: 'system', order: 999 } }),
      module('after-first', { priority: 900, inject: { slot: 'after-context', order: 5 } }),
      module('before', { inject: { slot: 'before-context', order: 9 } }),
      module('action', { inject: { slot: 'before-action', order: -99 } }),
    ] });
    expect(plan.modules.map(item => item.ref.moduleId)).toEqual(['head', 'before', 'after-first', 'winner', 'action']);
    expect(systemModules(plan)).toBe('SOURCE_BODY_head');
    expect(promptLayout(plan)).toEqual({ beforeContext: ['SOURCE_BODY_before'], afterContext: ['SOURCE_BODY_after-first', 'SOURCE_BODY_winner'], beforeAction: ['SOURCE_BODY_action'] });
  });

  it('fails closed for hidden values, including negation, and separates disclosure from conditions', async () => {
    const session = await fixture();
    const hidden = { path: 'world.variables.eastPier', equals: 'closed' } as const;
    const plan = compilePromptPlan(session, 'prose', 'compose', { snapshot: publicPromptView(session), text: '', presetModules: [], cardModules: [
      module('hidden-equal', { condition: hidden }),
      module('hidden-not', { condition: { not: hidden } }),
      module('private-module', { audience: [session.playerRoleId] }),
      module('author-module', { audience: 'author' }),
    ] });
    expect(plan.valid).toBe(true); expect(plan.modules).toEqual([]);
    expect(plan.decisions.map(item => item.reasons[0].code)).toEqual(['condition-unknown', 'condition-unknown', 'audience', 'audience']);
    expect(plan.diagnostics.map(item => item.severity)).toEqual(['warning', 'warning']);
  });

  it('treats required unknown conditions as errors but explicit false and disabled modules as intentional exclusions', async () => {
    const session = await fixture();
    const intentional = compilePromptPlan(session, 'prose', 'compose', { snapshot: publicPromptView(session), text: '', presetModules: [], cardModules: [
      module('false', { required: true, condition: { path: 'world.variables.fog', equals: false } }),
      module('disabled', { required: true, enabled: false }),
    ] });
    expect(intentional.valid).toBe(true); expect(intentional.modules).toEqual([]); expect(intentional.diagnostics).toEqual([]);
    const unknown = compilePromptPlan(session, 'prose', 'compose', { snapshot: publicPromptView(session), text: '', presetModules: [], cardModules: [
      module('required-hidden', { required: true, condition: { not: { path: 'world.variables.eastPier', equals: 'open' } } }),
    ] });
    expect(unknown.valid).toBe(false);
    expect(unknown.decisions[0]).toMatchObject({ status: 'error', reasons: [{ code: 'condition-unknown', severity: 'error' }] });
  });

  it('admits qualified cross-scope dependencies and resolves unqualified IDs within their own source', async () => {
    const session = await fixture();
    const plan = compilePromptPlan(session, 'prose', 'compose', { snapshot: publicPromptView(session), text: '',
      cardModules: [module('root'), module('dependent', { dependsOn: ['root', 'preset:shared'] })],
      presetModules: [module('shared'), module('dependent', { dependsOn: ['shared'] })],
    });
    expect(plan.valid).toBe(true);
    expect(plan.modules.map(item => item.ref.key)).toEqual(['card:root', 'card:dependent', 'preset:shared', 'preset:dependent']);
    expect(plan.diagnostics).toEqual([]);
  });

  it('propagates unavailable dependencies and makes a required unavailable dependency fatal', async () => {
    const session = await fixture();
    const plan = compilePromptPlan(session, 'prose', 'compose', { snapshot: publicPromptView(session), text: '', presetModules: [], cardModules: [
      module('off', { enabled: false }), module('middle', { dependsOn: ['off'] }),
      module('required', { dependsOn: ['middle'], required: true }), module('missing', { dependsOn: ['preset:absent'] }),
    ] });
    expect(plan.valid).toBe(false); expect(plan.modules).toEqual([]);
    expect(plan.decisions.find(item => item.ref.moduleId === 'middle')?.status).toBe('excluded');
    expect(plan.decisions.find(item => item.ref.moduleId === 'required')).toMatchObject({ status: 'error' });
    expect(plan.diagnostics.map(item => [item.moduleKey, item.code, item.severity])).toEqual([
      ['card:middle', 'dependency-unavailable', 'warning'], ['card:required', 'dependency-unavailable', 'error'], ['card:missing', 'dependency-unavailable', 'warning'],
    ]);
  });

  it('rejects active cross-scope dependency cycles and excludes their dependents', async () => {
    const session = await fixture();
    const plan = compilePromptPlan(session, 'prose', 'compose', { snapshot: publicPromptView(session), text: '',
      cardModules: [module('a', { dependsOn: ['preset:b'] }), module('tail', { dependsOn: ['a'] })],
      presetModules: [module('b', { dependsOn: ['card:a'] })],
    });
    expect(plan.valid).toBe(false); expect(plan.modules).toEqual([]);
    expect(plan.diagnostics.filter(item => item.code === 'dependency-cycle').map(item => item.moduleKey).sort()).toEqual(['card:a', 'preset:b']);
    expect(plan.decisions.find(item => item.ref.moduleId === 'tail')?.status).toBe('excluded');
  });

  it('rejects tied exclusive winners and a required module that loses exclusivity', async () => {
    const session = await fixture();
    const options = { snapshot: publicPromptView(session), text: '', presetModules: [] };
    const tied = compilePromptPlan(session, 'prose', 'compose', { ...options, cardModules: [module('one', { exclusiveGroup: 'voice' }), module('two', { exclusiveGroup: 'voice' })] });
    expect(tied.valid).toBe(false); expect(tied.modules).toEqual([]);
    expect(tied.diagnostics.map(item => item.code)).toEqual(['exclusive-ambiguous', 'exclusive-ambiguous']);
    const requiredLoser = compilePromptPlan(session, 'prose', 'compose', { ...options, cardModules: [
      module('winner', { exclusiveGroup: 'voice', priority: 1 }), module('required-loser', { exclusiveGroup: 'voice', priority: 2, required: true }),
    ] });
    expect(requiredLoser.valid).toBe(false);
    expect(requiredLoser.decisions.find(item => item.ref.moduleId === 'required-loser')?.reasons.at(-1)).toMatchObject({ code: 'exclusive-lower-rank', severity: 'error' });
  });

  it('uses current harbor facts and emits trace hashes without module bodies', async () => {
    const session = await fixture();
    const options = { snapshot: publicPromptView(session), text: '' };
    const plan = compilePromptPlan(session, 'prose', 'compose', options);
    expect(plan.modules.some(item => item.ref.moduleId === 'harbor.fog')).toBe(true);
    const trace = promptPlanTrace(plan) as any;
    expect(trace.sources.map((item: any) => item.source)).toEqual(['card', 'preset']);
    for (const item of plan.modules) {
      expect(JSON.stringify(trace)).not.toContain(item.content);
      expect(trace.modules.find((entry: any) => entry.ref.key === item.ref.key)).toMatchObject({ contentHash: runtimeFingerprint(item.content), characters: item.content.length });
    }
    session.world.variables.fog = false;
    const clear = compilePromptPlan(session, 'prose', 'compose', { snapshot: publicPromptView(session), text: '' });
    expect(clear.modules.some(item => item.ref.moduleId === 'harbor.fog')).toBe(false);
    expect(runtimeFingerprint({ a: 1, b: ['x', 'y'] })).toBe(runtimeFingerprint({ b: ['x', 'y'], a: 1 }));
    expect(runtimeFingerprint(['x', 'y'])).not.toBe(runtimeFingerprint(['y', 'x']));
  });

  it('constructs a public view that removes player-private events, fields, state, knowledge and personas', async () => {
    const session = await fixture(), player = session.roles.find(role => role.id === session.playerRoleId)!;
    session.fields.push({ key: 'private-code', label: 'PRIVATE_FIELD_LABEL', type: 'string', audience: [player.id], editable: true });
    session.world.variables['private-code'] = 'PRIVATE_WORLD_VALUE'; player.state['private-code'] = 'PRIVATE_PLAYER_VALUE';
    session.events.push({ id: 'private', at: '', kind: 'private-note', actor: player.id, text: 'PRIVATE_PLAYER_EVENT', audience: [player.id] });
    session.events.push({ id: 'public', at: '', kind: 'scene-note', actor: player.id, text: 'PUBLIC_EVENT', audience: 'public' });
    const playerView = project(session, player.id);
    expect(JSON.stringify(playerView)).toContain('PRIVATE_PLAYER_VALUE');
    const view = publicPromptView(session), serialized = JSON.stringify(view);
    for (const secret of ['PRIVATE_FIELD_LABEL', 'PRIVATE_WORLD_VALUE', 'PRIVATE_PLAYER_VALUE', 'PRIVATE_PLAYER_EVENT', player.persona, player.knowledge[0].text]) expect(serialized).not.toContain(secret);
    expect(serialized).toContain('PUBLIC_EVENT'); expect(view.world.variables.fog).toBe(true);
    expect(view.roles.find(role => role.id === player.id)?.state.energy).toBe(68);
    expect(view.roles.every(role => role.knowledge.every(item => item.audience === 'public') && !Object.hasOwn(role, 'persona') && !Object.hasOwn(role, 'goals'))).toBe(true);
  });

  it('records resolved control identity and blocks corrupt placement instead of losing prompt text', async () => {
    const session = await fixture(), snapshot = publicPromptView(session);
    const original = compilePromptPlan(session, 'prose', 'compose', { snapshot, text: '' });
    const altered = compilePromptPlan(session, 'prose', 'compose', { snapshot, text: '', cardModules: [module('resolved', { activation: { keys: ['fog'] } })] });
    expect(altered.sources[0].fingerprint).toBe(original.sources[0].fingerprint);
    expect(altered.sources[0].effectiveModulesFingerprint).not.toBe(original.sources[0].effectiveModulesFingerprint);
    const invalid = compilePromptPlan(session, 'prose', 'compose', { snapshot, text: '', cardModules: [module('bad-placement', { inject: { slot: 'unsupported' as any } })], presetModules: [] });
    expect(invalid.valid).toBe(false); expect(invalid.modules).toEqual([]);
    expect(invalid.diagnostics[0].code).toBe('injection-invalid');
  });
});
