import type { Audience, OutputContract, Preset, PromptModule } from './types';
import type { StateRule, StateWriteAuthority } from './state-rules';
import type { StateValueSchema } from './state-value-schema';
import type { AgentRuntimeConfig } from './agent-runtime';
import type { Worldbook } from './worldbook';
import type { CardVisualDefaults } from './visual-assets';

/** Metadata-only patch for an existing field. Null removes optional bounds/schema. */
export interface RuntimeFieldPolicyPatch {
  key: string;
  audience?: Audience;
  editable?: boolean;
  writableBy?: StateWriteAuthority;
  min?: number | null;
  max?: number | null;
  nullable?: boolean;
  valueSchema?: StateValueSchema | null;
}
export interface RuntimeRolePatch { id: string; persona?: string; goals?: string[]; peers?: string[] }
export interface RuntimeConfigurationUpdate {
  expectedRevision: number; reason: string;
  cardModules?: PromptModule[]; cardOutputs?: OutputContract[]; stateRules?: StateRule[]; preset?: Preset; roles?: RuntimeRolePatch[];
  cardWorldbook?: Worldbook | null;
  cardVisuals?: CardVisualDefaults | null;
  agentRuntime?: AgentRuntimeConfig;
  fieldPolicies?: RuntimeFieldPolicyPatch[];
}
