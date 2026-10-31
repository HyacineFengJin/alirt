import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createNativeTemplate } from '../shared/native';
import { proseBodyText, type ProseBody } from '../shared/prose-body';
import type { CharacterCard, Preset, WorldEvent } from '../shared/types';
import type { ParallelRun } from '../shared/parallel-output';
import { SessionStore, type StoredSession } from './store';
import { buildProseReviewContext, proseReviewTargets, type CurrentProseReviewMaterial } from './prose-review-context';
import { parseProseReviewContext, parseProseReviewResult, proseReviewRequest } from './prose-review';
import { compileResultValidator } from './result-schema.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const event = (id: string, kind: string, text: string, rest: Partial<WorldEvent> = {}): WorldEvent => ({ id, kind, text, at: '2026-10-31',
  turnId: 'material-turn', actor: 'world', audience: 'public', ...rest });
const target = { kind: 'main', entryId: 'draft' } as const;
const current = (): CurrentProseReviewMaterial => ({ world: { location: 'Original public room', time: 'After class', variables: { weather: 'rain' } },
  roles: [{ id: 'a', name: 'A', presence: 'present', state: { visible: 'Known coat' } }], playerControl: { mode: 'dialogue', authorizedAction: 'Exact user words.' } });
function fixture(): StoredSession {
  const root = mkdtempSync(join(tmpdir(), 'rp-review-context-')); roots.push(root);
  const card = createNativeTemplate('card') as CharacterCard; card.opening = '';
  const store = new SessionStore(root), session = structuredClone(store.get(store.create(card, createNativeTemplate('preset') as Preset).id));
  session.world.location = 'TODAY_LOCATION_CANARY'; session.world.time = 'TODAY_DATE_CANARY'; session.world.variables = { private: 'TODAY_STATE_CANARY' };
  session.card.modules.push({ id: 'source-canary', title: 'Source', content: 'SOURCE_INSTRUCTION_CANARY', category: 'style', enabled: true,
    targets: ['prose'], phase: 'compose', priority: 1 });
  session.roles[0].persona = 'PERSONA_CANARY'; session.roles[0].state = { secret: 'PRIVATE_ROLE_STATE_CANARY' };
  session.roles[0].knowledge = [{ id: 'secret', text: 'PRIVATE_KNOWLEDGE_CANARY', status: 'known', audience: 'author' }];
  session.turns = [
    { id: 'material-turn', requestId: 'material-request', action: 'Exact user words.', mode: 'dialogue', status: 'completed', phase: 'done', startedAt: '2026-10-31' },
    { id: 'draft-turn', requestId: 'draft-request', action: 'AUTHOR_INSTRUCTION_CANARY', mode: 'author', status: 'completed', phase: 'done', startedAt: '2026-10-31' },
  ];
  const behavior = { id: 'approved-speech', roleId: 'a', kind: 'speech', text: 'Exact approved local words.' };
  session.events = [
    event('brief', 'narration-material', 'MATERIAL_AUDIT_NOT_EVIDENCE', { turnId: 'draft-turn', actor: 'host', audience: 'author',
      data: { schema: 'rp.narration-brief/0.1', materialTurnId: 'material-turn' } }),
    event('adjudication', 'world-adjudication', 'WORLD_SUMMARY_NOT_EVIDENCE'),
    event('approved', 'role-behavior', behavior.text, { actor: 'a', data: behavior }),
    event('current-fact', 'world-event', 'The approved terminal result is a win.', { data: { fact: { text: 'The approved terminal result is a win.', sources: [
      { kind: 'host-input', id: 'evidence', evidence: { schema: 'rp.world-input/0.1', id: 'evidence', serviceId: 'stage', referenceId: 'battle',
        kind: 'stage-result', title: 'Final result', payload: { round: 'PRIVATE_HOST_PAYLOAD_CANARY' } } },
    ] } } }),
    event('private-fact', 'world-event', 'PRIVATE_WORLD_FACT_CANARY', { audience: 'author' }),
    event('old-fact', 'world-event', 'OLD_WORLD_FACT_CANARY', { turnId: 'old-turn' }),
    event('candidate', 'role-result', 'UNAPPROVED_CANDIDATE_CANARY', { actor: 'a', audience: 'author' }),
    event('host-output', 'host-output', 'HOST_DISPLAY_CANARY'),
  ];
  const body: ProseBody = { schema: 'rp.prose-body/0.1', materialTurnId: 'material-turn', renderer: 'character-dialogue', blocks: [
    { kind: 'narration', text: 'The room is quiet.' },
    { kind: 'speech', ref: behavior.id, roleId: 'a', name: 'A', text: behavior.text, channel: 'local', speaker: 'npc' },
  ] };
  session.prose = [{ id: 'old-draft', title: 'Old title', text: 'OLD_PROSE_CANARY', worldRevision: 0 },
    { id: 'draft', turnId: 'draft-turn', title: 'Saved first draft', body, text: proseBodyText(body), worldRevision: 1 }];
  return session;
}

