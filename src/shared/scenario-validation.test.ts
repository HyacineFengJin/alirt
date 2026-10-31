import { describe, expect, it } from 'vitest';
import { describeCreatorFormat } from '../server/creator-format';
import { createNativeTemplate, materializeNativeDocument, validateNativeDocument } from './native';
import { scenarioRequiresCurrentChapter } from './scenario';
import type { CharacterCard, Condition, ScenarioChapter } from './types';

const chapter = (id = 'arrival', overrides: Partial<ScenarioChapter> = {}): ScenarioChapter => ({ id, title: id, prerequisites: [], bindingIds: [], ...overrides });
const gate = (id = 'arrival'): Condition => ({ path: 'scenario.currentChapterId', equals: id });
function card(): CharacterCard {
  const value = createNativeTemplate('card') as CharacterCard;
  value.modules = [{ id: 'arrival-text', title: 'Arrival', category: 'supplement', content: 'Possible arrival developments.', enabled: true, targets: ['world'], phase: 'coordinate', priority: 0 }];
  value.worldbook = { schema: 'rp.worldbook/0.1', bindings: [{ id: 'arrival-plan', moduleId: 'arrival-text', purpose: 'scenario-plan', when: gate() }] };
  value.scenario = { schema: 'rp.scenario/0.1', id: 'harbor', title: 'Harbor', chapters: [chapter('arrival', { bindingIds: ['arrival-plan'] }), chapter('records', { prerequisites: ['arrival'] })] };
  value.panels = [{ id: 'chapters', title: 'Chapters', kind: 'scenario', side: 'right' }];
  return value;
}
const paths = (value: unknown) => validateNativeDocument('card', value).map(issue => issue.path);

