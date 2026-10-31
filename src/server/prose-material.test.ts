import { describe, expect, it } from 'vitest';
import { narrationBrief, NARRATION_BRIEF_SCHEMA, playerIdentity } from './prose-material';
import type { BehaviorCandidate } from '../shared/behavior';
import type { WorldEvent } from '../shared/types';

describe('narration disclosure material distinct from presentation', () => {
  it('keeps exact approved transmission channels even when the world subsequently brings an actor into the room', () => {
    const approved: BehaviorCandidate[] = [
      { id: 'sms', roleId: 'visitor', kind: 'speech', text: 'I will arrive shortly.', interaction: { mode: 'remote', channel: 'message' } },
      { id: 'arrival', roleId: 'visitor', kind: 'action', text: 'The visitor arrives.' },
    ];
    const brief = narrationBrief({ revision: 4, materialTurnId: 'world-turn', playerRoleId: 'player', playerMode: 'dialogue',
      roles: [{ id: 'player', name: '阿青', presence: 'present' }, { id: 'visitor', name: 'Visitor', presence: 'present' }],
      acceptedBehaviors: approved, events: [] });
    expect(brief.schema).toBe(NARRATION_BRIEF_SCHEMA);
    expect(brief.player.displayName).toBe('阿青');
    expect(brief.scene.physicalRoleIds).toEqual(['player', 'visitor']);
    expect(brief.scene.transmissions).toEqual([{ behaviorId: 'sms', roleId: 'visitor', channel: 'message' }]);
    expect(brief.evidence.behaviorIds).toEqual(['sms', 'arrival']);
    expect(brief.evidence.playerAction.mode).toBe('dialogue');
  });
  it('includes only current public fact handles and explicit previous-prose provenance, without trusting text as evidence', () => {
    const event = (id: string, kind: string): WorldEvent => ({ id, kind, actor: 'world', audience: 'public', text: 'Public text', at: '', turnId: 'world-turn' });
    const brief = narrationBrief({ revision: 7, materialTurnId: 'world-turn', playerRoleId: 'player', playerMode: 'action',
      roles: [{ id: 'player', name: '你', presence: 'present' }, { id: 'offstage', name: 'Away', presence: 'absent' }],
      acceptedBehaviors: [], events: [event('facts', 'world-event'), event('audit', 'world-adjudication'),
        { ...event('old-facts', 'world-event'), turnId: 'old-turn' }, { ...event('private-facts', 'world-facts'), audience: 'author' }],
      previousProse: { id: 'old-prose', turnId: 'old-turn', text: 'UNAPPROVED_PROSE_DETAIL', title: 'Old prose', worldRevision: 3 } });
    expect(brief.evidence.factEventIds).toEqual(['facts']);
    expect(brief.scene.physicalRoleIds).toEqual(['player']);
    expect(brief.scene.transmissions).toEqual([]);
    expect(brief.previousProse).toMatchObject({ entryId: 'old-prose', turnId: 'old-turn', worldRevision: 3 });
    expect(JSON.stringify(brief)).not.toContain('UNAPPROVED_PROSE_DETAIL');
    expect(brief.evidence.privateInteriority).toContain('Not supplied');
  });
  it('preserves actual identity names rather than coercing notation or guessing an unnamed player', () => {
    expect(playerIdentity({ playerRoleId: 'p', roles: [{ id: 'p', name: '<user>' }] }).displayName).toBe('<user>');
    expect(() => playerIdentity({ playerRoleId: 'missing', roles: [] })).toThrow('identity is unavailable');
  });
});
