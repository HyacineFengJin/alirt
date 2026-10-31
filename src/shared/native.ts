import { validateCatalogMapping } from './catalog';
import type { CreativeKind, DraftIssue, NativeDocument } from './creator';
import type { Condition, PromptActivation, PromptModule } from './types';
import type { ConditionResult } from './prompt-runtime';
import { WORLDBOOK_PURPOSES } from './worldbook';
import { validateRoleStageTemplate } from './role-stage';
import { scenarioRequiresCurrentChapter } from './scenario';
import { validateStateFieldDefinition, validateStateFieldValue } from './state-value-schema';
import { validCardVisualDefaults } from './visual-assets';

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const pointer = (path: string, key: string | number) => `${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;

/** Diagnostics only: neither accepted nor unknown fields are stripped, normalized or coerced. */
export function validateNativeDocument(kind: CreativeKind, value: unknown): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const issue = (path: string, message: string) => issues.push({ path: path || '/', message });
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  function json(node: unknown, path: string, depth = 0): void {
    if (++nodes > 100000 || depth > 100) { issue(path, 'Document exceeds the supported structural depth or size'); return; }
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return;
    if (typeof node === 'number') { if (!Number.isFinite(node)) issue(path, 'JSON numbers must be finite'); return; }
    if (typeof node !== 'object') { issue(path, 'Expected JSON data'); return; }
    if (ancestors.has(node)) { issue(path, 'Circular data is not a native JSON document'); return; }
    const proto = Object.getPrototypeOf(node);
    if (Array.isArray(node) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) { issue(path, 'Expected a plain JSON object or array'); return; }
    ancestors.add(node);
    if (Array.isArray(node)) {
      if (node.length > 100000) { issue(path, 'Array exceeds the supported size'); ancestors.delete(node); return; }
      for (let i = 0; i < node.length; i++) if (!Object.hasOwn(node, i)) issue(pointer(path, i), 'Sparse arrays are not native JSON data');
    }
    const descriptors = Object.getOwnPropertyDescriptors(node);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(node) && key === 'length') continue;
      if (Array.isArray(node) && !/^(?:0|[1-9][0-9]*)$/.test(key)) issue(pointer(path, key), 'Named array properties are not JSON data');
      if (forbidden.has(key)) issue(pointer(path, key), 'Reserved prototype key is not allowed');
      if (!descriptor.enumerable) issue(pointer(path, key), 'Hidden properties are not JSON data');
      if (!('value' in descriptor)) issue(pointer(path, key), 'Accessors are not JSON data');
      else json(descriptor.value, pointer(path, key), depth + 1);
    }
    if (Object.getOwnPropertySymbols(node).length) issue(path, 'Symbol keys are not JSON data');
    ancestors.delete(node);
  }
  json(value, '');
  // Do not evaluate accessors or traverse non-JSON input during schema diagnostics.
  if (issues.length) return issues;
  const obj = (node: unknown, path: string): Record<string, unknown> | undefined => { if (!record(node)) { issue(path, 'Expected object'); return; } return node; };
  const str = (node: unknown, path: string, nonempty = false): node is string => {
    if (typeof node !== 'string' || nonempty && !node.trim()) { issue(path, nonempty ? 'Expected nonempty string' : 'Expected string'); return false; } return true;
  };
  const bool = (node: unknown, path: string) => { if (typeof node !== 'boolean') issue(path, 'Expected boolean'); };
  const finite = (node: unknown, path: string) => { if (typeof node !== 'number' || !Number.isFinite(node)) issue(path, 'Expected finite number'); };
  const enumeration = (node: unknown, options: readonly string[], path: string) => { if (typeof node !== 'string' || !options.includes(node)) issue(path, `Expected one of: ${options.join(', ')}`); };
  const array = (node: unknown, path: string): unknown[] => { if (!Array.isArray(node)) { issue(path, 'Expected array'); return []; } return node; };
  const strings = (node: unknown, path: string): string[] => array(node, path).filter((entry, i): entry is string => str(entry, pointer(path, i)));
  const identifier = (node: unknown, path: string): node is string => { if (!str(node, path, true)) return false; if (forbidden.has(node)) { issue(path, 'Reserved identifier'); return false; } if (/[\/\\\u0000-\u001f\u007f-\u009f]/.test(node)) { issue(path, 'Identifiers cannot contain path separators or control characters'); return false; } return true; };
  function unique(values: unknown[], key: string, path: string) {
    const seen = new Set<string>();
    values.forEach((entry, i) => { if (!record(entry)) return; const id = entry[key]; if (identifier(id, pointer(pointer(path, i), key))) { if (seen.has(id)) issue(pointer(pointer(path, i), key), 'Duplicate identifier'); seen.add(id); } });
    return seen;
  }
  const document = obj(value, ''); if (!document) return issues;
  enumeration(document.schema, [kind === 'card' ? 'rp.card/0.1' : 'rp.preset/0.1'], '/schema');
  identifier(document.id, '/id'); str(document.title, '/title', true); str(document.description, '/description');
  const roles = kind === 'card' ? array(document.roles, '/roles') : [];
  const roleIds = kind === 'card' ? unique(roles, 'id', '/roles') : undefined;
  if (Object.hasOwn(document, 'visuals')) {
    if (kind !== 'card' || !validCardVisualDefaults(document.visuals)) issue('/visuals', 'Expected a native card dialogue-avatar defaults contract');
    else for (const [index, entry] of document.visuals.defaults.entries())
      if (!roleIds?.has(entry.roleId) || !roles.some(role => record(role) && role.id === entry.roleId && role.name === entry.roleName)) issue(`/visuals/defaults/${index}`, 'Visual defaults require the exact declared role ID and name');
  }
  function audience(node: unknown, path: string) {
    if (node === 'public' || node === 'author') return;
    const ids = strings(node, path); const seen = new Set<string>();
    ids.forEach((id, i) => { if (forbidden.has(id) || roleIds && !roleIds.has(id)) issue(pointer(path, i), 'Unknown role audience'); if (seen.has(id)) issue(pointer(path, i), 'Duplicate role audience'); seen.add(id); });
  }
  function condition(node: unknown, path: string, depth = 0) {
    if (depth > 100) { issue(path, 'Condition nesting is too deep'); return; }
    const value = obj(node, path); if (!value) return;
    const variants = ['path', 'all', 'any', 'not'].filter(key => Object.hasOwn(value, key));
    if (variants.length !== 1) { issue(path, 'Condition requires exactly one of path, all, any, not'); return; }
    if (variants[0] !== 'path') {
      if (Object.hasOwn(value, 'equals') || Object.hasOwn(value, 'op') || Object.hasOwn(value, 'value')) issue(path, 'Logical conditions cannot also contain comparison fields');
      if (variants[0] === 'not') condition(value.not, pointer(path, 'not'), depth + 1);
      else array(value[variants[0]], pointer(path, variants[0])).forEach((entry, i) => condition(entry, pointer(pointer(path, variants[0]), i), depth + 1));
      return;
    }
    if (str(value.path, pointer(path, 'path'), true) && value.path.split('.').some(segment => !segment || forbidden.has(segment))) issue(pointer(path, 'path'), 'Unsafe or empty condition path segment');
    if (Object.hasOwn(value, 'op')) {
      enumeration(value.op, ['exists', 'eq', 'neq', 'in', 'contains', 'gt', 'gte', 'lt', 'lte'], pointer(path, 'op'));
      if (Object.hasOwn(value, 'equals')) issue(path, 'Condition cannot combine equals with op');
      if (value.op === 'exists') { if (Object.hasOwn(value, 'value')) issue(pointer(path, 'value'), 'exists does not accept a comparison value'); }
      else if (!Object.hasOwn(value, 'value')) issue(pointer(path, 'value'), 'Comparison requires a value');
      if (value.op === 'in' && !Array.isArray(value.value)) issue(pointer(path, 'value'), 'in requires an array value');
      if (['gt', 'gte', 'lt', 'lte'].includes(value.op as string)) finite(value.value, pointer(path, 'value'));
      if (value.path === 'role.id' && ['eq', 'neq'].includes(value.op as string) && (typeof value.value !== 'string' || roleIds && !roleIds.has(value.value))) issue(pointer(path, 'value'), 'Unknown condition role');
      if (value.path === 'role.id' && value.op === 'in' && Array.isArray(value.value)) value.value.forEach((id, i) => { if (typeof id !== 'string' || roleIds && !roleIds.has(id)) issue(pointer(pointer(path, 'value'), i), 'Unknown condition role'); });
    } else {
      if (!Object.hasOwn(value, 'equals')) issue(pointer(path, 'equals'), 'Condition requires an equals value or operator');
      if (Object.hasOwn(value, 'value')) issue(pointer(path, 'value'), 'value requires an operator');
      if (value.path === 'role.id' && (typeof value.equals !== 'string' || roleIds && !roleIds.has(value.equals))) issue(pointer(path, 'equals'), 'Unknown condition role');
    }
  }
  const modules = array(document.modules, '/modules'), moduleIds = unique(modules, 'id', '/modules');
  if (Object.hasOwn(document, 'proseFormat')) {
    const format = obj(document.proseFormat, '/proseFormat');
    if (format) {
      for (const key of Object.keys(format)) if (!['schema', 'dialogue'].includes(key)) issue(`/proseFormat/${key}`, 'Unsupported prose format field');
      enumeration(format.schema, ['rp.prose-format/0.1'], '/proseFormat/schema');
      const dialogue = obj(format.dialogue, '/proseFormat/dialogue');
      if (dialogue) {
        for (const key of Object.keys(dialogue)) if (!['module', 'renderer', 'source'].includes(key)) issue(`/proseFormat/dialogue/${key}`, 'Unsupported dialogue format field');
        if (identifier(dialogue.module, '/proseFormat/dialogue/module') && !moduleIds.has(dialogue.module)) issue('/proseFormat/dialogue/module', 'Expected a local prompt module ID in this document');
        enumeration(dialogue.renderer, ['character-dialogue'], '/proseFormat/dialogue/renderer');
        if (Object.hasOwn(dialogue, 'source')) {
          const source = obj(dialogue.source, '/proseFormat/dialogue/source');
          if (source) {
            for (const key of Object.keys(source)) if (!['importId', 'pointer'].includes(key)) issue(`/proseFormat/dialogue/source/${key}`, 'Unsupported prose source field');
            str(source.importId, '/proseFormat/dialogue/source/importId', true);
            if (str(source.pointer, '/proseFormat/dialogue/source/pointer') && !/^(?:\/(?:[^~]|~[01])*)*$/.test(source.pointer)) issue('/proseFormat/dialogue/source/pointer', 'Expected a JSON Pointer');
          }
        }
      }
    }
  }
  modules.forEach((entry, i) => {
    const path = `/modules/${i}`, module = obj(entry, path); if (!module) return;
    str(module.title, `${path}/title`); str(module.content, `${path}/content`); bool(module.enabled, `${path}/enabled`); finite(module.priority, `${path}/priority`);
    enumeration(module.category, ['model', 'style', 'constraint', 'supplement', 'protocol'], `${path}/category`);
    enumeration(module.phase, ['decide', 'coordinate', 'compose'], `${path}/phase`);
    const targets = array(module.targets, `${path}/targets`); if (!targets.length) issue(`${path}/targets`, 'At least one agent target is required');
    targets.forEach((target, j) => enumeration(target, ['role', 'world', 'prose'], `${path}/targets/${j}`));
    if (new Set(targets).size !== targets.length) issue(`${path}/targets`, 'Duplicate agent target');
    if (Object.hasOwn(module, 'condition')) condition(module.condition, `${path}/condition`);
    if (Object.hasOwn(module, 'audience')) audience(module.audience, `${path}/audience`);
    if (Object.hasOwn(module, 'required')) bool(module.required, `${path}/required`);
    if (Object.hasOwn(module, 'exclusiveGroup')) str(module.exclusiveGroup, `${path}/exclusiveGroup`, true);
    if (Object.hasOwn(module, 'dependsOn')) {
      const dependencies = strings(module.dependsOn, `${path}/dependsOn`), seen = new Set<string>();
      dependencies.forEach((dependency, j) => {
        const key = `${path}/dependsOn/${j}`;
        const localId = dependency.startsWith('card:') || dependency.startsWith('preset:') ? dependency.slice(dependency.indexOf(':') + 1) : dependency;
        identifier(localId, key);
        if (seen.has(dependency)) issue(key, 'Duplicate module dependency'); seen.add(dependency);
        if (dependency === module.id || dependency === `${kind}:${String(module.id)}`) issue(key, 'Module cannot depend on itself');
      });
    }
    if (Object.hasOwn(module, 'inject')) {
      const inject = obj(module.inject, `${path}/inject`);
      if (inject) { enumeration(inject.slot, ['system', 'before-context', 'after-context', 'before-action'], `${path}/inject/slot`); if (Object.hasOwn(inject, 'order')) finite(inject.order, `${path}/inject/order`); }
    }
    if (Object.hasOwn(module, 'sourcePointer')) str(module.sourcePointer, `${path}/sourcePointer`);
    if (Object.hasOwn(module, 'lifetime')) {
      const lifetime = obj(module.lifetime, `${path}/lifetime`);
      if (lifetime) {
        for (const key of ['once', 'recursive']) if (Object.hasOwn(lifetime, key)) bool(lifetime[key], `${path}/lifetime/${key}`);
        for (const key of ['stickyTurns', 'cooldownTurns', 'delayTurns']) if (Object.hasOwn(lifetime, key)) {
          const minimum = key === 'stickyTurns' ? 1 : 0, duration = lifetime[key];
          if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < minimum) issue(`${path}/lifetime/${key}`, `Expected safe integer at least ${minimum}`);
        }
        if (Object.hasOwn(lifetime, 'probability') && (typeof lifetime.probability !== 'number' || !Number.isFinite(lifetime.probability) || lifetime.probability < 0 || lifetime.probability > 1)) issue(`${path}/lifetime/probability`, 'Expected finite probability between 0 and 1');
      }
    }
    if (Object.hasOwn(module, 'activation')) {
      const activation = obj(module.activation, `${path}/activation`);
      if (activation) {
        strings(activation.keys, `${path}/activation/keys`);
        if (Object.hasOwn(activation, 'secondaryKeys')) strings(activation.secondaryKeys, `${path}/activation/secondaryKeys`);
        for (const key of ['selective', 'caseSensitive']) if (Object.hasOwn(activation, key)) bool(activation[key], `${path}/activation/${key}`);
        if (Object.hasOwn(activation, 'match')) enumeration(activation.match, ['substring', 'word'], `${path}/activation/match`);
      }
    }
  });
  if (Object.hasOwn(document, 'worldbook')) {
    const worldbook = obj(document.worldbook, '/worldbook');
    if (worldbook) {
      enumeration(worldbook.schema, ['rp.worldbook/0.1'], '/worldbook/schema');
      const bindings = array(worldbook.bindings, '/worldbook/bindings');
      unique(bindings, 'id', '/worldbook/bindings');
      const boundModules = new Set<string>();
      const sha256 = (node: unknown, path: string) => {
        // Shared validation is browser-compatible. Exact body verification is
        // performed by the server's worldbook admission gate.
        if (typeof node !== 'string' || !/^[a-f0-9]{64}$/i.test(node)) issue(path, 'Expected a 64-character SHA-256 hexadecimal hash');
      };
      bindings.forEach((entry, i) => {
        const path = `/worldbook/bindings/${i}`, binding = obj(entry, path); if (!binding) return;
        if (identifier(binding.moduleId, `${path}/moduleId`)) {
          if (!moduleIds.has(binding.moduleId)) issue(`${path}/moduleId`, 'Worldbook binding refers to an unknown module in this document');
          if (boundModules.has(binding.moduleId)) issue(`${path}/moduleId`, 'A module can have only one worldbook binding');
          boundModules.add(binding.moduleId);
        }
        enumeration(binding.purpose, WORLDBOOK_PURPOSES, `${path}/purpose`);
        if (Object.hasOwn(binding, 'when')) condition(binding.when, `${path}/when`);
        else if (binding.purpose === 'scenario-plan') issue(`${path}/when`, 'Scenario plans require an explicit condition');
        if (Object.hasOwn(binding, 'audience')) audience(binding.audience, `${path}/audience`);
        if (Object.hasOwn(binding, 'contentHash')) sha256(binding.contentHash, `${path}/contentHash`);
        if (Object.hasOwn(binding, 'catalog')) {
          const module = modules.find(entry => record(entry) && entry.id === binding.moduleId);
          for (const problem of validateCatalogMapping(binding.catalog, record(module) && typeof module.content === 'string' ? module.content : ''))
            issue(`${path}/catalog${problem.path}`, problem.message);
          if (kind !== 'card' || binding.purpose !== 'ui-data' || binding.audience !== 'author') issue(`${path}/catalog`, 'Catalog chapter references require author-only card UI data');
          if (!Object.hasOwn(binding, 'contentHash') || !Object.hasOwn(binding, 'source')) issue(`${path}/catalog`, 'Catalog references require complete source and body hash evidence');
        }
        if (Object.hasOwn(binding, 'roleStage')) {
          const stage = obj(binding.roleStage, `${path}/roleStage`);
          const module = modules.find(entry => record(entry) && entry.id === binding.moduleId);
          if (stage) {
            for (const problem of validateRoleStageTemplate(stage, record(module) && typeof module.content === 'string' ? module.content : ''))
              issue(`${path}/roleStage${problem.path}`, problem.message);
            if (kind !== 'card') issue(`${path}/roleStage`, 'Role stage templates belong to a card with explicit roles and fields');
            if (binding.purpose !== 'entity-profile') issue(`${path}/purpose`, 'Role stages require an entity-profile binding');
            if (!Object.hasOwn(binding, 'contentHash')) issue(`${path}/contentHash`, 'Role stages require a hash of the complete unchanged source body');
            if (!Array.isArray(binding.audience) || binding.audience.length !== 1 || binding.audience[0] !== stage.roleId)
              issue(`${path}/audience`, 'Role stages must be disclosed only to their owning role');
            if (!record(module) || module.phase !== 'decide' || !Array.isArray(module.targets) || module.targets.length !== 1 || module.targets[0] !== 'role')
              issue(`${path}/moduleId`, 'Role stages require a role/decide module');
            const owner = roles.find(entry => record(entry) && entry.id === stage.roleId);
            const declaredField = Array.isArray(document.fields) ? document.fields.find(entry => record(entry) && entry.key === stage.field) : undefined;
            if (!record(owner)) issue(`${path}/roleStage/roleId`, 'Unknown stage owner');
            if (!record(declaredField) || declaredField.type !== 'number' || !record(owner) || !record(owner.state) || typeof stage.field !== 'string' || !Object.hasOwn(owner.state, stage.field))
              issue(`${path}/roleStage/field`, 'Stage selection requires an initialized numeric field on the owning role');
          }
        }
        if (Object.hasOwn(binding, 'source')) {
          const source = obj(binding.source, `${path}/source`);
          if (source) {
            str(source.importId, `${path}/source/importId`, true);
            sha256(source.sourceHash, `${path}/source/sourceHash`);
            if (str(source.pointer, `${path}/source/pointer`) && !/^(?:\/(?:[^~]|~[01])*)*$/.test(source.pointer)) issue(`${path}/source/pointer`, 'Expected a JSON Pointer');
            if (Object.hasOwn(source, 'entryId')) {
              if (typeof source.entryId === 'number') finite(source.entryId, `${path}/source/entryId`);
              else str(source.entryId, `${path}/source/entryId`);
            }
          }
        }
      });
    }
  }
  if (kind === 'card' && Object.hasOwn(document, 'scenario')) {
    const scenario = obj(document.scenario, '/scenario');
    if (scenario) {
      enumeration(scenario.schema, ['rp.scenario/0.1'], '/scenario/schema');
      identifier(scenario.id, '/scenario/id'); str(scenario.title, '/scenario/title', true);
      const chapters = array(scenario.chapters, '/scenario/chapters');
      if (!chapters.length) issue('/scenario/chapters', 'Scenario requires at least one chapter');
      const chapterIds = unique(chapters, 'id', '/scenario/chapters');
      const chapterMap = new Map<string, Record<string, unknown>>();
      const prerequisites = new Map<string, { id: string; path: string }[]>();
      const worldbook = record(document.worldbook) ? document.worldbook : undefined;
      const bindings = new Map<string, Record<string, unknown>>();
      if (Array.isArray(worldbook?.bindings)) for (const binding of worldbook.bindings) {
        if (record(binding) && typeof binding.id === 'string' && !bindings.has(binding.id)) bindings.set(binding.id, binding);
      }
      const boundChapters = new Set<string>();
      chapters.forEach((entry, i) => {
        const path = `/scenario/chapters/${i}`, chapter = obj(entry, path); if (!chapter) return;
        str(chapter.title, `${path}/title`, true);
        const dependencies: { id: string; path: string }[] = [], seen = new Set<string>();
        array(chapter.prerequisites, `${path}/prerequisites`).forEach((dependency, j) => {
          const key = `${path}/prerequisites/${j}`;
          if (!identifier(dependency, key)) return;
          if (!chapterIds.has(dependency)) issue(key, 'Unknown prerequisite chapter');
          if (dependency === chapter.id) issue(key, 'Chapter cannot require itself');
          if (seen.has(dependency)) issue(key, 'Duplicate prerequisite chapter');
          seen.add(dependency); dependencies.push({ id: dependency, path: key });
        });
        if (typeof chapter.id === 'string' && !chapterMap.has(chapter.id)) {
          chapterMap.set(chapter.id, chapter); prerequisites.set(chapter.id, dependencies);
        }
        array(chapter.bindingIds, `${path}/bindingIds`).forEach((bindingId, j) => {
          const key = `${path}/bindingIds/${j}`;
          if (!identifier(bindingId, key)) return;
          const binding = bindings.get(bindingId);
          if (!binding || binding.purpose !== 'scenario-plan') issue(key, 'Chapter binding must reference a scenario-plan binding in this card');
          else if (typeof chapter.id === 'string' && !scenarioRequiresCurrentChapter(binding.when, chapter.id)) issue(key, 'Chapter binding requires a positive necessary scenario.currentChapterId condition matching this chapter');
          if (boundChapters.has(bindingId)) issue(key, 'A scenario binding can belong to only one chapter and cannot be repeated');
          boundChapters.add(bindingId);
        });
        if (Object.hasOwn(chapter, 'completeWhen')) condition(chapter.completeWhen, `${path}/completeWhen`);
      });
      // Iterative DFS keeps validation bounded by document size without using
      // the JavaScript call stack for long prerequisite chains.
      const colors = new Map<string, 'visiting' | 'done'>();
      for (const id of chapterMap.keys()) {
        if (colors.has(id)) continue;
        const stack = [{ id, next: 0 }]; colors.set(id, 'visiting');
        while (stack.length) {
          const frame = stack[stack.length - 1], dependencies = prerequisites.get(frame.id) ?? [];
          if (frame.next >= dependencies.length) { colors.set(frame.id, 'done'); stack.pop(); continue; }
          const dependency = dependencies[frame.next++];
          if (!chapterMap.has(dependency.id) || dependency.id === frame.id) continue;
          if (colors.get(dependency.id) === 'visiting') issue(dependency.path, 'Chapter prerequisite cycle');
          else if (!colors.has(dependency.id)) { colors.set(dependency.id, 'visiting'); stack.push({ id: dependency.id, next: 0 }); }
        }
      }
    }
  }
  if (Object.hasOwn(document, 'outputs')) {
    const outputs = array(document.outputs, '/outputs'); unique(outputs, 'id', '/outputs');
    outputs.forEach((entry, i) => {
      const path = `/outputs/${i}`, output = obj(entry, path); if (!output) return;
      str(output.title, `${path}/title`); str(output.instruction, `${path}/instruction`, true);
      enumeration(output.type, ['text', 'list', 'object'], `${path}/type`);
      bool(output.enabled, `${path}/enabled`); bool(output.required, `${path}/required`); finite(output.priority, `${path}/priority`);
      audience(output.audience, `${path}/audience`);
      if (Object.hasOwn(output, 'valueFrom')) {
        const source = obj(output.valueFrom, `${path}/valueFrom`);
        if (source) {
          enumeration(source.kind, ['world-time', 'world-location', 'state', 'approved-messages', 'world-publications', 'story-progress', 'parallel-scenes', 'viewed-carriers'], `${path}/valueFrom/kind`);
          const allowed = source.kind === 'state' ? ['kind', 'roleId', 'key'] : ['kind'];
          for (const key of Object.keys(source)) if (!allowed.includes(key)) issue(`${path}/valueFrom/${key}`, 'Unsupported state output selector field');
          if (source.kind === 'state') {
            if (identifier(source.roleId, `${path}/valueFrom/roleId`) && source.roleId !== 'world' && roleIds && !roleIds.has(source.roleId)) issue(`${path}/valueFrom/roleId`, 'Unknown state output owner');
            identifier(source.key, `${path}/valueFrom/key`);
          } else if (source.kind === 'world-publications') {
            if (output.type !== 'object' || output.audience !== 'public') issue(path, 'World publications require a public object contract');
            if (Object.hasOwn(output, 'module')) issue(`${path}/module`, 'World publication host contracts do not support module association; use an explicit public condition');
          } else if (source.kind === 'viewed-carriers') {
            if (output.type !== 'object') issue(`${path}/type`, 'Viewed carriers require an object output');
            if (output.audience !== 'public') issue(`${path}/audience`, 'This carrier slice requires public scene carriers');
            if (!record(output.display) || output.display.renderer !== 'viewed-carriers') issue(`${path}/display/renderer`, 'Viewed carriers require their trusted renderer');
          } else if (source.kind === 'parallel-scenes') {
            if (output.type !== 'object' || output.audience !== 'author') issue(path, 'Parallel scenes require an author-only host object contract');
            if (!record(output.display) || output.display.renderer !== 'parallel-scenes') issue(`${path}/display/renderer`, 'Parallel scenes require their trusted scene renderer');
          } else if (source.kind === 'story-progress') {
            if (output.type !== 'text' || output.audience !== 'public') issue(path, 'Story progress requires a public text contract');
          } else if (source.kind === 'approved-messages') {
            if (output.type !== 'object') issue(`${path}/type`, 'Approved messages require an object contract');
            if (!record(output.display) || output.display.renderer !== 'messages') issue(`${path}/display/renderer`, 'Approved messages require the trusted messages renderer');
          } else if (output.type !== 'text') issue(`${path}/type`, 'World time/location outputs require a text contract');
        }
      }
      const display = obj(output.display, `${path}/display`);
      if (display) {
        enumeration(display.placement, ['before-prose', 'after-prose', 'side-panel', 'hidden'], `${path}/display/placement`);
        if (Object.hasOwn(display, 'renderer')) enumeration(display.renderer, ['plain', 'choices', 'folded', 'sandbox-html', 'messages', 'parallel-scenes', 'viewed-carriers'], `${path}/display/renderer`);
        if (display.renderer === 'parallel-scenes' && (output.audience !== 'author' || output.type !== 'object' || !record(output.valueFrom) || output.valueFrom.kind !== 'parallel-scenes')) issue(`${path}/display/renderer`, 'Scene rendering requires the author-only parallel-scenes object selector');
        if (display.renderer === 'viewed-carriers' && (output.audience !== 'public' || output.type !== 'object' || !record(output.valueFrom) || output.valueFrom.kind !== 'viewed-carriers')) issue(`${path}/display/renderer`, 'Carrier rendering requires the public host viewed-carriers object selector');
        if (display.renderer === 'messages' && (output.type !== 'object' || !record(output.valueFrom) || output.valueFrom.kind !== 'approved-messages')) issue(`${path}/display/renderer`, 'Messages rendering requires the host approved-messages object selector');
        if (display.renderer === 'choices' && output.type !== 'list') issue(`${path}/display/renderer`, 'Choice outputs require a list contract');
        if (display.renderer === 'sandbox-html' && output.type !== 'text') issue(`${path}/display/renderer`, 'HTML outputs require a text contract');
        if (Object.hasOwn(display, 'history')) {
          const history = obj(display.history, `${path}/display/history`);
          if (history) {
            for (const key of ['minEntriesAgo', 'maxEntriesAgo']) if (Object.hasOwn(history, key) && (typeof history[key] !== 'number' || !Number.isSafeInteger(history[key]) || (history[key] as number) < 0)) issue(`${path}/display/history/${key}`, 'Expected a nonnegative safe integer');
            if (typeof history.minEntriesAgo === 'number' && typeof history.maxEntriesAgo === 'number' && history.minEntriesAgo > history.maxEntriesAgo) issue(`${path}/display/history`, 'History minimum cannot exceed maximum');
          }
        }
        if (Object.hasOwn(display, 'source')) {
          const source = obj(display.source, `${path}/display/source`);
          if (source) {
            str(source.importId, `${path}/display/source/importId`, true);
            if (str(source.pointer, `${path}/display/source/pointer`) && !/^(?:\/(?:[^~]|~[01])*)*$/.test(source.pointer)) issue(`${path}/display/source/pointer`, 'Expected a JSON Pointer');
            if (Object.hasOwn(source, 'tag')) str(source.tag, `${path}/display/source/tag`, true);
            for (const key of ['minDepth', 'maxDepth']) if (Object.hasOwn(source, key) && (typeof source[key] !== 'number' || !Number.isSafeInteger(source[key]) || (source[key] as number) < 0)) issue(`${path}/display/source/${key}`, 'Expected a nonnegative safe integer');
          }
        }
      }
      if (Object.hasOwn(output, 'condition')) condition(output.condition, `${path}/condition`);
      if (Object.hasOwn(output, 'module')) {
        if (str(output.module, `${path}/module`, true) && /^(?:card|preset):\s*$/.test(output.module)) issue(`${path}/module`, 'Expected nonempty module reference');
      }
    });
  }
  if (Object.hasOwn(document, 'compatibility')) {
    const compatibility = obj(document.compatibility, '/compatibility');
    if (compatibility) { str(compatibility.importId, '/compatibility/importId', true); str(compatibility.status, '/compatibility/status'); strings(compatibility.warnings, '/compatibility/warnings'); }
  }
  if (kind === 'preset') {
    const narration = obj(document.narration, '/narration');
    if (narration) { enumeration(narration.person, ['auto', 'first', 'third'], '/narration/person'); enumeration(narration.pov, ['auto', 'limited', 'omniscient'], '/narration/pov'); }
    return issues;
  }
  str(document.opening, '/opening');
  if (identifier(document.playerRoleId, '/playerRoleId') && !roleIds!.has(document.playerRoleId)) issue('/playerRoleId', 'Player role is not present');
  const world = obj(document.world, '/world');
  if (world) { str(world.location, '/world/location'); str(world.time, '/world/time'); obj(world.variables, '/world/variables'); }
  const fields = array(document.fields, '/fields'); unique(fields, 'key', '/fields');
  const fieldMap = new Map<string, Record<string, unknown>>();
  fields.forEach((entry, i) => {
    const path = `/fields/${i}`, field = obj(entry, path); if (!field) return;
    if (typeof field.key === 'string') fieldMap.set(field.key, field);
    str(field.label, `${path}/label`); enumeration(field.type, ['number', 'string', 'boolean', 'list'], `${path}/type`); bool(field.editable, `${path}/editable`); audience(field.audience, `${path}/audience`);
    if (Object.hasOwn(field, 'writableBy')) enumeration(field.writableBy, ['model', 'author', 'derived'], `${path}/writableBy`);
    for (const error of validateStateFieldDefinition(field)) issue(`${path}${error.path}`, error.message);
  });
  function state(node: unknown, path: string, allowMetadata: boolean) {
    const value = obj(node, path); if (!value) return;
    for (const [key, item] of Object.entries(value)) {
      const field = fieldMap.get(key); if (!field) { if (!allowMetadata) issue(pointer(path, key), 'State key has no declared field'); continue; }
      for (const error of validateStateFieldValue(field, item, { initial: true })) issue(`${pointer(path, key)}${error.path}`, error.message);
    }
  }
  if (world) state(world.variables, '/world/variables', true);
  function interaction(node: unknown, presence: unknown, path: string) {
    const value = obj(node, path); if (!value) return;
    enumeration(value.mode, ['local', 'remote'], `${path}/mode`);
    const allowed = value.mode === 'remote' ? ['mode', 'channel'] : ['mode'];
    for (const key of Object.keys(value)) if (!allowed.includes(key)) issue(`${path}/${key}`, 'Unknown interaction property');
    if (value.mode === 'remote') {
      enumeration(value.channel, ['message', 'screen', 'audio'], `${path}/channel`);
      if (presence !== 'absent') issue(path, 'Remote scene participation requires physical absence');
    }
  }
  roles.forEach((entry, i) => {
    const path = `/roles/${i}`, role = obj(entry, path); if (!role) return;
    str(role.name, `${path}/name`, true); str(role.persona, `${path}/persona`); strings(role.goals, `${path}/goals`);
    if (Object.hasOwn(role, 'personaSourcePointer')) {
      str(role.personaSourcePointer, `${path}/personaSourcePointer`);
      if (typeof role.personaSourcePointer === 'string') modules.forEach((entry, moduleIndex) => {
        if (record(entry) && entry.sourcePointer === role.personaSourcePointer && typeof entry.content === 'string' && typeof role.persona === 'string' && entry.content !== role.persona) issue(`/modules/${moduleIndex}/content`, `Text conflicts with linked ${path}/persona; edit both linked copies atomically, or remove the personaSourcePointer/sourcePointer association for intentionally separate instructions`);
      });
    }
    enumeration(role.phase, ['active', 'dormant', 'faded', 'retired'], `${path}/phase`); enumeration(role.presence, ['present', 'absent'], `${path}/presence`);
    if (Object.hasOwn(role, 'interaction')) interaction(role.interaction, role.presence, `${path}/interaction`);
    if (Object.hasOwn(role, 'stateMirrors')) {
      const mirrors = obj(role.stateMirrors, `${path}/stateMirrors`);
      if (mirrors) {
        for (const key of Object.keys(mirrors)) if (key !== 'presence') issue(`${path}/stateMirrors/${key}`, 'Unsupported structural mirror');
        if (identifier(mirrors.presence, `${path}/stateMirrors/presence`)) {
          if (fieldMap.get(mirrors.presence)?.type !== 'boolean') issue(`${path}/stateMirrors/presence`, 'A presence mirror requires a declared boolean field');
          if (!record(role.state) || !Object.hasOwn(role.state, mirrors.presence) || typeof role.state[mirrors.presence] !== 'boolean') issue(`${path}/stateMirrors/presence`, 'A presence mirror must be a boolean held by this role');
          else if (role.state[mirrors.presence] !== (role.presence === 'present')) issue(`${path}/stateMirrors/presence`, 'The explicit presence mirror disagrees with structural presence');
        }
      }
    }
    const peers = strings(role.peers, `${path}/peers`), seen = new Set<string>();
    peers.forEach((peer, j) => { if (!roleIds!.has(peer) || peer === role.id) issue(`${path}/peers/${j}`, 'Unknown or self peer reference'); if (seen.has(peer)) issue(`${path}/peers/${j}`, 'Duplicate peer reference'); seen.add(peer); });
    state(role.state, `${path}/state`, false);
    const knowledge = array(role.knowledge, `${path}/knowledge`); unique(knowledge, 'id', `${path}/knowledge`);
    knowledge.forEach((entry, j) => { const key = `${path}/knowledge/${j}`, item = obj(entry, key); if (item) {
      str(item.text, `${key}/text`); audience(item.audience, `${key}/audience`); enumeration(item.status, ['known', 'uncertain'], `${key}/status`);
      if (Object.hasOwn(item, 'lifecycle')) enumeration(item.lifecycle, ['active', 'withdrawn', 'stale'], `${key}/lifecycle`);
      if (Object.hasOwn(item, 'provenance')) {
        const provenance = obj(item.provenance, `${key}/provenance`);
        if (provenance) { str(provenance.sourceId, `${key}/provenance/sourceId`, true); strings(provenance.sourceRefs, `${key}/provenance/sourceRefs`); enumeration(provenance.kind, ['card', 'author', 'derived', 'peer'], `${key}/provenance/kind`);
          for (const property of ['receivedFrom', 'deliveryId']) if (Object.hasOwn(provenance, property)) str(provenance[property], `${key}/provenance/${property}`, true);
          if (Object.hasOwn(provenance, 'observation')) { const observation = obj(provenance.observation, `${key}/provenance/observation`);
            if (observation) { str(observation.eventId, `${key}/provenance/observation/eventId`, true); str(observation.sceneId, `${key}/provenance/observation/sceneId`, true); }
          }
        }
      }
    } });
  });
  if (Object.hasOwn(document, 'initialization')) {
    const initialization = obj(document.initialization, '/initialization');
    if (initialization) {
      enumeration(initialization.schema, ['rp.initialization/0.1'], '/initialization/schema');
      const openings = array(initialization.openings, '/initialization/openings');
      const profiles = array(initialization.playerProfiles, '/initialization/playerProfiles');
      if (!openings.length) issue('/initialization/openings', 'Initialization requires at least one opening');
      if (!profiles.length) issue('/initialization/playerProfiles', 'Initialization requires at least one player profile');
      const openingIds = unique(openings, 'id', '/initialization/openings');
      const profileIds = unique(profiles, 'id', '/initialization/playerProfiles');
      for (const [key, ids] of [['defaultOpeningId', openingIds], ['defaultPlayerProfileId', profileIds]] as const) {
        if (Object.hasOwn(initialization, key) && identifier(initialization[key], `/initialization/${key}`) && !ids.has(initialization[key])) issue(`/initialization/${key}`, 'Unknown initialization default');
      }
      const ownerStates = new Map<string, Record<string, unknown>>();
      if (world && record(world.variables)) ownerStates.set('world', world.variables);
      for (const role of roles) if (record(role) && typeof role.id === 'string' && record(role.state)) ownerStates.set(role.id, role.state);
      function initialState(node: unknown, path: string) {
        const seen = new Map<string, Set<string>>();
        array(node, path).forEach((entry, i) => {
          const key = `${path}/${i}`, change = obj(entry, key); if (!change) return;
          const ownerValid = identifier(change.roleId, `${key}/roleId`), fieldValid = identifier(change.key, `${key}/key`);
          const owner = ownerValid ? ownerStates.get(change.roleId as string) : undefined;
          if (ownerValid && !owner) issue(`${key}/roleId`, 'Unknown initialization state owner');
          const field = fieldValid ? fieldMap.get(change.key as string) : undefined;
          if (fieldValid && !field) issue(`${key}/key`, 'Unknown initialization state field');
          if (owner && fieldValid && !Object.hasOwn(owner, change.key as string)) issue(`${key}/key`, 'Initialization field must already be initialized for this owner');
          if (ownerValid && fieldValid) {
            const keys = seen.get(change.roleId as string) ?? new Set<string>();
            if (keys.has(change.key as string)) issue(`${key}/key`, 'Duplicate initialization owner and field in one layer');
            keys.add(change.key as string); seen.set(change.roleId as string, keys);
          }
          if (!Object.hasOwn(change, 'value')) issue(`${key}/value`, 'Initialization state requires a JSON value');
          else if (field) for (const error of validateStateFieldValue(field, change.value, { initial: true })) issue(`${key}/value${error.path}`, error.message);
        });
      }
      function initialSource(node: unknown, path: string) {
        const source = obj(node, path); if (!source) return;
        str(source.importId, `${path}/importId`, true);
        if (typeof source.sourceHash !== 'string' || !/^[a-f0-9]{64}$/i.test(source.sourceHash)) issue(`${path}/sourceHash`, 'Expected a 64-character SHA-256 hexadecimal hash');
        if (str(source.pointer, `${path}/pointer`) && !/^(?:\/(?:[^~]|~[01])*)*$/.test(source.pointer)) issue(`${path}/pointer`, 'Expected a JSON Pointer');
        if (Object.hasOwn(source, 'entryId')) {
          if (typeof source.entryId === 'number') finite(source.entryId, `${path}/entryId`);
          else str(source.entryId, `${path}/entryId`);
        }
      }
      openings.forEach((entry, i) => {
        const path = `/initialization/openings/${i}`, opening = obj(entry, path); if (!opening) return;
        str(opening.title, `${path}/title`, true); str(opening.text, `${path}/text`);
        if (Object.hasOwn(opening, 'instruction')) str(opening.instruction, `${path}/instruction`);
        if (Object.hasOwn(opening, 'delivery')) {
          const delivery = obj(opening.delivery, `${path}/delivery`);
          if (delivery) for (const target of ['world', 'prose']) if (Object.hasOwn(delivery, target)) str(delivery[target], `${path}/delivery/${target}`);
        }
        if (Object.hasOwn(opening, 'world')) {
          const location = obj(opening.world, `${path}/world`);
          if (location) for (const key of ['location', 'time']) if (Object.hasOwn(location, key)) str(location[key], `${path}/world/${key}`);
        }
        const cast = array(opening.cast, `${path}/cast`), seen = new Set<string>();
        cast.forEach((entry, j) => {
          const key = `${path}/cast/${j}`, member = obj(entry, key); if (!member) return;
          if (identifier(member.roleId, `${key}/roleId`)) {
            if (!roleIds!.has(member.roleId)) issue(`${key}/roleId`, 'Unknown opening cast role');
            if (seen.has(member.roleId)) issue(`${key}/roleId`, 'Duplicate opening cast role');
            seen.add(member.roleId);
          }
          enumeration(member.phase, ['active', 'dormant', 'faded', 'retired'], `${key}/phase`);
          enumeration(member.presence, ['present', 'absent'], `${key}/presence`);
          if (Object.hasOwn(member, 'interaction')) interaction(member.interaction, member.presence, `${key}/interaction`);
        });
        if ([...roleIds!].some(id => !seen.has(id))) issue(`${path}/cast`, 'Opening cast must explicitly include every card role, including the player');
        if (Object.hasOwn(opening, 'roleSelection')) {
          const selectorPath = `${path}/roleSelection`, selector = obj(opening.roleSelection, selectorPath);
          if (selector) {
            for (const key of Object.keys(selector)) if (!['kind', 'roleIds', 'min', 'max', 'nameToken', 'nameSeparator', 'selected', 'unselected', 'selectedState'].includes(key)) issue(`${selectorPath}/${key}`, 'Unknown role selection property');
            enumeration(selector.kind, ['role-subset'], `${selectorPath}/kind`);
            const candidates = array(selector.roleIds, `${selectorPath}/roleIds`), candidateIds = new Set<string>();
            if (!candidates.length) issue(`${selectorPath}/roleIds`, 'Role selection requires available roles');
            candidates.forEach((id, index) => {
              if (identifier(id, `${selectorPath}/roleIds/${index}`)) {
                if (candidateIds.has(id)) issue(`${selectorPath}/roleIds/${index}`, 'Duplicate selectable role');
                candidateIds.add(id);
                const role = roles.find(role => record(role) && role.id === id);
                if (!record(role) || role.phase === 'retired' || id === document.playerRoleId) issue(`${selectorPath}/roleIds/${index}`, 'Selectable role must be an available nonplayer identity');
              }
            });
            for (const bound of ['min', 'max']) if (!Number.isSafeInteger(selector[bound]) || (selector[bound] as number) < 1 || (selector[bound] as number) > candidates.length) issue(`${selectorPath}/${bound}`, 'Selection bound must be a positive integer within the candidate count');
            if (typeof selector.min === 'number' && typeof selector.max === 'number' && selector.min > selector.max) issue(`${selectorPath}/min`, 'Selection minimum exceeds maximum');
            if (typeof selector.nameToken !== 'string' || !/^\[\[[a-z][a-z0-9-]{0,63}\]\]$/.test(selector.nameToken)) issue(`${selectorPath}/nameToken`, 'Expected an explicit literal [[name-token]]');
            else if (![opening.instruction, ...(record(opening.delivery) ? [opening.delivery.world, opening.delivery.prose] : [])].some(text => typeof text === 'string' && text.includes(selector.nameToken as string))) issue(`${selectorPath}/nameToken`, 'Selection name token must occur in the instruction or delivery');
            if (str(selector.nameSeparator, `${selectorPath}/nameSeparator`) && (selector.nameSeparator as string).length > 32) issue(`${selectorPath}/nameSeparator`, 'Name separator is too long');
            for (const mode of ['selected', 'unselected']) {
              const member = obj(selector[mode], `${selectorPath}/${mode}`); if (!member) continue;
              for (const key of Object.keys(member)) if (!['phase', 'presence', 'interaction'].includes(key)) issue(`${selectorPath}/${mode}/${key}`, 'Unknown selection cast property');
              enumeration(member.phase, ['active', 'dormant', 'faded', 'retired'], `${selectorPath}/${mode}/phase`);
              enumeration(member.presence, ['present', 'absent'], `${selectorPath}/${mode}/presence`);
              if (Object.hasOwn(member, 'interaction')) interaction(member.interaction, member.presence, `${selectorPath}/${mode}/interaction`);
            }
            if (Object.hasOwn(selector, 'selectedState')) {
              const values = array(selector.selectedState, `${selectorPath}/selectedState`);
              values.forEach((value, index) => {
                if (record(value)) for (const key of Object.keys(value)) if (!['key', 'value'].includes(key)) issue(`${selectorPath}/selectedState/${index}/${key}`, 'Unknown selected state property');
              });
              for (const roleId of candidateIds) initialState(values.map(value => record(value) ? { ...value, roleId } : value), `${selectorPath}/selectedState`);
              if (Array.isArray(opening.state) && opening.state.some(change => record(change) && candidateIds.has(change.roleId as string) && values.some(value => record(value) && value.key === change.key))) issue(`${selectorPath}/selectedState`, 'Selected state must not duplicate an opening state target');
            }
          }
        }
        if (Object.hasOwn(opening, 'roleGroups')) {
          const groupsPath = `${path}/roleGroups`, groups = array(opening.roleGroups, groupsPath);
          if (Object.hasOwn(opening, 'roleSelection')) issue(groupsPath, 'Role groups and legacy role selection are mutually exclusive');
          if (!groups.length) issue(groupsPath, 'Role groups must contain at least one group');
          const earlier = new Map<string, Set<string>>(), tokens = new Set<string>(), ownership = new Map<string, string>();
          const stateDomain = (roleId: string, key: string) => JSON.stringify([roleId, 'state', key]);
          if (Array.isArray(opening.state)) for (const change of opening.state) if (record(change)) ownership.set(stateDomain(change.roleId as string, change.key as string), 'opening state');
          groups.forEach((entry, index) => {
            const groupPath = `${groupsPath}/${index}`, group = obj(entry, groupPath); if (!group) return;
            for (const key of Object.keys(group)) if (!['kind', 'id', 'title', 'roleIds', 'min', 'max', 'nameToken', 'nameSeparator', 'emptyName', 'complementNameToken', 'subsetOf', 'selectWithParent', 'selected', 'unselected', 'selectedState', 'unselectedState'].includes(key)) issue(`${groupPath}/${key}`, 'Unknown role group property');
            enumeration(group.kind, ['role-subset'], `${groupPath}/kind`);
            const validId = identifier(group.id, `${groupPath}/id`);
            if (validId && earlier.has(group.id as string)) issue(`${groupPath}/id`, 'Duplicate role group ID');
            str(group.title, `${groupPath}/title`, true);
            const candidates = array(group.roleIds, `${groupPath}/roleIds`), candidateIds = new Set<string>();
            if (!candidates.length) issue(`${groupPath}/roleIds`, 'Role group requires available candidates');
            candidates.forEach((id, candidateIndex) => {
              if (!identifier(id, `${groupPath}/roleIds/${candidateIndex}`)) return;
              if (candidateIds.has(id)) issue(`${groupPath}/roleIds/${candidateIndex}`, 'Duplicate selectable role');
              candidateIds.add(id);
              const role = roles.find(role => record(role) && role.id === id);
              if (!record(role) || role.phase === 'retired' || id === document.playerRoleId) issue(`${groupPath}/roleIds/${candidateIndex}`, 'Selectable role must be an available nonplayer identity');
            });
            for (const bound of ['min', 'max']) if (!Number.isSafeInteger(group[bound]) || (group[bound] as number) < 0 || (group[bound] as number) > candidates.length) issue(`${groupPath}/${bound}`, 'Group bound must be a nonnegative integer within the candidate count');
            if (typeof group.min === 'number' && typeof group.max === 'number' && group.min > group.max) issue(`${groupPath}/min`, 'Selection minimum exceeds maximum');
            for (const key of ['nameToken', ...(Object.hasOwn(group, 'complementNameToken') ? ['complementNameToken'] : [])]) {
              const token = group[key];
              if (typeof token !== 'string' || !/^\[\[[a-z][a-z0-9-]{0,63}\]\]$/.test(token)) issue(`${groupPath}/${key}`, 'Expected an explicit literal [[name-token]]');
              else {
                if (tokens.has(token)) issue(`${groupPath}/${key}`, 'Role group tokens must be distinct');
                tokens.add(token);
                if (![opening.instruction, ...(record(opening.delivery) ? [opening.delivery.world, opening.delivery.prose] : [])].some(text => typeof text === 'string' && text.includes(token))) issue(`${groupPath}/${key}`, 'Role group token must occur in the instruction or delivery');
              }
            }
            if (str(group.nameSeparator, `${groupPath}/nameSeparator`) && (group.nameSeparator as string).length > 32) issue(`${groupPath}/nameSeparator`, 'Name separator is too long');
            if (Object.hasOwn(group, 'emptyName')) str(group.emptyName, `${groupPath}/emptyName`);
            if (Object.hasOwn(group, 'subsetOf')) {
              const parent = typeof group.subsetOf === 'string' ? earlier.get(group.subsetOf) : undefined;
              if (!parent) issue(`${groupPath}/subsetOf`, 'Subset parent must be an earlier role group');
              else if ([...candidateIds].some(id => !parent.has(id))) issue(`${groupPath}/roleIds`, 'Subset candidates must belong to the parent candidate set');
            }
            if (Object.hasOwn(group, 'selectWithParent')) {
              bool(group.selectWithParent, `${groupPath}/selectWithParent`);
              if (!Object.hasOwn(group, 'subsetOf')) issue(`${groupPath}/selectWithParent`, 'Parent selection hint requires a subset parent');
            }
            const hasCast = Object.hasOwn(group, 'selected') || Object.hasOwn(group, 'unselected'), domains = new Set<string>();
            if (hasCast) {
              if (!Object.hasOwn(group, 'selected') || !Object.hasOwn(group, 'unselected')) issue(groupPath, 'Selected and unselected cast modes must both be present or both absent');
              for (const mode of ['selected', 'unselected']) {
                const member = obj(group[mode], `${groupPath}/${mode}`); if (!member) continue;
                for (const key of Object.keys(member)) if (!['phase', 'presence', 'interaction'].includes(key)) issue(`${groupPath}/${mode}/${key}`, 'Unknown role group cast property');
                enumeration(member.phase, ['active', 'dormant', 'faded', 'retired'], `${groupPath}/${mode}/phase`);
                enumeration(member.presence, ['present', 'absent'], `${groupPath}/${mode}/presence`);
                if (Object.hasOwn(member, 'interaction')) interaction(member.interaction, member.presence, `${groupPath}/${mode}/interaction`);
              }
              for (const roleId of candidateIds) {
                domains.add(JSON.stringify([roleId, 'cast']));
                const role = roles.find(role => record(role) && role.id === roleId);
                if (record(role) && record(role.stateMirrors) && typeof role.stateMirrors.presence === 'string') domains.add(stateDomain(roleId, role.stateMirrors.presence));
              }
            }
            const castDomains = new Set(domains);
            for (const mode of ['selectedState', 'unselectedState']) if (Object.hasOwn(group, mode)) {
              const values = array(group[mode], `${groupPath}/${mode}`);
              values.forEach((value, valueIndex) => {
                if (record(value)) for (const key of Object.keys(value)) if (!['key', 'value'].includes(key)) issue(`${groupPath}/${mode}/${valueIndex}/${key}`, 'Unknown role group state property');
              });
              for (const roleId of candidateIds) {
                initialState(values.map(value => record(value) ? { ...value, roleId } : value), `${groupPath}/${mode}`);
                for (const value of values) if (record(value) && typeof value.key === 'string') {
                  const domain = stateDomain(roleId, value.key);
                  if (hasCast && castDomains.has(domain)) issue(`${groupPath}/${mode}`, 'Role group cast owns its presence mirror; do not also write that state');
                  domains.add(domain);
                }
              }
            }
            for (const domain of domains) {
              if (ownership.has(domain)) issue(groupPath, `Role group write target overlaps ${ownership.get(domain)}`);
              else ownership.set(domain, typeof group.id === 'string' ? group.id : groupPath);
            }
            if (validId) earlier.set(group.id as string, candidateIds);
          });
        }
        if (Object.hasOwn(opening, 'state')) initialState(opening.state, `${path}/state`);
        if (Object.hasOwn(opening, 'source')) initialSource(opening.source, `${path}/source`);
      });
      profiles.forEach((entry, i) => {
        const path = `/initialization/playerProfiles/${i}`, profile = obj(entry, path); if (!profile) return;
        str(profile.title, `${path}/title`, true); str(profile.name, `${path}/name`, true); str(profile.persona, `${path}/persona`);
        if (Object.hasOwn(profile, 'state')) initialState(profile.state, `${path}/state`);
        if (Object.hasOwn(profile, 'source')) initialSource(profile.source, `${path}/source`);
      });
    }
  }
  const panels = array(document.panels, '/panels'); unique(panels, 'id', '/panels');
  panels.forEach((entry, i) => { const path = `/panels/${i}`, panel = obj(entry, path); if (panel) { str(panel.title, `${path}/title`); if (panel.pluginId !== undefined) identifier(panel.pluginId, `${path}/pluginId`); enumeration(panel.kind, ['scene', 'roles', 'state', 'lore', 'events', 'source', 'outputs', 'scenario'], `${path}/kind`); enumeration(panel.side, ['left', 'right'], `${path}/side`); } });
  if (Object.hasOwn(document, 'stateRules')) {
    const rules = array(document.stateRules, '/stateRules'); unique(rules, 'id', '/stateRules');
    rules.forEach((entry, i) => {
      const path = `/stateRules/${i}`, rule = obj(entry, path); if (!rule) return;
      enumeration(rule.type, ['unique-item', 'invariant', 'transition', 'delta-limit'], `${path}/type`);
      if (rule.type === 'invariant') { condition(rule.condition, `${path}/condition`); str(rule.message, `${path}/message`, true); }
      if (rule.type === 'transition') {
        const trigger = obj(rule.trigger, `${path}/trigger`);
        if (trigger) {
          if (str(trigger.roleId, `${path}/trigger/roleId`, true) && trigger.roleId !== '*' && trigger.roleId !== 'world' && !roleIds!.has(trigger.roleId)) issue(`${path}/trigger/roleId`, 'Unknown trigger owner');
          if (str(trigger.key, `${path}/trigger/key`, true) && !fieldMap.has(trigger.key)) issue(`${path}/trigger/key`, 'Unknown trigger field');
        }
        if (Object.hasOwn(rule, 'when')) condition(rule.when, `${path}/when`);
        const effects = array(rule.effects, `${path}/effects`);
        if (!effects.length) issue(`${path}/effects`, 'Transition requires at least one effect');
        effects.forEach((raw, j) => {
          const key = `${path}/effects/${j}`, effect = obj(raw, key); if (!effect) return;
          enumeration(effect.type, ['set', 'increment', 'list-add', 'list-remove'], `${key}/type`);
          if (str(effect.roleId, `${key}/roleId`, true) && effect.roleId !== '$trigger' && effect.roleId !== 'world' && !roleIds!.has(effect.roleId)) issue(`${key}/roleId`, 'Unknown effect owner');
          if (str(effect.key, `${key}/key`, true) && !fieldMap.has(effect.key)) issue(`${key}/key`, 'Unknown effect field');
          const field = typeof effect.key === 'string' ? fieldMap.get(effect.key) : undefined;
          if (effect.type === 'increment') { finite(effect.amount, `${key}/amount`); if (field && field.type !== 'number') issue(`${key}/key`, 'Increment requires a number field'); }
          else if (!Object.hasOwn(effect, 'value')) issue(`${key}/value`, 'Effect requires a JSON value');
          if (['list-add', 'list-remove'].includes(effect.type as string) && field && field.type !== 'list') issue(`${key}/key`, 'List effect requires a list field');
          if (effect.type === 'set' && Object.hasOwn(effect, 'value') && field)
            for (const error of validateStateFieldValue(field, effect.value)) issue(`${key}/value${error.path}`, error.message);
          if (['list-add', 'list-remove'].includes(effect.type as string) && Object.hasOwn(effect, 'value') && field?.type === 'list')
            for (const error of validateStateFieldValue(field, [effect.value])) issue(`${key}/value${error.path.replace(/^\/0(?=\/|$)/, '')}`, error.message);
        });
      }
      if (rule.type === 'delta-limit') {
        enumeration(rule.authority, ['model', 'all'], `${path}/authority`);
        if (identifier(rule.field, `${path}/field`) && fieldMap.get(rule.field)?.type !== 'number') issue(`${path}/field`, 'Delta-limit requires a declared number field');
        const limits = ['maxIncrease', 'maxDecrease'].filter(key => Object.hasOwn(rule, key));
        if (!limits.length) issue(path, 'Delta-limit requires at least one numeric limit');
        for (const key of limits) {
          finite(rule[key], `${path}/${key}`);
          if (typeof rule[key] === 'number' && rule[key] < 0) issue(`${path}/${key}`, 'Delta limits must be nonnegative');
        }
        const world = record(document.world) && record(document.world.variables) ? document.world.variables : undefined;
        const holders = new Set<string>();
        if (world && typeof rule.field === 'string' && Object.hasOwn(world, rule.field)) holders.add('world');
        for (const role of roles) if (record(role) && record(role.state) && typeof role.id === 'string' && typeof rule.field === 'string' && Object.hasOwn(role.state, rule.field)) holders.add(role.id);
        if (Object.hasOwn(rule, 'owners')) {
          const owners = array(rule.owners, `${path}/owners`), seen = new Set<string>();
          if (!owners.length) issue(`${path}/owners`, 'Delta-limit owners must not be empty');
          owners.forEach((owner, j) => {
            const key = `${path}/owners/${j}`;
            if (!identifier(owner, key)) return;
            if (!holders.has(owner)) issue(key, 'Delta-limit owner must exist and hold the declared field');
            if (seen.has(owner)) issue(key, 'Duplicate delta-limit owner');
            seen.add(owner);
          });
        } else if (!holders.size) issue(`${path}/field`, 'Delta-limit field has no state owners');
      }
      if (rule.type === 'unique-item') {
        str(rule.item, `${path}/item`);
        if (str(rule.field, `${path}/field`, true) && fieldMap.get(rule.field)?.type !== 'list') issue(`${path}/field`, 'Unique-item rule requires a declared list field');
      }
      if (rule.type === 'unique-item' && typeof rule.field === 'string') {
        let occurrences = 0;
        for (const role of roles) { const state = record(role) && record(role.state) ? role.state : undefined; const list = state?.[rule.field]; if (Array.isArray(list)) occurrences += list.filter(value => value === rule.item).length; }
        if (occurrences > 1) issue(path, 'Unique item appears more than once in initial role state');
      }
    });
  }
  return issues;
}

export function createNativeTemplate(kind: CreativeKind): NativeDocument {
  if (kind === 'preset') return { schema: 'rp.preset/0.1', id: 'new-preset', title: '未命名预设', description: '', modules: [], narration: { person: 'auto', pov: 'auto' } };
  return { schema: 'rp.card/0.1', id: 'new-card', title: '未命名角色卡', description: '', opening: '', playerRoleId: 'player', world: { location: '', time: '', variables: {} }, roles: [{ id: 'player', name: '你', persona: '', goals: [], peers: [], phase: 'active', presence: 'present', state: {}, knowledge: [] }], fields: [], modules: [], panels: [] };
}

/** Fork the visible native document; an edited fork never reads active source-import modules. */
export function materializeNativeDocument(doc: NativeDocument): NativeDocument {
  const result = structuredClone(doc) as NativeDocument & Record<string, unknown>;
  if (Object.hasOwn(result, 'compatibility')) {
    let key = 'sourceCompatibility', suffix = 1;
    while (Object.hasOwn(result, key)) key = `sourceCompatibility_${suffix++}`;
    Object.defineProperty(result, key, { value: result.compatibility, enumerable: true, writable: true, configurable: true });
    delete result.compatibility;
  }
  return result;
}

function equalJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => equalJson(item, b[i]));
  if (!record(a) || !record(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equalJson(a[key], b[key]));
}
export interface NativeModuleContext { snapshot?: unknown; text?: string; roleId?: string; }
const result = (status: ConditionResult['status'], reason: string): ConditionResult => ({ status, reasons: [reason] });

/** Evaluate only the permitted fixed snapshot supplied by the caller; no global fallback. */
export function evaluateNativeCondition(condition: Condition, context: NativeModuleContext): ConditionResult {
  function read(path: string): { found: boolean; value?: unknown } {
    const segments = path.split('.');
    if (segments.some(segment => !segment || forbidden.has(segment))) return { found: false };
    if (path === 'role.id' && context.roleId !== undefined) return { found: true, value: context.roleId };
    let value: unknown = context.snapshot;
    for (const segment of segments) {
      if (!value || typeof value !== 'object') return { found: false };
      const descriptor = Object.getOwnPropertyDescriptor(value, segment);
      if (!descriptor || !('value' in descriptor)) return { found: false };
      value = descriptor.value;
    }
    return { found: true, value };
  }
  function evaluate(node: Condition, depth = 0): ConditionResult {
    if (depth > 100) return result('unknown', 'Condition nesting exceeds the supported depth');
    if ('not' in node) {
      const child = evaluate(node.not, depth + 1);
      return { status: child.status === 'unknown' ? 'unknown' : child.status === 'true' ? 'false' : 'true', reasons: child.reasons };
    }
    if ('all' in node || 'any' in node) {
      const all = 'all' in node;
      const children = ('all' in node ? node.all : node.any).map(child => evaluate(child, depth + 1));
      const status = all
        ? children.some(child => child.status === 'false') ? 'false' : children.some(child => child.status === 'unknown') ? 'unknown' : 'true'
        : children.some(child => child.status === 'true') ? 'true' : children.some(child => child.status === 'unknown') ? 'unknown' : 'false';
      return { status, reasons: children.length ? children.flatMap(child => child.reasons) : [`Empty ${all ? 'all' : 'any'} condition is ${status}`] };
    }
    if (node.path.split('.').some(segment => !segment || forbidden.has(segment))) return result('unknown', `Unsafe condition path: ${node.path}`);
    const fact = read(node.path), op = 'op' in node ? node.op : 'eq';
    if (op === 'exists') return result(fact.found ? 'true' : 'false', `${node.path} ${fact.found ? 'exists' : 'is absent from the permitted snapshot'}`);
    if (!fact.found) return result('unknown', `${node.path} is absent from the permitted snapshot`);
    const expected = 'equals' in node ? node.equals : 'value' in node ? node.value : undefined;
    let matched: boolean;
    switch (op) {
      case 'eq': matched = equalJson(fact.value, expected); break;
      case 'neq': matched = !equalJson(fact.value, expected); break;
      case 'in':
        if (!Array.isArray(expected)) return result('unknown', `in requires an array comparison at ${node.path}`);
        matched = expected.some(value => equalJson(fact.value, value)); break;
      case 'contains':
        if (typeof fact.value === 'string' && typeof expected === 'string') matched = fact.value.includes(expected);
        else if (Array.isArray(fact.value)) matched = fact.value.some(value => equalJson(value, expected));
        else return result('unknown', `contains requires a string/string or array/JSON comparison at ${node.path}`);
        break;
      case 'gt': case 'gte': case 'lt': case 'lte':
        if (typeof fact.value !== 'number' || !Number.isFinite(fact.value) || typeof expected !== 'number' || !Number.isFinite(expected)) return result('unknown', `${op} requires finite numbers at ${node.path}`);
        matched = op === 'gt' ? fact.value > expected : op === 'gte' ? fact.value >= expected : op === 'lt' ? fact.value < expected : fact.value <= expected;
        break;
      default: return result('unknown', `Unsupported condition operator at ${node.path}`);
    }
    return result(matched ? 'true' : 'false', `${node.path} ${op} comparison ${matched ? 'matched' : 'did not match'}`);
  }
  return evaluate(condition);
}

/** Primary-any, plus secondary-any when selective. Empty primary lists never activate. */
export function evaluateNativeActivation(activation: PromptActivation | undefined, text = ''): ConditionResult {
  if (!activation) return result('true', 'No keyword activation constraint');
  const haystack = activation.caseSensitive ? text : text.toLowerCase();
  const isWord = (value: string | undefined) => value !== undefined && /[\p{L}\p{N}_]/u.test(value);
  const matches = (key: string) => {
    if (!key.length) return false;
    const needle = activation.caseSensitive ? key : key.toLowerCase();
    if (activation.match !== 'word') return haystack.includes(needle);
    // Unicode letters, numbers and underscore are word characters. No locale tokenization.
    for (let offset = haystack.indexOf(needle); offset !== -1; offset = haystack.indexOf(needle, offset + 1)) {
      const before = [...haystack.slice(0, offset)].at(-1), after = [...haystack.slice(offset + needle.length)][0];
      if (!isWord(before) && !isWord(after)) return true;
    }
    return false;
  };
  if (!activation.keys.some(matches)) return result('false', 'No primary activation keyword matched');
  if (activation.selective && activation.secondaryKeys?.length && !activation.secondaryKeys.some(matches)) return result('false', 'No secondary activation keyword matched');
  return result('true', 'Activation keywords matched');
}

/** Compatibility convenience. Compilers should retain the detailed evaluation results. */
export function nativeModuleActive(module: PromptModule, context: NativeModuleContext): boolean {
  return module.enabled && evaluateNativeActivation(module.activation, context.text).status === 'true'
    && (!module.condition || evaluateNativeCondition(module.condition, context).status === 'true');
}
export function expandNativeMacros(text: string, context: { user?: string; char?: string }): string {
  return text.replace(/\{\{\s*(user|char)\s*\}\}/gi, (original, key: string) => context[key.toLowerCase() as 'user' | 'char'] ?? original);
}
