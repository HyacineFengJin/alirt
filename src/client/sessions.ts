import type { SessionSnapshot, TurnRecord } from "../shared/types";

const statusLabels: Record<TurnRecord["status"], string> = {
  queued: "等待调度",
  running: "生成中",
  committed: "等待成文",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
};
function timestamp(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
export function recentSessions(sessions: SessionSnapshot[]) {
  return [...sessions].sort(
    (a, b) =>
      timestamp(b.updatedAt) - timestamp(a.updatedAt) ||
      timestamp(b.createdAt) - timestamp(a.createdAt) ||
      a.id.localeCompare(b.id),
  );
}
export function initialSession(
  sessions: SessionSnapshot[],
  savedId: string | null,
) {
  return (
    sessions.find((session) => session.id === savedId) ??
    recentSessions(sessions)[0]
  );
}
export function sessionLabel(session: SessionSnapshot) {
  const date = new Date(session.updatedAt);
  const updated = Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date)
    : "时间未知";
  const turn = session.turns.at(-1);
  const state = turn ? statusLabels[turn.status] : "开篇";
  return `${session.title} · ${updated} · ${state} · ${session.id.slice(0, 6)}`;
}
