import type { Audience, Condition, Json, PromptModule } from './types';
import type { PromptModuleDecision, PromptModuleRef, RuntimeDiagnostic } from './prompt-runtime';
import type { RoleStageTemplate } from './role-stage';
import type { CatalogMapping } from './catalog';

export const WORLDBOOK_PURPOSES = [
  'reference', 'entity-profile', 'scenario-plan', 'state-rule',
  'initialization', 'output-contract', 'ui-data',
] as const;
export type WorldbookPurpose = typeof WORLDBOOK_PURPOSES[number];

/** Evidence only. Source metadata never grants execution or disclosure rights. */
export interface WorldbookSource {
  importId: string;
  sourceHash: string;
  pointer: string;
  entryId?: string | number;
  /** Original author inputs/translation choices, retained as evidence only. */
  parameters?: Json;
}

/** One binding owns one whole module body in the same document; text is not copied.
 * Audience and conditions only narrow the module's existing admission scope.
 * Native validation checks hash shape; the server checks contentHash against
 * the SHA-256 of the module's exact body before consuming the binding.
 */
export interface WorldbookBinding {
  id: string;
  moduleId: string;
  purpose: WorldbookPurpose;
  when?: Condition;
  audience?: Audience;
  contentHash?: string;
  source?: WorldbookSource;
  roleStage?: RoleStageTemplate;
  catalog?: CatalogMapping;
}

export interface Worldbook {
  schema: 'rp.worldbook/0.1';
  bindings: WorldbookBinding[];
}

/** Author commands edit the session's bound documents, never the imported source. */
type WorldbookRequiredModuleFields = 'title' | 'category' | 'content' | 'enabled' | 'targets' | 'phase' | 'priority';
export type WorldbookModuleEdit = Partial<Pick<PromptModule, WorldbookRequiredModuleFields>> & {
  [Key in Exclude<keyof PromptModule, 'id' | WorldbookRequiredModuleFields>]?: PromptModule[Key] | null;
};
export type WorldbookBindingEdit = {
  purpose?: WorldbookPurpose;
  when?: Condition | null;
  audience?: Audience | null;
  source?: WorldbookSource | null;
  roleStage?: RoleStageTemplate | null;
};
type WorldbookEditBase = { expectedRevision: number; reason: string; source: 'card' | 'preset' };
type WorldbookEditTarget = { moduleId: string; bindingId?: string } | { bindingId: string; moduleId?: string };
export type WorldbookEditCommand = WorldbookEditBase & (
  | { operation: 'add'; module: Pick<PromptModule, 'title' | 'content'> & Partial<Omit<PromptModule, 'id' | 'title' | 'content'>>; binding?: WorldbookBindingEdit }
  | (WorldbookEditTarget & { operation: 'edit'; module?: WorldbookModuleEdit; binding?: WorldbookBindingEdit })
  | (WorldbookEditTarget & { operation: 'delete' })
  | (WorldbookEditTarget & { operation: 'set-enabled'; enabled: boolean })
);

/** A diagnostic artifact. It contains references and decisions, never module bodies. */
export interface WorldbookDecision {
  bindingId: string;
  ref: PromptModuleRef;
  purpose: WorldbookPurpose;
  status: PromptModuleDecision['status'];
  reasons: RuntimeDiagnostic[];
}
export interface WorldbookPlan {
  schema: 'rp.worldbook-plan/0.1';
  bindings: WorldbookDecision[];
  diagnostics: RuntimeDiagnostic[];
}
