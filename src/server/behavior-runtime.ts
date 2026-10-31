import type { BehaviorApproval, BehaviorCandidate } from '../shared/behavior';
import type { RuntimeDiagnostic } from '../shared/prompt-runtime';
import type { RoleInteraction } from '../shared/types';
import { isRemoteInteraction } from '../shared/role-interaction';

export interface BehaviorReport {
  roleId: string;
  public?: { speech: readonly string[]; actions: readonly string[] };
  expression?: string;
  interaction?: RoleInteraction;
}

export class BehaviorContractError extends Error {
  constructor(public code: 'BEHAVIOR_CANDIDATE' | 'BEHAVIOR_APPROVAL', message: string) {
    super(message);
    this.name = 'BehaviorContractError';
  }
}

/** The caller supplies delivery-unique host ids (for example a UUID prefix and
 * an ordinal). Role reports never choose their own candidate ids. This helper
 * is deterministic with an injected id factory and does not mutate reports. */
export function createBehaviorCandidates(reports: readonly BehaviorReport[], idFactory: () => string): BehaviorCandidate[] {
  const candidates: BehaviorCandidate[] = [];
  const ids = new Set<string>();
  const append = (roleId: string, kind: BehaviorCandidate['kind'], text: string, interaction?: RoleInteraction) => {
    if (typeof text !== 'string') throw new BehaviorContractError('BEHAVIOR_CANDIDATE', 'Behavior text must be a string');
    const id = idFactory();
    if (typeof id !== 'string' || !id.trim() || ids.has(id)) {
      throw new BehaviorContractError('BEHAVIOR_CANDIDATE', 'Host behavior candidate ids must be nonempty and unique');
    }
    ids.add(id);
    candidates.push({ id, roleId, kind, text, ...(isRemoteInteraction(interaction) ? { interaction: structuredClone(interaction) } : {}) });
  };
  for (const report of reports) {
    if (typeof report.roleId !== 'string' || !report.roleId.trim()) throw new BehaviorContractError('BEHAVIOR_CANDIDATE', 'Behavior candidates require a role id');
    if (Object.hasOwn(report, 'public')) {
      if (!report.public || !Array.isArray(report.public.speech) || !Array.isArray(report.public.actions)) {
        throw new BehaviorContractError('BEHAVIOR_CANDIDATE', 'Public behavior requires speech and actions arrays');
      }
      for (const text of report.public.speech) append(report.roleId, 'speech', text, report.interaction);
      if (!isRemoteInteraction(report.interaction)) for (const text of report.public.actions) append(report.roleId, 'action', text);
    } else if (report.expression !== undefined) {
      append(report.roleId, 'speech', report.expression, report.interaction);
    }
  }
  return candidates;
}

/** Missing legacy approval fails closed with a diagnostic. An explicitly
 * supplied invalid list is an error, including duplicates and ids outside the
 * current turn. Returned snapshots share no objects with the inputs. */
export function parseBehaviorApproval(worldResult: unknown, candidates: readonly BehaviorCandidate[]): BehaviorApproval & { diagnostics: RuntimeDiagnostic[] } {
  const fail = (message: string): never => { throw new BehaviorContractError('BEHAVIOR_APPROVAL', message); };
  if (!worldResult || typeof worldResult !== 'object' || Array.isArray(worldResult)) return fail('World result must be an object');
  const byId = new Map<string, BehaviorCandidate>();
  for (const candidate of candidates) {
    if (typeof candidate.id !== 'string' || !candidate.id.trim() || byId.has(candidate.id)) return fail('Current-turn behavior candidate ids must be nonempty and unique');
    if (candidate.interaction !== undefined && (!isRemoteInteraction(candidate.interaction) || candidate.kind !== 'speech')) return fail('Remote behavior requires a valid channel and speech-only content');
    byId.set(candidate.id, candidate);
  }
  if (!Object.hasOwn(worldResult, 'acceptedBehaviorIds')) return {
    acceptedBehaviorIds: [], acceptedBehaviors: [], diagnostics: [{
      code: 'behavior-approval-missing', severity: 'warning',
      message: 'World result omitted acceptedBehaviorIds; no role behavior was approved.',
      path: 'acceptedBehaviorIds',
    }],
  };
  const value = (worldResult as Record<string, unknown>).acceptedBehaviorIds;
  if (!Array.isArray(value)) return fail('acceptedBehaviorIds must be an array of strings');
  const acceptedBehaviorIds: string[] = [];
  const acceptedBehaviors: BehaviorCandidate[] = [];
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== 'string') return fail('acceptedBehaviorIds must contain only strings');
    if (seen.has(id)) return fail(`Duplicate approved behavior id: ${id}`);
    const candidate = byId.get(id);
    if (!candidate) return fail(`Unknown current-turn behavior id: ${id}`);
    seen.add(id);
    acceptedBehaviorIds.push(id);
    acceptedBehaviors.push({ ...candidate });
  }
  return { acceptedBehaviorIds, acceptedBehaviors, diagnostics: [] };
}
