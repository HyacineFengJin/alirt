import type { AgentModuleManifest, AgentRuntimeConfig, AgentRuntimePlan } from '../shared/agent-runtime';
import type { SessionSnapshot } from '../shared/types';
import type { ModelTool } from './engine';
import type { DerivedMemoryBridge } from './derived-memory';
import type { TextCarrierViewBridge } from './text-carrier-views';

export type AgentModuleErrorCode = 'AGENT_CONFIG_INVALID' | 'AGENT_MODULE_UNKNOWN' | 'AGENT_MODULE_INVALID'
  | 'AGENT_MODULE_DUPLICATE' | 'AGENT_MODULE_API_VERSION' | 'AGENT_MODULE_DEPENDENCY'
  | 'AGENT_MODULE_CYCLE' | 'AGENT_TOOL_CONFLICT' | 'AGENT_TOOL_INVALID' | 'AGENT_MODULE_FACTORY';

export class AgentModuleError extends Error {
  constructor(public readonly code: AgentModuleErrorCode, message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'AgentModuleError';
  }
}

export interface AgentModuleContext {
  readonly roleId: string;
  /** A detached, permission-filtered view supplied by the caller. */
  readonly view: SessionSnapshot;
  readonly signal: AbortSignal;
  /** Host-scoped staging capability; no store or other actor authority. */
  readonly derivedMemory?: DerivedMemoryBridge;
  readonly carrierViews?: TextCarrierViewBridge;
}

/** Trusted same-process code, registered by the host rather than imported from document data. */
export interface AgentModule {
  readonly meta: AgentModuleManifest;
  readonly roleTools?: (context: AgentModuleContext) => ModelTool[];
}

const error = (code: AgentModuleErrorCode, message: string): never => { throw new AgentModuleError(code, message); };
function object(value: unknown, keys: readonly string[] | undefined, code: AgentModuleErrorCode): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length)
    return error(code, 'Expected a plain object');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor) || keys && !keys.includes(key)) error(code, `Unsupported field: ${key}`);
  }
  return value as Record<string, unknown>;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Validate and detach declarative configuration; legacy sessions select the full profile. */
export function parseAgentRuntimeConfig(value?: unknown): AgentRuntimeConfig {
  if (value === undefined) return freeze({ profile: 'full' });
  const input = object(value, ['profile', 'modules'], 'AGENT_CONFIG_INVALID');
  if (!['full', 'compact', 'minimal'].includes(input.profile as string)) error('AGENT_CONFIG_INVALID', 'Unknown agent runtime profile');
  const config: AgentRuntimeConfig = { profile: input.profile as AgentRuntimeConfig['profile'] };
  if (Object.hasOwn(input, 'modules')) {
    const modules = object(input.modules, undefined, 'AGENT_CONFIG_INVALID');
    for (const [id, enabled] of Object.entries(modules)) {
      if (!id.trim() || typeof enabled !== 'boolean') error('AGENT_CONFIG_INVALID', 'Module overrides require nonempty IDs and boolean values');
    }
    config.modules = Object.fromEntries(Object.entries(modules)) as Record<string, boolean>;
  }
  return freeze(config);
}

const builtins: readonly AgentModule[] = [
  { meta: { id: 'rp.role-agents', version: '0.1.0', apiVersion: 'rp.agent-module/0.1', title: 'Role agents' } },
  { meta: { id: 'rp.peer-mail', version: '0.1.0', apiVersion: 'rp.agent-module/0.1', title: 'Peer mail', requires: ['rp.role-agents'] } },
  { meta: { id: 'rp.auxiliary-outputs', version: '0.1.0', apiVersion: 'rp.agent-module/0.1', title: 'Auxiliary outputs' } },
];

function manifestOf(value: unknown): AgentModuleManifest {
  const meta = object(value, ['id', 'version', 'apiVersion', 'title', 'description', 'requires'], 'AGENT_MODULE_INVALID');
  if (meta.apiVersion !== 'rp.agent-module/0.1') error('AGENT_MODULE_API_VERSION', 'Unsupported agent module API version');
  for (const field of ['id', 'version', 'title']) {
    if (typeof meta[field] !== 'string' || !(meta[field] as string).trim()) error('AGENT_MODULE_INVALID', `Module ${field} must be nonempty text`);
  }
  if (Object.hasOwn(meta, 'description') && typeof meta.description !== 'string') error('AGENT_MODULE_INVALID', 'Module description must be text');
  if (Object.hasOwn(meta, 'requires') && (!Array.isArray(meta.requires)
    || meta.requires.some(id => typeof id !== 'string' || !id.trim()) || new Set(meta.requires).size !== meta.requires.length))
    error('AGENT_MODULE_INVALID', 'Module dependencies must be unique nonempty IDs');
  return freeze({ id: meta.id as string, version: meta.version as string, title: meta.title as string,
    apiVersion: 'rp.agent-module/0.1', ...(Object.hasOwn(meta, 'description') ? { description: meta.description as string } : {}),
    ...(Object.hasOwn(meta, 'requires') ? { requires: [...meta.requires as string[]] } : {}) });
}

