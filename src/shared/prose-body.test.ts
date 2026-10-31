import { describe, expect, it } from 'vitest';
import { validProseBody, proseBodyText, type ProseBody } from './prose-body';
import { validateNativeDocument } from './native';
import presetJson from '../../content/presets/basic.json';

const body = (): ProseBody => ({ schema: 'rp.prose-body/0.1', materialTurnId: 'world-turn', renderer: 'character-dialogue', blocks: [
  { kind: 'narration', text: '门边传来话语。' },
  { kind: 'speech', ref: 'behavior-1', roleId: 'role-6', name: '爱音', text: '原句\n不改写', channel: 'local', speaker: 'npc' },
] });
describe('saved native prose body', () => {
  it('preserves exact speech bytes and its own historical speaker snapshot in the plain-text counterpart', () => {
    const value = body(); expect(validProseBody(value)).toBe(true);
    expect(proseBodyText(value)).toBe('门边传来话语。\n\n爱音：「原句\n不改写」');
  });
  it('rejects duplicate references, unsupported renderers and malformed saved speech carriers', () => {
    const value = body(); value.blocks.push(structuredClone(value.blocks[1])); expect(validProseBody(value)).toBe(false);
    expect(validProseBody({ ...body(), renderer: 'arbitrary-code' })).toBe(false);
    const spoofed = body(); Object.assign(spoofed.blocks[1], { channel: 'message', html: '<script>run()</script>' });
    expect(validProseBody(spoofed)).toBe(false);
  });
  it('requires an installed typed renderer and existing local module gate in native documents', () => {
    const preset = structuredClone(presetJson) as Record<string, any>;
    preset.proseFormat = { schema: 'rp.prose-format/0.1', dialogue: { module: preset.modules[0].id, renderer: 'character-dialogue', source: { importId: 'source', pointer: '/prompts/1/content' } } };
    expect(validateNativeDocument('preset', preset)).toEqual([]);
    preset.proseFormat.dialogue.module = 'missing';
    expect(validateNativeDocument('preset', preset).some(issue => issue.path === '/proseFormat/dialogue/module')).toBe(true);
    preset.proseFormat.dialogue.module = preset.modules[0].id; preset.proseFormat.dialogue.renderer = 'script';
    expect(validateNativeDocument('preset', preset).some(issue => issue.path === '/proseFormat/dialogue/renderer')).toBe(true);
  });
});
