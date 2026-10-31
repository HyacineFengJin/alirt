import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProvenancedKnowledge } from "../../shared/knowledge";
import { KnowledgeList, KnowledgeProvenanceDetails, KnowledgeRetractionScope } from "./AuthorKnowledge";
import { knowledgeDraft, knowledgePayload } from "./knowledge";

const item: ProvenancedKnowledge = {
  id: "secret",
  text: "The seal may be forged.",
  audience: ["reader", "keeper"],
  status: "uncertain",
  lifecycle: "stale",
  provenance: { sourceId: "source-private", sourceRefs: ["source-one"], kind: "derived" },
};
describe("author knowledge edits", () => {
  it("preserves certainty, audience, dependencies and the opened revision while editing text", () => {
    const draft = knowledgeDraft(item, 7);
    draft.text = "The seal may be forged, pending inspection.";
    draft.reason = "  Correct the description  ";
    const payload = knowledgePayload("reader", draft);
    expect(payload).toEqual({
      operation: "upsert", roleId: "reader", id: "secret", text: draft.text,
      expectedRevision: 7, reason: "Correct the description",
      audience: ["reader", "keeper"], status: "uncertain", sourceRefs: ["source-one"],
    });
    expect(payload).not.toHaveProperty("provenance");
    expect(payload).not.toHaveProperty("lifecycle");
    (draft.audience as string[]).push("other");
    draft.sourceRefs.push("source-two");
    expect(item.audience).toEqual(["reader", "keeper"]);
    expect(item.provenance?.sourceRefs).toEqual(["source-one"]);
    expect(payload.sourceRefs).toEqual(["source-one"]);
  });
  it("retracts only the selected identity with a reason and revision", () => {
    const draft = { ...knowledgeDraft(item, 9), operation: "retract" as const, reason: "Withdraw invalid source" };
    expect(knowledgePayload("reader", draft)).toEqual({ operation: "retract", roleId: "reader", id: "secret", expectedRevision: 9, reason: "Withdraw invalid source" });
  });
  it("marks inactive knowledge and certainty independently in the author list", () => {
    const html = renderToStaticMarkup(createElement(KnowledgeList, { items: [item, { ...item, id: "withdrawn", status: "known", lifecycle: "withdrawn" }] }));
    expect(html).toContain("尚不确定");
    expect(html).toContain("来源已失效");
    expect(html).toContain("已撤回");
  });
  it('distinguishes a known observation occurrence from an uncertain source-linked derived note', () => {
    const observed: ProvenancedKnowledge = { ...item, id: 'observed', status: 'known', lifecycle: 'active', provenance: { sourceId: 'observation-source', sourceRefs: [], kind: 'derived', observation: { eventId: 'world-event-1', sceneId: 'office' } } };
    const html = renderToStaticMarkup(createElement(KnowledgeList, { items: [observed, item] }));
    expect(html).toContain('已知 · 有效'); expect(html).toContain('尚不确定 · 来源已失效');
    expect(html).toContain('“已知”不代表事件中被说出的内容已经验证');
    const observation = renderToStaticMarkup(createElement(KnowledgeProvenanceDetails, { item: observed }));
    expect(observation).toContain('历史观察记忆 · 无已登记依赖'); expect(observation).toContain('world-event-1'); expect(observation).toContain('office');
    const derived = renderToStaticMarkup(createElement(KnowledgeProvenanceDetails, { item }));
    expect(derived).toContain('派生条目 · 有来源依赖'); expect(derived).toContain('依赖来源：source-one'); expect(derived).not.toContain('历史观察记忆');
    expect(observed.status).toBe('known'); expect(item.status).toBe('uncertain');
  });
  it('explains the different retraction scope without promising semantic erasure or archive deletion', () => {
    const observation = renderToStaticMarkup(createElement(KnowledgeRetractionScope, { item: { ...item, provenance: { ...item.provenance!, observation: { eventId: 'event', sceneId: 'scene' } } } }));
    expect(observation).toContain('不再作为本角色当前有效的观察记忆');
    expect(observation).toContain('原始世界事件与旧正文仍保留');
    expect(observation).toContain('新的真实观察仍可重新建立记忆');
    const derived = renderToStaticMarkup(createElement(KnowledgeRetractionScope, { item }));
    expect(derived).toContain('本条派生条目'); expect(derived).toContain('已登记依赖后代会标记为来源已失效'); expect(derived).toContain('历史仍保留');
    for (const html of [observation, derived]) expect(html).toContain('独立片段不会按文字或语义匹配自动抹除');
  });
});
