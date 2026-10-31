import { validateStateJson } from './state-value-schema';
import { validateStoryProgressPatch, type StoryProgressIssue, type StoryProgressPatch, type StoryProgressState } from './story-progress';

export const STORY_PROGRESS_CONTROL_SERVICE_ID = 'rp.story-progress-control';
export interface StoryProgressPublicEvent { id: string; turnId?: string; text: string }
export interface StoryProgressControlView {
  schema: 'rp.story-progress-control/0.1';
  revision: number;
  progress: StoryProgressState | null;
  publicEvents: StoryProgressPublicEvent[];
}
export interface StoryProgressControlCommand {
  requestId: string;
  expectedRevision: number;
  /** Private author audit only; not a world action or a public output. */
  reason: string;
  patch: StoryProgressPatch;
}
export interface StoryProgressControlResult extends StoryProgressControlView {
  requestId: string;
  duplicate: boolean;
  appliedRevision: number;
}
/** The author controller references retained public events, never indexes into
 * facts from a world-model response that this command does not produce. */
export function validateStoryProgressControlCommand(value: unknown): StoryProgressIssue[] {
  const json = validateStateJson(value); if (json.length) return json.map(({ path, message }) => ({ path, message }));
  const issue = (message: string): StoryProgressIssue[] => [{ path: '', message }];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return issue('Expected a story progress author command');
  const command = value as Record<string, unknown>, keys = ['requestId', 'expectedRevision', 'reason', 'patch'];
  if (Object.keys(command).length !== keys.length || !keys.every(key => Object.hasOwn(command, key))) return issue('Expected exact requestId, expectedRevision, reason and patch fields');
  if (typeof command.requestId !== 'string' || !command.requestId.trim() || command.requestId.trim() !== command.requestId
    || typeof command.reason !== 'string' || !command.reason.trim()
    || !Number.isSafeInteger(command.expectedRevision) || (command.expectedRevision as number) < 0) return issue('Provide a request ID, current revision and nonblank private reason');
  const errors = validateStoryProgressPatch(command.patch); if (errors.length) return errors.map(error => ({ ...error, path: `/patch${error.path}` }));
  if ((command.patch as StoryProgressPatch).operations.some(op => op.evidence.factIndexes.length)) return issue('Author corrections require retained public event IDs; factIndexes must be empty');
  return [];
}
