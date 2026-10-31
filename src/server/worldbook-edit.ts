import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CharacterCard, PromptModule } from '../shared/types';
import type { WorldbookBinding } from '../shared/worldbook';
import { AgentModuleRegistry } from './agent-modules';
import { updateRuntimeConfiguration } from './runtime-config';
import { roleStageOwnsPersona } from './role-stage-runtime';
import { assertRevision, clone, fail, type SessionStore, type StoredSession } from './store';

const moduleFields = ['title', 'category', 'content', 'enabled', 'targets', 'phase', 'priority', 'condition', 'sourcePointer', 'activation', 'lifetime', 'audience', 'inject', 'dependsOn', 'exclusiveGroup', 'required'];
const requiredModuleFields = ['title', 'category', 'content', 'enabled', 'targets', 'phase', 'priority'];
const bindingFields = ['purpose', 'when', 'audience', 'source', 'roleStage'];
function object(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length)
    fail('WORLDBOOK_EDIT_INPUT', `${label} must be a plain object`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value)))
    if (!allowed.includes(key) || !('value' in descriptor)) fail('WORLDBOOK_EDIT_INPUT', `${label} contains unsupported field: ${key}`);
  return value as Record<string, unknown>;
}
function patchFields(target: object, patch: Record<string, unknown>, required: string[] = []) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null && !required.includes(key)) delete (target as Record<string, unknown>)[key];
    else Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  }
}
function assertDeletable(session: StoredSession, source: 'card' | 'preset', module: PromptModule, binding?: WorldbookBinding) {
  if (source === 'card' && binding && session.card.scenario?.chapters.some(chapter => chapter.bindingIds.includes(binding.id)))
    fail('WORLDBOOK_EDIT_REFERENCED', 'This entry belongs to a chapter; edit the chapter definition before deleting its worldbook entry');
  for (const owner of ['card', 'preset'] as const) {
    if (session[owner].modules.some(item => !(owner === source && item.id === module.id) && item.dependsOn?.some(ref => ref === `${source}:${module.id}` || owner === source && ref === module.id))
      || session[owner].outputs?.some(output => output.module === `${source}:${module.id}` || owner === source && output.module === module.id))
      fail('WORLDBOOK_EDIT_REFERENCED', 'Another module or output depends on this entry; remove that dependency before deleting it');
  }
}
const legacyActivation = (module: PromptModule) => !!module.condition && 'path' in module.condition && 'equals' in module.condition
  && module.condition.path === `importActivation.${module.id}` && module.condition.equals === true;

