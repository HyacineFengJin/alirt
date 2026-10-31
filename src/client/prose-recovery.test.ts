import { describe, expect, it } from "vitest";
import type { SessionSnapshot, TurnRecord, WorldEvent } from "../shared/types";
import { needsProseRecovery } from "./prose-recovery";
function turn(
  id: string,
  mode: "action" | "author",
  status: TurnRecord["status"],
): TurnRecord {
  return {
    id,
    mode,
    status,
    requestId: id,
    action: "已有请求",
    phase: status,
    startedAt: "2026-10-25T00:00:00Z",
  };
}
function event(kind: string, turnId: string): WorldEvent {
  return {
    id: `${kind}:${turnId}`,
    kind,
    turnId,
    actor: "host",
    text: "已保存事实",
    at: "2026-10-25T00:00:00Z",
    audience: "public",
  };
}
function snapshot(): Pick<SessionSnapshot, "events" | "turns" | "prose"> {
  return {
    turns: [
      turn("world-one", "action", "failed"),
      turn("recovery-one", "author", "failed"),
    ],
    events: [
      event("world-adjudication", "world-one"),
      event("turn-failed", "world-one"),
      event("turn-failed", "recovery-one"),
    ],
    prose: [
      { id: "opening", title: "开篇", text: "原始开篇", worldRevision: 0 },
    ],
  };
}
describe("explicit prose recovery availability", () => {
  it("remains available after a committed world turn and a later failed author attempt", () => {
    expect(needsProseRecovery(snapshot())).toBe(true);
  });
  it("ends when accepted recovery prose covers the facts and returns for a later uncovered world turn", () => {
    const state = snapshot();
    state.turns.push(turn("recovery-two", "author", "completed"));
    state.events.push(event("prose-completed", "recovery-two"));
    state.prose.push({
      id: "accepted",
      turnId: "recovery-two",
      title: "正文",
      text: "已接受的正文",
      worldRevision: 1,
    });
    expect(needsProseRecovery(state)).toBe(false);
    state.turns.push(turn("world-two", "action", "failed"));
    state.events.push(event("world-adjudication", "world-two"));
    expect(needsProseRecovery(state)).toBe(true);
  });
  it("does not offer world-fact recovery for an uncommitted failure or an already narrated world turn", () => {
    const state = snapshot();
    state.events = [event("turn-failed", "world-one")];
    expect(needsProseRecovery(state)).toBe(false);
    state.events = [event("world-adjudication", "world-one")];
    state.turns[0].status = "completed";
    state.prose.push({
      id: "done",
      turnId: "world-one",
      title: "正文",
      text: "已接受正文",
      worldRevision: 1,
    });
    expect(needsProseRecovery(state)).toBe(false);
  });
  it('does not let an independent scene recovery cover missing main prose', () => {
    const state = snapshot();
    state.turns.push({ ...turn('parallel-only', 'author', 'completed'), parallelRecovery: { runId: 'run-office' } });
    state.events.push(event('prose-completed', 'parallel-only'));
    state.prose.push({ id: 'parallel-empty-main', turnId: 'parallel-only', title: '', text: '旧客户端遗留文本', worldRevision: 1 });
    expect(needsProseRecovery(state)).toBe(true);
  });
});
