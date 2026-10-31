import { useEffect, useState } from "react";
import { api, errorText, type AuthorKnowledge as KnowledgeSnapshot } from "../api";
import type { ProvenancedKnowledge } from "../../shared/knowledge";
import type { PanelContext } from "./registry";
import { knowledgeDraft, knowledgePayload, type KnowledgeDraft } from "./knowledge";

const lifecycleLabels = { active: "有效", withdrawn: "已撤回", stale: "来源已失效" };
const originLabels = { card: '初始条目', author: '作者条目', derived: '派生条目', peer: '来信条目' };

export function KnowledgeProvenanceDetails({ item }: { item: ProvenancedKnowledge }) {
  const provenance = item.provenance;
  if (!provenance) return <small className="fine block">未记录来源元数据；不能据此推断依赖关系。</small>;
  return <>
    <small className="fine block">{provenance.observation ? '历史观察记忆' : originLabels[provenance.kind]} · {provenance.sourceRefs.length ? '有来源依赖' : '无已登记依赖'}</small>
    {provenance.observation && <small className="fine block">观察事件：{provenance.observation.eventId} · 场景：{provenance.observation.sceneId}</small>}
    <small className="fine block">来源：{provenance.sourceId}{provenance.sourceRefs.length ? ` · 依赖来源：${provenance.sourceRefs.join('、')}` : ''}</small>
  </>;
}

