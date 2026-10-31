import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AuxiliaryOutput, ProseEntry } from "../shared/types";
import { latestSidePanelOutputs, SidePanelOutputs, outputText } from "./AuxiliaryOutputs";
import { ProseEntries } from "./ProseEntries";
import { registerBuiltins, registry } from "./plugins/builtin";

function output(key: string, placement: AuxiliaryOutput["placement"] = "after-prose"): AuxiliaryOutput {
  return { key, title: key, type: "text", value: `${key}内容`, audience: "public", placement };
}
function entry(id: string, attachments: AuxiliaryOutput[]): ProseEntry {
  return { id, title: `段落${id}`, text: `正文${id}`, turnId: `turn-${id}`, worldRevision: Number(id), attachments };
}
describe("backend-projected auxiliary outputs", () => {
  it("keeps after-prose outputs with their prose entry and excludes other placements", () => {
    const html = renderToStaticMarkup(createElement(ProseEntries, { entries: [
      entry("1", [output("摘要"), output("侧栏", "side-panel"), output("隐藏", "hidden")]),
      entry("2", [output("下一段")]),
    ] }));
    expect(html).toContain('aria-label="本段附加输出"');
    expect(html.indexOf("正文1")).toBeLessThan(html.indexOf("摘要内容"));
    expect(html.indexOf("摘要内容")).toBeLessThan(html.indexOf("正文2"));
    expect(html).not.toContain("侧栏内容");
    expect(html).not.toContain("隐藏内容");
  });

  it("renders text, lists and objects through escaped React content", () => {
    const dangerous = '<script>alert("unsafe")</script>';
    const html = renderToStaticMarkup(createElement(ProseEntries, { entries: [entry("1", [
      { ...output("文本"), value: dangerous },
      { ...output("列表"), type: "list", value: [dangerous, { count: 2 }] },
      { ...output("对象"), type: "object", value: { content: dangerous } },
    ])] }));
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("<ul><li>");
    expect(html).toContain('<pre class="source-text">');
    expect(html).toContain("&quot;count&quot;: 2");
    expect(html).toContain("&quot;content&quot;");
  });

  it("shows the latest value per key with its source and does not revive outputs moved elsewhere", () => {
    const entries = [
      entry("1", [output("旧状态", "side-panel"), output("保持", "side-panel"), output("转正文", "side-panel"), output("转隐藏", "side-panel")]),
      entry("2", [{ ...output("旧状态", "side-panel"), value: "新状态" }, output("转正文"), output("转隐藏", "hidden")]),
    ];
    expect(latestSidePanelOutputs(entries).map(({ output, entry }) => [output.key, entry.id])).toEqual([["旧状态", "2"], ["保持", "1"]]);
    const html = renderToStaticMarkup(createElement(SidePanelOutputs, { prose: entries }));
    expect(html).toContain("新状态");
    expect(html).toContain("回合 turn-2 · 世界版本 2");
    expect(html).toContain("回合 turn-1 · 世界版本 1");
    expect(html).not.toContain("旧状态内容");
    expect(html).not.toContain("转正文");
    expect(html).not.toContain("转隐藏");
  });

  it("handles legacy prose, empty list values and empty side panels", () => {
    const legacy = entry("1", []);
    delete legacy.attachments;
    const html = renderToStaticMarkup(createElement(ProseEntries, { entries: [legacy, entry("2", [{ ...output("空列表"), type: "list", value: [] }])] }));
    expect(html).toContain("正文1");
    expect(html).toContain("暂无条目。");
    expect(renderToStaticMarkup(createElement(SidePanelOutputs, { prose: [legacy] }))).toContain("尚无可显示的侧栏输出。");
  });

  it("registers outputs as a host builtin with normal plugin cleanup", () => {
    const dispose = registerBuiltins();
    try {
      expect(registry.find("outputs")?.id).toBe("host.outputs");
    } finally {
      dispose();
    }
    expect(registry.find("outputs")).toBeUndefined();
  });

  it('keeps before-prose timing and explicit native history limits without reviving older side outputs', () => {
    const entries = [entry('1', [{ ...output('expired', 'side-panel'), display: { placement: 'side-panel', history: { maxEntriesAgo: 0 } } }]),
      entry('2', [{ ...output('time', 'before-prose'), display: { placement: 'before-prose', renderer: 'plain' } },
        { ...output('summary'), display: { placement: 'after-prose', renderer: 'folded' } }])];
    const html = renderToStaticMarkup(createElement(ProseEntries, { entries }));
    expect(html.indexOf('time内容')).toBeLessThan(html.indexOf('正文2'));
    expect(html).toContain('<summary>summary</summary>');
    expect(latestSidePanelOutputs(entries)).toEqual([]);
    // Source chat depth is provenance, not native entry distance.
    const sourceOnly = { ...output('source-depth'), display: { placement: 'after-prose' as const, source: { importId: 'test', pointer: '/source', maxDepth: 0 } } };
    expect(renderToStaticMarkup(createElement(ProseEntries, { entries: [entry('1', [sourceOnly]), entry('2', [])] }))).toContain('source-depth内容');
  });

  it('renders choices as explicit draft controls and generated HTML in a disabled sandbox', () => {
    const entries = [entry('1', [
      { ...output('options'), type: 'list', value: ['先问候', '留在原地'], display: { placement: 'after-prose', renderer: 'choices' } },
      { ...output('letter'), value: '<style>p{color:blue}</style><p>一封信</p><script>unsafe()</script><a href="https://example.com">link</a><button onclick="unsafe()">submit</button>', display: { placement: 'after-prose', renderer: 'sandbox-html' } },
    ])];
    const html = renderToStaticMarkup(createElement(ProseEntries, { entries, chooseAction: () => { throw new Error('Rendering must never submit or insert an action'); } }));
    expect(html).toContain('选择后填入行动框'); expect(html).toContain('type="button"');
    expect(html).toContain('sandbox=""'); expect(html).toContain('script-src'); expect(html).toContain('disabled');
    expect(html).not.toContain('unsafe()'); expect(html).not.toContain('https://example.com');
    expect(html).toContain('一封信');
  });


});
