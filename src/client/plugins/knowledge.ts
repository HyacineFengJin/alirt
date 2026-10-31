import type { ProvenancedKnowledge } from "../../shared/knowledge";
import type { Audience, Knowledge } from "../../shared/types";
import type { EditKnowledgeRequest } from "../api";

export interface KnowledgeDraft {
  id: string;
  text: string;
  audience: Audience;
  status: Knowledge["status"];
  sourceRefs: string[];
  expectedRevision: number;
  operation: "upsert" | "retract";
  reason: string;
}
export function knowledgeDraft(item: ProvenancedKnowledge | undefined, revision: number): KnowledgeDraft {
  return {
    id: item?.id ?? "",
    text: item?.text ?? "",
    audience: Array.isArray(item?.audience) ? [...item.audience] : item?.audience ?? "author",
    status: item?.status ?? "known",
    sourceRefs: [...(item?.provenance?.sourceRefs ?? [])],
    expectedRevision: revision,
    operation: "upsert",
    reason: "",
  };
}
export function knowledgePayload(roleId: string, draft: KnowledgeDraft): EditKnowledgeRequest {
  return {
    expectedRevision: draft.expectedRevision,
    operation: draft.operation,
    roleId,
    id: draft.id.trim(),
    reason: draft.reason.trim(),
    ...(draft.operation === "upsert" ? {
      text: draft.text,
      audience: draft.audience,
      status: draft.status,
      sourceRefs: [...draft.sourceRefs],
    } : {}),
  };
}
