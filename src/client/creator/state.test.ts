import { describe, expect, it } from "vitest";
import type {
  CreatorSession,
  NativeDocument,
  SubmitCreatorRun,
} from "../../shared/creator";
import {
  acceptsSnapshot,
  chooseCreatorSession,
  creatorBusy,
  creatorRunPayload,
  documentChanges,
  parseDraft,
  runAcknowledged,
} from "./state";
const preset: NativeDocument = {
  schema: "rp.preset/0.1",
  id: "writing",
  title: "留白",
  description: "原文说明",
  modules: [
    {
      id: "voice",
      title: "文风",
      category: "style",
      content: "完整的第一行\n完整的第二行",
      enabled: true,
      targets: ["prose"],
      phase: "compose",
      priority: 10,
    },
  ],
  narration: { person: "auto", pov: "auto" },
};
function session(
  id: string,
  revision: number,
  updatedAt: string,
): CreatorSession {
  return {
    id,
    revision,
    updatedAt,
    createdAt: "2026-10-25T01:00:00Z",
    title: id,
    kind: "preset",
    document: preset,
    messages: [],
    runs: [],
    revisions: [],
    issues: [],
    published: [],
  };
}
describe("persistent creator request and session state", () => {
  it("replays the full pending payload after a response is lost, regardless of later typing or revision", () => {
    const pending: SubmitCreatorRun = Object.freeze({
      requestId: "same-request",
      expectedRevision: 4,
      instruction: "保留原角色，仅修改文风",
    });
    const replay = creatorRunPayload(
      "新写的其他要求",
      9,
      "new-request",
      pending,
    );
    expect(replay).toEqual(pending);
    expect(replay).not.toBe(pending);
    expect(creatorRunPayload("  新建角色卡  ", 2, "first")).toEqual({
      requestId: "first",
      expectedRevision: 2,
      instruction: "新建角色卡",
    });
  });
  it("acknowledges only the same request and keeps queued/running work distinct from terminal failures", () => {
    const item = session("draft", 4, "2026-10-25T02:00:00Z");
    item.runs = [
      {
        id: "run",
        requestId: "accepted",
        instruction: "编辑",
        status: "failed",
        phase: "validate",
        startedAt: item.updatedAt,
      },
    ];
    expect(
      runAcknowledged(item, {
        requestId: "accepted",
        expectedRevision: 3,
        instruction: "编辑",
      }),
    ).toBe(true);
    expect(
      runAcknowledged(item, {
        requestId: "different",
        expectedRevision: 3,
        instruction: "编辑",
      }),
    ).toBe(false);
    expect(creatorBusy(item)).toBe(false);
    item.runs[0].status = "running";
    expect(creatorBusy(item)).toBe(true);
  });
  it("rejects stale polling snapshots and resumes the explicit saved session without removing failures", () => {
    const older = session("older", 2, "2026-10-25T02:00:00Z"),
      newer = session("newer", 5, "2026-10-25T03:00:00Z");
    expect(chooseCreatorSession([older, newer], null)?.id).toBe("newer");
    expect(chooseCreatorSession([older, newer], "older")?.id).toBe("older");
    expect(
      acceptsSnapshot(newer, {
        ...newer,
        revision: 4,
        updatedAt: "2026-10-25T04:00:00Z",
      }),
    ).toBe(false);
    expect(
      acceptsSnapshot(newer, { ...newer, updatedAt: "2026-10-25T02:00:00Z" }),
    ).toBe(false);
    expect(acceptsSnapshot(newer, { ...newer, revision: 6 })).toBe(true);
  });
});
describe("full-content native revision review", () => {
  it("aligns modules by ID so inserting a module does not pretend existing prompt text changed", () => {
    const after = structuredClone(preset);
    after.modules.unshift({
      ...after.modules[0],
      id: "constraint",
      title: "约束",
      category: "constraint",
      content: "不得替玩家决定行动",
    });
    const changes = documentChanges(preset, after);
    expect(changes.map((change) => change.path)).toContain(
      "/modules[constraint]",
    );
    expect(changes.map((change) => change.path)).not.toContain(
      "/modules[voice]/content",
    );
    expect(
      changes.find((change) => change.path === "/modules[constraint]")?.after,
    ).toContain("不得替玩家决定行动");
  });
  it("retains complete before/after prompt text and unknown metadata in comparisons", () => {
    const before = {
      ...structuredClone(preset),
      extension: { source: "原始自定义字段" },
    };
    const after = {
      ...structuredClone(preset),
      extension: { source: "手动修改的自定义字段" },
    };
    after.modules[0].content = "完整的新第一行\n完整的新第二行";
    const changes = documentChanges(before, after);
    expect(
      changes.find((change) => change.path === "/modules[voice]/content"),
    ).toEqual({
      path: "/modules[voice]/content",
      before: preset.modules[0].content,
      after: after.modules[0].content,
    });
    expect(
      changes.find((change) => change.path === "/extension/source")?.before,
    ).toBe("原始自定义字段");
  });
  it("parses JSON without dropping unknown properties and refuses cross-kind replacement", () => {
    const raw = JSON.stringify({
      ...preset,
      extension: { keep: ["一", "二"] },
    });
    expect(parseDraft(raw, "preset")).toHaveProperty("extension.keep", [
      "一",
      "二",
    ]);
    expect(() => parseDraft(raw, "card")).toThrow("rp.card/0.1");
    expect(() => parseDraft("broken json", "preset")).toThrow();
  });
});
