import { afterEach, describe, expect, it, vi } from 'vitest';
import * as native from '../shared/native';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CharacterCard, Preset, PromptModule } from '../shared/types';
import cardJson from '../../content/cards/harbor.json';
import presetJson from '../../content/presets/basic.json';
import { compilePromptPlan, publicPromptView, runtimeFingerprint } from './prompt-compiler';
import { activationProbabilityDraw, activationIdentity, type PromptActivationLedger } from './activation-runtime';
import { SessionStore } from './store';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const module = (id: string, extra: Partial<PromptModule> = {}): PromptModule => ({
  id, title: id, category: 'supplement', content: `${id} text`, enabled: true,
  targets: ['prose'], phase: 'compose', priority: 10, ...extra,
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rp-activation-test-')); roots.push(root);
  const store = new SessionStore(root), created = store.create(cardJson as CharacterCard, presetJson as Preset);
  const session = store.get(created.id);
  const ledger: PromptActivationLedger = {};
  const compile = (turnIndex: number, modules: PromptModule[], text = '', options: { roleId?: string; target?: 'role' | 'prose'; seed?: string; logicalKey?: string } = {}) =>
    compilePromptPlan(session, options.target ?? 'prose', options.target === 'role' ? 'decide' : 'compose', {
      snapshot: publicPromptView(session), text, cardModules: modules, presetModules: [], roleId: options.roleId,
      activation: { turnIndex, logicalKey: options.logicalKey ?? 'prose', seed: options.seed ?? 'story', ledger },
    });
  const deliver = (plan: ReturnType<typeof compile>) => { expect(plan.valid).toBe(true); Object.assign(ledger, plan.activation!.updates); };
  return { session, ledger, compile, deliver };
}

describe('accepted-turn module lifetime', () => {
  it('proposes delay state without mutating preview inputs and consumes once only on delivery', async () => {
    const { ledger, compile, deliver } = await fixture();
    const entry = module('delayed', { required: true, activation: { keys: ['bell'] }, lifetime: { delayTurns: 2, once: true } });
    const preview = compile(5, [entry], 'bell');
    expect(preview.modules).toEqual([]); expect(ledger).toEqual({}); expect(preview.activation!.updates['card:delayed'].firstMatchedTurn).toBe(5);
    // Another preview has no remembered match until an accepted delivery commits it.
    expect(compile(6, [entry], 'bell').activation!.updates['card:delayed'].firstMatchedTurn).toBe(6);
    deliver(preview);
    expect(compile(6, [entry], 'bell').modules).toEqual([]);
    const active = compile(7, [entry], 'bell'); expect(active.modules).toHaveLength(1);
    expect(ledger['card:delayed'].consumed).toBeUndefined(); deliver(active);
    expect(compile(7, [entry], 'bell').modules).toEqual([]);
    expect(compile(8, [entry], 'bell')).toMatchObject({ valid: true, modules: [] });
    expect(compile(8, [entry], 'bell').decisions[0].reasons[0].code).toBe('lifetime-once');
  });

  it('counts sticky activation turn once, then skips exactly N cooldown turns', async () => {
    const { compile, deliver } = await fixture();
    const entry = module('sticky', { activation: { keys: ['bell'] }, lifetime: { stickyTurns: 3, cooldownTurns: 2 } });
    deliver(compile(1, [entry], 'bell'));
    for (const turn of [2, 3]) { const plan = compile(turn, [entry]); expect(plan.modules).toHaveLength(1); deliver(plan); }
    for (const turn of [4, 5]) { const plan = compile(turn, [entry], 'bell'); expect(plan.modules).toEqual([]); expect(plan.decisions[0].reasons[0].code).toBe('lifetime-cooldown'); deliver(plan); }
    expect(compile(6, [entry], 'bell').modules).toHaveLength(1);
    const immediate = module('immediate', { lifetime: { stickyTurns: 1, cooldownTurns: 0 } });
    deliver(compile(1, [immediate])); expect(compile(2, [immediate]).modules).toHaveLength(1);
  });

  it('rejects zero sticky turns and malformed lifetime booleans at the compiler boundary', async () => {
    const { compile } = await fixture();
    for (const lifetime of [{ stickyTurns: 0 }, { once: 'yes' }, { recursive: 1 }]) {
      const plan = compile(1, [module('invalid', { lifetime: lifetime as PromptModule['lifetime'] })]);
      expect(plan.valid).toBe(false); expect(plan.modules).toEqual([]);
      expect(plan.decisions[0].reasons[0].code).toBe('lifetime-invalid');
    }
  });

  it('keeps once consumed across off/on, admits a new definition, and retains its original sticky window', async () => {
    const { compile, deliver } = await fixture();
    const entry = module('once', { activation: { keys: ['bell'] }, lifetime: { once: true, stickyTurns: 2 } });
    deliver(compile(1, [entry], 'bell'));
    expect(compile(2, [entry]).modules).toHaveLength(1);
    deliver(compile(2, [{ ...entry, enabled: false }], 'bell'));
    expect(compile(3, [entry], 'bell').modules).toEqual([]);
    expect(compile(3, [{ ...entry, content: 'new definition' }], 'bell').modules).toHaveLength(1);
  });

  it('never lets sticky recall override disabled, audience, conditions, dependencies or groups', async () => {
    const { session, compile, deliver } = await fixture();
    const entry = module('sticky', { activation: { keys: ['bell'] }, lifetime: { stickyTurns: 8 } });
    deliver(compile(1, [entry], 'bell'));
    const hidden = compile(2, [{ ...entry, audience: 'author' }]); expect(hidden.modules).toEqual([]);
    expect(compile(2, [{ ...entry, enabled: false }]).modules).toEqual([]);
    // Establish sticky state for a condition/dependency-bearing definition first.
    const conditional = { ...entry, condition: { path: 'world.variables.fog', equals: true } } as PromptModule;
    deliver(compile(1, [conditional], 'bell')); session.world.variables.fog = false;
    expect(compile(2, [conditional]).modules).toEqual([]);
    const dependent = { ...entry, dependsOn: ['root'] };
    deliver(compile(1, [module('root'), dependent], 'bell'));
    expect(compile(2, [module('root', { enabled: false }), dependent]).modules).toEqual([]);
    const grouped = { ...entry, exclusiveGroup: 'one' };
    deliver(compile(1, [grouped], 'bell'));
    expect(compile(2, [grouped, module('winner', { exclusiveGroup: 'one', priority: 0 })]).modules.map(m => m.ref.moduleId)).toEqual(['winner']);
  });

  it('uses exact probability endpoints and stable per-story/agent/turn/identity draws', async () => {
    const { compile, deliver } = await fixture();
    const never = module('never', { required: true, lifetime: { probability: 0 } });
    const always = module('always', { lifetime: { probability: 1 } });
    expect(compile(1, [never, always]).modules.map(m => m.ref.moduleId)).toEqual(['always']);
    const draw = activationProbabilityDraw('story', 'role:a', 4, 'definition');
    expect(draw).toBeGreaterThanOrEqual(0); expect(draw).toBeLessThan(1);
    expect(activationProbabilityDraw('story', 'role:a', 4, 'definition')).toBe(draw);
    expect(activationProbabilityDraw('story', 'role:b', 4, 'definition')).not.toBe(draw);
    expect(activationProbabilityDraw('story', 'role:a', 5, 'definition')).not.toBe(draw);
    const random = module('random', { lifetime: { probability: 0.5 } });
    const first = compile(3, [random]); expect(compile(3, [random])).toEqual(first); deliver(first);
    expect(compile(3, [random]).modules).toEqual(first.modules);
  });

  it('lets sticky recall bypass a later failed probability draw while retaining condition safety', async () => {
    const { session, compile, deliver } = await fixture();
    const entry = module('probabilistic', { activation: { keys: ['bell'] }, condition: { path: 'world.variables.fog', equals: true }, lifetime: { probability: 0.5, stickyTurns: 3 } });
    const identity = activationIdentity(session.card.id, entry, runtimeFingerprint);
    const seed = Array.from({ length: 100 }, (_, i) => `seed-${i}`).find(value =>
      activationProbabilityDraw(value, 'prose', 1, identity) < 0.5 && activationProbabilityDraw(value, 'prose', 2, identity) >= 0.5)!;
    expect(seed).toBeDefined();
    deliver(compile(1, [entry], 'bell', { seed }));
    expect(compile(2, [entry], '', { seed }).modules).toHaveLength(1);
    delete session.world.variables.fog;
    const hidden = compile(2, [entry], '', { seed });
    expect(hidden.modules).toEqual([]); expect(hidden.decisions[0].reasons[0].code).toBe('condition-unknown');
  });

  it('does not renew sticky recall on each delivery or override once after expiry', async () => {
    const { compile, deliver } = await fixture();
    const entry = module('short', { activation: { keys: ['bell'] }, lifetime: { stickyTurns: 2, once: true } });
    deliver(compile(1, [entry], 'bell')); deliver(compile(2, [entry]));
    expect(compile(3, [entry], 'bell').modules).toEqual([]);
  });
});

describe('recursive recall resolution', () => {
  it('recalls a multiwave same-agent chain only for explicitly opted-in receivers', async () => {
    const { compile } = await fixture();
    const entries = [module('root', { content: 'second' }), module('second', { content: 'third', activation: { keys: ['second'] }, lifetime: { recursive: true } }),
      module('third', { activation: { keys: ['third'] }, lifetime: { recursive: true }, dependsOn: ['second'] }), module('manual', { activation: { keys: ['third'] } })];
    const plan = compile(1, entries);
    expect(plan.valid).toBe(true); expect(plan.modules.map(m => m.ref.moduleId)).toEqual(['root', 'second', 'third']);
    expect(plan.decisions).toHaveLength(4);
  });

  it('does not seed from disabled, false-condition, private, or dependency-pruned text', async () => {
    const { session, compile } = await fixture();
    const roleId = session.playerRoleId;
    const entries = [module('off', { enabled: false, content: 'SECRET' }), module('false', { content: 'SECRET', condition: { path: 'world.variables.fog', equals: false } }),
      module('private', { content: 'SECRET', audience: [roleId] }), module('pruned', { content: 'SECRET', dependsOn: ['missing'] }),
      module('receiver', { activation: { keys: ['SECRET'] }, lifetime: { recursive: true } })].map(m => ({ ...m, targets: ['role'] as PromptModule['targets'], phase: 'decide' as const }));
    const plan = compile(1, entries, '', { target: 'role', roleId });
    expect(plan.modules.map(m => m.ref.moduleId)).toEqual(['private']);
    expect(plan.decisions.find(d => d.ref.moduleId === 'receiver')?.status).toBe('excluded');
  });

  it('rejects an exclusive winner requiring its losing member instead of silently emitting an empty plan', async () => {
    const { compile } = await fixture();
    const plan = compile(1, [module('winner', { priority: 1, exclusiveGroup: 'voice', dependsOn: ['loser'] }),
      module('loser', { priority: 2, exclusiveGroup: 'voice' })]);
    expect(plan.valid).toBe(false); expect(plan.modules).toEqual([]);
    expect(plan.diagnostics.some(d => d.code === 'dependency-exclusive-conflict')).toBe(true);
  });

  it('rejects excessive finite-state recursive work without retaining any admitted text', async () => {
    const { compile } = await fixture();
    // Exercise the host-work boundary with a deterministic six-bit state machine:
    // its 64 distinct states exceed the six-candidate graph's 49-wave budget.
    vi.spyOn(native, 'evaluateNativeActivation').mockImplementation((activation, text = '') => {
      const state = Array.from({ length: 6 }, (_, i) => text.includes(`bit_${i};`) ? 1 << i : 0).reduce((a, b) => a + b, 0);
      const bit = Number(activation!.keys[0]);
      return { status: ((state + 1) % 64) & (1 << bit) ? 'true' : 'false', reasons: ['Deterministic test state machine.'] };
    });
    const plan = compile(1, Array.from({ length: 6 }, (_, i) => module(`bit-${i}`, {
      content: `bit_${i};`, activation: { keys: [String(i)] }, lifetime: { recursive: true },
    })));
    expect(plan.valid).toBe(false); expect(plan.modules).toEqual([]);
    expect(plan.decisions).toHaveLength(6);
    expect(plan.diagnostics.filter(d => d.code === 'recursion-work-budget')).toHaveLength(6);
    expect(plan.activation!.activated).toEqual([]);
  });

  it('blocks oscillating recursive group winners explicitly and retains all decisions', async () => {
    const { compile } = await fixture();
    const plan = compile(1, [module('seed', { content: 'recall', exclusiveGroup: 'voice', priority: 2 }),
      module('recall', { content: '', exclusiveGroup: 'voice', priority: 1, activation: { keys: ['recall'] }, lifetime: { recursive: true } })]);
    expect(plan.valid).toBe(false); expect(plan.modules).toEqual([]); expect(plan.decisions).toHaveLength(2);
    expect(plan.diagnostics.every(d => d.code === 'recursion-nonconvergent')).toBe(true);
  });
});
