import type { ProseReviewContext, ProseReviewEvidence, ProseReviewSegment, ProseReviewTarget, ProseReviewTargetInfo } from '../shared/prose-review';
import type { ProseEntry } from '../shared/types';
import { validProseBody, proseBodyText } from '../shared/prose-body';
import { validateStateJson } from '../shared/state-value-schema';
import { runtimeFingerprint } from './prompt-compiler';
import { ApiError, clone, type StoredSession } from './store';
import { publicFactEvent } from './world-facts-runtime';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nonblank = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
function fail(message: string): never { throw new ApiError(400, 'PROSE_REVIEW_CONTEXT', message); }
export function parseProseReviewTarget(value: unknown): ProseReviewTarget {
  if (validateStateJson(value).length || !record(value)) return fail('Select an exact saved prose target.');
  const keys = value.kind === 'main' ? ['kind', 'entryId'] : value.kind === 'parallel' ? ['kind', 'runId', 'renderAttemptId'] : [];
  if (!keys.length || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key) || !nonblank(value[key]))) return fail('Select an exact main entry or completed parallel rendering.');
  return clone(value) as unknown as ProseReviewTarget;
}
export const proseReviewTargetKey = (target: ProseReviewTarget) => JSON.stringify(target.kind === 'main' ? ['main', target.entryId] : ['parallel', target.runId, target.renderAttemptId]);
function mainSegments(entry: ProseEntry): ProseReviewSegment[] {
  const segments: ProseReviewSegment[] = [{ id: 'title', kind: 'title', text: entry.title }];
  if (validProseBody(entry.body) && proseBodyText(entry.body) === entry.text) entry.body.blocks.forEach((block, index) => segments.push({ id: `body:${index}`, kind: block.kind, text: block.text }));
  else segments.push({ id: 'body', kind: 'narration', text: entry.text });
  return segments;
}
export interface CurrentProseReviewMaterial {
  world: { location: string; time: string; variables: Record<string, unknown> };
  roles: { id: string; name: string; presence: string; state: Record<string, unknown> }[];
  playerControl: { mode: string; authorizedAction: string | null };
}
/** Build from immutable saved drafts and committed evidence. A current writer
 * snapshot may add only its already public scene/state fields, never prompts. */
