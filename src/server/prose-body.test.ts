import { expect, it } from 'vitest';
import { createNativeTemplate, validateNativeDocument } from '../shared/native';
import { proseBodyText, validProseBody } from '../shared/prose-body';
import type { CharacterCard, Preset } from '../shared/types';
import type { BehaviorCandidate } from '../shared/behavior';
import { compilePromptPlan } from './prompt-compiler';
import { compileProseBodyPlan, resolveProseBody, type CompileProseBodyOptions } from './prose-body';
import type { StoredSession } from './store';
import { compileResultValidator } from './result-schema.mjs';

function fixture() {
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.modules = [{ id: 'dialogue', title: 'Reviewed dialogue format', category: 'style', content: 'Ordinary dialogue presentation.', enabled: true, targets: ['prose'], phase: 'compose', priority: 0 }];
  preset.modules = [];
  card.proseFormat = { schema: 'rp.prose-format/0.1', dialogue: { module: 'dialogue', renderer: 'character-dialogue', source: { importId: 'reviewed-pack', pointer: '/source/dialogue' } } };
  const roles = [{ id: 'player', name: 'Player' }, { id: 'a', name: 'Speaker A' }, { id: 'b', name: 'Speaker B' }];
  const acceptedBehaviors: BehaviorCandidate[] = [
    { id: 'npc-a', roleId: 'a', kind: 'speech', text: '  原样「引号」\n第二行  ' },
    { id: 'remote-message', roleId: 'b', kind: 'speech', text: 'PRIVATE_MESSAGE_NOT_LOCAL', interaction: { mode: 'remote', channel: 'message' } },
    { id: 'action', roleId: 'a', kind: 'action', text: 'An approved action, not speech.' },
    { id: 'remote-audio', roleId: 'b', kind: 'speech', text: 'REMOTE_AUDIO_NOT_LOCAL', interaction: { mode: 'remote', channel: 'audio' } },
    { id: 'npc-b', roleId: 'b', kind: 'speech', text: 'The second approved line.', interaction: { mode: 'local' } },
    { id: 'remote-screen', roleId: 'a', kind: 'speech', text: 'REMOTE_SCREEN_NOT_LOCAL', interaction: { mode: 'remote', channel: 'screen' } },
  ];
  const snapshot = { world: { location: 'Room', variables: { adopt: true } } };
  const refresh = (): CompileProseBodyOptions => {
    const session = { id: 'story', card, preset, roles: card.roles, fields: card.fields } as StoredSession;
    return { card, preset, roles, acceptedBehaviors, proseModules: compilePromptPlan(session, 'prose', 'compose', { snapshot, text: '' }), materialTurnId: 'turn',
      playerRoleId: 'player', playerControl: { mode: 'action', authorizedAction: 'A quoted term 「not speech」 in an action.' } };
  };
  return { card, preset, roles, acceptedBehaviors, snapshot, refresh };
}

it('adopts only the actually admitted local format, preserves legacy without one, and rejects two active formats', () => {
  const f = fixture(); expect(compileProseBodyPlan(f.refresh())!.formatScope).toEqual({ source: 'card', documentId: f.card.id, moduleId: 'dialogue', key: 'card:dialogue', provenance: { importId: 'reviewed-pack', pointer: '/source/dialogue' } });
  f.card.modules[0].condition = { path: 'world.variables.adopt', equals: false };
  expect(compileProseBodyPlan(f.refresh())).toBeUndefined();
  delete f.card.modules[0].condition; f.card.modules[0].enabled = false;
  f.preset.modules = [{ ...f.card.modules[0], enabled: true }];
  expect(compileProseBodyPlan(f.refresh())).toBeUndefined(); // Same ID in another document cannot admit the card format.
  f.preset.proseFormat = { schema: 'rp.prose-format/0.1', dialogue: { module: 'dialogue', renderer: 'character-dialogue' } };
  expect(compileProseBodyPlan(f.refresh())!.formatScope.source).toBe('preset');
  f.card.modules[0].enabled = true; expect(() => compileProseBodyPlan(f.refresh())).toThrow('conflict');
  delete f.card.proseFormat; delete f.preset.proseFormat;
  const legacy = f.refresh(); legacy.materialTurnId = null; legacy.acceptedBehaviors = [];
  expect(compileProseBodyPlan(legacy)).toBeUndefined();
});

it('accepts native-valid local colon IDs literally while rejecting a matching ID found only in the other document', () => {
  const f = fixture(); f.card.modules[0].id = 'card:foo'; f.card.proseFormat!.dialogue.module = 'card:foo';
  expect(validateNativeDocument('card', f.card)).toEqual([]);
  const plan = compileProseBodyPlan(f.refresh())!;
  expect(plan.formatScope).toMatchObject({ source: 'card', moduleId: 'card:foo', key: 'card:card:foo' });
  expect(resolveProseBody([{ kind: 'speech', ref: 'npc-a' }, { kind: 'speech', ref: 'npc-b' }], plan).body.blocks).toHaveLength(2);
  f.preset.modules = [structuredClone(f.card.modules[0])]; f.card.modules = [];
  expect(() => compileProseBodyPlan(f.refresh())).toThrow('existing local module');
});

