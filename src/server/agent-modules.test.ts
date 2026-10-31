import { describe, expect, it, vi } from 'vitest';
import type { AgentModuleManifest } from '../shared/agent-runtime';
import type { SessionSnapshot } from '../shared/types';
import { AgentModuleError, AgentModuleRegistry, parseAgentRuntimeConfig, type AgentModule } from './agent-modules';

const meta = (id: string, requires: string[] = []): AgentModuleManifest => ({ id, version: '1.0.0', apiVersion: 'rp.agent-module/0.1', title: id, requires });
const tool = (name: string) => ({ name, description: name, parameters: { type: 'object' }, execute: () => ({ ok: true }) });
const context = () => ({ roleId: 'npc', view: {
  id: 'story', revision: 0, title: 'Story', cardId: 'card', presetId: 'preset', playerRoleId: 'player',
  createdAt: '', updatedAt: '', roles: [], world: { location: 'room', time: 'night', variables: {} },
  fields: [], panels: [], events: [], prose: [], turns: [], narration: { person: 'auto', pov: 'auto' }, perspective: 'npc',
} satisfies SessionSnapshot, signal: new AbortController().signal });
function fails(action: () => unknown, code: string) {
  try { action(); throw new Error('Expected failure'); }
  catch (error) { expect(error).toBeInstanceOf(AgentModuleError); expect(error).toMatchObject({ code }); }
}

