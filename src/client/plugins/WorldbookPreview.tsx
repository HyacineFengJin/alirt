import { useEffect, useRef, useState } from 'react';
import type { PromptPlan, RuntimeDiagnostic } from '../../shared/prompt-runtime';
import type { AgentKind, RoleDefinition } from '../../shared/types';
import { api, errorText, type RuntimeConfiguration } from '../api';

const sources = { card: '角色卡', preset: '预设' };
const reasons: Record<string, string> = {
  disabled: '资料已关闭', target: '未投递给此代理', phase: '执行阶段不匹配', audience: '不在此代理可见范围',
  'condition-false': '模块条件未满足', 'condition-unknown': '模块条件无法判断', 'activation-keys': '主关键词未命中',
  'activation-secondary': '辅助关键词未命中', 'worldbook-condition-false': '绑定条件未满足', 'worldbook-condition-unknown': '绑定条件无法判断',
  keywords: '关键词触发条件未满足', 'worldbook-audience': '不在绑定的可见范围', 'worldbook-data-channel': '此项用于界面数据，不投递给模型',
  'worldbook-adapter-required': '此用途需要原生适配器', 'worldbook-content-changed': '正文已变化，需要重新审阅绑定',
  'lifetime-once': '此资料已完成单次投递', 'lifetime-cooldown': '此资料仍在冷却期', 'lifetime-delay': '尚未达到延迟投递回合', 'lifetime-probability': '本回合未通过激活概率',
  'dependency-unavailable': '依赖模块未入选', 'exclusive-lower-rank': '互斥组中有更高优先级的资料',
};
const reasonText = (reason: RuntimeDiagnostic) => reasons[reason.code] ?? reason.message;
export function WorldbookPreviewResult({ plan, runtime }: { plan: PromptPlan; runtime: RuntimeConfiguration }) {
  const title = (ref: PromptPlan['decisions'][number]['ref']) => runtime[ref.source].modules.find(module => module.id === ref.moduleId)?.title ?? ref.moduleId;
  const excluded = plan.decisions.filter(decision => decision.status !== 'included');
  return <div className="worldbook-preview-result" aria-live="polite">
    <p className="fine">已保存故事版本 {plan.snapshotRevision} · {plan.valid ? '投递计划可用' : '投递计划存在错误'}</p>
    {plan.snapshotRevision !== runtime.revision && <p className="notice">故事版本已变化，请重新读取资料后再预览以核对最新标题。</p>}
    <h4>入选模块 · {plan.modules.length} 项</h4>
    {plan.modules.length ? <ul>{plan.modules.map(module => <li key={module.ref.key}><strong>{title(module.ref)}</strong><span className="fine"> · {sources[module.ref.source]}</span></li>)}</ul> : <p className="muted">没有模块入选此代理。</p>}
    <details><summary>排除与错误 · {excluded.length} 项</summary><ul>{excluded.map(decision => <li key={decision.ref.key}><strong>{title(decision.ref)}</strong><span className="fine"> · {sources[decision.ref.source]}</span><p className={decision.status === 'error' ? 'error' : 'fine'}>{decision.reasons.map(reasonText).join('；') || '未入选'}</p></li>)}</ul></details>
    {plan.diagnostics.filter(diagnostic => diagnostic.severity !== 'info').map((diagnostic, index) => <p className={diagnostic.severity === 'error' ? 'error' : 'notice'} key={index}>{reasonText(diagnostic)}</p>)}
  </div>;
}
export function WorldbookPreview({ sessionId, runtime, roles, disabled }: { sessionId: string; runtime: RuntimeConfiguration; roles: RoleDefinition[]; disabled: boolean }) {
  const [target, setTarget] = useState<AgentKind>('world');
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '');
  const [text, setText] = useState('');
  const [plan, setPlan] = useState<PromptPlan>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    controller.current?.abort(); setPending(false); setPlan(undefined); setError('');
    return () => controller.current?.abort();
  }, [sessionId, runtime.revision]);
  function reset() { controller.current?.abort(); setPending(false); setPlan(undefined); setError(''); }
  async function preview() {
    if (disabled || pending || target === 'role' && !roleId) return;
    const request = new AbortController();
    controller.current?.abort(); controller.current = request;
    setPending(true); setError(''); setPlan(undefined);
    try {
      const next = await api.runtimePreview(sessionId, { target, ...(target === 'role' ? { roleId } : {}), text }, request.signal);
      if (!request.signal.aborted) setPlan(next);
    } catch (error) { if (!request.signal.aborted) setError(errorText(error)); }
    finally { if (!request.signal.aborted) setPending(false); }
  }
  return <details className="worldbook-section worldbook-preview"><summary>预览已保存资料的实际投递</summary>
    <p className="fine">只预览已保存的资料；当前编辑草稿不参与。此操作不调用模型，不产生模型费用。</p>
    <div className="worldbook-fields"><label>接收代理<select value={target} disabled={pending} onChange={event => { reset(); setTarget(event.target.value as AgentKind); }}><option value="world">世界协调</option><option value="prose">正文成文</option><option value="role">角色决策</option></select></label>{target === 'role' && <label>选择角色<select value={roleId} disabled={pending} onChange={event => { reset(); setRoleId(event.target.value); }}><option value="" disabled>请选择角色</option>{roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>}</div>
    <label>触发测试文本<textarea rows={2} value={text} disabled={pending} onChange={event => { reset(); setText(event.target.value); }} placeholder="用于测试关键词触发的行动或对话" /></label>
    <button type="button" disabled={disabled || pending || target === 'role' && !roleId} onClick={() => void preview()}>{pending ? '编译预览中…' : '预览已保存资料'}</button>
    {error && <p className="error" role="alert">预览失败：{error}</p>}
    {plan && <WorldbookPreviewResult plan={plan} runtime={runtime} />}
  </details>;
}