it('uses only the selected material turn public canonical sources and clips historical host payloads', () => {
  const session = fixture(), before = structuredClone(session), context = buildProseReviewContext(session, target, current());
  expect(parseProseReviewContext(context)).toEqual(context);
  expect(context.material.references.map(item => item.ref)).toEqual(['player:material-turn', 'behavior:approved-speech', 'fact:current-fact',
    'scene:location', 'scene:time', 'scene:world-state', 'scene:role:"a"']);
  const encoded = JSON.stringify(context.material);
  expect(encoded).toContain('Exact user words.'); expect(encoded).toContain('Exact approved local words.'); expect(encoded).toContain('rp.world-input-reference/0.1');
  expect(encoded).not.toMatch(/PRIVATE_|OLD_WORLD|OLD_PROSE|SOURCE_INSTRUCTION|PERSONA_CANARY|AUTHOR_INSTRUCTION|UNAPPROVED|HOST_DISPLAY|WORLD_SUMMARY|MATERIAL_AUDIT|TODAY_/);
  expect(encoded).not.toContain('"payload"'); expect(session).toEqual(before);
  context.material.references[0].text = 'Caller mutation'; expect(session).toEqual(before);
});

it('segments typed speech as ineligible and excludes auxiliary artifacts from draft evidence', () => {
  const session = fixture(), entry = session.prose.at(-1)!;
  entry.attachments = [
    { key: 'private-summary', title: 'Private', type: 'text', value: 'PRIVATE_ATTACHMENT_CANARY', audience: 'author', placement: 'after-prose' },
    { key: 'other-summary', title: 'Other', type: 'text', value: 'ARBITRARY_OUTPUT_CANARY', audience: 'public', placement: 'after-prose' },
  ];
  const context = buildProseReviewContext(session, target);
  expect(context.segments.map(segment => [segment.id, segment.kind])).toEqual([['title', 'title'], ['body:0', 'narration'], ['body:1', 'speech']]);
  expect(JSON.stringify(context.material)).not.toContain('PUBLIC_DRAFT_SUMMARY'); expect(JSON.stringify(context)).not.toMatch(/PRIVATE_ATTACHMENT|ARBITRARY_OUTPUT/);
  const raw = { summary: 'An advisory concern.', findings: [{ segmentId: 'body:1', quote: 'Exact approved', category: 'speech', severity: 'note', explanation: 'A comment.', sourceRefs: [] }] };
  expect(compileResultValidator(proseReviewRequest(context).resultSchema)(raw).length).toBeGreaterThan(0);
  expect(() => parseProseReviewResult(raw, context)).toThrow('non-speech');
});

it('does not reconstruct historical state from today and reuses an immutable captured original snapshot', () => {
  const session = fixture(), historical = buildProseReviewContext(session, target);
  expect(historical.material.references.every(ref => ref.kind !== 'scene')).toBe(true);
  expect(JSON.stringify(historical)).not.toContain('TODAY_'); expect(historical.material.limitations.join(' ')).toContain('no full original state snapshot');
  const captured = buildProseReviewContext(session, target, current());
  session.proseReviews = [{ ...structuredClone(captured), schema: 'rp.prose-review/0.1', id: 'review', attempts: [] }];
  session.world.variables = { changed: 'LATER_STATE_CANARY' };
  const changed = current(); changed.world.location = 'LATER_LOCATION_CANARY'; changed.roles[0].state = { changed: 'LATER_ROLE_CANARY' };
  expect(buildProseReviewContext(session, target, changed)).toEqual(captured);
  expect(buildProseReviewContext(session, target)).toEqual(captured);
  const returned = buildProseReviewContext(session, target); returned.material.references[0].text = 'Caller mutation';
  expect(session.proseReviews[0].material.references).toEqual(captured.material.references);
});

it('supports anchored legacy narration and empty-world author drafts without treating author instructions as evidence', () => {
  const session = fixture(); session.turns[0].mode = 'author'; session.turns[0].action = 'PRIVATE_AUTHOR_COMMAND_CANARY';
  delete session.prose.at(-1)!.body; session.prose.at(-1)!.text = 'A plain saved first draft.';
  const legacy = buildProseReviewContext(session, target);
  expect(legacy.segments.find(segment => segment.id === 'body')).toMatchObject({ kind: 'narration', text: 'A plain saved first draft.' });
  expect(legacy.material.references.some(ref => ref.kind === 'player-authorized')).toBe(false);
  expect(JSON.stringify(legacy.material)).not.toContain('PRIVATE_AUTHOR_COMMAND');
  (session.events[0].data as Record<string, unknown>).materialTurnId = null;
  const authorDraft = buildProseReviewContext(session, target);
  expect(authorDraft.material.references).toEqual([]);
});

