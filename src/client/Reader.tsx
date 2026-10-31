import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, SlidersHorizontal } from "lucide-react";
import type {
  AppStatus,
  NarrationSettings,
  SessionSnapshot,
  SubmitTurn,
} from "../shared/types";
import { api, ApiError, errorText } from "./api";
import { needsProseRecovery } from "./prose-recovery";
import { ProseEntries } from "./ProseEntries";
import { PendingHostOutputs } from "./PendingHostOutputs";
import { committedParallelScenes } from './ParallelSceneOutput';
import type { ProseReviewTarget } from '../shared/prose-review';
import { ProseReviewDialog } from './ProseReviewDialog';
import type { TextCarrierSelection, TextCarrierTarget } from '../shared/text-carriers';
import { TextCarrierPicker, viewCarrierAction } from './TextCarriers';
import { VisualAssetsDialog } from './VisualAssets';
export const DEFAULT_PROSE_REVIEW_FOCUS = '核对这份已保存稿件是否超出获准素材，重点检查额外行为、内心与知情、时间和对白；仅报告疑点，不改写原稿。';
export function recoverableParallelScene(session: Pick<SessionSnapshot, 'prose'>, runId: string) {
  const scene = [...session.prose].reverse().flatMap(entry => [...(entry.attachments ?? [])].reverse())
    .flatMap(output => committedParallelScenes(output)?.scenes ?? []).find(scene => scene.id === runId);
  return scene?.status !== 'completed' ? scene : undefined;
}
export function readerTurnRequest({ requestId, revision, mode, action, narration, perspective, parallelRunId, proseReview, viewCarrier }: { requestId: string; revision: number; mode: SubmitTurn['mode']; action: string; narration: NarrationSettings; perspective: string; parallelRunId?: string; proseReview?: ProseReviewTarget; viewCarrier?: TextCarrierSelection }): SubmitTurn {
  if (viewCarrier && (perspective !== 'author' || mode !== 'action' || proseReview || parallelRunId || !action.trim() || !viewCarrier.carrierId.trim() || !Number.isSafeInteger(viewCarrier.version) || viewCarrier.version < 1)) throw new Error('查看载体需要明确的独立玩家行动目标。');
  if (proseReview) {
    if (perspective !== 'author' || mode !== 'author' || parallelRunId || !action.trim()) throw new Error('成文审阅需要单独的作者请求与审阅重点。');
    return { requestId, expectedRevision: revision, mode: 'author', action: action.trim(), proseReview: structuredClone(proseReview) };
  }
  if (parallelRunId && (perspective !== 'author' || mode !== 'author' || !parallelRunId.trim())) throw new Error('场外场景恢复只接受明确的作者请求。');
  return { requestId, expectedRevision: revision, mode, action: action.trim(), narration, ...(parallelRunId ? { parallelRecovery: { runId: parallelRunId } } : {}), ...(viewCarrier ? { viewCarrier: { carrierId: viewCarrier.carrierId, version: viewCarrier.version } } : {}) };
}
export const turnBusy = (session: SessionSnapshot) =>
  session.turns.some((turn) =>
    ["queued", "running", "committed"].includes(turn.status),
  );