describe('trusted agent module assembly', () => {
  it('keeps legacy behavior and explicitly reduces capabilities by profile', () => {
    const registry = new AgentModuleRegistry();
    expect(registry.resolve().enabled).toEqual(['rp.role-agents', 'rp.peer-mail', 'rp.auxiliary-outputs']);
    expect(registry.resolve({ profile: 'compact' }).enabled).toEqual(['rp.role-agents']);
    const minimal = registry.resolve({ profile: 'minimal' });
    expect(minimal.enabled).toEqual([]); expect(minimal.disabled).toHaveLength(3);
    expect(registry.resolve({ profile: 'full', modules: { 'rp.peer-mail': false } }).enabled).toEqual(['rp.role-agents', 'rp.auxiliary-outputs']);
    fails(() => registry.resolve({ profile: 'full', modules: { 'rp.role-agents': false } }), 'AGENT_MODULE_DEPENDENCY');
    fails(() => registry.resolve({ profile: 'minimal', modules: { 'rp.peer-mail': true } }), 'AGENT_MODULE_DEPENDENCY');
  });

  it('rejects malformed configuration and unknown module IDs without evaluating getters', () => {
    const registry = new AgentModuleRegistry(), getter = vi.fn();
    for (const value of [null, [], {}, { profile: 'other' }, { profile: 'full', extra: true }, { profile: 'full', modules: null }, { profile: 'full', modules: { x: 1 } }, { profile: 'full', modules: { '': true } }, { get profile() { getter(); return 'full'; } }])
      fails(() => registry.resolve(value), 'AGENT_CONFIG_INVALID');
    expect(getter).not.toHaveBeenCalled();
    fails(() => registry.resolve({ profile: 'full', modules: { missing: false } }), 'AGENT_MODULE_UNKNOWN');
    expect(parseAgentRuntimeConfig()).toEqual({ profile: 'full' });
  });

  it('rejects invalid module catalogs before any factories execute', () => {
    const factory = vi.fn(() => []);
    fails(() => new AgentModuleRegistry([{ meta: meta('rp.role-agents') }]), 'AGENT_MODULE_DUPLICATE');
    const wrongVersion = meta('x'); Reflect.set(wrongVersion, 'apiVersion', 'other');
    fails(() => new AgentModuleRegistry([{ meta: wrongVersion }]), 'AGENT_MODULE_API_VERSION');
    fails(() => new AgentModuleRegistry([{ meta: meta('x', ['missing']) }]), 'AGENT_MODULE_DEPENDENCY');
    fails(() => new AgentModuleRegistry([{ meta: meta('x'), roleTools: factory }]), 'AGENT_MODULE_DEPENDENCY');
    fails(() => new AgentModuleRegistry([{ meta: meta('x', ['y']) }, { meta: meta('y', ['x']) }]), 'AGENT_MODULE_CYCLE');
    expect(factory).not.toHaveBeenCalled();
  });

  it('never runs disabled factories and gives enabled factories only a detached role view and cancellation', () => {
    const factory = vi.fn(input => { expect(Object.keys(input).sort()).toEqual(['roleId', 'signal', 'view']); return [tool('recall_note')]; });
    const registry = new AgentModuleRegistry([{ meta: meta('trusted.notes', ['rp.role-agents']), roleTools: factory }]);
    const input = context();
    expect(registry.roleTools(registry.resolve(), input)).toEqual([]);
    expect(registry.roleTools(registry.resolve({ profile: 'minimal' }), input)).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
    const plan = registry.resolve({ profile: 'compact', modules: { 'trusted.notes': true } });
    expect(registry.roleTools(plan, input).map(tool => tool.name)).toEqual(['recall_note']);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0][0].signal).toBe(input.signal);
    expect(factory.mock.calls[0][0].view).not.toBe(input.view);
    expect(Object.isFrozen(factory.mock.calls[0][0].view.world)).toBe(true);
    fails(() => registry.resolve({ profile: 'minimal', modules: { 'trusted.notes': true } }), 'AGENT_MODULE_DEPENDENCY');
  });

  it('detects tool conflicts across enabled factories and reserves host completion and mail names', () => {
    for (const name of ['submit_result', 'peer_send']) {
      const registry = new AgentModuleRegistry([{ meta: meta('x', ['rp.role-agents']), roleTools: () => [tool(name)] }]);
      fails(() => registry.roleTools(registry.resolve({ profile: 'full', modules: { x: true } }), context()), 'AGENT_TOOL_CONFLICT');
    }
    const registry = new AgentModuleRegistry(['x', 'y'].map(id => ({ meta: meta(id, ['rp.role-agents']), roleTools: () => [tool('duplicate')] })));
    fails(() => registry.roleTools(registry.resolve({ profile: 'full', modules: { x: true, y: true } }), context()), 'AGENT_TOOL_CONFLICT');
  });

  it('copies and freezes configuration and manifests against caller drift', () => {
    const requires = ['rp.role-agents'], manifest = meta('x', requires), module: AgentModule = { meta: manifest };
    const registry = new AgentModuleRegistry([module]);
    requires.push('missing');
    const config = { profile: 'compact', modules: { x: true } }, plan = registry.resolve(config);
    config.modules.x = false;
    expect(plan.enabled).toContain('x'); expect(plan.config.modules?.x).toBe(true);
    expect(registry.catalog().find(entry => entry.id === 'x')?.requires).toEqual(['rp.role-agents']);
    for (const value of [plan, plan.config, plan.config.modules, plan.enabled, plan.manifests, registry.catalog()[3], registry.catalog()[3].requires]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => { plan.config.modules!.x = false; }).toThrow();
  });

  it('reports non-synchronous and failed factories as module errors', () => {
    const invalid: AgentModule = { meta: meta('async', ['rp.role-agents']) };
    Reflect.set(invalid, 'roleTools', () => Promise.resolve([]));
    const registry = new AgentModuleRegistry([invalid]);
    fails(() => registry.roleTools(registry.resolve({ profile: 'full', modules: { async: true } }), context()), 'AGENT_TOOL_INVALID');
    const broken = new AgentModuleRegistry([{ meta: meta('broken', ['rp.role-agents']), roleTools: () => { throw new Error('Fixture failure'); } }]);
    fails(() => broken.roleTools(broken.resolve({ profile: 'full', modules: { broken: true } }), context()), 'AGENT_MODULE_FACTORY');
  });
});
