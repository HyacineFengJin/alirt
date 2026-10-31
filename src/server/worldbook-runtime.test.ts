import { describe, expect, it } from 'vitest';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset, PromptModule } from '../shared/types';
import { compilePromptPlan, promptPlanTrace, systemModules } from './prompt-compiler';
import { readAuthorWorldbookData } from './worldbook-runtime';
import { project, type StoredSession } from './store';

const moduleFor = (id: string, extra: Partial<PromptModule> = {}): PromptModule => ({
  id, title: id, category: 'supplement', content: `${id}_BODY`, enabled: true,
  targets: ['world'], phase: 'coordinate', priority: 0, ...extra,
});
function session(modules: PromptModule[]): StoredSession {
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.modules = modules;
  return { id: 'worldbook-test', revision: 0, title: card.title, cardId: card.id, presetId: preset.id,
    playerRoleId: card.playerRoleId, createdAt: '', updatedAt: '', world: card.world, roles: card.roles,
    fields: card.fields, panels: [], events: [], prose: [], turns: [], narration: preset.narration,
    perspective: 'author', card, preset };
}

describe('world material boundaries', () => {
  it('never uses a binding-restricted body as a public recursive seed', () => {
    for (const audience of ['author', ['player']] as const) {
      const s = session([
        moduleFor('seed', { content: 'PRIVATE_RECALL_ANCHOR' }),
        moduleFor('receiver', { activation: { keys: ['PRIVATE_RECALL_ANCHOR'] }, lifetime: { recursive: true } }),
      ]);
      s.card.worldbook = { schema: 'rp.worldbook/0.1', bindings: [{ id: 'seed-binding', moduleId: 'seed', purpose: 'reference', audience: typeof audience === 'string' ? audience : [...audience] }] };
      const plan = compilePromptPlan(s, 'world', 'coordinate', { snapshot: s, text: '' });
      expect(plan.modules.some(item => item.ref.moduleId === 'receiver')).toBe(false);
      expect(plan.modules.some(item => item.ref.moduleId === 'seed')).toBe(audience === 'author');
    }
  });

  it('allows disabled prompt content through the author data channel only, without activation or mutation', () => {
    const s = session([moduleFor('catalog', { enabled: false, content: 'CATALOG_DATA', activation: { keys: ['irrelevant'] }, lifetime: { once: true } })]);
    s.card.worldbook = { schema: 'rp.worldbook/0.1', bindings: [{ id: 'catalog-binding', moduleId: 'catalog', purpose: 'ui-data', audience: 'author' }] };
    const before = structuredClone(s);
    const read = () => readAuthorWorldbookData([{ source: 'card', id: s.card.id, modules: s.card.modules, worldbook: s.card.worldbook }], s);
    expect(read()).toMatchObject({ valid: true, items: [{ content: 'CATALOG_DATA', promptEnabled: false }] });
    expect(compilePromptPlan(s, 'world', 'coordinate', { snapshot: s, text: 'irrelevant' }).modules).toEqual([]);
    expect(s).toEqual(before);
    s.card.worldbook.bindings[0].when = { path: 'world.variables.missing', equals: true };
    expect(read().items).toEqual([]);
    delete s.card.worldbook.bindings[0].when;
    s.card.worldbook.bindings[0].contentHash = '0'.repeat(64);
    expect(read()).toMatchObject({ valid: false, items: [] });
  });

  it('prunes dependencies when a scenario gate closes before lifetime evaluation and keeps trace bodies out', () => {
    const s = session([
      moduleFor('chapter', { content: 'CHAPTER_REFERENCE_BODY', lifetime: { stickyTurns: 10 } }),
      moduleFor('dependent', { dependsOn: ['chapter'] }),
    ]);
    s.card.worldbook = { schema: 'rp.worldbook/0.1', bindings: [{ id: 'chapter-binding', moduleId: 'chapter', purpose: 'scenario-plan', when: { path: 'world.variables.chapter', equals: 'one' } }] };
    s.world.variables.chapter = 'one';
    const first = compilePromptPlan(s, 'world', 'coordinate', { snapshot: s, text: '', activation: { seed: s.id, logicalKey: 'world', turnIndex: 1, ledger: {} } });
    expect(first.modules).toHaveLength(2);
    expect(first.modules[0].content).toBe('CHAPTER_REFERENCE_BODY');
    expect(systemModules(first)).toContain('possible developments, not committed events');
    expect(JSON.stringify(promptPlanTrace(first))).not.toContain('CHAPTER_REFERENCE_BODY');
    s.world.variables.chapter = '';
    const closed = compilePromptPlan(s, 'world', 'coordinate', { snapshot: s, text: '', activation: { seed: s.id, logicalKey: 'world', turnIndex: 2, ledger: first.activation!.updates } });
    expect(closed.modules).toEqual([]);
    expect(closed.decisions.find(item => item.ref.moduleId === 'dependent')?.reasons.some(item => item.code === 'dependency-unavailable')).toBe(true);
    expect(closed.worldbook?.bindings[0].status).toBe('excluded');
    expect(closed.activation?.updates['card:chapter']).toBeUndefined();
  });

  it('does not resolve hidden state or its negation through an author fallback for roles', () => {
    const s = session([moduleFor('private-condition', { targets: ['role'], phase: 'decide' })]);
    s.world.variables.secret = true;
    s.card.worldbook = { schema: 'rp.worldbook/0.1', bindings: [{ id: 'private-binding', moduleId: 'private-condition', purpose: 'reference', when: { not: { path: 'world.variables.secret', equals: true } } }] };
    const plan = compilePromptPlan(s, 'role', 'decide', { snapshot: project(s, 'player'), roleId: 'player', text: '' });
    expect(plan.modules).toEqual([]);
    expect(plan.decisions[0].reasons[0].code).toBe('worldbook-condition-unknown');
    expect(plan.worldbook?.bindings[0].reasons[0].code).toBe('worldbook-condition-unknown');
  });
});
