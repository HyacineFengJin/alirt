import { evaluateNativeCondition, validateNativeDocument } from '../shared/native';
import type { CharacterCard, ScenarioCommand, ScenarioProgress, ScenarioView } from '../shared/types';
import type { StoredSession } from './store';

export class ScenarioError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); this.name = 'ScenarioError'; }
}
function fail(code: string, message: string): never { throw new ScenarioError(code, message); }

/** Source definitions are author data; they cannot replace committed world facts. */
export function initialScenarioProgress(card: CharacterCard): ScenarioProgress | undefined {
  if (!card.scenario) return;
  if (validateNativeDocument('card', card).length) fail('SCENARIO_DEFINITION', 'The scenario card has invalid definitions; review the native document.');
  return { scenarioId: card.scenario.id, currentChapterId: null, completedChapterIds: [] };
}

export function assertScenarioProgress(session: Pick<StoredSession, 'card' | 'scenario'>) {
  const definition = session.card.scenario, progress = session.scenario;
  if (!definition) {
    if (progress) fail('SCENARIO_PROGRESS', 'Scenario progress has no matching definition.');
    return;
  }
  if (validateNativeDocument('card', session.card).length) fail('SCENARIO_DEFINITION', 'The scenario card has invalid definitions; review the native document.');
  if (!progress || progress.scenarioId !== definition.id || !Array.isArray(progress.completedChapterIds)
    || progress.currentChapterId !== null && typeof progress.currentChapterId !== 'string')
    fail('SCENARIO_PROGRESS', 'Scenario progress does not match its definition.');
  const chapters = new Map(definition.chapters.map(chapter => [chapter.id, chapter]));
  const completed = new Set(progress.completedChapterIds);
  if (completed.size !== progress.completedChapterIds.length || [...completed].some(id => typeof id !== 'string' || !chapters.has(id)))
    fail('SCENARIO_PROGRESS', 'Completed chapters contain duplicate or unknown entries.');
  for (const id of completed) if (chapters.get(id)!.prerequisites.some(required => !completed.has(required)))
    fail('SCENARIO_PROGRESS', 'Completed chapter prerequisites are inconsistent.');
  if (progress.currentChapterId !== null) {
    const chapter = chapters.get(progress.currentChapterId);
    if (!chapter || completed.has(chapter.id) || chapter.prerequisites.some(required => !completed.has(required)))
      fail('SCENARIO_PROGRESS', 'The active chapter or its prerequisites are inconsistent.');
  }
}

/** This view is only for the world selector and the author controller, never role/prose input. */
export function scenarioPromptProgress(session: Pick<StoredSession, 'card' | 'scenario'>) {
  assertScenarioProgress(session);
  return session.scenario ? structuredClone(session.scenario) : undefined;
}

export function readScenario(session: StoredSession): ScenarioView {
  assertScenarioProgress(session);
  const definition = session.card.scenario, progress = session.scenario;
  if (!definition || !progress) return { revision: session.revision, chapters: [] };
  const completed = new Set(progress.completedChapterIds);
  const snapshot = { world: structuredClone(session.world), scenario: structuredClone(progress),
    roles: Object.fromEntries(session.roles.map(role => [role.id, { id: role.id, state: structuredClone(role.state), phase: role.phase, presence: role.presence }])) };
  return { revision: session.revision, definition: structuredClone(definition), progress: structuredClone(progress),
    chapters: definition.chapters.map(chapter => {
      const active = progress.currentChapterId === chapter.id;
      const missingPrerequisites = chapter.prerequisites.filter(id => !completed.has(id));
      const completionStatus = chapter.completeWhen ? evaluateNativeCondition(chapter.completeWhen, { snapshot }).status : 'manual';
      return { id: chapter.id, title: chapter.title, prerequisites: [...chapter.prerequisites], bindingIds: [...chapter.bindingIds],
        status: active ? 'active' : completed.has(chapter.id) ? 'completed' : missingPrerequisites.length ? 'locked' : 'available',
        missingPrerequisites, canStart: !progress.currentChapterId && !completed.has(chapter.id) && !missingPrerequisites.length,
        canComplete: active && (completionStatus === 'manual' || completionStatus === 'true'), canAbandon: active, completionStatus };
    }) };
}

export function parseScenarioCommand(value: unknown): ScenarioCommand {
  const allowed = ['requestId', 'expectedRevision', 'reason', 'operation', 'chapterId'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length)
    fail('SCENARIO_INPUT', 'Provide a scenario command object.');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value)))
    if (!allowed.includes(key) || !('value' in descriptor)) fail('SCENARIO_INPUT', 'Scenario command contains an unsupported field.');
  const input = value as ScenarioCommand;
  for (const key of ['requestId', 'reason', 'chapterId'] as const)
    if (typeof input[key] !== 'string' || !input[key].trim()) fail('SCENARIO_INPUT', 'Scenario commands require a request ID, chapter ID and reason.');
  if (!Number.isSafeInteger(input.expectedRevision) || !['start', 'complete', 'abandon'].includes(input.operation))
    fail('SCENARIO_INPUT', 'Select a valid scenario operation and revision.');
  return { requestId: input.requestId, expectedRevision: input.expectedRevision, reason: input.reason, operation: input.operation, chapterId: input.chapterId };
}

/** Pure proposal: no save, clock advance, model call or world/role mutation. */
export function proposeScenarioCommand(session: StoredSession, input: ScenarioCommand): ScenarioProgress {
  const view = readScenario(session);
  if (!view.progress) fail('SCENARIO_UNAVAILABLE', 'This story has no chapter controller.');
  const chapter = view.chapters.find(chapter => chapter.id === input.chapterId);
  if (!chapter) fail('SCENARIO_CHAPTER', 'Unknown chapter.');
  const next = structuredClone(view.progress);
  switch (input.operation) {
    case 'start':
      if (next.currentChapterId) fail('SCENARIO_ACTIVE', 'Finish or leave the current chapter before starting another.');
      if (chapter.status === 'completed') fail('SCENARIO_COMPLETED', 'This chapter is already complete.');
      if (chapter.missingPrerequisites.length) fail('SCENARIO_PREREQUISITES', 'Complete the prerequisite chapters first.');
      next.currentChapterId = chapter.id;
      break;
    case 'complete':
      if (next.currentChapterId !== chapter.id) fail('SCENARIO_NOT_ACTIVE', 'Only the current chapter can be completed.');
      if (!chapter.canComplete) fail('SCENARIO_COMPLETION', 'The declared completion condition is false or unknown.');
      next.completedChapterIds.push(chapter.id); next.currentChapterId = null;
      break;
    case 'abandon':
      if (next.currentChapterId !== chapter.id) fail('SCENARIO_NOT_ACTIVE', 'Only the current chapter can be left.');
      next.currentChapterId = null;
      break;
  }
  return next;
}
