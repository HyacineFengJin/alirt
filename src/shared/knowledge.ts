import type { Audience, Knowledge } from './types';

export type KnowledgeLifecycle = 'active' | 'withdrawn' | 'stale';
export type KnowledgeOrigin = 'card' | 'author' | 'derived' | 'peer';
/** A private host observation, not a quote from a generated prose attachment. */
export interface KnowledgeObservation { eventId: string; sceneId: string }

/** Portable lineage, with source records held privately by the session host. */
export interface KnowledgeProvenance {
  sourceId: string;
  sourceRefs: string[];
  kind: KnowledgeOrigin;
  receivedFrom?: string;
  deliveryId?: string;
  observation?: KnowledgeObservation;
}
export type ProvenancedKnowledge = Knowledge & {
  lifecycle?: KnowledgeLifecycle;
  provenance?: KnowledgeProvenance;
};

/** Never include the registry in a role/world/prose snapshot. */
export interface KnowledgeSource {
  id: string;
  kind: KnowledgeOrigin;
  ownerRoleId: string;
  knowledgeId: string;
  text: string;
  audience: Audience;
  certainty: Knowledge['status'];
  lifecycle: KnowledgeLifecycle;
  sourceRefs: string[];
  receivedFrom?: string;
  deliveryId?: string;
  observation?: KnowledgeObservation;
}
export interface KnowledgeHistoryEntry {
  roleId: string;
  knowledge: ProvenancedKnowledge;
  reason: 'replaced' | 'retracted' | 'source-withdrawn';
}
export interface KnowledgeRegistry {
  schema: 'rp.knowledge/0.1';
  sources: KnowledgeSource[];
  history: KnowledgeHistoryEntry[];
}
export interface KnowledgeEdit {
  operation: 'upsert' | 'retract';
  roleId: string;
  id: string;
  text?: string;
  audience?: Audience;
  status?: Knowledge['status'];
  sourceRefs?: string[];
}
export interface KnowledgeDelivery {
  /** Mail identity makes accepting the same delivery idempotent. */
  id: string;
  from: string;
  to: string;
  body: string;
  sourceRefs?: string[];
}
