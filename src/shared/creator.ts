import type { CharacterCard, Json, Preset } from './types';

export type CreativeKind = 'card' | 'preset';
export type NativeDocument = CharacterCard | Preset;
export interface DraftIssue { path: string; message: string; }
export interface DraftRevision {
  revision: number; at: string; origin: 'seed' | 'user' | 'agent' | 'restore'; summary: string;
  document: NativeDocument; runId?: string;
}
export interface CreatorMessage { id: string; at: string; role: 'user' | 'assistant'; text: string; runId?: string; }
export interface CreatorRun {
  id: string; requestId: string; instruction: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  phase: string; startedAt: string; finishedAt?: string; error?: string;
}
export interface PublishedDocument { id: string; kind: CreativeKind; title: string; revision: number; publishedAt: string; }
export interface CreatorSession {
  id: string; title: string; kind: CreativeKind; createdAt: string; updatedAt: string;
  revision: number; document: NativeDocument; sourceId?: string;
  messages: CreatorMessage[]; runs: CreatorRun[]; revisions: DraftRevision[];
  issues: DraftIssue[]; published: PublishedDocument[];
}
export interface CreateCreatorSession { kind: CreativeKind; sourceId?: string; title?: string; }
export interface SubmitCreatorRun { requestId: string; expectedRevision: number; instruction: string; }
export interface ReplaceCreatorDraft { expectedRevision: number; document: NativeDocument; summary: string; }
export interface RestoreCreatorDraft { expectedRevision: number; revision: number; }
export interface PublishCreatorDraft { expectedRevision: number; }
export interface DraftPatchOperation { op: 'add' | 'replace' | 'remove' | 'test'; path: string; value?: Json; }
