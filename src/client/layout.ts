import type { PanelDefinition } from "../shared/types";
export interface PanelPlacement {
  side: "left" | "right";
  open: boolean;
}
export type Layout = Record<string, PanelPlacement>;
export function restoreLayout(
  panels: PanelDefinition[],
  raw: string | null,
): Layout {
  let stored: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      stored = parsed;
  } catch {
    /* Invalid browser storage falls back to the card's defaults. */
  }
  const result: Layout = {};
  for (const [id, value] of Object.entries(stored)) {
    if (
      value &&
      typeof value === "object" &&
      "side" in value &&
      (value.side === "left" || value.side === "right") &&
      "open" in value &&
      typeof value.open === "boolean"
    )
      result[id] = { side: value.side, open: value.open };
  }
  for (const panel of panels)
    result[panel.id] ??= { side: panel.side, open: true };
  return result;
}
export function storageRead(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function storageWrite(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Layout remains usable without persistent storage. */
  }
}
