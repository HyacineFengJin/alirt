import { readCatalogReferences } from './catalog-data';
import type { AuthorCatalog } from '../shared/catalog';
import type { ScenarioDefinition } from '../shared/scenario';
import { createHash } from 'node:crypto';
import { evaluateNativeCondition, validateNativeDocument } from '../shared/native';
import type { CreativeKind, NativeDocument } from '../shared/creator';
import { WORLDBOOK_PURPOSES, type Worldbook, type WorldbookBinding, type WorldbookDecision, type WorldbookPlan } from '../shared/worldbook';
import type { AgentKind, Audience, PromptModule } from '../shared/types';
import type { PromptModuleDecision, RuntimeDiagnostic } from '../shared/prompt-runtime';

const bodyHash = (text: string) => createHash('sha256').update(text).digest('hex');
const promptPurposes = new Set(['reference', 'entity-profile', 'scenario-plan']);
export interface WorldbookContext {
  snapshot: unknown; target: AgentKind; roleId?: string;
  /** The compiler names only the local module consumed by a declared native
   * prose format. This is not general output-contract prompt admission. */
  proseFormatModuleId?: string;
}
export function worldbookAudienceAllows(audience: Audience = 'public', context: WorldbookContext): boolean {
  return audience === 'public' || context.target === 'world' && audience === 'author'
    || context.target === 'role' && Array.isArray(audience) && !!context.roleId && audience.includes(context.roleId);
}
export interface WorldbookGate {
  binding: WorldbookBinding;
  decision: WorldbookDecision;
}
const reason = (code: string, message: string, severity: RuntimeDiagnostic['severity'] = 'info'): RuntimeDiagnostic => ({ code, message, severity });

/** References stay local to a document. No import/source reference is dereferenced here. */
export function prepareWorldbook(source: 'card' | 'preset', documentId: string, modules: PromptModule[], worldbook?: Worldbook) {
  const gates = new Map<string, WorldbookGate>();
  const plan: WorldbookPlan = { schema: 'rp.worldbook-plan/0.1', bindings: [], diagnostics: [] };
  const global: RuntimeDiagnostic[] = [];
  if (worldbook === undefined) return { gates, plan, global };
  if (worldbook?.schema !== 'rp.worldbook/0.1' || !Array.isArray(worldbook.bindings)) {
    global.push(reason('worldbook-invalid', 'Invalid worldbook contract.', 'error')); return { gates, plan, global };
  }
  const ids = new Map<string, WorldbookGate>();
  for (const binding of worldbook.bindings) {
    const module = modules.find(module => module.id === binding.moduleId);
    const ref = { source, documentId, moduleId: binding.moduleId, key: `${source}:${binding.moduleId}`,
      ...(module?.sourcePointer ? { sourcePointer: module.sourcePointer } : {}) };
    const decision: WorldbookDecision = { bindingId: binding.id, ref, purpose: binding.purpose, status: 'excluded', reasons: [] };
    plan.bindings.push(decision);
    const gate: WorldbookGate = { binding, decision };
    if (!module) {
      const diagnostic = reason('worldbook-module-missing', 'A worldbook binding refers to an unavailable local module.', 'error');
      decision.status = 'error'; decision.reasons.push(diagnostic); global.push(diagnostic); continue;
    }
    for (const previous of [ids.get(binding.id), gates.get(binding.moduleId)].filter(Boolean) as WorldbookGate[]) {
      previous.decision.status = decision.status = 'error';
      const diagnostic = reason('worldbook-duplicate', 'Worldbook binding identities and module references must be unique.', 'error');
      previous.decision.reasons.push(diagnostic); decision.reasons.push(diagnostic); global.push(diagnostic);
    }
    if (!WORLDBOOK_PURPOSES.includes(binding.purpose) || binding.purpose === 'scenario-plan' && !binding.when) {
      const diagnostic = reason('worldbook-invalid', 'A scenario plan needs an explicit state condition and a supported purpose.', 'error');
      decision.status = 'error'; decision.reasons.push(diagnostic); global.push(diagnostic);
    }
    if (binding.contentHash !== undefined && binding.contentHash.toLowerCase() !== bodyHash(module.content)) {
      const diagnostic = reason('worldbook-content-changed', 'The bound body changed; review its worldbook binding before delivery.', 'error');
      decision.status = 'error'; decision.reasons.push(diagnostic); global.push(diagnostic);
    }
    ids.set(binding.id, gate); gates.set(binding.moduleId, gate);
  }
  return { gates, plan, global };
}

