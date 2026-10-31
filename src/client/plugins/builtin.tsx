import { useState } from "react";
import type { RolePhase } from "../../shared/types";
import { errorText } from "../api";
import { PluginRegistry, type PanelContext } from "./registry";
import { ImportedSource } from "./ImportedSource";
import { SidePanelOutputs } from "../AuxiliaryOutputs";
import { AuthorKnowledge, KnowledgeList } from "./AuthorKnowledge";
import { Scenario } from "./Scenario";
import { WorldbookEditor } from "./WorldbookEditor";
import { StateEditor, display } from "./StateEditor";
import { RoleStateFields } from './RoleStateFields';
export { display, parseStateValue } from "./StateEditor";
const phaseLabels: Record<RolePhase, string> = {
  active: "活跃",
  dormant: "休眠",
  faded: "淡出",
  retired: "退场",
};
const channelLabels = { message: '短信', screen: '屏幕', audio: '音频' };
function Scene(context: PanelContext) {
  const { session } = context;
  return (
    <>
      <p className="eyebrow">当前场景</p>
      <h3>{session.world.location}</h3>
      <p className="muted">{session.world.time}</p>
      <dl>
        {Object.entries(session.world.variables).map(([key, value]) => (
          <div key={key}>
            <dt>
              {session.fields.find((field) => field.key === key)?.label ?? key}
            </dt>
            <dd>{display(value)}</dd>
          </div>
        ))}
      </dl>
      {session.fields.some(
        (field) =>
          field.editable && Object.hasOwn(session.world.variables, field.key),
      ) && (
        <details>
          <summary>修正世界状态</summary>
          {session.fields
            .filter(
              (field) =>
                field.editable &&
                Object.hasOwn(session.world.variables, field.key),
            )
            .map((field) => (
              <StateEditor
                key={`world:${field.key}`}
                field={field}
                world
                {...context}
              />
            ))}
        </details>
      )}
      <p className="fine">世界版本 {session.revision}</p>
    </>
  );
}
function Roles({
  session,
  selectedRole,
  selectRole,
  setLifecycle,
  readOnly,
}: PanelContext) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<RolePhase | "">("");
  const [presence, setPresence] = useState<"present" | "absent" | "">("");
  const [interaction, setInteraction] = useState<'' | 'none' | 'message' | 'screen' | 'audio'>('');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('present');
  const role = selectedRole;
  const currentChannel = role?.interaction?.mode === 'remote' ? role.interaction.channel : 'none';
  const selectedChannel = interaction || (presence === 'present' ? 'none' : currentChannel);
  const invalidRemotePresence = selectedChannel !== 'none' && (presence || role?.presence) !== 'absent';
  const visibleRoles = session.roles.filter(item => (!query || item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    && (scope === 'all' || scope === 'present' && item.presence === 'present' || scope === 'active' && item.phase === 'active'
      || scope === 'kept' && ['dormant', 'faded'].includes(item.phase) || scope === 'retired' && item.phase === 'retired'));
  async function save() {
    if (!role || invalidRemotePresence) return;
    setBusy(true);
    setError("");
    try {
      await setLifecycle({
        expectedRevision: session.revision,
        roleId: role.id,
        phase: phase || role.phase,
        presence: presence || role.presence,
        ...(interaction ? { interaction: interaction === 'none' ? null : { mode: 'remote', channel: interaction } } : {}),
      });
      setPhase("");
      setPresence("");
      setInteraction('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <label>查找角色<input aria-label="查找角色" value={query} onChange={event => setQuery(event.target.value)} placeholder="姓名或所属世界" /></label>
      <label>角色范围<select aria-label="角色范围" value={scope} onChange={event => setScope(event.target.value)}><option value="present">当前在场</option><option value="active">活跃（含远程）</option><option value="kept">休眠与淡出</option><option value="retired">已退场</option><option value="all">全部角色</option></select></label>
      <p className="fine">显示 {visibleRoles.length} / {session.roles.length}；筛选不改变角色生命周期。</p>
      <div className="role-list">
        {visibleRoles.map((item) => (
          <button
            key={item.id}
            className="role-choice"
            aria-pressed={item.id === role?.id}
            onClick={() => {
              selectRole(item.id);
              setPhase("");
              setPresence("");
              setInteraction('');
              setError("");
            }}
          >
            <span className="role-mark">{item.name.slice(0, 1)}</span>
            <span>
              {item.name}
              <small>
                {item.id === session.playerRoleId ? "玩家控制 · " : ""}
                {phaseLabels[item.phase]} ·{" "}
                {item.presence === "present" ? "在场" : "离场"}
                {item.interaction?.mode === 'remote' ? ` · ${channelLabels[item.interaction.channel]}` : ''}
              </small>
            </span>
          </button>
        ))}
      </div>
      {role && (
        <div className="role-detail" key={role.id}>
          <p className="eyebrow">正在查看 · {role.name}</p>
          <p>{role.persona}</p>
          <p className="fine">查看角色不会改变玩家身份或成文视角。</p>
          {role.interaction?.mode === 'remote' && <p className="fine">通过{channelLabels[role.interaction.channel]}参与场景，物理上仍然离场。</p>}
          {role.goals.length > 0 && (
            <>
              <h3>目标</h3>
              <ul>
                {role.goals.map((goal, index) => (
                  <li key={index}>{goal}</li>
                ))}
              </ul>
            </>
          )}
          {role.peers.length > 0 && (
            <details className="role-peers"><summary>可交流对象 · {role.peers.length}</summary><p className="muted">
              关联：
              {role.peers
                .map((id) => session.roles.find((r) => r.id === id)?.name ?? id)
                .join("、")}
            </p></details>
          )}
          <details>
            <summary>生命周期</summary>
            <p className="fine">
              关闭面板只影响布局。角色生命周期由世界记录独立管理。
            </p>
            <label>
              活动状态
              <select
                disabled={readOnly || busy}
                value={phase || role.phase}
                onChange={(e) => setPhase(e.target.value as RolePhase)}
              >
                {Object.entries(phaseLabels).map(([key, label]) => (
                  <option value={key} key={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              在场状态
              <select
                disabled={readOnly || busy}
                value={presence || role.presence}
                onChange={(e) =>
                  setPresence(e.target.value as "present" | "absent")
                }
              >
                <option value="present">在场</option>
                <option value="absent">离场</option>
              </select>
            </label>
            <label>
              场景交流渠道
              <select aria-label="场景交流渠道" disabled={readOnly || busy} value={selectedChannel} onChange={event => setInteraction(event.target.value as typeof interaction)}>
                <option value="none">无远程参与</option>
                <option value="message">远程短信</option>
                <option value="screen">远程屏幕</option>
                <option value="audio">远程音频</option>
              </select>
            </label>
            <p className="fine">远程参与需要物理离场，并保持活跃才会进入下一回合。设为在场会结束已有通话；选择“无远程参与”可停止通话并保留角色。</p>
            {invalidRemotePresence && <p className="notice">请先将物理在场状态设为“离场”，再保存远程渠道。</p>}
            <button
              disabled={readOnly || busy || invalidRemotePresence || (!phase && !presence && !interaction)}
              onClick={save}
            >
              {busy ? "提交中…" : "更新生命周期"}
            </button>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
          </details>
        </div>
      )}
    </>
  );
}
function State(context: PanelContext) {
  return <RoleStateFields {...context} />;
}
function Lore(context: PanelContext) {
  const { session, selectedRole } = context;
  return (
    <>
      <p className="eyebrow">当前获准素材</p>
      {session.perspective === "author" ? <AuthorKnowledge {...context} /> : <KnowledgeList items={selectedRole?.knowledge ?? []} />}
      <WorldbookEditor {...context} />
    </>
  );
}
function Events({ session }: PanelContext) {
  return (
    <>
      <p className="fine">事件与 Agent 协作记录单独保留，不混入正文。</p>
      {[...session.events].reverse().map((event) => (
        <details key={event.id}>
          <summary>
            <span className="event-kind">{event.kind}</span> {event.actor}
          </summary>
          <p>{event.text}</p>
          <time className="fine">{event.at}</time>
          {event.data !== undefined && (
            <pre className="source-text">
              {JSON.stringify(event.data, null, 2)}
            </pre>
          )}
        </details>
      ))}
      {session.events.length === 0 && <p className="muted">尚无事件。</p>}
    </>
  );
}
function Outputs({ session, chooseAction, readOnly }: PanelContext) {
  return <SidePanelOutputs prose={session.prose} chooseAction={readOnly ? undefined : chooseAction} />;
}
export const registry = new PluginRegistry();
const builtins = [
  { id: "host.scene", kind: "scene", render: Scene },
  { id: "host.roles", kind: "roles", render: Roles },
  { id: "host.state", kind: "state", render: State },
  { id: "host.lore", kind: "lore", render: Lore },
  { id: "host.events", kind: "events", render: Events },
  { id: "host.source", kind: "source", render: ImportedSource },
  { id: "host.outputs", kind: "outputs", render: Outputs },
  { id: "host.scenario", kind: "scenario", render: Scenario },
] as const;
export function registerBuiltins() {
  const dispose = builtins.map((plugin) => registry.register(plugin));
  return () => dispose.forEach((unregister) => unregister());
}