const statusNames = {
  queued: "等待调度",
  running: "正在生成",
  committed: "世界已提交，等待成文",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
};
export interface ReadingView {
  perspective: string;
  projection?: SessionSnapshot;
  error: string;
  changePerspective: (perspective: string) => void;
  retry: () => void;
}
/** Never fall back to an author snapshot while a different reading view is pending. */
export function currentReadingSnapshot(author: SessionSnapshot, perspective: string, projection?: SessionSnapshot): SessionSnapshot | undefined {
  if (perspective === 'author') return author.perspective === 'author' ? author : undefined;
  return projection?.id === author.id && projection.perspective === perspective && projection.revision === author.revision
    && projection.updatedAt === author.updatedAt ? projection : undefined;
}
export function readingProjectionKey(session: SessionSnapshot, perspective: string) {
  return JSON.stringify([session.id, perspective, session.revision, session.updatedAt]);
}
export function Reader({
  session,
  status,
  refresh,
  suggestion,
  reading,
}: {
  session: SessionSnapshot;
  status?: AppStatus;
  refresh: () => Promise<void>;
  suggestion?: { id: string; sessionId: string; text: string };
  reading: ReadingView;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [narration, setNarration] = useState<NarrationSettings>(
    session.narration,
  );
  const perspective = reading.perspective;
  const projection = currentReadingSnapshot(session, perspective, reading.projection);
  const projectionError = reading.error;
  const [mode, setMode] = useState<SubmitTurn["mode"]>("action");
  const [action, setAction] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [parallelRecovery, setParallelRecovery] = useState<{ sessionId: string; runId: string; title: string }>();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [proseReview, setProseReview] = useState<{ sessionId: string; target: ProseReviewTarget; title: string }>();
  const [carrierOpen, setCarrierOpen] = useState(false);
  const [carrierTarget, setCarrierTarget] = useState<{ sessionId: string; target: TextCarrierTarget }>();
  const [visualEditor, setVisualEditor] = useState<{ sessionId: string; roleId?: string }>();
  const pending = useRef<SubmitTurn | null>(null);
  const submitFlight = useRef(false);
  const recovering = useRef(false);
  const lastSuggestion = useRef<string | undefined>(undefined);
  const player = session.roles.find((role) => role.id === session.playerRoleId);
  const busy = turnBusy(session);
  const visibleTurns = perspective === 'author' ? session.turns : projection?.turns ?? [];
  const lastTurn = session.turns.at(-1);
  const recoveryAvailable = needsProseRecovery(session);
  const selectedRecovery = perspective === 'author' && parallelRecovery?.sessionId === session.id ? parallelRecovery : undefined;
  const selectedReview = perspective === 'author' && proseReview?.sessionId === session.id ? proseReview : undefined;
  const selectedCarrier = perspective === 'author' && carrierTarget?.sessionId === session.id ? carrierTarget.target : undefined;
  useEffect(() => { if (perspective !== 'author' || parallelRecovery?.sessionId !== session.id) setParallelRecovery(undefined); if (proseReview) setAction(current => current === DEFAULT_PROSE_REVIEW_FOCUS ? '' : current); if (carrierTarget) setAction(current => current === viewCarrierAction(carrierTarget.target) ? '' : current); setVisualEditor(undefined); setCarrierTarget(undefined); setCarrierOpen(false); setProseReview(undefined); setReviewOpen(false); }, [perspective, session.id]);
  function openVisualEditor(roleId?: string) { if (perspective === 'author') { setReviewOpen(false); setCarrierOpen(false); setVisualEditor({ sessionId: session.id, roleId }); } }
  function prepareCarrier(target: TextCarrierTarget) {
    if (perspective !== 'author' || submitFlight.current || submitting || busy || uncertain) return;
    setReviewOpen(false); setProseReview(undefined); setParallelRecovery(undefined); setCarrierOpen(false);
    setCarrierTarget({ sessionId: session.id, target: structuredClone(target) }); setMode('action'); setAction(viewCarrierAction(target));
  }
  function prepareReview(target: ProseReviewTarget, title: string) {
    if (perspective !== 'author' || submitFlight.current || submitting || busy || uncertain) return;
    setParallelRecovery(undefined); setReviewOpen(false); setProseReview({ sessionId: session.id, target: structuredClone(target), title });
    setCarrierTarget(undefined); setCarrierOpen(false);
    setMode('author'); setAction(DEFAULT_PROSE_REVIEW_FOCUS);
  }
  function prepareParallelRecovery(runId: string) {
    if (perspective !== 'author' || submitFlight.current || submitting || busy || uncertain) return;
    const scene = recoverableParallelScene(session, runId);
    if (!scene) { setError('此场景当前已完成或没有可恢复记录，请核对最新状态。'); return; }
    setParallelRecovery({ sessionId: session.id, runId, title: scene.title });
    setProseReview(undefined);
    setCarrierTarget(undefined); setCarrierOpen(false);
    setMode('author'); setAction('仅按原已提交材料重新整理该场外场景');
  }
  function chooseAction(text: string) {
    if (submitting || busy || uncertain) return;
    setMode("action");
    setParallelRecovery(undefined);
    setProseReview(undefined);
    setCarrierTarget(undefined);
    setAction((current) => selectedRecovery || selectedReview || selectedCarrier ? text : current.trim() ? `${current}\n${text}` : text);
  }
  useEffect(() => {
    if (!suggestion || suggestion.sessionId !== session.id || suggestion.id === lastSuggestion.current) return;
    lastSuggestion.current = suggestion.id;
    chooseAction(suggestion.text);
  }, [suggestion, session.id]);
  useEffect(() => {
    if (
      pending.current &&
      session.turns.some(
        (turn) => turn.requestId === pending.current?.requestId,
      )
    ) {
      pending.current = null;
      setUncertain(false);
      setError("");
      if (!recovering.current) setAction("");
      setParallelRecovery(undefined);
      setProseReview(undefined);
      setCarrierTarget(undefined);
      recovering.current = false;
    }
  }, [session.turns]);
  async function submit(retry = false) {
    if (submitFlight.current || submitting || busy || !retry && uncertain) return;
    if (!retry) {
      recovering.current = false;
      try { pending.current = readerTurnRequest({ requestId: crypto.randomUUID(), revision: session.revision, mode, action, narration, perspective, parallelRunId: selectedRecovery?.runId, proseReview: selectedReview?.target, viewCarrier: selectedCarrier }); }
      catch (error) { setError(errorText(error)); return; }
    }
    const payload = pending.current;
    if (!payload) return;
    if ((payload.parallelRecovery || payload.proseReview || payload.viewCarrier) && perspective !== 'author') return;
    submitFlight.current = true;
    setSubmitting(true);
    setError("");
    let acknowledged = false;
    try {
      await api.turn(session.id, payload);
      acknowledged = true;
      pending.current = null;
      setUncertain(false);
      if (!recovering.current) setAction("");
      setParallelRecovery(undefined);
      setProseReview(undefined);
      setCarrierTarget(undefined);
      recovering.current = false;
      await refresh();
    } catch (e) {
      if (acknowledged) {
        setError(`请求已接收，状态尚未同步：${errorText(e)}`);
        return;
      }
      setError(errorText(e));
      const ambiguous = !(e instanceof ApiError) || e.status >= 500;
      setUncertain(ambiguous);
      if (!ambiguous) pending.current = null;
      try {
        await refresh();
      } catch {
        /* Preserve the exact request for safe retry after an ambiguous response. */
      }
    } finally {
      submitFlight.current = false;
      setSubmitting(false);
    }
  }
  async function recoverProse() {
    if (submitFlight.current || submitting || busy || uncertain || !status?.configured) return;
    recovering.current = true;
    setParallelRecovery(undefined);
    setProseReview(undefined);
    setCarrierTarget(undefined);
    pending.current = {
      requestId: crypto.randomUUID(),
      expectedRevision: session.revision,
      mode: "author",
      action:
        "依据当前已提交的事实补写正文；保留玩家控制权，不增加新的世界行动。",
      narration,
    };
    await submit(true);
  }
  return (
    <main className="reader" aria-label="阅读与创作">
      <div className="reading-head">
        <span className="eyebrow">PROSE · 成文正文</span>
        <div className="actions">
          {perspective === 'author' && <button type="button" onClick={() => { setVisualEditor(undefined); setCarrierOpen(false); setReviewOpen(true); }}>成文审阅</button>}
          {perspective === 'author' && <button type="button" onClick={() => { setVisualEditor(undefined); setReviewOpen(false); setCarrierOpen(true); }}>查看载体</button>}
          {perspective === 'author' && <button type="button" onClick={() => openVisualEditor()}>对白头像</button>}
          <select
            aria-label="阅读内容与角色投影"
            value={perspective}
            onChange={(e) => reading.changePerspective(e.target.value)}
          >
            <option value="author">作者 · 完整正文</option>
            {session.roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name} · 已有认知
              </option>
            ))}
          </select>
          <button
            onClick={() => setSettingsOpen(!settingsOpen)}
            aria-expanded={settingsOpen}
          >
            <SlidersHorizontal size={13} />
            成文设置
          </button>
        </div>
      </div>
      {reviewOpen && perspective === 'author' && <ProseReviewDialog sessionId={session.id} revision={session.revision} updatedAt={session.updatedAt} author disabled={submitting || busy || uncertain || !status?.configured} close={() => setReviewOpen(false)} prepareReview={prepareReview} refresh={refresh}/>}
      {carrierOpen && perspective === 'author' && <TextCarrierPicker sessionId={session.id} revision={session.revision} updatedAt={session.updatedAt} author disabled={submitting || busy || uncertain || !status?.configured} close={() => setCarrierOpen(false)} prepare={prepareCarrier} refresh={refresh}/>}
      {visualEditor?.sessionId === session.id && perspective === 'author' && <VisualAssetsDialog session={session} readOnly={false} refresh={refresh} roleId={visualEditor.roleId} close={() => setVisualEditor(undefined)}/>}
      {settingsOpen && (
        <section className="narration-settings" aria-label="下一轮成文设置">
          <p className="eyebrow">用于下一次提交 · 不重写现有正文</p>
          <div className="setting-grid">
            <label>
              人称
              <select
                value={narration.person}
                onChange={(e) =>
                  setNarration({
                    ...narration,
                    person: e.target.value as NarrationSettings["person"],
                  })
                }
              >
                <option value="auto">由成文 Agent 决定</option>
                <option value="first">第一人称</option>
                <option value="third">第三人称</option>
              </select>
            </label>
            <label>
              叙述范围
              <select
                value={narration.pov}
                onChange={(e) =>
                  setNarration({
                    ...narration,
                    pov: e.target.value as NarrationSettings["pov"],
                  })
                }
              >
                <option value="auto">由成文 Agent 决定</option>
                <option value="limited">有限视角</option>
                <option value="omniscient">全知叙述</option>
              </select>
            </label>
            <label>
              焦点角色
              <select
                value={narration.focalRoleId ?? ""}
                onChange={(e) =>
                  setNarration({
                    ...narration,
                    focalRoleId: e.target.value || undefined,
                  })
                }
              >
                <option value="">由成文 Agent 决定</option>
                {session.roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="fine">
            叙述策略、玩家控制对象、侧栏查看角色与读取权限分别设置。
          </p>
        </section>
      )}
      {perspective === "author" ? (
        <>
          <div className="prose-meta">
            成文 Agent · 世界版本 {session.revision}
          </div>
          <article className="prose" aria-label="故事正文">
            <ProseEntries entries={session.prose} chooseAction={submitting || busy || uncertain ? undefined : chooseAction} onParallelRecovery={submitting || busy || uncertain ? undefined : prepareParallelRecovery} onEditVisual={openVisualEditor} />
            <PendingHostOutputs events={session.events} prose={session.prose} />
            {session.prose.length === 0 && (
              <p className="empty-note">此故事还没有已完成正文。</p>
            )}
            <div className="end-mark" aria-hidden="true">
              · · ·
            </div>
          </article>
        </>
      ) : (
        <section className="knowledge-view">
          <p className="notice">
            正在读取后端提供的角色投影。正文与侧栏使用同一视角的获准素材，不调用模型重新成文；侧栏为只读。
          </p>
          {projectionError && (
            <div role="alert"><p className="error">{projectionError}</p><button type="button" onClick={reading.retry}>重试读取角色投影</button></div>
          )}
          {!projection && !projectionError && <p className="muted">读取中…</p>}
          {projection && (
            <>
              <h2>
                {projection.roles.find((role) => role.id === perspective)
                  ?.name ?? "角色"}
                的已有认知
              </h2>
              {projection.roles
                .find((role) => role.id === perspective)
                ?.knowledge.map((item) => (
                  <p key={item.id}>
                    {item.text}
                    <small className="fine block">
                      {item.status === "uncertain" ? "尚不确定" : "已知"}
                    </small>
                  </p>
                ))}
              <details>
                <summary>可读取事件 · {projection.events.length}</summary>
                {projection.events.map((event) => (
                  <p key={event.id}>
                    {event.actor} · {event.text}
                  </p>
                ))}
              </details>
              <PendingHostOutputs events={projection.events} prose={projection.prose} />
              {projection.prose.length > 0 && (
                <article className="prose" aria-label="角色获准正文与附加输出">
                  <ProseEntries entries={projection.prose} />
                </article>
              )}
            </>
          )}
        </section>
      )}
      <section className="composer" aria-label="行动输入">
        <div className="input-modes" role="group" aria-label="输入方式">
          {(["action", "dialogue", "author"] as const).map((value) => (
            <button
              key={value}
              aria-pressed={mode === value}
              disabled={submitting || uncertain}
              onClick={() => { setMode(value); if (value !== 'action') { if (selectedCarrier) setAction(current => current === viewCarrierAction(selectedCarrier) ? '' : current); setCarrierTarget(undefined); } if (value !== 'author') { setParallelRecovery(undefined); if (selectedReview) setAction(current => current === DEFAULT_PROSE_REVIEW_FOCUS ? '' : current); setProseReview(undefined); } }}
            >
              {{ action: "行动", dialogue: "对白", author: "作者指示" }[value]}
            </button>
          ))}
        </div>
        {selectedRecovery && <div className="notice"><p>仅恢复场外场景：{selectedRecovery.title} · 记录 {selectedRecovery.runId}。提交后只按原材料成文，不推进角色、世界或主场正文。</p><button type="button" disabled={submitting || uncertain} onClick={() => setParallelRecovery(undefined)}>取消场景恢复选择</button></div>}
        {selectedReview && <div className="notice"><p>仅审阅已保存稿件：{selectedReview.title} · {selectedReview.target.kind === 'main' ? `主稿 ${selectedReview.target.entryId}` : `场外记录 ${selectedReview.target.runId} · 成文尝试 ${selectedReview.target.renderAttemptId}`}。本次提交只做审阅，不成文、不推进世界。</p><button type="button" disabled={submitting || uncertain} onClick={() => { setProseReview(undefined); setAction(current => current === DEFAULT_PROSE_REVIEW_FOCUS ? '' : current); }}>取消审阅选择</button></div>}
        {selectedCarrier && <div className="notice"><p>准备查看：{selectedCarrier.title} · 版本 {selectedCarrier.version} · {selectedCarrier.location}。尚未执行查看；提交后由世界裁定。</p><button type="button" disabled={submitting || uncertain} onClick={() => { setCarrierTarget(undefined); setAction(current => current === viewCarrierAction(selectedCarrier) ? '' : current); }}>取消载体目标</button></div>}
        <textarea
          aria-label="下一步内容"
          value={action}
          disabled={submitting || uncertain}
          onChange={(e) => setAction(e.target.value)}
          placeholder={
            selectedReview
              ? '填写本次审阅重点，不改写原稿…'
              : mode === "author"
              ? "给下一段叙事的指示…"
              : mode === "dialogue"
                ? "说出你想说的话…"
                : "你准备如何行动？"
          }
          rows={3}
        />
        <div className="composer-footer">
          <span className="fine">
            {selectedReview ? '以作者身份请求成文审阅' : mode === "author"
              ? "以作者身份指导叙事"
              : `玩家控制：${player?.name ?? session.playerRoleId}`}
          </span>
          <button
            className="primary"
            disabled={
              !action.trim() ||
              submitting ||
              busy ||
              uncertain ||
              !status?.configured
            }
            onClick={() => void submit()}
          >
            {submitting ? "提交中…" : busy ? "等待当前回合" : selectedReview ? '提交成文审阅' : selectedRecovery ? '提交场景恢复' : selectedCarrier ? '提交查看行动' : "继续故事"}
            <ArrowUpRight size={15} />
          </button>
        </div>
        {!status?.configured && (
          <p className="notice">
            模型 API 尚未配置。配置后才可生成正文；角色卡中已有的文字仍可阅读。
          </p>
        )}
        {lastTurn && (
          <div
            className={`turn-status ${["failed", "interrupted"].includes(lastTurn.status) ? "error" : ""}`}
            role="status"
          >
            <span>
              {statusNames[lastTurn.status]} · {lastTurn.phase}
            </span>
            {busy && (
              <button
                className="text-button"
                disabled={submitting}
                onClick={async () => {
                  setSubmitting(true);
                  try {
                    await api.cancel(session.id);
                    await refresh();
                  } catch (e) {
                    setError(errorText(e));
                  } finally {
                    setSubmitting(false);
                  }
                }}
              >
                中断本回合
              </button>
            )}
            {lastTurn.error && <p>{lastTurn.error}</p>}
          </div>
        )}
        {recoveryAvailable && (
          <div className="notice">
            <p>
              最近已提交的世界事实尚无对应正文。可显式请求成文者补写，所有失败记录会保留。
            </p>
            <button
              disabled={submitting || busy || uncertain || !status?.configured}
              onClick={() => void recoverProse()}
            >
              按已提交事实重新成文
            </button>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {uncertain && (
          <div className="notice">
            <p>
              本次提交的回执未确认。重试将复用同一请求 ID
              与世界版本，避免重复投递。
            </p>
            <button
              disabled={submitting || busy || !!(pending.current?.parallelRecovery || pending.current?.proseReview || pending.current?.viewCarrier) && perspective !== 'author'}
              onClick={() => void submit(true)}
            >
              重试同一请求
            </button>
          </div>
        )}
      </section>
      <details className="turn-history">
        <summary>行动与回合记录 · {visibleTurns.length}</summary>
        {[...visibleTurns].reverse().map((turn) => (
          <div key={turn.id}>
            <p>{turn.action}</p>
            <span className="fine">
              {statusNames[turn.status]} · {turn.phase} · {turn.startedAt}
            </span>
            {turn.error && <p className="error">{turn.error}</p>}
          </div>
        ))}
      </details>
    </main>
  );
}