export function buildProseReviewContext(session: StoredSession, rawTarget: ProseReviewTarget, current?: CurrentProseReviewMaterial): ProseReviewContext {
  const target = parseProseReviewTarget(rawTarget), refs: ProseReviewEvidence[] = [], limitations: string[] = [];
  const add = (ref: string, kind: ProseReviewEvidence['kind'], value: unknown) => {
    if (validateStateJson(value).length || refs.some(item => item.ref === ref)) fail('Review evidence must have unique ordinary JSON references.');
    refs.push({ ref, kind, text: typeof value === 'string' ? value : JSON.stringify(value) });
  };
  let segments: ProseReviewSegment[];
  if (target.kind === 'parallel') {
    const run = session.parallelRuns?.find(run => run.id === target.runId), attempt = run?.render.attempts.find(attempt => attempt.id === target.renderAttemptId);
    if (!run || attempt?.status !== 'completed' || !attempt.prose || typeof attempt.prose.title !== 'string' || !nonblank(attempt.prose.text)) return fail('Select an actually completed saved parallel draft.');
    segments = [{ id: 'title', kind: 'title', text: attempt.prose.title }, { id: 'body', kind: 'narration', text: attempt.prose.text }];
    add('scene:location', 'scene', run.location); add('scene:time', 'scene', run.time); add('scene:cast', 'scene', run.cast);
    for (const behavior of run.material.acceptedBehaviors) add(`behavior:${behavior.id}`, 'behavior', behavior);
    for (const event of run.material.events) {
      if (event.kind !== 'parallel-world-event' || event.turnId !== run.turnId || event.audience !== 'author' || !record(event.data)
        || event.data.runId !== run.id || event.data.sceneId !== run.sceneId) fail('Parallel review evidence crosses its committed scene.');
      add(`fact:${event.id}`, 'world-fact', { text: event.text, fact: event.data.fact });
    }
    limitations.push('Private scene only. No main-scene activity, private character thoughts, source instructions or old writer prose are supplied.');
  } else {
    const entry = session.prose.find(entry => entry.id === target.entryId);
    if (!entry || !entry.turnId) return fail('This entry has no saved material-turn anchor.');
    if (typeof entry.title !== 'string' || !nonblank(entry.text)) return fail('The selected saved prose text is unavailable or empty.');
    segments = mainSegments(entry);
    const brief = session.events.findLast(event => event.turnId === entry.turnId && event.kind === 'narration-material' && event.actor === 'host' && event.audience === 'author');
    const data = brief?.data;
    const materialTurnId = record(data) && data.schema === 'rp.narration-brief/0.1' && (data.materialTurnId === null || nonblank(data.materialTurnId))
      ? data.materialTurnId as string | null : session.events.some(event => event.turnId === entry.turnId && event.kind === 'world-adjudication') ? entry.turnId : undefined;
    if (materialTurnId === undefined) return fail('The original material selection was not recorded for this entry.');
    if (materialTurnId) {
      const playerTurn = session.turns.find(turn => turn.id === materialTurnId);
      if (!playerTurn) return fail('The saved material turn is unavailable.');
      if (playerTurn.mode !== 'author') add(`player:${materialTurnId}`, 'player-authorized', { roleId: session.playerRoleId, mode: playerTurn.mode, authorizedAction: playerTurn.action });
      for (const event of session.events.filter(event => event.turnId === materialTurnId && event.audience === 'public')) {
        if (event.kind === 'role-behavior') {
          const behavior = event.data;
          if (!record(behavior) || !nonblank(behavior.id) || behavior.roleId !== event.actor || behavior.text !== event.text || !['speech', 'action'].includes(behavior.kind as string)) fail('Review behavior source is not an exact committed record.');
          add(`behavior:${behavior.id}`, 'behavior', behavior);
        } else if (event.kind === 'world-event') {
          const disclosed = publicFactEvent(event);
          add(`fact:${event.id}`, 'world-fact', { text: disclosed.text, ...(disclosed.data !== undefined ? { data: disclosed.data } : {}) });
        }
      }
    }
    if (current) {
      add('scene:location', 'scene', current.world.location || null); add('scene:time', 'scene', current.world.time || null);
      add('scene:world-state', 'scene', current.world.variables);
      for (const role of current.roles) add('scene:role:' + JSON.stringify(role.id), 'scene', { id: role.id, name: role.name, presence: role.presence, state: role.state });
    } else {
      for (const output of entry.attachments ?? []) if (output.provenance?.kind === 'state' && output.provenance.worldRevision === entry.worldRevision
        && output.provenance.known && output.audience === 'public' && ['world-time', 'world-location'].includes(output.provenance.selector.kind))
        add(`scene:historical:${output.key}`, 'scene', { selector: output.provenance.selector.kind, value: output.value });
      limitations.push('Historical review: no full original state snapshot is reconstructed. Use only retained facts, approved behaviors, user authorization and host-stamped historical scene values. Missing evidence is not proof a detail is false.');
    }
    limitations.push('Source prompts, author instructions, private role knowledge and previous generated prose are not factual evidence. A recorded utterance proves it was said, not its claim was true.');
  }
  if (!segments.some(segment => nonblank(segment.text))) return fail('The selected draft is empty.');
  const targetHash = runtimeFingerprint({ target, segments });
  // Preserve the actual first captured public material for later explicit
  // reviews. Today's role/state edits must not become yesterday's evidence.
  const captured = session.proseReviews?.find(review => proseReviewTargetKey(review.target) === proseReviewTargetKey(target) && review.targetHash === targetHash);
  if (captured) return clone({ target: captured.target, targetHash: captured.targetHash, materialHash: captured.materialHash, segments: captured.segments, material: captured.material });
  const material = { references: refs, limitations };
  return { target, targetHash, materialHash: runtimeFingerprint(material), segments, material };
}
export function proseReviewTargets(session: StoredSession): ProseReviewTargetInfo[] {
  const targets: { target: ProseReviewTarget; title: string; worldRevision: number }[] = session.prose.map(entry => ({ target: { kind: 'main', entryId: entry.id }, title: entry.title || '未命名正文', worldRevision: entry.worldRevision }));
  for (const run of session.parallelRuns ?? []) for (const attempt of run.render.attempts) if (attempt.status === 'completed' && attempt.prose)
    targets.push({ target: { kind: 'parallel', runId: run.id, renderAttemptId: attempt.id }, title: `${run.title} · ${attempt.prose.title}`, worldRevision: run.worldRevision });
  return targets.map(info => { try { buildProseReviewContext(session, info.target); return { ...info, available: true }; }
    catch (error) { return { ...info, available: false, reason: error instanceof Error ? error.message : 'Review material unavailable.' }; } });
}