export function KnowledgeRetractionScope({ item }: { item?: ProvenancedKnowledge }) {
  return <div className="notice">
    <p>{item?.provenance?.observation
      ? '撤回此历史观察条目后，它不再作为本角色当前有效的观察记忆；原始世界事件与旧正文仍保留，新的真实观察仍可重新建立记忆。'
      : item?.provenance?.kind === 'derived'
        ? '撤回本条派生条目会将其标记为已撤回，引用它的已登记依赖后代会标记为来源已失效；历史仍保留。'
        : '撤回所选条目会使引用它的已登记依赖后代失效；历史仍保留。'}</p>
    {item?.provenance?.observation && <p>引用此条目来源的已登记依赖后代也会标记为来源已失效；这不会删除事件档案。</p>}
    <p>未登记依赖的独立片段不会按文字或语义匹配自动抹除。</p>
  </div>;
}
export function KnowledgeList({ items }: { items: ProvenancedKnowledge[] }) {
  return <>{items.map((item) => <p key={item.id}>
    {item.text}
    <small className="fine block">
      {item.status === "uncertain" ? "尚不确定" : "已知"} · {lifecycleLabels[item.lifecycle ?? "active"]}
    </small>
    {item.provenance?.observation && <small className="fine block">此处记录观察事件的发生；“已知”不代表事件中被说出的内容已经验证。</small>}
  </p>)}</>;
}
export function AuthorKnowledge({ session, selectedRole, editKnowledge, readOnly }: PanelContext) {
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot>();
  const [draft, setDraft] = useState<KnowledgeDraft>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setSnapshot(undefined);
    setError("");
    api.knowledge(session.id).then((next) => { if (active) setSnapshot(next); })
      .catch((e) => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [session.id, session.revision, session.updatedAt, attempt]);
  useEffect(() => { setDraft(undefined); }, [session.id, selectedRole?.id]);
  const role = snapshot?.roles.find((item) => item.id === selectedRole?.id);
  const items: ProvenancedKnowledge[] = role?.knowledge ?? selectedRole?.knowledge ?? [];
  const latestRevision = Math.max(session.revision, snapshot?.revision ?? 0);
  function open(item?: ProvenancedKnowledge, retract = false) {
    if (!snapshot) return;
    const next = knowledgeDraft(item, snapshot.revision);
    if (!item) next.id = `knowledge-${crypto.randomUUID()}`;
    if (retract) next.operation = "retract";
    setDraft(next);
    setEditing(!!item);
    setError("");
  }
  async function save() {
    if (!draft || !selectedRole || busy || readOnly) return;
    setBusy(true);
    setError("");
    try {
      await editKnowledge(knowledgePayload(selectedRole.id, draft));
      setDraft(undefined);
      setAttempt((value) => value + 1);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  function update(patch: Partial<KnowledgeDraft>) { setDraft((current) => current ? { ...current, ...patch } : current); }
  return <section aria-label="作者知识管理">
    {error && <div role="alert"><p className="error">{error}</p><button onClick={() => setAttempt((value) => value + 1)}>重新读取知识</button></div>}
    {!snapshot && !error && <p className="muted">正在读取知识来源…</p>}
    {items.map((item) => {
      const knowledge = item as ProvenancedKnowledge;
      return <div key={item.id}>
        <KnowledgeList items={[knowledge]} />
        <small className="fine block">{item.id} · 读者：{Array.isArray(item.audience) ? item.audience.join("、") : item.audience === "author" ? "作者" : "公开"}</small>
        <KnowledgeProvenanceDetails item={knowledge}/>
        <div className="actions">
          <button disabled={!snapshot || readOnly || busy} onClick={() => open(knowledge)}>编辑</button>
          <button disabled={!snapshot || readOnly || busy || knowledge.lifecycle === "withdrawn"} onClick={() => open(knowledge, true)}>撤回</button>
        </div>
      </div>;
    })}
    {!items.length && <p className="muted">此角色尚无知识。</p>}
    {selectedRole && <button disabled={!snapshot || readOnly || busy} onClick={() => open()}>添加知识</button>}
    {draft && selectedRole && <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <h3>{draft.operation === "retract" ? "撤回知识" : editing ? "编辑知识" : "添加知识"} · {selectedRole.name}</h3>
      <p className="fine">基于世界版本 {draft.expectedRevision}{draft.expectedRevision !== latestRevision ? " · 世界已有更新，请取消并重新打开编辑" : ""}</p>
      {draft.operation === 'retract' && <KnowledgeRetractionScope item={items.find(item => item.id === draft.id)}/>}
      <label>知识 ID<input value={draft.id} disabled={editing || busy} onChange={(event) => update({ id: event.target.value })} required /></label>
      {draft.operation === "upsert" && <>
        <label>知识内容<textarea value={draft.text} disabled={busy} onChange={(event) => update({ text: event.target.value })} required rows={3} /></label>
        <label>确定程度<select value={draft.status} disabled={busy} onChange={(event) => update({ status: event.target.value as KnowledgeDraft["status"] })}><option value="known">已知</option><option value="uncertain">尚不确定</option></select></label>
        <label>获准读者<select value={Array.isArray(draft.audience) ? "roles" : draft.audience} disabled={busy} onChange={(event) => update({ audience: event.target.value === "roles" ? [selectedRole.id] : event.target.value as "author" | "public" })}><option value="author">仅作者</option><option value="public">公开</option><option value="roles">指定角色</option></select></label>
        {Array.isArray(draft.audience) && <fieldset disabled={busy}><legend>角色读者</legend>{session.roles.map((reader) => <label key={reader.id}><input type="checkbox" checked={draft.audience.includes(reader.id)} onChange={(event) => update({ audience: event.target.checked ? [...draft.audience as string[], reader.id] : (draft.audience as string[]).filter((id) => id !== reader.id) })} />{reader.name}</label>)}</fieldset>}
        <fieldset disabled={busy}><legend>推导依据（可选）</legend><p className="fine">选择来源 ID 后，服务端会核验来源与读者权限。</p>{snapshot?.registry.sources.filter((source) => source.id !== items.find((item) => item.id === draft.id)?.provenance?.sourceId && (source.lifecycle === "active" || draft.sourceRefs.includes(source.id))).map((source) => <label key={source.id}><input type="checkbox" checked={draft.sourceRefs.includes(source.id)} onChange={(event) => update({ sourceRefs: event.target.checked ? [...draft.sourceRefs, source.id] : draft.sourceRefs.filter((id) => id !== source.id) })} />{source.id} · {source.ownerRoleId} · {source.certainty === "uncertain" ? "尚不确定" : "已知"} · {lifecycleLabels[source.lifecycle]}</label>)}</fieldset>
      </>}
      <label>修改原因<input value={draft.reason} disabled={busy} onChange={(event) => update({ reason: event.target.value })} required /></label>
      <div className="actions"><button type="submit" disabled={busy || readOnly || !draft.reason.trim() || !draft.id.trim() || draft.expectedRevision !== latestRevision}>{busy ? "保存中…" : draft.operation === "retract" ? "确认撤回" : "保存知识"}</button><button type="button" disabled={busy} onClick={() => setDraft(undefined)}>取消</button></div>
    </form>}
  </section>;
}
