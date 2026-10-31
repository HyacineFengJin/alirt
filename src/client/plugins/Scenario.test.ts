import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api, ApiError, type ScenarioCommand, type ScenarioView } from "../api";
import type { PanelContext } from "./registry";
import { Scenario, ScenarioChapters } from "./Scenario";
import { registerBuiltins, registry } from "./builtin";

const view: ScenarioView = {
  revision: 7,
  definition: { schema: "rp.scenario/0.1", id: "story", title: "章节计划", chapters: [] },
  progress: { scenarioId: "story", currentChapterId: "one", completedChapterIds: [] },
  chapters: [
    { id: "one", title: "港口", prerequisites: [], bindingIds: ["scene-one"], status: "active", missingPrerequisites: [], canStart: false, canComplete: false, canAbandon: true, completionStatus: "unknown" },
    { id: "two", title: "秘密终局", prerequisites: ["one"], bindingIds: ["scene-two"], status: "locked", missingPrerequisites: ["one"], canStart: false, canComplete: false, canAbandon: false, completionStatus: "manual" },
  ],
};

afterEach(() => vi.unstubAllGlobals());
describe("author scenario panel", () => {
  it("registers through the trusted dock plugin lifecycle", () => {
    const dispose = registerBuiltins();
    try { expect(registry.find("scenario")?.render).toBe(Scenario); }
    finally { dispose(); }
    expect(registry.find("scenario")).toBeUndefined();
  });
  it("does not render the author consumer or chapter metadata in a role context", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const html = renderToStaticMarkup(createElement(Scenario, {
      session: { perspective: "reader" },
    } as PanelContext));
    expect(html).toContain("仅在作者视角");
    expect(html).not.toContain("秘密终局");
    expect(html).not.toContain("作者控制");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses server eligibility without inventing unlocks or treating unknown completion as true", () => {
    const html = renderToStaticMarkup(createElement(ScenarioChapters, { view, disabled: false, open: vi.fn() }));
    expect(html).toContain("进行中");
    expect(html).toContain("未解锁");
    expect(html).toContain("尚缺：港口");
    expect(html).toContain("关联资料 1 项");
    expect(html).not.toContain("scene-one");
    expect(html).toContain("完成条件暂无法判定");
    expect(html).toContain('<button disabled="">确认完成</button>');
    expect(html).toContain('<button>退出章节</button>');
    expect(html).not.toContain(">开始章节</button>");
  });
  it("shows an explicit manual completion control and disables all commands during a turn", () => {
    const manual: ScenarioView = { ...view, chapters: [{ ...view.chapters[0], canComplete: true, completionStatus: "manual" }] };
    const ready = renderToStaticMarkup(createElement(ScenarioChapters, { view: manual, disabled: false, open: vi.fn() }));
    expect(ready).toContain("由作者确认完成");
    expect(ready).toContain('<button>确认完成</button>');
    const busy = renderToStaticMarkup(createElement(ScenarioChapters, { view: manual, disabled: true, open: vi.fn() }));
    expect(busy).toContain('<button disabled="">确认完成</button>');
    expect(busy).toContain('<button disabled="">退出章节</button>');
  });
  it("sends retry payloads unchanged and preserves server errors and validation issues", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: { message: "提交结果暂未确认", issues: [{ path: "requestId", message: "请重试原请求" }] } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...view, duplicate: true, appliedRevision: 7 }) });
    vi.stubGlobal("fetch", fetch);
    const command: ScenarioCommand = { requestId: "same-request", expectedRevision: 6, reason: "已核对章节依据", operation: "complete", chapterId: "one" };
    await expect(api.scenarioCommand("session/one", command)).rejects.toMatchObject({ message: "提交结果暂未确认", status: 503, issues: [{ path: "requestId", message: "请重试原请求" }] } satisfies Partial<ApiError>);
    await expect(api.scenarioCommand("session/one", command)).resolves.toMatchObject({ duplicate: true, appliedRevision: 7 });
    expect(fetch.mock.calls[0][0]).toBe("/api/sessions/session%2Fone/scenario/commands");
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(command);
  });
});
