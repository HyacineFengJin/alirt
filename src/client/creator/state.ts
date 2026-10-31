import type {
  CreatorSession,
  NativeDocument,
  SubmitCreatorRun,
} from "../../shared/creator";
export const runLabels = {
  queued: "等待调度",
  running: "正在创作",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
};
export function creatorBusy(session?: CreatorSession) {
  return !!session?.runs.some(
    (run) => run.status === "queued" || run.status === "running",
  );
}
export function newestCreatorSessions(sessions: CreatorSession[]) {
  return [...sessions].sort(
    (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) ||
      b.createdAt.localeCompare(a.createdAt) ||
      a.id.localeCompare(b.id),
  );
}
export function chooseCreatorSession(
  sessions: CreatorSession[],
  saved: string | null,
) {
  return (
    sessions.find((session) => session.id === saved) ??
    newestCreatorSessions(sessions)[0]
  );
}
export function acceptsSnapshot(
  current: CreatorSession | undefined,
  incoming: CreatorSession,
) {
  return (
    !current ||
    current.id !== incoming.id ||
    incoming.revision > current.revision ||
    (incoming.revision === current.revision &&
      incoming.updatedAt >= current.updatedAt)
  );
}
/** An ambiguous HTTP response must replay this complete immutable payload, including its original revision. */
export function creatorRunPayload(
  instruction: string,
  revision: number,
  requestId: string,
  pending?: SubmitCreatorRun | null,
): SubmitCreatorRun {
  return pending
    ? { ...pending }
    : {
        requestId,
        expectedRevision: revision,
        instruction: instruction.trim(),
      };
}
export function runAcknowledged(
  session: CreatorSession,
  pending?: SubmitCreatorRun | null,
) {
  return (
    !!pending && session.runs.some((run) => run.requestId === pending.requestId)
  );
}
export interface DocumentChange {
  path: string;
  before?: string;
  after?: string;
}
function text(value: unknown) {
  return value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function keyed(
  values: unknown[],
): values is (Record<string, unknown> & { id: string })[] {
  return (
    values.every((value) => object(value) && typeof value.id === "string") &&
    new Set(values.map((value) => (value as { id: string }).id)).size ===
      values.length
  );
}
/** Align modules and roles by stable ID so inserting one entry does not disguise edits to all later entries. */
export function documentChanges(
  before: NativeDocument,
  after: NativeDocument,
): DocumentChange[] {
  const changes: DocumentChange[] = [];
  const visit = (left: unknown, right: unknown, path: string) => {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (object(left) && object(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
        visit(left[key], right[key], `${path}/${key}`);
      return;
    }
    if (
      Array.isArray(left) &&
      Array.isArray(right) &&
      keyed(left) &&
      keyed(right)
    ) {
      const leftIds = left.map((item) => item.id),
        rightIds = right.map((item) => item.id);
      if (JSON.stringify(leftIds) !== JSON.stringify(rightIds))
        changes.push({
          path: `${path}/顺序`,
          before: text(leftIds),
          after: text(rightIds),
        });
      for (const id of new Set([...leftIds, ...rightIds]))
        visit(
          left.find((item) => item.id === id),
          right.find((item) => item.id === id),
          `${path}[${id}]`,
        );
      return;
    }
    changes.push({ path: path || "/", before: text(left), after: text(right) });
  };
  visit(before, after, "");
  return changes;
}
export function parseDraft(
  raw: string,
  kind: "card" | "preset",
): NativeDocument {
  const value: unknown = JSON.parse(raw);
  if (!object(value) || value.schema !== `rp.${kind}/0.1`)
    throw new Error(
      `草稿必须是 rp.${kind}/0.1 原生${kind === "card" ? "角色卡" : "预设"}。`,
    );
  return value as unknown as NativeDocument;
}
export function exportDraft(document: NativeDocument) {
  const blob = new Blob([JSON.stringify(document, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement("a");
  link.href = url;
  link.download = `${document.id || "draft"}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