/** Additional eligibility only: this never replaces module permissions or consumes a lifetime. */
export function evaluateWorldbookGate(gate: WorldbookGate, module: PromptModule, context: WorldbookContext): RuntimeDiagnostic | undefined {
  if (gate.decision.status === 'error') return gate.decision.reasons.find(item => item.severity === 'error');
  const binding = gate.binding;
  if (!worldbookAudienceAllows(binding.audience, context)) return reason('worldbook-audience', 'Outside the binding disclosure scope.');
  if (binding.purpose === 'ui-data') return reason('worldbook-data-channel', 'UI data is available through the author data reader, not model prompt injection.');
  const nativeProseOutput = binding.purpose === 'output-contract' && context.target === 'prose' && context.proseFormatModuleId === module.id;
  if (!promptPurposes.has(binding.purpose) && !nativeProseOutput) return reason('worldbook-adapter-required', `The ${binding.purpose} binding needs an explicit native adapter; text preservation alone does not execute it.`, module.required ? 'error' : 'warning');
  if (binding.when) {
    const condition = evaluateNativeCondition(binding.when, { snapshot: context.snapshot, roleId: context.roleId });
    if (condition.status !== 'true') return reason(condition.status === 'unknown' ? 'worldbook-condition-unknown' : 'worldbook-condition-false',
      'The bound world state condition is not satisfied in this permitted snapshot.', condition.status === 'unknown' ? module.required ? 'error' : 'warning' : 'info');
  }
}

/** Mirror the final dependency/lifetime result, rather than claiming eligible means delivered. */
export function finishWorldbookPlan(prepared: ReturnType<typeof prepareWorldbook>[], decisions: PromptModuleDecision[]): WorldbookPlan {
  const bindings = prepared.flatMap(item => item.plan.bindings).map(binding => {
    if (binding.status === 'error') return binding;
    const final = decisions.find(item => item.ref.key === binding.ref.key);
    return final ? { ...binding, status: final.status, reasons: final.reasons } : binding;
  });
  return { schema: 'rp.worldbook-plan/0.1', bindings,
    diagnostics: [...prepared.flatMap(item => item.global), ...bindings.flatMap(item => item.reasons.filter(reason => reason.severity !== 'info'))] };
}

/** Author-console data consumption. Disabled prompt switches are deliberately not data deletion.
 * This is not a role query interface, renderer, script runner or prompt activation.
 */
export function readAuthorWorldbookData(documents: { source: 'card' | 'preset'; id: string; modules: PromptModule[]; worldbook?: Worldbook; scenario?: ScenarioDefinition }[], snapshot: unknown) {
  const items: { source: 'card' | 'preset'; documentId: string; bindingId: string; moduleId: string; content: string; promptEnabled: boolean; catalog?: AuthorCatalog }[] = [];
  const decisions: WorldbookDecision[] = [], diagnostics: RuntimeDiagnostic[] = [];
  for (const document of documents) {
    const prepared = prepareWorldbook(document.source, document.id, document.modules, document.worldbook);
    diagnostics.push(...prepared.global);
    const localDecisions = prepared.plan.bindings.map(item => structuredClone(item));
    decisions.push(...localDecisions);
    for (const decision of localDecisions) {
      if (decision.status === 'error') continue;
      const gate = prepared.gates.get(decision.ref.moduleId)!;
      const binding = gate.binding;
      if (binding.purpose !== 'ui-data') { decision.reasons.push(reason('worldbook-data-channel', 'Not assigned to UI data consumption.')); continue; }
      if (binding.when && evaluateNativeCondition(binding.when, { snapshot }).status !== 'true') {
        decision.reasons.push(reason('worldbook-condition-unavailable', 'Data condition is false or unknown.')); continue;
      }
      const module = document.modules.find(item => item.id === binding.moduleId)!;
      items.push({ source: document.source, documentId: document.id, bindingId: binding.id, moduleId: module.id, content: module.content, promptEnabled: module.enabled, ...(binding.catalog ? { catalog: readCatalogReferences(binding, module.content, document) } : {}) });
      decision.status = 'included'; decision.reasons.push(reason('worldbook-data', 'Read as author data without prompt execution or state changes.'));
    }
  }
  // An invalid contract never returns a partial data result as a successful consumption.
  return { schema: 'rp.worldbook-data/0.1' as const, items: diagnostics.some(item => item.severity === 'error') ? [] : items,
    decisions, diagnostics, valid: !diagnostics.some(item => item.severity === 'error') };
}

/** Used on complete proposed document snapshots before committing runtime edits. */
export function worldbookContentIssues(document: { modules: PromptModule[]; worldbook?: Worldbook }) {
  return (document.worldbook?.bindings ?? []).flatMap((binding, index) => {
    const module = document.modules.find(item => item.id === binding.moduleId);
    return binding.contentHash && module && binding.contentHash.toLowerCase() !== bodyHash(module.content)
      ? [{ path: `/worldbook/bindings/${index}/contentHash`, message: `Body hash does not match the bound module text; review the binding before using current SHA-256 ${bodyHash(module.content)}` }] : [];
  });
}

/** Authoring and publication use the same body-integrity check as dispatch. */
export function validateRuntimeDocument(kind: CreativeKind, value: unknown) {
  const issues = validateNativeDocument(kind, value);
  return issues.length ? issues : worldbookContentIssues(value as NativeDocument);
}
