import { createHash } from 'node:crypto';
import type { AgentKind, Json, PromptInjectionSlot, PromptModule } from '../shared/types';
import type { PromptPlan, PromptModuleDecision, RuntimeDiagnostic } from '../shared/prompt-runtime';
import { evaluateNativeActivation, evaluateNativeCondition, expandNativeMacros } from '../shared/native';
import { clone, type StoredSession } from './store';
import { activationIdentity, deliveredActivationState, evaluateModuleLifetime, type LifetimeEvaluation, type PromptActivationContext, type PromptActivationPlan } from './activation-runtime';
import { projectKnowledgeEntries } from './knowledge-runtime';
import { evaluateWorldbookGate, finishWorldbookPlan, prepareWorldbook } from './worldbook-runtime';
import { materializeRoleStage } from './role-stage-runtime';
import { publicFactEvent } from './world-facts-runtime';

const slots: PromptInjectionSlot[] = ['system', 'before-context', 'after-context', 'before-action'];
/** Stable across object insertion order; array order remains meaningful. */
export function runtimeFingerprint(value: unknown): string {
  function canonical(node: any): any {
    if (Array.isArray(node)) return node.map(canonical);
    if (node && typeof node === 'object') return Object.fromEntries(Object.keys(node).sort().map(key => [key, canonical(node[key])]));
    return node;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export interface CompilePromptOptions {
  snapshot: unknown; text: string; roleId?: string;
  cardModules?: PromptModule[]; presetModules?: PromptModule[];
  activation?: PromptActivationContext;
}

/** Compile fixed, permission-filtered inputs; this function never mutates or runs a model. */
export function compilePromptPlan(session: StoredSession, target: AgentKind, phase: PromptModule['phase'], options: CompilePromptOptions): PromptPlan {
  const plan: PromptPlan = { schema: 'rp.prompt-plan/0.1', snapshotRevision: session.revision, target, phase,
    ...(options.roleId ? { roleId: options.roleId } : {}), sources: [], modules: [], decisions: [], diagnostics: [], valid: true };
  type Entry = { module: PromptModule; content: string; decision: PromptModuleDecision; index: number; eligible: boolean; identity: string };
  const entries: Entry[] = [];
  const worldbooks = (['card', 'preset'] as const).map(source => prepareWorldbook(source, session[source].id,
    options[source === 'card' ? 'cardModules' : 'presetModules'] ?? session[source].modules, session[source].worldbook));
  const activation = options.activation ?? { turnIndex: 0, logicalKey: `${target}:${options.roleId ?? ''}:${phase}`, seed: session.id, ledger: {} };
  const addReason = (decision: PromptModuleDecision, code: string, message: string, severity: RuntimeDiagnostic['severity'] = 'info') => {
    const diagnostic: RuntimeDiagnostic = { code, severity, message, moduleKey: decision.ref.key };
    decision.reasons.push(diagnostic);
    if (severity === 'error') decision.status = 'error';
  };
  for (const source of ['card', 'preset'] as const) {
    const worldbook = worldbooks[source === 'card' ? 0 : 1];
    const document = session[source];
    const resolvedModules = options[source === 'card' ? 'cardModules' : 'presetModules'] ?? document.modules;
    plan.sources.push({ source, documentId: document.id, schema: document.schema, fingerprint: runtimeFingerprint(document), effectiveModulesFingerprint: runtimeFingerprint(resolvedModules) });
    for (const module of resolvedModules) {
      const ref = { source, documentId: document.id, moduleId: module.id, key: `${source}:${module.id}`,
        ...(module.sourcePointer ? { sourcePointer: module.sourcePointer } : {}) };
      const decision: PromptModuleDecision = { ref, status: 'excluded', reasons: [], slot: module.inject?.slot ?? 'system', order: module.inject?.order ?? module.priority, priority: module.priority };
      const entry = { module, content: module.content, decision, index: entries.length, eligible: false, identity: activationIdentity(document.id, module, runtimeFingerprint) };
      entries.push(entry);
      if (!module.enabled) { addReason(decision, 'disabled', 'Explicitly disabled by the document.'); continue; }
      if (!module.targets.includes(target)) { addReason(decision, 'target', 'Not assigned to this agent kind.'); continue; }
      if (module.phase !== phase) { addReason(decision, 'phase', 'Not assigned to this execution phase.'); continue; }
      const audience = module.audience ?? 'public';
      const allowed = audience === 'public' || target === 'world' && audience === 'author'
        || target === 'role' && Array.isArray(audience) && !!options.roleId && audience.includes(options.roleId);
      if (!allowed) { addReason(decision, 'audience', 'This module is outside the agent disclosure scope.'); continue; }
      const gate = worldbook.gates.get(module.id);
      if (gate) {
        const format = document.proseFormat;
        const proseFormatModuleId = target === 'prose' && phase === 'compose' && format?.schema === 'rp.prose-format/0.1'
          && format.dialogue?.renderer === 'character-dialogue' && format.dialogue.module === module.id ? module.id : undefined;
        const blocked = evaluateWorldbookGate(gate, module, { snapshot: options.snapshot, target, roleId: options.roleId, proseFormatModuleId });
        if (blocked) { addReason(decision, blocked.code, blocked.message, blocked.severity); continue; }
        const stage = gate.binding.roleStage;
        if (stage) {
          const owner = session.roles.find(role => role.id === stage.roleId);
          const field = session.fields.find(field => field.key === stage.field);
          if (target !== 'role' || options.roleId !== stage.roleId || gate.binding.purpose !== 'entity-profile'
            || !gate.binding.contentHash || !Array.isArray(gate.binding.audience) || gate.binding.audience.length !== 1 || gate.binding.audience[0] !== stage.roleId
            || !owner || field?.type !== 'number' || !Object.hasOwn(owner.state, stage.field)) {
            addReason(decision, 'role-stage-scope', 'Role stage selection requires an explicit owning-role numeric field and private binding.', 'error'); continue;
          }
          // This declared selector reads only that role's own value. It does not
          // expand the role snapshot or hand the private number to the model.
          const selected = materializeRoleStage(module.content, stage, owner.state[stage.field]);
          for (const diagnostic of selected.diagnostics) addReason(decision, diagnostic.code, diagnostic.message, diagnostic.severity);
          if (selected.diagnostics.some(diagnostic => diagnostic.severity === 'error')) continue;
          entry.content = selected.content;
        }
      }
      if (!slots.includes(decision.slot) || !Number.isFinite(decision.order) || !Number.isFinite(decision.priority)) {
        addReason(decision, 'injection-invalid', 'Invalid injection slot, order or priority; no prompt text was silently discarded.', 'error'); continue;
      }
      const lifetime = module.lifetime;
      if (lifetime && (['stickyTurns', 'cooldownTurns', 'delayTurns'].some(key => {
        const value = lifetime[key as 'stickyTurns']; return value !== undefined && (!Number.isSafeInteger(value) || value < (key === 'stickyTurns' ? 1 : 0));
      }) || ['once', 'recursive'].some(key => {
        const value = lifetime[key as 'once']; return value !== undefined && typeof value !== 'boolean';
      }) || lifetime.probability !== undefined && (!Number.isFinite(lifetime.probability) || lifetime.probability < 0 || lifetime.probability > 1))) {
        addReason(decision, 'lifetime-invalid', 'Sticky turns must be positive safe integers; cooldown/delay turns must be nonnegative safe integers, once/recursive must be booleans, and probability must lie in [0, 1].', 'error'); continue;
      }
      const condition = module.condition ? evaluateNativeCondition(module.condition, options) : { status: 'true', reasons: ['No condition.'] };
      if (condition.status !== 'true') {
        addReason(decision, condition.status === 'unknown' ? 'condition-unknown' : 'condition-false', condition.reasons.join('; '), condition.status === 'unknown' ? module.required ? 'error' : 'warning' : 'info');
        continue;
      }
      entry.eligible = true;
    }
  }
  const byKey = new Map<string, Entry>();
  for (const entry of entries) {
    const previous = byKey.get(entry.decision.ref.key);
    if (previous) {
      for (const duplicate of [previous, entry]) {
        duplicate.eligible = false;
        addReason(duplicate.decision, 'duplicate-id', 'Duplicate module identity within one document.', 'error');
      }
    } else byKey.set(entry.decision.ref.key, entry);
  }
  const macros = { user: session.roles.find(role => role.id === session.playerRoleId)?.name,
    char: target === 'role' ? session.roles.find(role => role.id === options.roleId)?.name : session.title };
  const baseDecisions = entries.map(entry => structuredClone(entry.decision));
  const dependencyKey = (entry: Entry, id: string) => /^(card|preset):/.test(id) ? id : `${entry.decision.ref.source}:${id}`;
  let evaluations = new Map<string, LifetimeEvaluation>();
  function resolve(seedKeys: Set<string>) {
    evaluations = new Map();
    for (const entry of entries) entry.decision = structuredClone(baseDecisions[entry.index]);
    // Only text admitted in the preceding wave can recall another module. Each
    // receiver must explicitly opt in; hidden/ineligible text never enters seeds.
    const seedText = entries.filter(entry => {
      const binding = worldbooks[entry.decision.ref.source === 'card' ? 0 : 1].gates.get(entry.module.id)?.binding;
      return seedKeys.has(entry.decision.ref.key) && (entry.module.audience ?? 'public') === 'public' && (binding?.audience ?? 'public') === 'public';
    }).map(entry => expandNativeMacros(entry.content, macros)).join('\n\n');
    for (const entry of entries) {
      if (!entry.eligible) continue;
      const text = entry.module.lifetime?.recursive ? `${options.text}\n\n${seedText}` : options.text;
      const matched = evaluateNativeActivation(entry.module.activation, text);
      const evaluation = evaluateModuleLifetime(entry.module, entry.identity, entry.decision.ref.key, matched.status === 'true', activation);
      evaluations.set(entry.decision.ref.key, evaluation);
      if (!evaluation.active) {
        addReason(entry.decision, evaluation.code, evaluation.code === 'keywords' ? matched.reasons.join('; ') : evaluation.message); continue;
      }
      entry.decision.status = 'included'; addReason(entry.decision, evaluation.code, evaluation.message);
    }
    const visiting = new Set<string>(), visited = new Set<string>(), stack: string[] = [];
    function visit(entry: Entry) {
      const key = entry.decision.ref.key;
      if (entry.decision.status !== 'included' || visited.has(key)) return;
      if (visiting.has(key)) {
        for (const cyclic of stack.slice(stack.indexOf(key))) addReason(byKey.get(cyclic)!.decision, 'dependency-cycle', 'Active module dependencies contain a cycle.', 'error');
        return;
      }
      visiting.add(key); stack.push(key);
      for (const id of entry.module.dependsOn ?? []) { const peer = byKey.get(dependencyKey(entry, id)); if (peer) visit(peer); }
      stack.pop(); visiting.delete(key); visited.add(key);
    }
    entries.forEach(visit);
    function pruneDependencies() {
      let changed = true;
      while (changed) {
        changed = false;
        for (const entry of entries) {
          if (entry.decision.status !== 'included') continue;
          const unavailable = (entry.module.dependsOn ?? []).map(id => dependencyKey(entry, id)).filter(key => byKey.get(key)?.decision.status !== 'included');
          if (!unavailable.length) continue;
          entry.decision.status = 'excluded';
          addReason(entry.decision, 'dependency-unavailable', `Required modules were not admitted: ${unavailable.join(', ')}`, entry.module.required ? 'error' : 'warning');
          changed = true;
        }
      }
    }
    pruneDependencies();
    const groups = new Map<string, Entry[]>();
    for (const entry of entries) if (entry.decision.status === 'included' && entry.module.exclusiveGroup) {
      const group = groups.get(entry.module.exclusiveGroup) ?? []; group.push(entry); groups.set(entry.module.exclusiveGroup, group);
    }
    for (const [name, group] of groups) {
      if (group.length < 2) continue;
      group.sort((a, b) => a.module.priority - b.module.priority);
      const tied = group.filter(entry => entry.module.priority === group[0].module.priority);
      if (tied.length > 1) {
        for (const entry of group) addReason(entry.decision, 'exclusive-ambiguous', `Exclusive group ${name} has equal winning priorities; choose an explicit winner.`, 'error');
      } else {
        const losers = new Set(group.slice(1).map(entry => entry.decision.ref.key));
        const traversed = new Set<string>();
        const requiresLoser = (entry: Entry): boolean => (entry.module.dependsOn ?? []).some(id => {
          const key = dependencyKey(entry, id);
          if (losers.has(key)) return true;
          if (traversed.has(key)) return false;
          traversed.add(key); const peer = byKey.get(key); return !!peer && requiresLoser(peer);
        });
        if (requiresLoser(group[0])) addReason(group[0].decision, 'dependency-exclusive-conflict', `Exclusive group ${name} selected a winner that requires a losing member.`, 'error');
        for (const entry of group.slice(1)) {
          entry.decision.status = 'excluded';
          addReason(entry.decision, 'exclusive-lower-rank', `Exclusive group ${name} selected ${group[0].decision.ref.key}.`, entry.module.required ? 'error' : 'info');
        }
      }
    }
    pruneDependencies();
    return new Set(entries.filter(entry => entry.decision.status === 'included').map(entry => entry.decision.ref.key));
  }
  // Repeated exact sets prove oscillation. A graph-derived polynomial wave
  // budget also bounds host work when the finite state space is exponential.
  // Exhaustion rejects the whole candidate set; it never truncates prompt text.
  const candidates = entries.filter(entry => entry.eligible);
  const maximumWaves = Math.max(16, (candidates.length + 1) ** 2);
  let waves = 0;
  let seeds = new Set<string>();
  const seen = new Set<string>();
  while (true) {
    if (waves++ >= maximumWaves) {
      for (const entry of candidates) addReason(entry.decision, 'recursion-work-budget', `Recursive admission did not stabilize within the graph-derived limit of ${maximumWaves} waves.`, 'error');
      break;
    }
    const signature = JSON.stringify([...seeds].sort()); seen.add(signature);
    const next = resolve(seeds), nextSignature = JSON.stringify([...next].sort());
    if (signature === nextSignature || !entries.some(entry => entry.eligible && entry.module.lifetime?.recursive)) break;
    if (seen.has(nextSignature)) {
      for (const entry of entries.filter(entry => entry.eligible)) {
        addReason(entry.decision, 'recursion-nonconvergent', 'Recursive recall, dependencies and exclusive groups do not converge to a stable admitted set.', 'error');
      }
      break;
    }
    seeds = next;
  }
  plan.decisions = entries.map(entry => entry.decision);
  plan.diagnostics = plan.decisions.flatMap(decision => decision.reasons.filter(reason => reason.severity !== 'info'));
  if (session.card.worldbook || session.preset.worldbook) {
    plan.worldbook = finishWorldbookPlan(worldbooks, plan.decisions);
    plan.diagnostics.push(...worldbooks.flatMap(item => item.global));
  }
  plan.valid = !plan.diagnostics.some(diagnostic => diagnostic.severity === 'error');
  if (options.activation) {
    const proposed: PromptActivationPlan = { turnIndex: activation.turnIndex, logicalKey: activation.logicalKey, updates: {}, activated: [] };
    for (const entry of entries) {
      const evaluation = evaluations.get(entry.decision.ref.key);
      if (!evaluation) continue;
      const included = entry.decision.status === 'included';
      proposed.updates[entry.decision.ref.key] = included ? deliveredActivationState(entry.module, evaluation, activation.turnIndex) : evaluation.state;
      if (included) proposed.activated.push(entry.decision.ref.key);
    }
    plan.activation = proposed;
  }
  const admitted = entries.filter(entry => entry.decision.status === 'included').sort((a, b) =>
    slots.indexOf(a.decision.slot) - slots.indexOf(b.decision.slot) || a.decision.order - b.decision.order || a.index - b.index);
  plan.modules = admitted.map(({ module, content, decision }) => {
    const binding = worldbooks[decision.ref.source === 'card' ? 0 : 1].gates.get(module.id)?.binding;
    return { ref: decision.ref, content: expandNativeMacros(content, macros), slot: decision.slot, order: decision.order, priority: module.priority,
      ...(binding ? { material: { purpose: binding.purpose } } : {}) };
  });
  return plan;
}

/** Public prose gets exactly this public world/role view, never the player's private projection. */
export function publicPromptView(session: StoredSession) {
  const keys = new Set(session.fields.filter(field => field.audience === 'public').map(field => field.key));
  return { id: session.id, revision: session.revision, playerRoleId: session.playerRoleId, narration: clone(session.narration),
    world: { ...clone(session.world), variables: Object.fromEntries(Object.entries(session.world.variables).filter(([key]) => keys.has(key))) },
    roles: session.roles.map(role => ({ id: role.id, name: role.name, phase: role.phase, presence: role.presence,
      ...(role.interaction ? { interaction: clone(role.interaction) } : {}),
      state: Object.fromEntries(Object.entries(role.state).filter(([key]) => keys.has(key))),
      knowledge: projectKnowledgeEntries(role.knowledge.filter(item => item.audience === 'public'), 'public') })),
    fields: session.fields.filter(field => field.audience === 'public'), events: session.events.filter(event => event.audience === 'public' && !['world-adjudication', 'host-output'].includes(event.kind)).map(publicFactEvent) };
}

export interface PromptLayout { beforeContext: string[]; afterContext: string[]; beforeAction: string[]; }
function deliveredModule(module: PromptPlan['modules'][number]): string {
  return module.material?.purpose === 'scenario-plan'
    ? `[Active scenario reference: possible developments, not committed events. Preserve the actual branch and player agency.]\n${module.content}\n[End scenario reference.]`
    : module.content;
}
export function promptLayout(plan: PromptPlan): PromptLayout {
  const content = (slot: PromptInjectionSlot) => plan.modules.filter(module => module.slot === slot).map(deliveredModule);
  return { beforeContext: content('before-context'), afterContext: content('after-context'), beforeAction: content('before-action') };
}
export function systemModules(plan: PromptPlan): string { return plan.modules.filter(module => module.slot === 'system').map(deliveredModule).join('\n\n'); }
/** Traces retain every decision, but not duplicate source documents or prompt bodies. */
export function promptPlanTrace(plan: PromptPlan): Json {
  return JSON.parse(JSON.stringify({ ...plan, modules: plan.modules.map(({ content, ...module }) => ({ ...module, contentHash: runtimeFingerprint(content), characters: content.length })) }));
}