it('anchors explicit dialogue-mode player wording first and resolves only exact current local NPC speech in approved relative order', () => {
  const f = fixture(), options = f.refresh(); options.playerControl = { mode: 'dialogue', authorizedAction: '  我说「先等等」\n保留空格  ' };
  const plan = compileProseBodyPlan(options)!;
  expect(plan.references.map(reference => reference.ref)).toEqual(['player:turn', 'npc-a', 'npc-b']);
  expect(plan.references[0]).toEqual({ ref: 'player:turn', roleId: 'player', name: 'Player', text: options.playerControl.authorizedAction, channel: 'local', speaker: 'player' });
  expect(plan.references.slice(1).every(reference => reference.speaker === 'npc')).toBe(true);
  expect(JSON.stringify(plan.references)).not.toMatch(/NOT_LOCAL|An approved action/);
  const raw = [{ kind: 'narration', text: '第一段静景。' }, { kind: 'speech', ref: 'player:turn' }, { kind: 'narration', text: '叙事留在对白之间。' }, { kind: 'speech', ref: 'npc-a' }, { kind: 'speech', ref: 'npc-b' }];
  const before = structuredClone(raw), resolved = resolveProseBody(raw, plan);
  expect(raw).toEqual(before); expect(validProseBody(resolved.body)).toBe(true);
  expect(resolved.body.materialTurnId).toBe('turn'); expect(resolved.body.renderer).toBe('character-dialogue');
  expect(resolved.body.blocks[3]).toEqual({ kind: 'speech', ...plan.references[1] });
  expect(resolved.text).toBe(proseBodyText(resolved.body));
  expect(resolved.text).toContain(`Speaker A：「${f.acceptedBehaviors[0].text}」`);
  expect(resolved.text.split('第二行')).toHaveLength(2);
  expect(resolved.body).not.toHaveProperty('formatScope');
});

it.each(['action', 'author'] as const)('does not parse player quotes into speech in %s mode and keeps narration-only material possible', mode => {
  const f = fixture(), options = f.refresh(); options.playerControl = { mode, authorizedAction: '「An apparent quote」 is part of a private instruction or action.' };
  options.acceptedBehaviors = f.acceptedBehaviors.filter(behavior => !!behavior.interaction && behavior.interaction.mode === 'remote');
  const plan = compileProseBodyPlan(options)!; expect(plan.references).toEqual([]);
  const body = [{ kind: 'narration', text: '留白与节奏仍由成文者选择。' }];
  expect(resolveProseBody(body, plan).text).toBe(body[0].text);
  expect(() => resolveProseBody([{ kind: 'speech', ref: 'player:turn' }], plan)).toThrow();
  expect(plan.instruction).toContain('proseBody.references');
  expect(plan.instruction).toContain('does not verify');
});

it('keeps a fresh author narration workflow without a world material turn, while refusing all uncommitted speech material', () => {
  const options = fixture().refresh(); options.materialTurnId = null; options.acceptedBehaviors = [];
  options.playerControl = { mode: 'author', authorizedAction: 'Rewrite the opening with 「quoted instructions」 and no world turn.' };
  const plan = compileProseBodyPlan(options)!;
  expect(plan.materialTurnId).toBeNull(); expect(plan.references).toEqual([]);
  const resolved = resolveProseBody([{ kind: 'narration', text: 'A freshly authored opening remains available.' }], plan);
  expect(resolved.body.materialTurnId).toBeNull(); expect(validProseBody(resolved.body)).toBe(true);
  expect(resolved.text).toBe('A freshly authored opening remains available.');
  expect(() => resolveProseBody([{ kind: 'speech', ref: 'player:null' }], plan)).toThrow();
  expect(() => compileProseBodyPlan({ ...options, acceptedBehaviors: [{ id: 'uncommitted', roleId: 'a', kind: 'speech', text: 'No committed source.' }] })).toThrow();
  for (const authorizedAction of ['A direct utterance.', null])
    expect(() => compileProseBodyPlan({ ...options, playerControl: { mode: 'dialogue', authorizedAction } })).toThrow();
});