export class AgentModuleRegistry {
  private readonly modules: readonly AgentModule[];
  private readonly manifests: readonly AgentModuleManifest[];
  constructor(additionalModules: readonly AgentModule[] = []) {
    const ids = new Set<string>();
    this.modules = [...builtins, ...additionalModules].map(module => {
      const entry = object(module, ['meta', 'roleTools'], 'AGENT_MODULE_INVALID');
      const meta = manifestOf(entry.meta);
      if (ids.has(meta.id)) error('AGENT_MODULE_DUPLICATE', `Duplicate agent module: ${meta.id}`);
      ids.add(meta.id);
      if (Object.hasOwn(entry, 'roleTools') && typeof entry.roleTools !== 'function') error('AGENT_MODULE_INVALID', `Invalid roleTools factory: ${meta.id}`);
      if (entry.roleTools && !meta.requires?.includes('rp.role-agents')) error('AGENT_MODULE_DEPENDENCY', `Role tools module ${meta.id} must require rp.role-agents`);
      return Object.freeze({ meta, ...(entry.roleTools ? { roleTools: entry.roleTools as AgentModule['roleTools'] } : {}) });
    });
    this.manifests = Object.freeze(this.modules.map(module => module.meta));
    const visited = new Set<string>(), visiting = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) error('AGENT_MODULE_CYCLE', `Agent module dependency cycle at ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of this.modules.find(module => module.meta.id === id)!.meta.requires ?? []) {
        if (!ids.has(dependency)) error('AGENT_MODULE_DEPENDENCY', `Module ${id} requires unknown module ${dependency}`);
        visit(dependency);
      }
      visiting.delete(id); visited.add(id);
    };
    ids.forEach(visit);
    Object.freeze(this.modules);
  }

  catalog(): readonly AgentModuleManifest[] { return this.manifests; }

  resolve(value?: unknown): AgentRuntimePlan {
    const config = parseAgentRuntimeConfig(value), overrides = config.modules ?? {};
    for (const id of Object.keys(overrides)) {
      if (!this.modules.some(module => module.meta.id === id)) error('AGENT_MODULE_UNKNOWN', `Unknown agent module: ${id}`);
    }
    const enabled = this.modules.filter(({ meta }) => Object.hasOwn(overrides, meta.id) ? overrides[meta.id]
      : config.profile === 'full' && builtins.some(module => module.meta.id === meta.id)
        || config.profile === 'compact' && meta.id === 'rp.role-agents').map(module => module.meta.id);
    for (const module of this.modules.filter(module => enabled.includes(module.meta.id))) {
      for (const dependency of module.meta.requires ?? []) {
        if (!enabled.includes(dependency)) error('AGENT_MODULE_DEPENDENCY', `Enabled module ${module.meta.id} requires disabled module ${dependency}`);
      }
    }
    return freeze({ config, profile: config.profile, enabled, disabled: this.modules.filter(module => !enabled.includes(module.meta.id)).map(module => module.meta.id), manifests: this.manifests });
  }

  has(plan: AgentRuntimePlan, id: string): boolean { return plan.enabled.includes(id); }

  roleToolManifests(plan: AgentRuntimePlan): readonly AgentModuleManifest[] {
    return Object.freeze(this.modules.filter(module => this.has(plan, module.meta.id) && module.roleTools).map(module => module.meta));
  }

  /** Run only enabled trusted factories against a detached role view; no store or provider is passed. */
  roleTools(plan: AgentRuntimePlan, context: AgentModuleContext, onlyModuleIds?: readonly string[]): ModelTool[] {
    const tools: ModelTool[] = [], names = new Set(['submit_result', 'peer_send']);
    for (const module of this.modules) {
      if (!this.has(plan, module.meta.id) || !module.roleTools || onlyModuleIds && !onlyModuleIds.includes(module.meta.id)) continue;
      let produced: ModelTool[];
      try {
        produced = module.roleTools(Object.freeze({ roleId: context.roleId, view: freeze(structuredClone(context.view)), signal: context.signal,
          ...(context.derivedMemory ? { derivedMemory: Object.freeze({ references: freeze(structuredClone(context.derivedMemory.references)), prepare: context.derivedMemory.prepare }) } : {}),
          ...(context.carrierViews ? { carrierViews: Object.freeze({ targets: freeze(structuredClone(context.carrierViews.targets)), propose: context.carrierViews.propose }) } : {}) }));
      } catch (cause) {
        // Error messages become visible turn status. Preserve private details as
        // an internal cause instead of copying a role's data into other views.
        throw new AgentModuleError('AGENT_MODULE_FACTORY', `Role tools factory failed for ${module.meta.id}`, { cause });
      }
      if (!Array.isArray(produced)) error('AGENT_TOOL_INVALID', `Module ${module.meta.id} must return tools synchronously`);
      for (const tool of produced) {
        if (!tool || typeof tool.name !== 'string' || !tool.name.trim() || typeof tool.description !== 'string' || typeof tool.execute !== 'function')
          error('AGENT_TOOL_INVALID', `Invalid role tool from ${module.meta.id}`);
        if (names.has(tool.name)) error('AGENT_TOOL_CONFLICT', `Duplicate or reserved role tool: ${tool.name}`);
        names.add(tool.name); tools.push(tool);
      }
    }
    return tools;
  }
}
