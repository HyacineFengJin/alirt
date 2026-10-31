import type { BehaviorCandidate } from '../shared/behavior';
import type { CharacterCard, Preset } from '../shared/types';
import type { PromptPlan } from '../shared/prompt-runtime';
import { proseBodyText, validProseBody, type ProseBody, type ProseFormat, type ProseSpeechBlock } from '../shared/prose-body';
import { validateStateJson } from '../shared/state-value-schema';
import { isRemoteInteraction } from '../shared/role-interaction';
import { ApiError } from './store';

export type ProseSpeechReference = Omit<ProseSpeechBlock, 'kind'>;
export interface ProseBodyPlan {
  materialTurnId: string | null;
  renderer: 'character-dialogue';
  formatScope: { source: 'card' | 'preset'; documentId: string; moduleId: string; key: string; provenance?: { importId: string; pointer: string } };
  references: ProseSpeechReference[];
  bodySchema: Record<string, unknown>;
  schema: Record<string, unknown>;
  instruction: string;
}
export interface CompileProseBodyOptions {
  card: Pick<CharacterCard, 'id' | 'modules'> & { proseFormat?: ProseFormat };
  preset: Pick<Preset, 'id' | 'modules'> & { proseFormat?: ProseFormat };
  proseModules: PromptPlan;
  materialTurnId: string | null;
  playerControl: { mode: 'action' | 'dialogue' | 'author'; authorizedAction: string | null };
  playerRoleId: string;
  roles: readonly { id: string; name: string }[];
  acceptedBehaviors: readonly BehaviorCandidate[];
}
const fail = (message: string): never => { throw new ApiError(400, 'PROSE_BODY', message); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonblank = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function json(value: unknown, label: string) { if (validateStateJson(value).length) fail(`${label} must contain ordinary JSON only`); }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function readFormat(value: unknown): ProseFormat {
  json(value, 'Prose format');
  if (!record(value) || !exact(value, ['schema', 'dialogue']) || value.schema !== 'rp.prose-format/0.1' || !record(value.dialogue)
    || !exact(value.dialogue, ['module', 'renderer', ...(Object.hasOwn(value.dialogue, 'source') ? ['source'] : [])])
    || !nonblank(value.dialogue.module) || value.dialogue.renderer !== 'character-dialogue') return fail('Invalid local prose format contract');
  if (Object.hasOwn(value.dialogue, 'source')) {
    const source = value.dialogue.source;
    if (!record(source) || !exact(source, ['importId', 'pointer']) || !nonblank(source.importId) || typeof source.pointer !== 'string') return fail('Invalid prose format source metadata');
  }
  return structuredClone(value) as unknown as ProseFormat;
}
const bodySchema = () => ({ type: 'array', minItems: 1, items: { oneOf: [
  { type: 'object', additionalProperties: false, required: ['kind', 'text'], properties: { kind: { const: 'narration' }, text: { type: 'string', minLength: 1, pattern: '\\S' } } },
  { type: 'object', additionalProperties: false, required: ['kind', 'ref'], properties: { kind: { const: 'speech' }, ref: { type: 'string', minLength: 1, pattern: '\\S' } } },
] } });
const INSTRUCTION = 'Typed prose body contract rp.prose-body/0.1: submit title, body, person and pov (plus only separately declared auxiliary outputs), without a free text field. body is a nonempty ordered array of {kind:"narration",text} or {kind:"speech",ref}. Render each current proseBody.references ref exactly once, in supplied order; narration may occur between refs. The host resolves speaker identity, exact literal words and local channel. Never return speaker/name/roleId/text in a speech block. A player reference is explicitly authorized dialogue-mode user wording, not world-approved NPC behavior. Do not parse quotations in action/author instructions or turn remote messages/audio/screen content into local speech. Narration remains creative presentation of admitted material; this structural speech contract does not verify the truth or authorization of arbitrary actions, thoughts or claims written in narration. Do not repeat resolved speech as a separate transcript or duplicate it in narration.';

/** Resolve only a format whose local module was actually admitted by this
 * delivery's prose compiler. Historical formats and source text do not opt in. */
export function compileProseBodyPlan(options: CompileProseBodyOptions): ProseBodyPlan | undefined {
  const active: ProseBodyPlan['formatScope'][] = [];
  for (const source of ['card', 'preset'] as const) {
    const document = options[source], descriptor = Object.getOwnPropertyDescriptor(document, 'proseFormat');
    if (!descriptor) continue;
    if (!('value' in descriptor)) fail('Prose format cannot be an accessor');
    const format = readFormat(descriptor.value), moduleId = format.dialogue.module, key = `${source}:${moduleId}`;
    const modules = document.modules.filter(module => module.id === moduleId);
    if (modules.length !== 1) fail('Prose format requires one existing local module');
    const admitted = options.proseModules.modules.filter(module => module.ref.key === key && module.ref.source === source && module.ref.documentId === document.id && module.ref.moduleId === moduleId);
    if (!admitted.length) continue;
    if (admitted.length !== 1 || !modules[0].enabled || !modules[0].targets.includes('prose') || modules[0].phase !== 'compose') fail('Prose format and admitted module are inconsistent');
    active.push({ source, documentId: document.id, moduleId, key, ...(format.dialogue.source ? { provenance: structuredClone(format.dialogue.source) } : {}) });
  }
  if (!active.length) return undefined;
  if (!options.proseModules.valid || options.proseModules.target !== 'prose' || options.proseModules.phase !== 'compose') fail('Typed prose requires a valid current prose plan');
  if (active.length !== 1) fail('Multiple active prose formats conflict');
  const materialTurnId = options.materialTurnId;
  if (materialTurnId !== null && !nonblank(materialTurnId)) return fail('Typed prose requires an exact material turn or null');
  json({ roles: options.roles, acceptedBehaviors: options.acceptedBehaviors, playerControl: options.playerControl, playerRoleId: options.playerRoleId }, 'Prose speech material');
  if (materialTurnId === null && (options.acceptedBehaviors.length || options.playerControl.mode === 'dialogue'))
    return fail('Without committed material, typed prose permits narration only, without NPC behaviors or player dialogue');
  const roles = new Map<string, string>();
  for (const role of options.roles) {
    if (!record(role) || !nonblank(role.id) || !nonblank(role.name) || roles.has(role.id)) fail('Prose speaker identities must be unique and known');
    roles.set(role.id, role.name);
  }
  if (!roles.has(options.playerRoleId) || !['action', 'dialogue', 'author'].includes(options.playerControl.mode)
    || options.playerControl.authorizedAction !== null && typeof options.playerControl.authorizedAction !== 'string') fail('Invalid explicit player speech control');
  const references: ProseSpeechReference[] = [];
  if (options.playerControl.mode === 'dialogue' && options.playerControl.authorizedAction !== null && options.playerControl.authorizedAction.length) references.push({
    ref: `player:${materialTurnId}`, roleId: options.playerRoleId, name: roles.get(options.playerRoleId)!, text: options.playerControl.authorizedAction, channel: 'local', speaker: 'player',
  });
  const ids = new Set<string>(), refIds = new Set(references.map(reference => reference.ref));
  for (const behavior of options.acceptedBehaviors) {
    if (!record(behavior) || !exact(behavior as unknown as Record<string, unknown>, ['id', 'roleId', 'kind', 'text', ...(Object.hasOwn(behavior, 'interaction') ? ['interaction'] : [])])
      || !nonblank(behavior.id) || ids.has(behavior.id) || !roles.has(behavior.roleId) || behavior.roleId === options.playerRoleId
      || !['speech', 'action'].includes(behavior.kind) || typeof behavior.text !== 'string') fail('Approved prose behavior must be an exact unique known NPC candidate');
    ids.add(behavior.id);
    if (behavior.interaction !== undefined && !isRemoteInteraction(behavior.interaction)
      && (!record(behavior.interaction) || !exact(behavior.interaction as unknown as Record<string, unknown>, ['mode']) || behavior.interaction.mode !== 'local')) fail('Invalid approved behavior channel');
    if (behavior.kind !== 'speech' || isRemoteInteraction(behavior.interaction)) continue;
    if (refIds.has(behavior.id)) fail('Player and NPC speech reference identities collide');
    refIds.add(behavior.id);
    references.push({ ref: behavior.id, roleId: behavior.roleId, name: roles.get(behavior.roleId)!, text: behavior.text, channel: 'local', speaker: 'npc' });
  }
  const schema = bodySchema();
  return freeze({ materialTurnId, renderer: 'character-dialogue' as const, formatScope: active[0], references,
    bodySchema: schema, schema: { type: 'object', additionalProperties: false, required: ['body'], properties: { body: schema } }, instruction: INSTRUCTION });
}

/** Models supply only block kind/ref, never trusted speech text or identities.
 * This verifies placement completeness, not natural-language narration meaning. */
export function resolveProseBody(rawBody: unknown, plan: ProseBodyPlan): { body: ProseBody; text: string } {
  json(rawBody, 'Prose body');
  if (!Array.isArray(rawBody) || !rawBody.length) return fail('Prose body must be a nonempty block array');
  const blocks: ProseBody['blocks'] = []; let speech = 0;
  for (const block of rawBody) {
    if (!record(block)) return fail('Prose body blocks must be ordinary objects');
    if (block.kind === 'narration') {
      if (!exact(block, ['kind', 'text']) || !nonblank(block.text)) fail('Narration requires exact kind and nonblank text');
      blocks.push({ kind: 'narration', text: block.text as string });
    } else if (block.kind === 'speech') {
      if (!exact(block, ['kind', 'ref']) || !nonblank(block.ref)) fail('Speech blocks require only kind and a current host ref');
      const expected = plan.references[speech];
      if (!expected || block.ref !== expected.ref) fail('Speech references must be current, complete, unique and in approved order');
      blocks.push({ kind: 'speech', ...structuredClone(expected) }); ++speech;
    } else fail('Unknown prose body block kind');
  }
  if (speech !== plan.references.length) fail('Prose body omitted required current speech references');
  const body: ProseBody = { schema: 'rp.prose-body/0.1', materialTurnId: plan.materialTurnId, renderer: plan.renderer, blocks };
  if (!validProseBody(body)) fail('Resolved prose body does not satisfy its saved host contract');
  return { body, text: proseBodyText(body) };
}
