import type { SessionSnapshot } from "../shared/types";

/** A failed author-only attempt does not remove an earlier world's need for prose. */
export function needsProseRecovery(
  session: Pick<SessionSnapshot, "events" | "turns" | "prose">,
): boolean {
  const committedIndex = session.events.findLastIndex(
    (event) =>
      !!event.turnId &&
      (event.kind === "world-adjudication" || event.kind === "world-event"),
  );
  if (committedIndex < 0) return false;
  const committed = session.events[committedIndex];
  const worldTurnIndex = session.turns.findIndex(
    (turn) => turn.id === committed.turnId,
  );
  const covered = session.prose.some((entry) => {
    if (!entry.turnId || !entry.text.trim()) return false;
    const proseTurnIndex = session.turns.findIndex(
      (turn) => turn.id === entry.turnId,
    );
    const proseTurn = session.turns[proseTurnIndex];
    if (proseTurn?.parallelRecovery) return false;
    if (proseTurn && proseTurn.status !== "completed") return false;
    if (entry.turnId === committed.turnId) return true;
    if (
      session.events.some(
        (event, index) =>
          index > committedIndex &&
          event.kind === "prose-completed" &&
          event.turnId === entry.turnId,
      )
    )
      return true;
    // Persisted prose is also sufficient when a legacy snapshot lacks its completion event.
    return (
      worldTurnIndex >= 0 &&
      proseTurnIndex > worldTurnIndex &&
      proseTurn?.mode === "author" &&
      proseTurn.status === "completed"
    );
  });
  return !covered;
}