/** Build and validate one complete document replacement; there is no second data store. */
export function applyWorldbookEdit(store: SessionStore, id: string, input: unknown, registry = new AgentModuleRegistry(), evidence?: { sourceModules: PromptModule[] }) {
  const command = object(input, ['expectedRevision', 'reason', 'source', 'operation', 'moduleId', 'bindingId', 'module', 'binding', 'enabled'], 'Worldbook edit');
  const current = store.get(id);
  assertRevision(current, command.expectedRevision as number);
  if (typeof command.reason !== 'string' || !command.reason.trim()) fail('RUNTIME_CONFIG_REASON', 'A nonempty runtime configuration reason is required');
  if (command.source !== 'card' && command.source !== 'preset') fail('WORLDBOOK_EDIT_INPUT', 'Select card or preset worldbook data');
  if (!['add', 'edit', 'delete', 'set-enabled'].includes(command.operation as string)) fail('WORLDBOOK_EDIT_INPUT', 'Select a supported worldbook edit operation');
  const source = command.source, operation = command.operation;
  const allowed = operation === 'add' ? ['module', 'binding'] : operation === 'edit' ? ['moduleId', 'bindingId', 'module', 'binding'] : operation === 'delete' ? ['moduleId', 'bindingId'] : ['moduleId', 'bindingId', 'enabled'];
  for (const field of ['moduleId', 'bindingId', 'module', 'binding', 'enabled'])
    if (Object.hasOwn(command, field) && !allowed.includes(field)) fail('WORLDBOOK_EDIT_INPUT', `${String(operation)} does not accept ${field}`);
  const document = clone(current[source]);
  const modulePatch = Object.hasOwn(command, 'module') ? object(command.module, moduleFields, 'Module edit') : undefined;
  const bindingPatch = Object.hasOwn(command, 'binding') ? object(command.binding, bindingFields, 'Binding edit') : undefined;
  const roles: { id: string; persona: string }[] = [];
  let module: PromptModule, binding: WorldbookBinding | undefined;
  if (operation === 'add') {
    if (!modulePatch) fail('WORLDBOOK_EDIT_INPUT', 'A new entry requires a module with title and content');
    module = { id: `worldbook-${randomUUID()}`, title: '', content: '', category: 'supplement', enabled: true, targets: ['world'], phase: 'coordinate', priority: 0 };
    if (typeof modulePatch.title !== 'string' || !modulePatch.title.trim() || typeof modulePatch.content !== 'string') fail('WORLDBOOK_EDIT_INPUT', 'A new entry requires a nonempty title and a text body');
    patchFields(module, modulePatch, requiredModuleFields);
    document.modules.push(module);
    binding = { id: `worldbook-${randomUUID()}`, moduleId: module.id, purpose: 'reference' };
    document.worldbook ??= { schema: 'rp.worldbook/0.1', bindings: [] };
    document.worldbook.bindings.push(binding);
  } else {
    if (command.moduleId !== undefined && (typeof command.moduleId !== 'string' || !command.moduleId)
      || command.bindingId !== undefined && (typeof command.bindingId !== 'string' || !command.bindingId)
      || command.moduleId === undefined && command.bindingId === undefined) fail('WORLDBOOK_EDIT_INPUT', 'Select an existing module or binding');
    binding = document.worldbook?.bindings.find(item => command.bindingId !== undefined ? item.id === command.bindingId : item.moduleId === command.moduleId);
    if (command.bindingId !== undefined && !binding) fail('WORLDBOOK_EDIT_UNKNOWN', 'Worldbook binding not found', 404);
    const found = document.modules.find(item => item.id === (command.moduleId ?? binding?.moduleId));
    if (!found || binding && binding.moduleId !== found.id) fail('WORLDBOOK_EDIT_UNKNOWN', 'Worldbook module not found or target identities disagree', 404);
    module = found;
    if (operation === 'delete') {
      assertDeletable(current, source, module, binding);
      document.modules = document.modules.filter(item => item.id !== module.id);
      if (binding) document.worldbook!.bindings = document.worldbook!.bindings.filter(item => item.id !== binding!.id);
    } else if (operation === 'set-enabled') {
      if (typeof command.enabled !== 'boolean') fail('WORLDBOOK_EDIT_INPUT', 'enabled must be a boolean');
      module.enabled = command.enabled;
    } else {
      if (!modulePatch && !bindingPatch) fail('WORLDBOOK_EDIT_INPUT', 'Provide module or binding fields to edit');
      if (modulePatch && Object.hasOwn(modulePatch, 'content') && modulePatch.content !== module.content
        && legacyActivation(module) && (!Object.hasOwn(modulePatch, 'condition') || isDeepStrictEqual(modulePatch.condition, module.condition))) {
        // Resolve the unchanged old body before applying the edit. Only the
        // native activation translation is retained; source text never replaces
        // the bound module or the author's new body.
        const hydrated = evidence?.sourceModules.find(item => item.id === module.id && item.sourcePointer === module.sourcePointer && item.content === module.content);
        if (!hydrated || hydrated.condition !== undefined || !hydrated.activation)
          fail('WORLDBOOK_EDIT_ACTIVATION', 'This old entry still uses an untranslated import activation condition. Clear or replace that condition and configure native keyword activation before changing its body');
        delete module.condition;
        if (!module.activation) module.activation = clone(hydrated.activation);
      }
      if (binding?.roleStage && modulePatch && Object.hasOwn(modulePatch, 'content') && modulePatch.content !== module.content && !bindingPatch?.roleStage)
        fail('WORLDBOOK_EDIT_STAGE', 'Changing a role-stage body requires a complete reviewed roleStage template for the new body');
      if (source === 'card' && modulePatch && typeof modulePatch.content === 'string' && modulePatch.content !== module.content) {
        for (const role of current.card.roles.filter(role => module.sourcePointer && role.personaSourcePointer === module.sourcePointer
          || binding?.roleStage?.roleId === role.id && role.persona === module.content)) {
          if (role.persona !== module.content) fail('WORLDBOOK_EDIT_LINKED', 'The linked persona and module body disagree; review the complete runtime configuration');
          const liveRole = current.roles.find(item => item.id === role.id);
          if (!liveRole || liveRole.persona !== role.persona || liveRole.personaSourcePointer !== role.personaSourcePointer)
            fail('WORLDBOOK_EDIT_LINKED', 'The current role uses a selected or independently edited persona; editing this base module cannot overwrite that persona. Review its runtime persona association first');
          roles.push({ id: role.id, persona: modulePatch.content });
        }
      }
      if (modulePatch) patchFields(module, modulePatch, requiredModuleFields);
      if (!binding && bindingPatch) {
        binding = { id: `worldbook-${randomUUID()}`, moduleId: module.id, purpose: 'reference' };
        document.worldbook ??= { schema: 'rp.worldbook/0.1', bindings: [] };
        document.worldbook.bindings.push(binding);
      }
    }
  }
  if (operation === 'add' || operation === 'edit') {
    if (binding && bindingPatch) patchFields(binding, bindingPatch, ['purpose']);
    // A manual body edit is an explicit review of this exact local binding.
    if (binding && (operation === 'add' || modulePatch && Object.hasOwn(modulePatch, 'content')) && typeof module.content === 'string')
      binding.contentHash = createHash('sha256').update(module.content).digest('hex');
  }
  if (source === 'card') {
    for (const role of current.card.roles) {
      const persona = roles.find(patch => patch.id === role.id)?.persona ?? role.persona;
      if (!role.personaSourcePointer && roleStageOwnsPersona(current.card, role.id, role.persona)
        && !roleStageOwnsPersona(document as CharacterCard, role.id, persona))
        fail('WORLDBOOK_EDIT_LINKED', 'This edit would restore the complete stage template as an unconditional persona; review its persona association before removing the stage binding');
    }
  }
  return updateRuntimeConfiguration(store, id, { expectedRevision: command.expectedRevision, reason: command.reason,
    ...(roles.length ? { roles } : {}),
    ...(source === 'card' ? { cardModules: document.modules, ...(document.worldbook ? { cardWorldbook: document.worldbook } : {}) } : { preset: document }) }, registry);
}
