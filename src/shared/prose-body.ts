import { validateStateJson } from './state-value-schema';

/** An installed renderer and a local prompt-module gate, never imported code. */
export interface ProseFormat {
  schema: 'rp.prose-format/0.1';
  dialogue: {
    module: string;
    renderer: 'character-dialogue';
    source?: { importId: string; pointer: string };
  };
}
export interface ProseNarrationBlock { kind: 'narration'; text: string }
/** Only the host resolves a model's speech reference into this saved snapshot. */
export interface ProseSpeechBlock {
  kind: 'speech'; ref: string; roleId: string; name: string; text: string;
  channel: 'local'; speaker: 'player' | 'npc';
}
export interface ProseBody {
  schema: 'rp.prose-body/0.1'; materialTurnId: string | null; renderer: 'character-dialogue';
  blocks: (ProseNarrationBlock | ProseSpeechBlock)[];
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const nonblank = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
export function validProseBody(value: unknown): value is ProseBody {
  if (validateStateJson(value).length || !record(value) || !exact(value, ['schema', 'materialTurnId', 'renderer', 'blocks'])
    || value.schema !== 'rp.prose-body/0.1' || !(value.materialTurnId === null || nonblank(value.materialTurnId)) || value.renderer !== 'character-dialogue'
    || !Array.isArray(value.blocks) || !value.blocks.length) return false;
  const refs = new Set<string>();
  return value.blocks.every(block => {
    if (!record(block)) return false;
    if (block.kind === 'narration') return exact(block, ['kind', 'text']) && nonblank(block.text);
    if (value.materialTurnId === null || block.kind !== 'speech' || !exact(block, ['kind', 'ref', 'roleId', 'name', 'text', 'channel', 'speaker'])
      || !nonblank(block.ref) || refs.has(block.ref) || !nonblank(block.roleId) || !nonblank(block.name)
      || typeof block.text !== 'string' || block.channel !== 'local' || !['player', 'npc'].includes(block.speaker as string)) return false;
    refs.add(block.ref); return true;
  });
}

/** Stable plain-text counterpart for history, export and older reading clients. */
export function proseBodyText(body: ProseBody): string {
  return body.blocks.map(block => block.kind === 'narration' ? block.text : `${block.name}：「${block.text}」`).join('\n\n');
}
