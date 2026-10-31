import { describe, expect, it } from "vitest";
import { restoreLayout } from "./layout";
import { parseStateValue } from "./plugins/builtin";
import type { PanelDefinition, StateField } from "../shared/types";
const panels: PanelDefinition[] = [
  { id: "card.roster", title: "人物", kind: "roles", side: "left" },
  { id: "card.tide", title: "潮汐", kind: "scene", side: "right" },
];
describe("persistent per-session panel placement", () => {
  it("retains closed panels and missing plugin placements, while assigning new panels their card defaults", () => {
    const result = restoreLayout(
      panels,
      JSON.stringify({
        "card.roster": { side: "right", open: false },
        "missing.panel": { side: "left", open: true },
      }),
    );
    expect(result["card.roster"]).toEqual({ side: "right", open: false });
    expect(result["missing.panel"]).toEqual({ side: "left", open: true });
    expect(result["card.tide"]).toEqual({ side: "right", open: true });
    expect(panels[0].side).toBe("left");
  });
  it("handles broken storage and rejects malformed placement fields", () => {
    expect(restoreLayout(panels, "not-json")["card.roster"]).toEqual({
      side: "left",
      open: true,
    });
    expect(
      restoreLayout(panels, '{"card.roster":{"side":"bottom","open":"yes"}}')[
        "card.roster"
      ],
    ).toEqual({ side: "left", open: true });
  });
  it("opens a runtime-contributed outputs panel without resetting saved choices", () => {
    const saved = restoreLayout(
      panels,
      JSON.stringify({ "card.roster": { side: "right", open: false } }),
    );
    const withOutputs: PanelDefinition[] = [
      ...panels,
      { id: "host.outputs", title: "附加输出", kind: "outputs", side: "right" },
    ];
    const refreshed = restoreLayout(withOutputs, JSON.stringify(saved));
    expect(refreshed["host.outputs"]).toEqual({ side: "right", open: true });
    expect(refreshed["card.roster"]).toEqual({ side: "right", open: false });
    // Once explicitly closed or moved, later snapshot refreshes honor the choice.
    refreshed["host.outputs"] = { side: "left", open: false };
    expect(restoreLayout(withOutputs, JSON.stringify(refreshed))["host.outputs"])
      .toEqual({ side: "left", open: false });
  });
});
describe("author state edits", () => {
  const field: StateField = {
    key: "energy",
    label: "精力",
    type: "number",
    min: 0,
    max: 100,
    audience: "public",
    editable: true,
  };
  it("validates declared numeric bounds before submitting", () => {
    expect(parseStateValue(field, "50")).toBe(50);
    for (const invalid of ["", "NaN", "101", "-1"])
      expect(() => parseStateValue(field, invalid)).toThrow();
  });
  it("preserves lists as structured JSON rather than splitting comma-delimited text", () => {
    const { min: _min, max: _max, ...unbounded } = field;
    const list = { ...unbounded, type: "list" as const };
    expect(parseStateValue(list, '["a,b", {"count":2}]')).toEqual([
      "a,b",
      { count: 2 },
    ]);
    expect(() => parseStateValue(list, '"not an array"')).toThrow();
  });
});
