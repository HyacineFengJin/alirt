import { createHash } from 'node:crypto';
import type { ScenarioView } from '../shared/types';
import { parseScenarioCommand, proposeScenarioCommand, readScenario, ScenarioError } from './scenario-runtime';
import { assertRevision, clone, event, SessionStore } from './store';

export interface ScenarioCommandReceipt { requestId: string; fingerprint: string; revision: number; }
export interface ScenarioCommandResult extends ScenarioView { duplicate: boolean; appliedRevision: number; }

/** The route also requires an idle engine. One synchronous save owns the whole command. */
export function applyScenarioCommand(store: SessionStore, id: string, value: unknown): ScenarioCommandResult {
  const input = parseScenarioCommand(value), current = store.get(id);
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const previous = current.scenarioRequests?.find(receipt => receipt.requestId === input.requestId);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new ScenarioError('SCENARIO_REQUEST_CONFLICT', 'This request ID names a different scenario command.', 409);
    return { ...readScenario(current), duplicate: true, appliedRevision: previous.revision };
  }
  assertRevision(current, input.expectedRevision);
  const progress = proposeScenarioCommand(current, input);
  const next = clone(current); next.scenario = progress; ++next.revision;
  next.scenarioRequests ??= [];
  next.scenarioRequests.push({ requestId: input.requestId, fingerprint, revision: next.revision });
  event(next, { kind: 'scenario-command', actor: 'author', audience: 'author', text: input.reason,
    data: { operation: input.operation, chapterId: input.chapterId, requestId: input.requestId } });
  const result = { ...readScenario(next), duplicate: false, appliedRevision: next.revision };
  store.save(next);
  return result;
}
