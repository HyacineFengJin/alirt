import { inflateSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import type { Json } from '../shared/types';
import type { SourceText } from './types';

export const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
export const escapePointer = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
const MAX_SOURCE = 64 * 1024 * 1024;
export function decodeSource(bytes: Uint8Array): Json {
  if (!bytes.length || bytes.length > MAX_SOURCE) throw new Error('Import size must be between 1 byte and 64 MiB');
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    const candidates = new Map<string, string>();
    for (let at = 8; at + 12 <= buffer.length;) {
      const length = buffer.readUInt32BE(at), kind = buffer.toString('ascii', at + 4, at + 8);
      if (length > MAX_SOURCE || at + length + 12 > buffer.length) throw new Error('Invalid PNG chunk');
      const data = buffer.subarray(at + 8, at + 8 + length), zero = data.indexOf(0);
      if (zero >= 0 && ['tEXt', 'zTXt', 'iTXt'].includes(kind)) {
        const key = data.toString('latin1', 0, zero);
        if (key === 'chara' || key === 'ccv3') {
          let value: Buffer;
          if (kind === 'tEXt') value = data.subarray(zero + 1);
          else if (kind === 'zTXt') value = inflateSync(data.subarray(zero + 2), { maxOutputLength: MAX_SOURCE });
          else {
            const compressed = data[zero + 1] === 1;
            const langEnd = data.indexOf(0, zero + 3), translatedEnd = data.indexOf(0, langEnd + 1);
            if (langEnd < 0 || translatedEnd < 0) throw new Error('Invalid PNG international text');
            value = data.subarray(translatedEnd + 1);
            if (compressed) value = inflateSync(value, { maxOutputLength: MAX_SOURCE });
          }
          candidates.set(key, value.toString('utf8'));
        }
      }
      at += length + 12;
    }
    const payload = candidates.get('ccv3') ?? candidates.get('chara');
    if (!payload) throw new Error('PNG has no character-card text chunk');
    return parseJson(payload.trim().startsWith('{') ? payload : Buffer.from(payload, 'base64').toString('utf8'));
  }
  return parseJson(buffer.toString('utf8').replace(/^\uFEFF/, ''));
}
function parseJson(value: string): Json {
  if (Buffer.byteLength(value) > MAX_SOURCE) throw new Error('Decoded import exceeds 64 MiB');
  const parsed: unknown = JSON.parse(value);
  if (!object(parsed)) throw new Error('Expected JSON object');
  const nativeSchema = typeof parsed.schema === 'string' && /^rp\.(?:card|preset)\//.test(parsed.schema);
  if (!nativeSchema && !Array.isArray(parsed.prompts) && !object(parsed.data) && !('character_book' in parsed) && !('name' in parsed)) throw new Error('Unrecognized Tavern card or preset');
  return parsed as Json;
}
export function auditContainer(source: Record<string, any>) {
  const nested = object(source.data), aliases: string[] = [], retainedOuterFields: string[] = [], conflicts: string[] = [];
  if (nested) for (const key of Object.keys(source)) {
    if (key === 'data') continue;
    if (Object.hasOwn(source.data, key) && isDeepStrictEqual(source[key], source.data[key])) aliases.push(key);
    else { retainedOuterFields.push(key); if (Object.hasOwn(source.data, key)) conflicts.push(key); }
  }
  return { canonicalRoot: nested ? '/data' : '', aliases, retainedOuterFields, conflicts };
}
export function collectTexts(source: Json, pointer = '', result: SourceText[] = []): SourceText[] {
  if (typeof source === 'string') {
    const frontend = /\/(regex_scripts|scripts|replaceString|findRegex|html|css|javascript)(\/|$)/i.test(pointer);
    const prompt = /\/(content|description|personality|scenario|first_mes|mes_example|system_prompt|post_history_instructions)$/.test(pointer) || /\/(alternate_greetings|group_only_greetings)\/\d+$/.test(pointer);
    result.push({ pointer, text: source, role: frontend ? 'frontend' : prompt ? 'prompt' : 'metadata' });
  } else if (Array.isArray(source)) source.forEach((value, i) => collectTexts(value, `${pointer}/${i}`, result));
  else if (object(source)) for (const [key, value] of Object.entries(source)) collectTexts(value as Json, `${pointer}/${escapePointer(key)}`, result);
  return result;
}
export function atPointer(source: Json, pointer: string): Json | undefined {
  let value: any = source;
  for (const segment of pointer.split('/').slice(1)) {
    if (value === null || typeof value !== 'object') return undefined;
    value = value[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
  }
  return value;
}
