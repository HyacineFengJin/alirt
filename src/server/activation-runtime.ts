import { createHash } from 'node:crypto';
import type { PromptModule } from '../shared/types';
import type { PromptActivationState, PromptActivationLedger } from '../shared/prompt-runtime';
export type { PromptActivationState, PromptActivationLedger, PromptActivationPlan } from '../shared/prompt-runtime';

export interface PromptActivationContext {
  turnIndex: number;
  logicalKey: string;
  seed: string;
  ledger: PromptActivationLedger;
}
export interface LifetimeEvaluation {
  active: boolean;
  state: PromptActivationState;
  code: string;
  message: string;
}

/** No request IDs or revisions: retries and previews use the same draw. */
export function activationProbabilityDraw(seed: string, logicalKey: string, turnIndex: number, identity: string): number {
  const hex = createHash('sha256').update(JSON.stringify([seed, logicalKey, turnIndex, identity])).digest('hex');
  return Number.parseInt(hex.slice(0, 13), 16) / 0x10000000000000;
}

/** Disabled is a runtime switch, not a new definition that rearms once. */
export function activationIdentity(documentId: string, module: PromptModule, fingerprint: (value: unknown) => string): string {
  const { enabled: _enabled, ...definition } = module;
  return fingerprint({ documentId, module: definition });
}

export function evaluateModuleLifetime(module: PromptModule, identity: string, key: string, matched: boolean, context: PromptActivationContext): LifetimeEvaluation {
  const previous = context.ledger[key];
  const state: PromptActivationState = previous?.identity === identity ? { ...previous } : { identity };
  const lifetime = module.lifetime ?? {}, turn = context.turnIndex;
  const result = (active: boolean, code: string, message: string): LifetimeEvaluation => ({ active, state, code, message });
  const sticky = (lifetime.stickyTurns ?? 0) > 1 && state.stickyUntilTurn !== undefined && turn <= state.stickyUntilTurn;
  if (lifetime.once && state.consumed && !sticky) return result(false, 'lifetime-once', 'This definition has already been delivered once.');
  if (!sticky && state.cooldownUntilTurn !== undefined && turn > (state.stickyUntilTurn ?? state.lastActivatedTurn ?? -1) && turn <= state.cooldownUntilTurn) {
    return result(false, 'lifetime-cooldown', `Cooling down through accepted turn ${state.cooldownUntilTurn}.`);
  }
  if (matched && state.firstMatchedTurn === undefined) state.firstMatchedTurn = turn;
  if (!matched && !sticky) return result(false, 'keywords', 'No activation keyword matched and no sticky recall remains.');
  const delay = lifetime.delayTurns ?? 0;
  if (!sticky && (state.firstMatchedTurn === undefined || turn < state.firstMatchedTurn + delay)) {
    return result(false, 'lifetime-delay', `Waiting ${delay} accepted turns after the first eligible match.`);
  }
  const probability = lifetime.probability ?? 1;
  if (!sticky && activationProbabilityDraw(context.seed, context.logicalKey, turn, identity) >= probability) {
    return result(false, 'lifetime-probability', 'The deterministic activation probability did not pass for this accepted turn.');
  }
  return result(true, sticky ? 'lifetime-sticky' : 'eligible', sticky ? 'Recalled within its sticky lifetime.' : 'Activation and lifetime requirements satisfied.');
}

/** Only call on modules admitted after dependency/exclusivity resolution. */
export function deliveredActivationState(module: PromptModule, evaluation: LifetimeEvaluation, turn: number): PromptActivationState {
  const state = { ...evaluation.state }, lifetime = module.lifetime ?? {};
  const alreadyRecalling = state.lastActivatedTurn === turn || state.stickyUntilTurn !== undefined && turn <= state.stickyUntilTurn;
  state.lastActivatedTurn = turn;
  if (!alreadyRecalling) state.stickyUntilTurn = turn + Math.max(1, lifetime.stickyTurns ?? 1) - 1;
  state.cooldownUntilTurn = (state.stickyUntilTurn ?? turn) + (lifetime.cooldownTurns ?? 0);
  if (lifetime.once) state.consumed = true;
  return state;
}
