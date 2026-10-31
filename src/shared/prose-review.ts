export type ProseReviewTarget = { kind: 'main'; entryId: string }
  | { kind: 'parallel'; runId: string; renderAttemptId: string };
export interface ProseReviewSegment {
  id: string; kind: 'title' | 'narration' | 'speech' | 'summary'; text: string;
}
export interface ProseReviewEvidence { ref: string; kind: 'scene' | 'player-authorized' | 'behavior' | 'world-fact'; text: string }
export interface ProseReviewContext {
  target: ProseReviewTarget; targetHash: string; materialHash: string;
  segments: ProseReviewSegment[];
  material: { references: ProseReviewEvidence[]; limitations: string[] };
}
export type ProseReviewCategory = 'action' | 'interiority' | 'time' | 'message-duplication' | 'speech' | 'other';
export interface ProseReviewFinding {
  segmentId: string; quote: string; category: ProseReviewCategory; severity: 'note' | 'concern';
  explanation: string; sourceRefs: string[];
}
export interface ProseReviewResult { summary: string; findings: ProseReviewFinding[] }
export interface ProseReviewAttempt {
  id: string; requestId: string; turnId: string; status: 'running' | 'completed' | 'failed' | 'interrupted';
  startedAt: string; finishedAt?: string; nativeSessionId?: string; result?: ProseReviewResult; error?: string;
}
/** Author-only retained context. Never part of ordinary model/reader projections. */
export interface StoredProseReview extends ProseReviewContext {
  schema: 'rp.prose-review/0.1'; id: string; attempts: ProseReviewAttempt[];
}
export interface ProseReviewTargetInfo {
  target: ProseReviewTarget; title: string; worldRevision: number; available: boolean; reason?: string;
}
export interface ProseReviewsView {
  revision: number; installed: boolean; enabled: boolean;
  targets: ProseReviewTargetInfo[]; reviews: StoredProseReview[];
}
