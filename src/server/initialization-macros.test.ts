import { describe, expect, it } from 'vitest';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard } from '../shared/types';
import { initializationContext, initializeStory } from './initialization-runtime';

describe('source opening macros', () => {
  it('resolves only common name macros in displayed text and first-dispatch context, keeping the bound definition intact', () => {
    const card = createNativeTemplate('card') as CharacterCard;
    card.title = 'Harbor';
    card.initialization = { schema: 'rp.initialization/0.1',
      openings: [{ id: 'hello', title: 'Greeting', text: '{{user}} enters {{char}}. {{unknown}}', instruction: 'Welcome {{user}}.',
        delivery: { world: 'Set up {{user}} in {{char}}.', prose: 'Write for {{user}}.' },
        cast: card.roles.map(role => ({ roleId: role.id, phase: role.phase, presence: role.presence })) }],
      playerProfiles: [{ id: 'visitor', title: 'Visitor', name: 'Aster', persona: 'A visitor.' }] };
    const before = JSON.stringify(card);
    const initialized = initializeStory(card, {});
    expect(initialized.opening).toBe('Aster enters Harbor. {{unknown}}');
    const view = initializationContext({ card, roles: initialized.roles, playerRoleId: card.playerRoleId, initialization: initialized.receipt });
    expect(view?.opening.instruction).toBe('Welcome Aster.');
    expect(view?.opening.delivery).toEqual({ world: 'Set up Aster in Harbor.', prose: 'Write for Aster.' });
    expect(JSON.stringify(card)).toBe(before);
    view!.opening.delivery!.world = 'Edited return value';
    expect(JSON.stringify(card)).toBe(before);
  });
});
