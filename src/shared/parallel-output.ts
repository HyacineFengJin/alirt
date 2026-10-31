import type { BehaviorCandidate } from './behavior';
import type { ProseEntry, WorldEvent } from './types';
import { validateStateJson } from './state-value-schema';

export interface ParallelProse { title: string; text: string; person: 'first' | 'third'; pov: 'limited' | 'omniscient' }
export interface ParallelRenderAttempt {
  id: string; requestId: string; status: 'running' | 'completed' | 'failed'; at: string;
  prose?: ParallelProse; error?: string;
}
/** Private committed scene snapshot. A presentation attempt never edits its material. */
export interface ParallelRun {
  schema: 'rp.parallel-run/0.1'; id: string; turnId: string; sceneId: string;
  grantGeneration: number; attemptEpoch: number; title: string; location: string; time: string | null;
  cast: { roleId: string; name: string }[]; worldRevision: number;
  material: { acceptedBehaviors: BehaviorCandidate[]; events: WorldEvent[] };
  render: { status: 'pending' | 'running' | 'completed' | 'failed'; attempts: ParallelRenderAttempt[] };
}
/** Journaled BEFORE model decisions; incomplete attempts cannot reuse their native histories. */
export interface ParallelAttempt {
  id: string; turnId: string; sceneId: string; grantGeneration: number; epoch: number;
  status: 'prepared' | 'committed' | 'aborted'; rejectedCandidates?: boolean;
}
export interface ParallelSceneView {
  id: string; sceneId: string; title: string; location: string; time: string | null;
  cast: { roleId: string; name: string }[]; status: 'pending' | 'completed' | 'failed';
  prose?: ParallelProse; error?: string;
}
export interface ParallelScenesOutput {
  schema: 'rp.parallel-scenes/0.1'; materialTurnId: string | null; worldRevision: number; scenes: ParallelSceneView[];
}
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const exact = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => Object.hasOwn(v, key)) && Object.keys(v).every(key => [...required, ...optional].includes(key));
export function validParallelScenesOutput(value: unknown): value is ParallelScenesOutput {
  if (validateStateJson(value).length || !obj(value) || !exact(value, ['schema', 'materialTurnId', 'worldRevision', 'scenes'])
    || value.schema !== 'rp.parallel-scenes/0.1' || !(value.materialTurnId === null || text(value.materialTurnId))
    || !Number.isSafeInteger(value.worldRevision) || (value.worldRevision as number) < 0 || !Array.isArray(value.scenes) || value.scenes.length > 2) return false;
  const ids = new Set<string>(), scenes = new Set<string>();
  return value.scenes.every(scene => {
    if (!obj(scene) || !exact(scene, ['id', 'sceneId', 'title', 'location', 'time', 'cast', 'status'], ['prose', 'error'])
      || !text(scene.id) || ids.has(scene.id) || !text(scene.sceneId) || scenes.has(scene.sceneId) || !text(scene.title) || !text(scene.location)
      || !(scene.time === null || typeof scene.time === 'string') || !Array.isArray(scene.cast) || !scene.cast.length
      || !['pending', 'completed', 'failed'].includes(scene.status as string) || scene.error !== undefined && !text(scene.error)) return false;
    const roles = new Set<string>();
    if (!scene.cast.every(role => { if (!obj(role) || !exact(role, ['roleId', 'name']) || !text(role.roleId) || roles.has(role.roleId) || !text(role.name)) return false; roles.add(role.roleId); return true; })) return false;
    if (scene.prose !== undefined && (!obj(scene.prose) || !exact(scene.prose, ['title', 'text', 'person', 'pov']) || typeof scene.prose.title !== 'string'
      || !text(scene.prose.text) || !['first', 'third'].includes(scene.prose.person as string) || !['limited', 'omniscient'].includes(scene.prose.pov as string))) return false;
    if ((scene.status === 'completed') !== (scene.prose !== undefined)) return false;
    ids.add(scene.id); scenes.add(scene.sceneId); return true;
  });
}

export function parallelSceneView(run: ParallelRun): ParallelSceneView {
  const completed = run.render.attempts.findLast(attempt => attempt.status === 'completed');
  const failed = run.render.attempts.findLast(attempt => attempt.status === 'failed');
  return { id: run.id, sceneId: run.sceneId, title: run.title, location: run.location, time: run.time, cast: structuredClone(run.cast),
    status: run.render.status === 'completed' && completed?.prose ? 'completed' : run.render.status === 'failed' ? 'failed' : 'pending',
    ...(run.render.status === 'completed' && completed?.prose ? { prose: structuredClone(completed.prose) } : {}),
    ...(run.render.status === 'failed' && failed?.error ? { error: failed.error } : {}) };
}

/** Latest presentation is a projection. The original attachment and failed
 * attempts remain immutable audit data; ordinary prose is never rewritten. */
export function refreshParallelPresentations(entries: ProseEntry[], runs: ParallelRun[]): ProseEntry[] {
  return entries.map(entry => ({ ...entry, ...(entry.attachments ? { attachments: entry.attachments.map(output => {
    const provenance = output.provenance;
    if (output.audience !== 'author' || provenance?.kind !== 'committed-parallel' || !validParallelScenesOutput(output.value)) return output;
    const previous = output.value as unknown as ParallelScenesOutput;
    const matched = runs.filter(run => run.turnId === provenance.materialTurnId && run.worldRevision === provenance.worldRevision
      && previous.scenes.some(scene => scene.id === run.id && scene.sceneId === run.sceneId));
    if (matched.length !== previous.scenes.length) return output;
    try {
      const value: ParallelScenesOutput = { ...previous, scenes: previous.scenes.map(scene => parallelSceneView(matched.find(run => run.id === scene.id)!)) };
      return validParallelScenesOutput(value) ? { ...output, value: value as never } : output;
    } catch { return output; }
  }) } : {}) }));
}
