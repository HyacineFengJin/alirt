import type { AgentKind, PromptInjectionSlot, PromptModule } from './types';
import type { WorldbookPlan, WorldbookPurpose } from './worldbook';

/** Runtime artifacts are separate from the portable card/preset documents. */
export interface RuntimeDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  moduleKey?: string;
  path?: string;
}
export interface ConditionResult {
  status: 'true' | 'false' | 'unknown';
  reasons: string[];
}
export interface PromptModuleRef {
  source: 'card' | 'preset';
  documentId: string;
  moduleId: string;
  /** Qualified module key: card:<moduleId> or preset:<moduleId>. */
  key: string;
  sourcePointer?: string;
}
export interface PromptPlanModule {
  ref: PromptModuleRef;
  content: string;
  slot: PromptInjectionSlot;
  order: number;
  priority: number;
  material?: { purpose: WorldbookPurpose };
}
export interface PromptModuleDecision {
  ref: PromptModuleRef;
  status: 'included' | 'excluded' | 'error';
  reasons: RuntimeDiagnostic[];
  slot: PromptInjectionSlot;
  order: number;
  priority: number;
}
export interface PromptActivationState {
  identity: string;
  firstMatchedTurn?: number;
  lastActivatedTurn?: number;
  stickyUntilTurn?: number;
  cooldownUntilTurn?: number;
  consumed?: boolean;
}
export type PromptActivationLedger = Record<string, PromptActivationState>;
export interface PromptActivationPlan {
  turnIndex: number;
  logicalKey: string;
  updates: PromptActivationLedger;
  activated: string[];
}
export interface PromptPlan {
  schema: 'rp.prompt-plan/0.1';
  snapshotRevision: number;
  target: AgentKind;
  phase: PromptModule['phase'];
  roleId?: string;
  /** Identity and stable hash of source documents retained once on the session. */
  sources: { source: 'card' | 'preset'; documentId: string; schema: string; fingerprint: string; effectiveModulesFingerprint: string }[];
  modules: PromptPlanModule[];
  decisions: PromptModuleDecision[];
  diagnostics: RuntimeDiagnostic[];
  valid: boolean;
  activation?: PromptActivationPlan;
  worldbook?: WorldbookPlan;
}
