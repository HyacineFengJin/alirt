import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversionReport } from "../../server/compatibility";
import { ConversionReview } from "./ConversionReview";

describe("conversion review", () => {
  it("distinguishes exact retention, native binding and unsupported source without printing prompt content", () => {
    const report: ConversionReport = {
      schema: "rp.import-conversion-report/0.1",
      conversion: { schema: "rp.import-conversion/0.1", id: "conversion", creatorSessionId: "creator", importId: "source", kind: "card", createdAt: "now", sourceHash: "hash" },
      revision: 3,
      preservation: { exactSourceArchive: true, allSourceStringsRetained: true, sourceStrings: 3, originalPrompts: 2, retainedOriginalPrompts: 2, nativePromptCopiesIntact: false },
      coverage: [{ pointer: "/description", textHash: "hash", characters: 20, retainedExact: true, sourceDisposition: "native", nativeBindings: [{ path: "/modules/0/content", sourceLinked: true }], runtimeState: "bound" }, { pointer: "/isolated", textHash: "hash2", characters: 10, retainedExact: true, sourceDisposition: "isolated", nativeBindings: [], runtimeState: "retained-only" }],
      plan: [{ content: "SENSITIVE SOURCE PROMPT" }],
      unsupported: [{ pointer: "/script", kind: "javascript", reason: "Adapter required" }],
      diagnostics: [{ code: "native-prompt-loss", severity: "error", pointer: "/modules/1/content", message: "Restore the exact prompt" }],
      nativeIssues: [], readyForReview: false, runtimeEquivalence: "not-established", limitations: [],
    };
    const html = renderToStaticMarkup(createElement(ConversionReview, { report }));
    expect(html).toContain("需要修正");
    expect(html).toContain("已有原生绑定");
    expect(html).toContain("仅保留来源");
    expect(html).toContain("/modules/0/content");
    expect(html).toContain("Adapter required");
    expect(html).not.toContain("SENSITIVE SOURCE PROMPT");
  });
});
