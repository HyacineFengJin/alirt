import type { RuntimeDiagnostic } from './prompt-runtime';
import type { Json } from './types';
import type { WorldInputEvidence } from './world-input';

export const PUBLICATION_KINDS = ['news', 'forum', 'fan', 'team', 'notice'] as const;
export type PublicationKind = typeof PUBLICATION_KINDS[number];
export interface WorldPublication { kind: PublicationKind; sourceLabel: string }
export interface ResolvedWorldPublication extends WorldPublication { worldTime: string | null; worldRevision: number }

/** References supplied by the world, without model-authored copies of host data. */
export type WorldFactSource =
  | { kind: 'behavior'; id: string }
  | { kind: 'host-input'; id: string }
  | { kind: 'state'; roleId: string; key: string }
  | { kind: 'player-action' }
  | { kind: 'opening-setup' }
  /** An independent environmental development. This is a declared semantic
   * category, not host proof that the fact follows from another source. */
  | { kind: 'world-development' };

export interface WorldFact {
  text: string;
  sources: WorldFactSource[];
  publication?: WorldPublication;
}

/** State values are read from the completed host transaction, never the model. */
export type ResolvedWorldFactSource =
  | Exclude<WorldFactSource, { kind: 'state' | 'host-input' }>
  | { kind: 'host-input'; id: string; evidence: WorldInputEvidence }
  | { kind: 'state'; roleId: string; key: string; value: Json };

export interface ResolvedWorldFact {
  text: string;
  /** Empty only for explicitly diagnosed legacy events. */
  sources: ResolvedWorldFactSource[];
  publication?: ResolvedWorldPublication;
}

/** Provenance for a public fact. The referenced host payload remains private audit data. */
export interface WorldInputEvidenceReference {
  schema: 'rp.world-input-reference/0.1';
  serviceId: string; referenceId: string; kind: string; title: string; payloadSha256: string;
}
export type PublicWorldFactSource =
  | Exclude<ResolvedWorldFactSource, { kind: 'host-input' }>
  | { kind: 'host-input'; id: string; evidenceRef: WorldInputEvidenceReference };
export interface PublicWorldFact { text: string; sources: PublicWorldFactSource[]; publication?: ResolvedWorldPublication }

export interface WorldFactsCompilation {
  mode: 'sourced' | 'legacy';
  facts: ResolvedWorldFact[];
  diagnostics: RuntimeDiagnostic[];
}
