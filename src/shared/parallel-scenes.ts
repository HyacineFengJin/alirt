import type { RoleInteraction, RolePhase } from './types';
import { validateStateJson } from './state-value-schema';

export const PARALLEL_SCENES_SERVICE_ID = 'rp.parallel-scenes';
export interface ParallelSceneDefinition {
  id: string; title: string; enabled: boolean; participantRoleIds: string[]; locationKey: string; goal: string;
}
export interface ParallelSceneGrant extends ParallelSceneDefinition { generation: number }
export type ParallelAppearanceEvidence =
  | { kind: 'opening-cast'; roleId: string; openingId: string; definitionHash: string }
  | { kind: 'approved-behavior'; roleId: string; eventId: string; turnId: string; behaviorId: string };
export interface ParallelSceneDiagnostic { code: string; message: string; roleId?: string }
export interface ParallelSceneRoleView {
  roleId: string; name: string; phase: RolePhase; presence: 'present' | 'absent'; interaction: RoleInteraction | null;
  /** At most one opening and one strict approved-behavior witness; not a copy of the history. */
  appearanceEvidence: ParallelAppearanceEvidence[];
  /** Own-readable, held, nonblank string fields, suitable as binding candidates. */
  heldStringKeys: string[];
  readableStringFields: { key: string; label: string; value: string | null; known: boolean }[];
  /** Actor eligibility before any particular scene's location binding. */
  ready: boolean;
  diagnostics: ParallelSceneDiagnostic[];
}
export interface ParallelSceneParticipantView extends ParallelSceneRoleView {
  location: { key: string; value: string | null; readable: boolean };
}
export interface ParallelSceneReadiness {
  sceneId: string; ready: boolean; location: string | null;
  participants: ParallelSceneParticipantView[]; diagnostics: ParallelSceneDiagnostic[];
}
export interface ParallelScenesView {
  schema: 'rp.parallel-scenes-control/0.1'; revision: number;
  grants: ParallelSceneGrant[]; archives: ParallelSceneGrant[]; selectedSceneIds: string[];
  roles: ParallelSceneRoleView[]; sceneReadiness: ParallelSceneReadiness[];
}
interface CommandMeta { requestId: string; expectedRevision: number; reason: string }
export type ParallelScenesCommand = CommandMeta & (
  | { operation: 'upsert'; scene: ParallelSceneDefinition }
  | { operation: 'select'; selectedSceneIds: string[] }
  | { operation: 'remove'; sceneId: string }
);
export interface ParallelScenesResult extends ParallelScenesView { requestId: string; duplicate: boolean; appliedRevision: number }
export interface ResolvedParallelScene extends ParallelSceneGrant {
  location: string; participants: ParallelSceneParticipantView[];
}
export interface ParallelSceneSelection {
  scenes: ResolvedParallelScene[];
  blocked: { sceneId: string; diagnostics: ParallelSceneDiagnostic[] }[];
}
export interface ParallelSceneIssue { path: string; message: string }
const nonblank = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validateParallelSceneDefinition(value: unknown, held = false): ParallelSceneIssue[] {
  const json = validateStateJson(value); if (json.length) return json.map(({ path, message }) => ({ path, message }));
  const fail = (message: string) => [{ path: '', message }];
  if (!record(value) || !exact(value, ['id', 'title', 'enabled', 'participantRoleIds', 'locationKey', 'goal', ...(held ? ['generation'] : [])])) return fail('Expected exact parallel scene fields');
  if (!nonblank(value.id) || value.id.trim() !== value.id || !nonblank(value.title) || !nonblank(value.goal) || !nonblank(value.locationKey) || value.locationKey.trim() !== value.locationKey || typeof value.enabled !== 'boolean') return fail('Invalid scene identity, title, location key, goal or switch');
  if (!Array.isArray(value.participantRoleIds) || !value.participantRoleIds.length || value.participantRoleIds.some(id => !nonblank(id) || id.trim() !== id) || new Set(value.participantRoleIds).size !== value.participantRoleIds.length) return fail('Participants must be unique existing role IDs');
  if (held && (!Number.isSafeInteger(value.generation) || (value.generation as number) < 1)) return fail('Invalid host scene generation');
  return [];
}
export function validateParallelScenesCommand(value: unknown): ParallelSceneIssue[] {
  const json = validateStateJson(value); if (json.length) return json.map(({ path, message }) => ({ path, message }));
  const fail = (message: string) => [{ path: '', message }];
  if (!record(value)) return fail('Expected a parallel scenes author command');
  const fields = value.operation === 'upsert' ? ['scene'] : value.operation === 'select' ? ['selectedSceneIds'] : value.operation === 'remove' ? ['sceneId'] : null;
  if (!fields || !exact(value, ['requestId', 'expectedRevision', 'reason', 'operation', ...fields])) return fail('Unexpected author command fields');
  if (!nonblank(value.requestId) || value.requestId.trim() !== value.requestId || !nonblank(value.reason) || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) return fail('Provide request identity, current revision and a nonblank private reason');
  if (value.operation === 'upsert') return validateParallelSceneDefinition(value.scene).map(issue => ({ ...issue, path: `/scene${issue.path}` }));
  if (value.operation === 'remove') return nonblank(value.sceneId) && value.sceneId.trim() === value.sceneId ? [] : fail('Provide an exact scene ID');
  if (!Array.isArray(value.selectedSceneIds) || value.selectedSceneIds.length > 2 || value.selectedSceneIds.some(id => !nonblank(id) || id.trim() !== id) || new Set(value.selectedSceneIds).size !== value.selectedSceneIds.length) return fail('Select zero, one or two distinct scene IDs');
  return [];
}
