import type { RoleInteraction } from './types';
/** Host-issued public behavior proposals. Candidate text has no authority until
 * the world explicitly approves its id for the current turn. */
export interface BehaviorCandidate {
  id: string;
  roleId: string;
  kind: 'speech' | 'action';
  text: string;
  /** Stamped by the host from the actor's scene grant, never chosen by the model. */
  interaction?: RoleInteraction;
}

/** Persist this snapshot with the world commit. Prose recovery reads this
 * approved material rather than reconstructing it from role reports. */
export interface BehaviorApproval {
  acceptedBehaviorIds: string[];
  /** Ordered exactly as acceptedBehaviorIds, including across roles. */
  acceptedBehaviors: BehaviorCandidate[];
}
