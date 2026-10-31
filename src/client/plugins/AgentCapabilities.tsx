import { useEffect, useState } from 'react';
import type { AgentRuntimeConfig } from '../../shared/agent-runtime';
import { api, errorText, type AgentModuleCatalog } from '../api';
import './AgentCapabilities.css';

const profiles = { full: '完整装配', compact: '精简装配', minimal: '最小装配' };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonblank = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
export function validAgentModuleCatalog(value: unknown): value is AgentModuleCatalog {
  if (!record(value) || !Array.isArray(value.modules) || !record(value.profiles)) return false;
  const ids = new Set<string>();
  for (const module of value.modules) {
    if (!record(module) || !nonblank(module.id) || ids.has(module.id) || !nonblank(module.title) || !nonblank(module.version) || module.apiVersion !== 'rp.agent-module/0.1'
      || module.description !== undefined && typeof module.description !== 'string'
      || module.requires !== undefined && (!Array.isArray(module.requires) || !module.requires.every(nonblank) || new Set(module.requires).size !== module.requires.length)) return false;
    ids.add(module.id);
  }
  if (value.modules.some(module => module.requires?.some((id: string) => !ids.has(id)))) return false;
  return Object.keys(value.profiles).length === 3 && Object.keys(profiles).every(profile => {
    const defaults = (value.profiles as Record<string, unknown>)[profile];
    return Array.isArray(defaults) && defaults.every(id => typeof id === 'string' && ids.has(id)) && new Set(defaults).size === defaults.length;
  });
}
export function agentModuleEnabled(config: AgentRuntimeConfig, catalog: AgentModuleCatalog, id: string): boolean {
  return Object.hasOwn(config.modules ?? {}, id) ? config.modules![id] : catalog.profiles[config.profile]?.includes(id) ?? false;
}
export function agentCapabilitiesIssues(config: AgentRuntimeConfig, catalog: AgentModuleCatalog): string[] {
  const issues: string[] = [];
  if (!Object.hasOwn(profiles, config.profile)) issues.push(`未知装配方案：${config.profile}`);
  for (const [id, enabled] of Object.entries(config.modules ?? {})) {
    if (!catalog.modules.some(module => module.id === id)) issues.push(`未知模块覆盖：${id}`);
    if (typeof enabled !== 'boolean') issues.push(`模块开关必须为布尔值：${id}`);
  }
  for (const module of catalog.modules) if (agentModuleEnabled(config, catalog, module.id)) {
    for (const dependency of module.requires ?? []) if (!agentModuleEnabled(config, catalog, dependency)) issues.push(`${module.title}（${module.id}）需要启用 ${catalog.modules.find(item => item.id === dependency)?.title ?? dependency}（${dependency}）；请明确选择依赖开关。`);
  }
  return issues;
}
export function setAgentModule(config: AgentRuntimeConfig, id: string, enabled: boolean): AgentRuntimeConfig {
  return { ...config, modules: { ...config.modules, [id]: enabled } };
}
export function resetAgentModule(config: AgentRuntimeConfig, id: string): AgentRuntimeConfig {
  const modules = { ...config.modules }; delete modules[id];
  return { profile: config.profile, ...(Object.keys(modules).length ? { modules } : {}) };
}

export function AgentCapabilitiesForm({ value, catalog, disabled, change }: { value: AgentRuntimeConfig; catalog: AgentModuleCatalog; disabled: boolean; change: (value: AgentRuntimeConfig) => void }) {
  const issues = agentCapabilitiesIssues(value, catalog);
  return <fieldset disabled={disabled} className="agent-capabilities">
    <legend>代理模块装配</legend>
    <p className="fine">更改只在保存到当前故事后影响后续投递，不会自动调用模型。切换方案保留逐项覆盖；依赖不会自动勾选。</p>
    <label>默认方案<select value={value.profile} onChange={event => change({ ...value, profile: event.target.value as AgentRuntimeConfig['profile'] })}>{Object.entries(profiles).map(([id, title]) => <option value={id} key={id}>{title}</option>)}</select></label>
    <button type="button" onClick={() => change({ profile: value.profile })}>使用此方案默认开关（清空覆盖）</button>
    {catalog.modules.map(module => {
      const overridden = Object.hasOwn(value.modules ?? {}, module.id), enabled = agentModuleEnabled(value, catalog, module.id), defaultEnabled = catalog.profiles[value.profile]?.includes(module.id) ?? false;
      return <div key={module.id}>
        <label><input type="checkbox" checked={enabled} onChange={event => change(setAgentModule(value, module.id, event.target.checked))}/>{module.title} · {module.id}</label>
        <p className="fine">方案默认：{defaultEnabled ? '开启' : '关闭'} · 当前：{enabled ? '开启' : '关闭'} · {overridden ? '显式覆盖' : '跟随方案'}</p>
        {module.description && <p className="fine">{module.description}</p>}
        {!!module.requires?.length && <p className="fine">依赖：{module.requires.map(id => `${catalog.modules.find(item => item.id === id)?.title ?? id}（${id}）`).join('、')}</p>}
        {overridden && <button type="button" onClick={() => change(resetAgentModule(value, module.id))}>恢复此项方案默认</button>}
      </div>;
    })}
    {Object.keys(value.modules ?? {}).filter(id => !catalog.modules.some(module => module.id === id)).map(id => <p key={id} className="error">未知覆盖：{id} <button type="button" onClick={() => change(resetAgentModule(value, id))}>移除此未知覆盖</button></p>)}
    {!!issues.length && <div role="alert">{issues.map((issue, index) => <p className="error" key={index}>{issue}</p>)}</div>}
    {catalog.modules.some(module => module.id === 'rp.derived-memory') && <p className="fine">派生记忆工具只暂存未核实的推断或摘要；世界成功后同笔保存为本人私有、尚不确定的条目。关闭模块保留已提交知识，不会按语义自动遗忘。</p>}
  </fieldset>;
}

export function AgentCapabilities({ value, disabled, change, invalid }: { value: AgentRuntimeConfig; disabled: boolean; change: (value: AgentRuntimeConfig) => void; invalid: (message: string) => void }) {
  const [catalog, setCatalog] = useState<AgentModuleCatalog>(), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setCatalog(undefined); setError('');
    api.agentModules(controller.signal).then(result => { if (controller.signal.aborted) return; if (!validAgentModuleCatalog(result)) throw new Error('代理模块目录格式无效，不能核验装配。'); setCatalog(result); })
      .catch(error => { if (!controller.signal.aborted) setError(errorText(error)); });
    return () => controller.abort();
  }, [attempt]);
  const message = catalog ? agentCapabilitiesIssues(value, catalog).join('；') : error || '代理模块目录尚未读取，不能核验装配。';
  useEffect(() => { invalid(message); }, [message, invalid]);
  return <section aria-label="代理模块装配">
    {!catalog && !error && <p className="muted">正在读取已安装代理模块…</p>}
    {error && <div role="alert"><p className="error">{error}</p><button type="button" disabled={disabled} onClick={() => setAttempt(value => value + 1)}>重新读取模块目录</button></div>}
    {catalog && <AgentCapabilitiesForm value={value} catalog={catalog} disabled={disabled} change={next => { invalid(agentCapabilitiesIssues(next, catalog).join('；')); change(next); }}/>}
  </section>;
}