it('keeps the wire schema and instruction stable across turn references, while host snapshots remain detached and immutable', () => {
  const f = fixture(), first = compileProseBodyPlan(f.refresh())!;
  f.roles[1].name = 'Changed after the first plan'; f.acceptedBehaviors[0].text = 'Changed after the first plan';
  const next = f.refresh(); next.materialTurnId = 'next-turn'; next.acceptedBehaviors = [{ id: 'new-turn-host-id', roleId: 'a', kind: 'speech', text: 'Current new words.' }];
  const second = compileProseBodyPlan(next)!;
  expect(first.schema).toEqual(second.schema); expect(first.instruction).toBe(second.instruction);
  expect(JSON.stringify(first.schema)).not.toContain('npc-a'); expect(JSON.stringify(second.schema)).not.toContain('new-turn-host-id');
  expect(first.references[0].name).toBe('Speaker A'); expect(first.references[0].text).toBe('  原样「引号」\n第二行  ');
  expect(() => { first.references[0].text = 'Model cannot replace this'; }).toThrow();
  const result = resolveProseBody([{ kind: 'speech', ref: 'npc-a' }, { kind: 'speech', ref: 'npc-b' }], first);
  (result.body.blocks[0] as any).text = 'Mutated returned snapshot'; expect(first.references[0].text).not.toBe('Mutated returned snapshot');
});

it.each([
  [{ kind: 'speech', ref: 'unknown' }, { kind: 'speech', ref: 'npc-b' }],
  [{ kind: 'speech', ref: 'npc-a' }],
  [{ kind: 'speech', ref: 'npc-b' }, { kind: 'speech', ref: 'npc-a' }],
  [{ kind: 'speech', ref: 'npc-a' }, { kind: 'speech', ref: 'npc-a' }, { kind: 'speech', ref: 'npc-b' }],
  [{ kind: 'speech', ref: 'npc-a', text: 'Invented replacement words.' }, { kind: 'speech', ref: 'npc-b' }],
  [{ kind: 'speech', ref: 'npc-a', roleId: 'player' }, { kind: 'speech', ref: 'npc-b' }],
  [{ kind: 'narration', text: ' ' }],
  [{ kind: 'unsupported', ref: 'npc-a' }],
  [],
].map(body => ({ body })))('rejects incomplete, reordered, duplicate or model-authored speech metadata (%#)', ({ body }) => {
  const plan = compileProseBodyPlan(fixture().refresh())!;
  expect(() => resolveProseBody(body, plan)).toThrow();
});

it('validates exact schemas without legacy text or speech identity fields and rejects non-JSON bodies without invoking accessors', () => {
  const plan = compileProseBodyPlan(fixture().refresh())!, validate = compileResultValidator(plan.schema);
  const good = [{ kind: 'speech', ref: 'npc-a' }, { kind: 'speech', ref: 'npc-b' }];
  expect(validate({ body: good })).toEqual([]); expect(validate({ text: 'A fallback transcript', body: good }).length).toBeGreaterThan(0);
  expect(validate({ body: [{ kind: 'speech', ref: 'npc-a', name: 'Spoofed' }] }).length).toBeGreaterThan(0);
  let reads = 0; const accessor = Object.defineProperty({ kind: 'speech' }, 'ref', { enumerable: true, get() { ++reads; return 'npc-a'; } });
  const sparse = new Array(2); sparse[1] = good[1];
  for (const raw of [[accessor, good[1]], sparse, [{ kind: 'narration', text: Infinity }], { body: good }, [Object.assign(Object.create({ inherited: true }), good[0]), good[1]]]) expect(() => resolveProseBody(raw, plan)).toThrow();
  expect(reads).toBe(0);
});

it('fails closed on player impersonation, duplicate host IDs, malformed channel grants, missing material or malformed format metadata', () => {
  for (const mutate of [
    (options: CompileProseBodyOptions) => { options.acceptedBehaviors = [{ id: 'fake-npc', roleId: 'player', kind: 'speech', text: 'Not an NPC candidate.' }]; },
    (options: CompileProseBodyOptions) => { options.acceptedBehaviors = [...options.acceptedBehaviors, options.acceptedBehaviors[0]]; },
    (options: CompileProseBodyOptions) => { options.acceptedBehaviors = [{ id: 'bad', roleId: 'a', kind: 'speech', text: 'Bad channel', interaction: { mode: 'remote', channel: 'unrecognized' } as any }]; },
    (options: CompileProseBodyOptions) => { options.materialTurnId = null; },
    (options: CompileProseBodyOptions) => { options.playerControl.mode = 'dialogue'; options.playerControl.authorizedAction = 'Player words'; options.acceptedBehaviors = [{ id: 'player:turn', roleId: 'a', kind: 'speech', text: 'Colliding ref' }]; },
    (options: CompileProseBodyOptions) => { options.card.proseFormat!.dialogue.module = 'card:dialogue'; },
    (options: CompileProseBodyOptions) => { (options.card.proseFormat!.dialogue as any).execute = 'No imported code'; },
  ]) { const options = fixture().refresh(); mutate(options); expect(() => compileProseBodyPlan(options)).toThrow(); }
  const f = fixture(), options = f.refresh(); let reads = 0;
  Object.defineProperty(f.card, 'proseFormat', { get() { ++reads; return undefined; } });
  expect(() => compileProseBodyPlan(options)).toThrow(); expect(reads).toBe(0);
});
