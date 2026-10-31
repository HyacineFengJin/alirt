import { describe, expect, it } from "vitest";
import type { SessionSnapshot } from "../shared/types";
import { initialSession, recentSessions, sessionLabel } from "./sessions";
function session(
  id: string,
  updatedAt: string,
  status?: "completed" | "failed",
): SessionSnapshot {
  return {
    id,
    title: "同名故事",
    updatedAt,
    createdAt: "2026-10-23T12:00:00Z",
    turns: status ? [{ status }] : [],
  } as unknown as SessionSnapshot;
}
describe("existing story selection", () => {
  const older = session("older1", "2026-10-23T13:00:00Z", "failed");
  const newer = session("newer1", "2026-10-24T10:00:00Z", "completed");
  it("opens the most recently updated story in a fresh browser, including if it failed", () => {
    expect(initialSession([older, newer], null)?.id).toBe("newer1");
    expect(
      initialSession(
        [older, { ...newer, turns: [{ status: "failed" }] } as SessionSnapshot],
        null,
      )?.turns.at(-1)?.status,
    ).toBe("failed");
    expect(recentSessions([older, newer]).map((item) => item.id)).toEqual([
      "newer1",
      "older1",
    ]);
  });
  it("honors an explicit previous selection and falls back when that story no longer exists", () => {
    expect(initialSession([older, newer], older.id)?.id).toBe(older.id);
    expect(initialSession([older, newer], "removed")?.id).toBe(newer.id);
    expect(initialSession([], null)).toBeUndefined();
  });
  it("keeps failed stories and distinguishes repeated titles with date, status, and short ID", () => {
    expect(sessionLabel(older)).toContain("失败");
    expect(sessionLabel(newer)).toContain("已完成");
    expect(sessionLabel(older)).toContain("older1");
    expect(sessionLabel(newer)).toContain("newer1");
    expect(sessionLabel(older)).not.toBe(sessionLabel(newer));
  });
});
