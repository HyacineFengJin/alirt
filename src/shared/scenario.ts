import type { Condition } from './types';

export interface ScenarioChapter {
  id: string;
  title: string;
  prerequisites: string[];
  bindingIds: string[];
  completeWhen?: Condition;
}

/** Chapter definitions belong to a card; progress belongs to a session. */
export interface ScenarioDefinition {
  schema: 'rp.scenario/0.1';
  id: string;
  title: string;
  chapters: ScenarioChapter[];
}

export interface ScenarioProgress {
  scenarioId: string;
  currentChapterId: string | null;
  completedChapterIds: string[];
}

export interface ScenarioCommand {
  requestId: string;
  expectedRevision: number;
  reason: string;
  operation: 'start' | 'complete' | 'abandon';
  chapterId: string;
}

export interface ScenarioChapterView {
  id: string;
  title: string;
  prerequisites: string[];
  bindingIds: string[];
  status: 'active' | 'completed' | 'available' | 'locked';
  missingPrerequisites: string[];
  canStart: boolean;
  canComplete: boolean;
  canAbandon: boolean;
  completionStatus: 'true' | 'false' | 'unknown' | 'manual';
}

export interface ScenarioView {
  revision: number;
  definition?: ScenarioDefinition;
  progress?: ScenarioProgress;
  chapters: ScenarioChapterView[];
}

/** A positive current-chapter comparison must be necessary, not merely one
 * alternative. Only conjunctions preserve that guarantee; any/not never do.
 */
export function scenarioRequiresCurrentChapter(condition: unknown, chapterId: string): boolean {
  function required(value: unknown, depth: number): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 100) return false;
    const node = value as Record<string, unknown>;
    if (Object.hasOwn(node, 'any') || Object.hasOwn(node, 'not')) return false;
    if (Object.hasOwn(node, 'all')) return Array.isArray(node.all) && node.all.some(child => required(child, depth + 1));
    return node.path === 'scenario.currentChapterId'
      && (Object.hasOwn(node, 'op') ? node.op === 'eq' && node.value === chapterId : node.equals === chapterId);
  }
  return required(condition, 0);
}
