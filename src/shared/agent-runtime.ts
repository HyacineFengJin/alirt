/** Declarative selection of trusted host capabilities; it never names executable files. */
export type AgentRuntimeConfig = {
  profile: 'full' | 'compact' | 'minimal';
  modules?: Record<string, boolean>;
};

export interface AgentModuleManifest {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: 'rp.agent-module/0.1';
  readonly title: string;
  readonly description?: string;
  readonly requires?: readonly string[];
}

/** Immutable resolution for one delivery. Changing configuration affects the next resolution. */
export interface AgentRuntimePlan {
  readonly config: AgentRuntimeConfig;
  readonly profile: AgentRuntimeConfig['profile'];
  readonly enabled: readonly string[];
  readonly disabled: readonly string[];
  readonly manifests: readonly AgentModuleManifest[];
}