function parallel(session: StoredSession): ParallelRun {
  const fact = { text: 'A paper falls in the private room.', sources: [{ kind: 'world-development' }], observedBy: ['a'] };
  return { schema: 'rp.parallel-run/0.1', id: 'run-private', turnId: 'parallel-turn', sceneId: 'scene-private', grantGeneration: 1, attemptEpoch: 1,
    title: 'Private scene', location: 'Side room', time: null, cast: [{ roleId: 'a', name: 'A' }], worldRevision: 1,
    material: { acceptedBehaviors: [{ id: 'side-speech', roleId: 'a', kind: 'speech', text: 'PRIVATE_SCENE_APPROVED' }],
      events: [event('side-fact', 'parallel-world-event', fact.text, { turnId: 'parallel-turn', actor: 'parallel-world', audience: 'author',
        data: { sceneId: 'scene-private', runId: 'run-private', observerRoleIds: ['a'], fact } })] },
    render: { status: 'completed', attempts: [{ id: 'render-private', requestId: 'render-request', status: 'completed', at: '2026-10-31',
      prose: { title: 'Private first draft', text: 'A private scene draft.', person: 'third', pov: 'limited' } }] } };
}

it('reviews only the chosen completed private run with no main or other-scene material', () => {
  const session = fixture(), run = parallel(session), other = structuredClone(run);
  other.id = 'other-run'; other.sceneId = 'other-scene'; other.material.acceptedBehaviors[0].text = 'OTHER_SCENE_CANARY';
  session.parallelRuns = [run, other];
  const selected = { kind: 'parallel', runId: run.id, renderAttemptId: 'render-private' } as const;
  const context = buildProseReviewContext(session, selected, current()), encoded = JSON.stringify(context);
  expect(context.material.references.map(ref => ref.ref)).toEqual(['scene:location', 'scene:time', 'scene:cast', 'behavior:side-speech', 'fact:side-fact']);
  expect(encoded).toContain('PRIVATE_SCENE_APPROVED'); expect(encoded).toContain('A paper falls');
  expect(encoded).not.toMatch(/OTHER_SCENE|TODAY_|Exact user|Exact approved local|terminal result|AUTHOR_INSTRUCTION|PRIVATE_KNOWLEDGE|PUBLIC_DRAFT_SUMMARY/);
  expect(parseProseReviewContext(context)).toEqual(context);
  (run.material.events[0].data as Record<string, unknown>).runId = 'other-run';
  expect(() => buildProseReviewContext(session, selected)).toThrow('crosses');
  expect(proseReviewTargets(session).find(info => info.target.kind === 'parallel' && info.target.runId === run.id)).toMatchObject({ available: false, reason: expect.any(String) });
});

it('marks missing material anchors and unfinished parallel drafts unavailable with a reason', () => {
  const session = fixture(); session.events = session.events.filter(event => event.kind !== 'narration-material' && event.kind !== 'world-adjudication');
  const run = parallel(session); run.render.attempts[0].status = 'failed'; delete run.render.attempts[0].prose; session.parallelRuns = [run];
  expect(proseReviewTargets(session).find(info => info.target.kind === 'main' && info.target.entryId === 'draft')).toMatchObject({ available: false, reason: expect.stringContaining('not recorded') });
  expect(proseReviewTargets(session).find(info => info.target.kind === 'main' && info.target.entryId === 'old-draft')).toMatchObject({ available: false, reason: expect.stringContaining('anchor') });
  expect(proseReviewTargets(session).some(info => info.target.kind === 'parallel')).toBe(false);
  expect(() => buildProseReviewContext(session, { kind: 'parallel', runId: run.id, renderAttemptId: run.render.attempts[0].id })).toThrow('completed');
});

it('rejects unavailable or blank saved prose instead of offering a title-only review of missing body text', () => {
  for (const text of [undefined, '', '   ']) {
    const session = fixture(), entry = session.prose.at(-1)!; delete entry.body;
    (entry as unknown as { text: unknown }).text = text;
    expect(() => buildProseReviewContext(session, target)).toThrow('unavailable or empty');
    expect(proseReviewTargets(session).find(info => info.target.kind === 'main' && info.target.entryId === 'draft'))
      .toMatchObject({ available: false, reason: expect.stringContaining('unavailable or empty') });
  }
});