describe('native scenario definitions', () => {
  it('accepts chapter workflows with empty bindings and preserves unknown JSON and module bodies', () => {
    const value = card();
    (value.scenario as any).extension = { exact: 'untouched' };
    (value.scenario!.chapters[0] as any).source = { text: 'Original metadata' };
    value.scenario!.chapters[0].completeWhen = { all: [{ path: 'world.variables.ready', op: 'eq', value: true }, { not: { path: 'world.variables.closed', equals: true } }] };
    const before = structuredClone(value);
    expect(validateNativeDocument('card', value)).toEqual([]);
    expect(value).toEqual(before); expect(materializeNativeDocument(value)).toEqual(before);
  });

  it('requires scenario shape, nonempty unique IDs and nonempty chapter collections', () => {
    for (const [scenario, expected] of [
      [null, '/scenario'],
      [{ ...card().scenario, schema: 'rp.scenario/next' }, '/scenario/schema'],
      [{ ...card().scenario, id: '' }, '/scenario/id'],
      [{ ...card().scenario, title: '' }, '/scenario/title'],
      [{ ...card().scenario, chapters: [] }, '/scenario/chapters'],
      [{ ...card().scenario, chapters: [null] }, '/scenario/chapters/0'],
      [{ ...card().scenario, chapters: [chapter('')] }, '/scenario/chapters/0/id'],
      [{ ...card().scenario, chapters: [chapter(), chapter()] }, '/scenario/chapters/1/id'],
      [{ ...card().scenario, chapters: [chapter('arrival', { title: '' })] }, '/scenario/chapters/0/title'],
    ] as const) expect(paths({ ...card(), scenario })).toContain(expected);
    expect(paths({ ...card(), scenario: { ...card().scenario, chapters: [{ id: 'one', title: 'One' }] } })).toEqual(expect.arrayContaining(['/scenario/chapters/0/prerequisites', '/scenario/chapters/0/bindingIds']));
  });

  it('rejects unknown, empty, duplicate and self prerequisites and multi-node cycles', () => {
    const value = card();
    value.scenario!.chapters[0].prerequisites = ['missing', '', 'arrival', 'missing'];
    expect(paths(value)).toEqual(expect.arrayContaining([0, 1, 2, 3].map(index => `/scenario/chapters/0/prerequisites/${index}`)));
    value.scenario!.chapters = [chapter('a', { prerequisites: ['b'] }), chapter('b', { prerequisites: ['c'] }), chapter('c', { prerequisites: ['a'] })];
    expect(paths(value)).toContain('/scenario/chapters/2/prerequisites/0');
    value.scenario!.chapters = [chapter('a'), chapter('b', { prerequisites: ['a'] }), chapter('c', { prerequisites: ['a', 'b'] })];
    expect(paths(value)).toEqual([]);
  });

  it('requires each binding to be a local scenario-plan owned once across all chapters', () => {
    const value = card();
    value.scenario!.chapters[0].bindingIds = ['arrival-plan', 'arrival-plan', 'missing', ''];
    value.scenario!.chapters[1].bindingIds = ['arrival-plan'];
    expect(paths(value)).toEqual(expect.arrayContaining(['/scenario/chapters/0/bindingIds/1', '/scenario/chapters/0/bindingIds/2', '/scenario/chapters/0/bindingIds/3', '/scenario/chapters/1/bindingIds/0']));
    value.scenario!.chapters = [chapter('arrival', { bindingIds: ['arrival-plan'] })];
    value.worldbook!.bindings[0].purpose = 'reference';
    expect(paths(value)).toContain('/scenario/chapters/0/bindingIds/0');
    delete value.worldbook;
    expect(paths(value)).toContain('/scenario/chapters/0/bindingIds/0');
  });

  it('requires a positive chapter gate directly or under all, preserving additional guards', () => {
    const value = card();
    const extra: Condition = { path: 'world.variables.ready', equals: true };
    const valid: Condition[] = [gate(), { path: 'scenario.currentChapterId', op: 'eq', value: 'arrival' }, { all: [extra, { all: [gate(), { any: [extra] }] }] }];
    const invalid: Condition[] = [gate('records'), { path: 'world.variables.chapter', equals: 'arrival' }, { any: [gate(), extra] }, { not: { not: gate() } }, { all: [{ any: [gate()] }, extra] }, { path: 'scenario.currentChapterId', op: 'neq', value: 'arrival' }];
    for (const when of valid) {
      value.worldbook!.bindings[0].when = when;
      expect(paths(value)).toEqual([]); expect(scenarioRequiresCurrentChapter(when, 'arrival')).toBe(true);
    }
    for (const when of invalid) {
      value.worldbook!.bindings[0].when = when;
      expect(paths(value)).toContain('/scenario/chapters/0/bindingIds/0'); expect(scenarioRequiresCurrentChapter(when, 'arrival')).toBe(false);
    }
    delete value.worldbook!.bindings[0].when;
    expect(paths(value)).toEqual(expect.arrayContaining(['/worldbook/bindings/0/when', '/scenario/chapters/0/bindingIds/0']));
  });

  it('validates completeWhen with the existing condition schema and role references', () => {
    const value = card();
    for (const [completeWhen, expected] of [
      [{ path: 'world.variables.ready', op: 'in', value: true }, '/scenario/chapters/0/completeWhen/value'],
      [{ path: 'role.id', equals: 'missing' }, '/scenario/chapters/0/completeWhen/equals'],
      [{ all: [], any: [] }, '/scenario/chapters/0/completeWhen'],
      [{ path: 'world.constructor.secret', equals: true }, '/scenario/chapters/0/completeWhen/path'],
    ] as const) {
      value.scenario!.chapters[0].completeWhen = completeWhen as Condition;
      expect(paths(value)).toContain(expected);
    }
  });

  it('documents scenario panels and card definitions without adding a preset definition', () => {
    const guide = describeCreatorFormat('card');
    if (!('card' in guide)) throw new Error('Card guide is missing');
    expect(guide.card.panels.kind).toContain('scenario');
    expect(guide.card.scenario.schema).toBe('rp.scenario/0.1');
    expect('card' in describeCreatorFormat('preset')).toBe(false);
  });
});
