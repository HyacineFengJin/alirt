import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ImportDetail } from "../../shared/types";
import type { FrontendAsset } from "../api";
import { FrontendPreview } from "../FrontendPreview";
import {
  defaultAssetIndex,
  resolveSourceImportId,
  sourceEnabled,
  sourceImportCandidates,
} from "./ImportedSource";
const asset: FrontendAsset = {
  pointer: "/extensions/ui/0",
  kind: "html",
  executable: false,
  missingApis: ["getVariables"],
  remoteReferences: ["https://example.test/image.png"],
  previewHtml: "<style>body{color:green}</style><main>Original layout</main>",
  sourceText: "original full source",
  sourceAdmitted: true,
};
describe("docked imported frontend contribution", () => {
  it("chooses an admitted original preview before isolated or source-only assets", () => {
    expect(
      defaultAssetIndex([
        { ...asset, sourceAdmitted: false },
        { ...asset, previewHtml: undefined },
        asset,
      ]),
    ).toBe(2);
    expect(defaultAssetIndex([])).toBe(-1);
  });
  it("preserves source-disabled status independently from preview availability", () => {
    const detail = {
      modules: [{ pointer: asset.pointer, sourceEnabled: false }],
    } as ImportDetail;
    expect(sourceEnabled(asset, detail)).toBe(false);
    expect(sourceEnabled({ ...asset, sourceEnabled: true }, detail)).toBe(true);
    expect(sourceEnabled(asset)).toBeNull();
  });
  it("places admitted markup behind an empty iframe sandbox and strict no-script/no-network CSP", () => {
    const html = renderToStaticMarkup(
      createElement(FrontendPreview, { asset }),
    );
    expect(html).toContain('sandbox=""');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain("default-src &#x27;none&#x27;");
    expect(html).toContain("script-src &#x27;none&#x27;");
    expect(html).toContain("Original layout");
    expect(html).not.toContain("<main>Original layout</main>");
  });
  it("does not create an iframe for an isolated source even if it includes preview markup", () => {
    const html = renderToStaticMarkup(
      createElement(FrontendPreview, {
        asset: { ...asset, sourceAdmitted: false },
      }),
    );
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("Original layout");
  });
});

describe("published native fork source association", () => {
  const id = "generic-111111111111",
    existing = new Set([id, "generic-222222222222"]);
  it("retains an edited fork's original interface without restoring active source prompts", () => {
    const fork = {
      id: "created-card-new",
      sourceCompatibility: { importId: id },
      modules: [{ id: "voice", content: "edited native prompt wins" }],
    };
    expect(resolveSourceImportId(fork, { sourceImportId: id }, existing)).toBe(
      id,
    );
    expect(fork).not.toHaveProperty("compatibility");
    expect(fork.modules[0].content).toBe("edited native prompt wins");
    expect(resolveSourceImportId(fork, {}, existing)).toBe(id);
    expect(resolveSourceImportId({}, { sourceImportId: id }, existing)).toBe(
      id,
    );
  });
  it("handles retained metadata collisions and uses only existing well-formed import IDs", () => {
    const fork = {
      sourceCompatibility: { unrelated: true },
      sourceCompatibility_1: { importId: id },
    };
    expect(resolveSourceImportId(fork, {}, existing)).toBe(id);
    expect(
      resolveSourceImportId(
        { sourceCompatibility: { importId: "generic-aaaaaaaaaaaa" } },
        {},
        existing,
      ),
    ).toBeUndefined();
    expect(
      resolveSourceImportId({ compatibility: { importId: id } }, {}, existing),
    ).toBe(id);
  });
  it("ignores malformed, executable, path-like and non-string origin values", () => {
    for (const value of [
      null,
      false,
      123,
      [id],
      { importId: id },
      "../../secrets",
      "javascript:alert(1)",
      "GENERIC-111111111111",
      "generic-bad",
      `${id}/frontend`,
    ]) {
      expect(
        sourceImportCandidates(
          { sourceCompatibility: { importId: value } },
          { sourceImportId: value },
        ),
      ).toEqual([]);
    }
  });
});
