import type { Json, RoleInteraction, RolePhase } from './types';
import type { WorldbookSource } from './worldbook';

/** Baseline values applied only when a new session is created. */
export interface InitialStateChange {
  roleId: string;
  key: string;
  value: Json;
}

/** Explicit audience selection. Strings are author-selected instructions, never inferred
 * from instruction/text/source. Presence (including {}) disables legacy forwarding.
 * World setup establishes consequences; prose instructions control narration only and
 * must not authorize facts, disclosures or player actions that world has not committed.
 */
export interface OpeningDelivery {
  world?: string;
  prose?: string;
}

/** Finite author-selected role subset; not an imported script or general template language. */
export interface OpeningRoleSelection {
  kind: 'role-subset';
  roleIds: string[];
  min: number;
  max: number;
  /** Exact literal token replaced only in instruction and delivery strings. */
  nameToken: string;
  nameSeparator: string;
  selected: { phase: RolePhase; presence: 'present' | 'absent'; interaction?: RoleInteraction };
  unselected: { phase: RolePhase; presence: 'present' | 'absent'; interaction?: RoleInteraction };
  /** Declared baseline values applied only to chosen roles, after ordinary state layers. */
  selectedState?: { key: string; value: Json }[];
}

/** Ordered finite selectors. Each group owns disjoint cast/state targets. */
export interface OpeningRoleSelectionGroup extends Omit<OpeningRoleSelection, 'selected' | 'unselected'> {
  id: string;
  title: string;
  emptyName?: string;
  complementNameToken?: string;
  /** An earlier group whose chosen identities bound this group's choices. */
  subsetOf?: string;
  /** UI hint only; the request must still explicitly select every group. */
  selectWithParent?: boolean;
  selected?: OpeningRoleSelection['selected'];
  unselected?: OpeningRoleSelection['unselected'];
  unselectedState?: { key: string; value: Json }[];
}

export interface OpeningDefinition {
  id: string;
  title: string;
  text: string;
  /** Original source instruction. Legacy world premise only when delivery is absent. */
  instruction?: string;
  delivery?: OpeningDelivery;
  world?: { location?: string; time?: string };
  /** Every card role, including the player, must be listed exactly once. */
  /** Omitted interaction clears a baseline remote grant for this selected opening. */
  cast: { roleId: string; phase: RolePhase; presence: 'present' | 'absent'; interaction?: RoleInteraction }[];
  state?: InitialStateChange[];
  source?: WorldbookSource;
  roleSelection?: OpeningRoleSelection;
  roleGroups?: OpeningRoleSelectionGroup[];
}

export interface PlayerProfileDefinition {
  id: string;
  title: string;
  name: string;
  persona: string;
  state?: InitialStateChange[];
  source?: WorldbookSource;
}

/** Explicit author data; imported source scripts are never executed. */
export interface InitializationDefinition {
  schema: 'rp.initialization/0.1';
  openings: OpeningDefinition[];
  playerProfiles: PlayerProfileDefinition[];
  defaultOpeningId?: string;
  defaultPlayerProfileId?: string;
}

export interface InitializationSelection {
  openingId?: string;
  playerProfileId?: string;
  selectedRoleIds?: string[];
  selectedRoleGroups?: Record<string, string[]>;
}

export interface InitializationReceipt {
  schema: 'rp.initialization-receipt/0.1';
  openingId: string;
  playerProfileId: string;
  definitionHash: string;
  selectedRoleIds?: string[];
  selectedRoleGroups?: Record<string, string[]>;
  /** Author-only resolved template/cast/state, retained rather than replaying genesis. */
  resolvedOpening?: OpeningDefinition;
}
