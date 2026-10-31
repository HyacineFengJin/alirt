import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentRuntimeConfig } from '../../shared/agent-runtime';
import { api, type AgentModuleCatalog } from '../api';
import { agentCapabilitiesIssues, agentModuleEnabled, AgentCapabilitiesForm, resetAgentModule, setAgentModule, validAgentModuleCatalog } from './AgentCapabilities';

const catalog: AgentModuleCatalog = { modules: [
  { id: 'rp.role-agents', title: '角色代理', version: '1', apiVersion: 'rp.agent-module/0.1' },
  { id: 'rp.peer-mail', title: '角色通信', version: '1', apiVersion: 'rp.agent-module/0.1', requires: ['rp.role-agents'] },
  { id: 'rp.auxiliary-outputs', title: '附加输出', version: '1', apiVersion: 'rp.agent-module/0.1' },
  { id: 'rp.derived-memory', title: '派生记忆', description: '按已投递来源建立未核实笔记。', version: '1', apiVersion: 'rp.agent-module/0.1', requires: ['rp.role-agents'] },
], profiles: { full: ['rp.role-agents', 'rp.peer-mail', 'rp.auxiliary-outputs'], compact: ['rp.role-agents'], minimal: [] } };
afterEach(() => vi.unstubAllGlobals());

it('uses published profile defaults and keeps optional derived memory off in every default plan', () => {
  expect(validAgentModuleCatalog(catalog)).toBe(true);
  for (const profile of ['full', 'compact', 'minimal'] as const) {
    expect(agentCapabilitiesIssues({ profile }, catalog)).toEqual([]);
    expect(agentModuleEnabled({ profile }, catalog, 'rp.derived-memory')).toBe(false);
  }
  expect(agentModuleEnabled({ profile: 'compact' }, catalog, 'rp.role-agents')).toBe(true);
  expect(agentModuleEnabled({ profile: 'compact' }, catalog, 'rp.peer-mail')).toBe(false);
});
it('does not silently grant dependencies and validates profile switches with their retained overrides', () => {
  const original: AgentRuntimeConfig = { profile: 'minimal' }, enabled = setAgentModule(original, 'rp.derived-memory', true);
  expect(enabled).toEqual({ profile: 'minimal', modules: { 'rp.derived-memory': true } });
  expect(original).toEqual({ profile: 'minimal' });
  expect(agentCapabilitiesIssues(enabled, catalog).join('')).toContain('需要启用 角色代理');
  expect(agentModuleEnabled(enabled, catalog, 'rp.role-agents')).toBe(false);
  const explicit = setAgentModule(enabled, 'rp.role-agents', true);
  expect(agentCapabilitiesIssues(explicit, catalog)).toEqual([]);
  const switched = { ...enabled, profile: 'compact' as const };
  expect(switched.modules).toEqual({ 'rp.derived-memory': true }); expect(agentCapabilitiesIssues(switched, catalog)).toEqual([]);
  expect(resetAgentModule(explicit, 'rp.role-agents')).toEqual(enabled);
  expect(agentCapabilitiesIssues({ profile: 'full', modules: { uninstalled: false } }, catalog).join('')).toContain('未知模块覆盖：uninstalled');
});
it('shows effective/default/override states and dependency controls with no extra API action', () => {
  const value = { profile: 'minimal' as const, modules: { 'rp.derived-memory': true } };
  const html = renderToStaticMarkup(createElement(AgentCapabilitiesForm, { value, catalog, disabled: true, change: () => { throw new Error('Rendering must not change config'); } }));
  expect(html).toContain('<fieldset disabled="" class="agent-capabilities">');
  expect(html).toContain('默认方案'); expect(html).toContain('方案默认：关闭 · 当前：开启 · 显式覆盖');
  expect(html).toContain('使用此方案默认开关（清空覆盖）'); expect(html).toContain('恢复此项方案默认');
  expect(html).toContain('派生记忆'); expect(html).toContain('按已投递来源建立未核实笔记。');
  expect(html).toContain('请明确选择依赖开关');
  expect(html).toContain('世界成功后同笔保存为本人私有、尚不确定的条目');
  expect(html).toContain('关闭模块保留已提交知识，不会按语义自动遗忘');
});
it('rejects incomplete or contradictory catalog metadata instead of assuming optional capabilities are installed', () => {
  expect(validAgentModuleCatalog({ modules: catalog.modules })).toBe(false);
  expect(validAgentModuleCatalog({ ...catalog, profiles: { ...catalog.profiles, minimal: ['uninstalled'] } })).toBe(false);
  expect(validAgentModuleCatalog({ ...catalog, modules: [...catalog.modules, catalog.modules[0]] })).toBe(false);
  expect(validAgentModuleCatalog({ ...catalog, modules: [{ ...catalog.modules[0], requires: ['uninstalled'] }] })).toBe(false);
});
it('reads the catalog and profile defaults through an abortable GET, never a session write', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => catalog }); vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  await expect(api.agentModules(controller.signal)).resolves.toEqual(catalog);
  expect(fetch.mock.calls[0][0]).toBe('/api/runtime/modules');
  expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', signal: controller.signal });
  expect(fetch.mock.calls[0][1].body).toBeUndefined();
});
