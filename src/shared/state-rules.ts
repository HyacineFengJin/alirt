import type { Audience, Condition, Json, RoleDefinition, RoleInteraction, StateField } from './types';

export type StateWriteAuthority = 'model' | 'author' | 'derived';
export type StateRule =
  | { id: string; type: 'unique-item'; field: string; item: string }
  | { id: string; type: 'invariant'; condition: Condition; message: string }
  /** Limits each owner's net baseline-to-final numeric change, including derived effects.
   * Omitted owners selects all actual holders, including world. Authority is explicit:
   * model permits author corrections; all also constrains author transactions.
   * Changed values require a finite baseline; unknown is never coerced to zero. */
  | { id: string; type: 'delta-limit'; field: string; owners?: string[]; maxIncrease?: number; maxDecrease?: number; authority: 'model' | 'all' }
  | { id: string; type: 'transition'; trigger: { roleId: string; key: string }; when?: Condition; effects: StateEffect[] };

/** '*' is permitted only in triggers; '$trigger' resolves to the triggering owner in effects. */
export type StateEffect =
  | { type: 'set'; roleId: string; key: string; value: Json }
  | { type: 'increment'; roleId: string; key: string; amount: number }
  | { type: 'list-add' | 'list-remove'; roleId: string; key: string; value: Json };

export interface StateChange {
  roleId: string;
  key: string;
  value: Json;
  /** Optional compare-and-swap against the original transaction snapshot. */
  expectedValue?: Json;
}
export interface StateSnapshot {
  revision?: number;
  world: { location: string; time: string; variables: Record<string, Json> };
  roles: RoleDefinition[];
  fields: (StateField & { writableBy?: StateWriteAuthority })[];
}
export interface StateTransactionOptions {
  authority: 'model' | 'author';
  /** Restricts direct writes to one owner; declared rule effects may cross owners. */
  owner?: string;
  rules?: readonly StateRule[];
  expectedRevision?: number;
  /** A hard upper limit also applies, even when a caller supplies a larger limit. */
  maxEffects?: number;
}
export interface StateAuditEntry {
  id: string;
  roleId: string;
  key: string;
  before: Json;
  after: Json;
  authority: 'model' | 'author' | 'rule';
  origin: 'proposal' | 'rule';
  audience: Audience;
  ruleId?: string;
  causeId?: string;
  trigger?: { roleId: string; key: string; before: Json; after: Json };
  /** Structural effects of an explicitly bound boolean presence state write. */
  presenceSync?: { before: RoleDefinition['presence']; after: RoleDefinition['presence']; interactionBefore: RoleInteraction | null; interactionAfter: RoleInteraction | null };
}
export interface StateTransactionResult<T extends StateSnapshot> {
  nextState: T;
  audit: StateAuditEntry[];
}

/** Conditions receive this explicit view, never the session's events, prompts or clock.
 * Example: roles.player.state.health, world.variables.weather, trigger.after.
 * Transition conditions see all writes in the current wave; invariants see the final state.
 */
export interface StateConditionView {
  world: StateSnapshot['world'];
  roles: Record<string, Pick<RoleDefinition, 'id' | 'state' | 'phase' | 'presence'>>;
  trigger?: { roleId: string; key: string; before: Json; after: Json };
}
