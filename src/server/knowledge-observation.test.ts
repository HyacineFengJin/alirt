import { describe, expect, it } from 'vitest';
import type { RoleDefinition, WorldEvent } from '../shared/types';
import { textCarrierObservationText, type TextCarrierState, type TextCarrierViewReceipt } from '../shared/text-carriers';
import { runtimeFingerprint } from './prompt-compiler';
import { migrateKnowledge, projectKnowledgeEntries, proposeKnowledgeEdit, proposeKnowledgeObservation, type KnowledgeSession } from './knowledge-runtime';

const role = (id: string): RoleDefinition => ({ id, name: id, persona: '', goals: [], peers: [], phase: 'active', presence: 'absent', state: {}, knowledge: [] });
function fixture(): KnowledgeSession & { events: WorldEvent[] } {
  const event: WorldEvent = { id: 'scene-fact', at: '', kind: 'parallel-world-event', actor: 'parallel-world', audience: 'author', text: 'A note is marked PRIVATE_SCENE_TOKEN.',
    data: { sceneId: 'practice', observerRoleIds: ['a'], fact: { text: 'A note is marked PRIVATE_SCENE_TOKEN.', sources: [{ kind: 'world-development' }] } } };
  return { roles: [role('a'), role('b')], events: [event] };
}
describe('host-observed scene knowledge', () => {
  it('learns only for the declared observer, without turning reader disclosure into general role knowledge', () => {
    const original = fixture(), before = JSON.stringify(original);
    const next = proposeKnowledgeObservation(original, 'a', { eventId: 'scene-fact', sceneId: 'practice' });
    expect(JSON.stringify(original)).toBe(before);
    expect(next.roles[0].knowledge[0]).toMatchObject({ id: 'observed:scene-fact', status: 'known', audience: ['a'],
      provenance: { kind: 'derived', observation: { eventId: 'scene-fact', sceneId: 'practice' } } });
    expect(projectKnowledgeEntries(next.roles[0].knowledge, 'b')).toEqual([]);
    expect(next.roles[1].knowledge).toEqual([]);
    expect(() => proposeKnowledgeObservation(original, 'b', { eventId: 'scene-fact', sceneId: 'practice' })).toThrow('did not observe');
    expect(migrateKnowledge(next)).toEqual(next);
  });
  it('is idempotent and never restores withdrawn or author-replaced observations from archive replay', () => {
    const learned = proposeKnowledgeObservation(fixture(), 'a', { eventId: 'scene-fact', sceneId: 'practice' });
    expect(proposeKnowledgeObservation(learned, 'a', { eventId: 'scene-fact', sceneId: 'practice' })).toEqual(learned);
    const retracted = proposeKnowledgeEdit(learned, { operation: 'retract', roleId: 'a', id: 'observed:scene-fact' });
    expect(proposeKnowledgeObservation(retracted, 'a', { eventId: 'scene-fact', sceneId: 'practice' })).toEqual(retracted);
    const corrected = proposeKnowledgeEdit(learned, { operation: 'upsert', roleId: 'a', id: 'observed:scene-fact', text: 'Author-corrected memory.', audience: ['a'], status: 'uncertain' });
    expect(proposeKnowledgeObservation(corrected, 'a', { eventId: 'scene-fact', sceneId: 'practice' })).toEqual(corrected);
  });
  it('rejects public/prose/raw reports, wrong scene, inconsistent fact text and corrupted provenance', () => {
    for (const modify of [
      (event: WorldEvent) => { event.audience = 'public'; },
      (event: WorldEvent) => { event.kind = 'role-result'; },
      (event: WorldEvent) => { event.kind = 'host-output'; },
      (event: WorldEvent) => { (event.data as any).sceneId = 'different'; },
      (event: WorldEvent) => { (event.data as any).fact.text = 'Not this fact.'; },
    ]) {
      const source = fixture(); modify(source.events[0]);
      expect(() => proposeKnowledgeObservation(source, 'a', { eventId: 'scene-fact', sceneId: 'practice' })).toThrow();
    }
    const next = proposeKnowledgeObservation(fixture(), 'a', { eventId: 'scene-fact', sceneId: 'practice' });
    next.knowledgeRegistry!.sources[0].text = 'forged';
    expect(() => migrateKnowledge(next)).toThrow('Observation source');
  });
  it('records the actor own approved speech as an occurrence, while other listeners need explicit fact observations', () => {
    const source = fixture(); source.events[0] = { id: 'speech', at: '', kind: 'parallel-behavior', actor: 'a', audience: 'author', text: 'Someone told me the room is booked.',
      data: { sceneId: 'practice', observerRoleIds: ['a'], behavior: { id: 'behavior-1', roleId: 'a', kind: 'speech', text: 'Someone told me the room is booked.' } } };
    const next = proposeKnowledgeObservation(source, 'a', { eventId: 'speech', sceneId: 'practice' });
    expect(next.roles[0].knowledge[0].text).toBe('场外已批准发言：Someone told me the room is booked.');
    expect(() => proposeKnowledgeObservation(source, 'b', { eventId: 'speech', sceneId: 'practice' })).toThrow();
  });
});

function carrierFixture(): KnowledgeSession & { revision: number; events: WorldEvent[]; textCarriers: TextCarrierState } {
  const content = { medium: 'screen' as const, title: 'Unverified bulletin', text: 'The sign claims the rehearsal is cancelled.', location: 'Practice room', available: true };
  const command = { requestId: 'carrier-created', expectedRevision: 0, reason: 'Author retained local screen.', operation: 'create', content };
  const receipt: TextCarrierViewReceipt = { id: 'view', intentId: 'view-intent', materialTurnId: 'view-turn', worldRevision: 2, carrierId: 'carrier', carrierVersion: 1,
    readerRoleId: 'a', readerName: 'a', location: content.location, time: null, origin: { kind: 'behavior', behaviorId: 'approved-view-behavior' },
    carrier: { medium: content.medium, title: content.title, text: content.text, sourceEventId: 'carrier-created-event' }, observationEventId: 'carrier-view-event' };
  return { roles: [role('a'), role('b')], revision: 2,
    textCarriers: { schema: 'rp.text-carriers/0.1', carriers: [{ id: 'carrier', versions: [{ ...content, version: 1, retired: false, sourceEventId: 'carrier-created-event', revision: 1 }] }],
      views: [receipt], commands: [{ requestId: command.requestId, fingerprint: runtimeFingerprint(command), carrierId: 'carrier', version: 1, revision: 1 }] },
    events: [{ id: 'carrier-created-event', at: '', kind: 'text-carrier-control', actor: 'author', audience: 'author', text: 'Carrier retained.',
      data: { schema: 'rp.text-carrier-control-audit/0.1', carrierId: 'carrier', version: 1, revision: 1, fingerprint: runtimeFingerprint(command), command } },
    { id: 'world-commit', at: '', turnId: 'view-turn', kind: 'world-adjudication', actor: 'world', audience: 'author', text: 'Read occurrence committed.' },
    { id: 'carrier-view-event', at: '', turnId: 'view-turn', kind: 'text-carrier-view-observation', actor: 'host', audience: 'author', text: textCarrierObservationText(receipt),
      data: { schema: 'rp.text-carrier-view-observation/0.1', sceneId: 'main', observerRoleIds: ['a'], viewId: 'view' } }] };
}
describe('carrier read occurrence knowledge', () => {
  it('records a receipt-backed owner-only read occurrence without treating the carrier claim as a verified world fact', () => {
    const original = carrierFixture(), before = structuredClone(original), observation = { eventId: 'carrier-view-event', sceneId: 'main' };
    const learned = proposeKnowledgeObservation(original, 'a', observation), entry = learned.roles[0].knowledge[0];
    expect(entry).toMatchObject({ id: 'observed:carrier-view-event', text: '载体观察：' + textCarrierObservationText(original.textCarriers.views[0]), status: 'known', audience: ['a'],
      provenance: { kind: 'derived', sourceRefs: [], observation } });
    expect(learned.roles[1].knowledge).toEqual([]); expect(projectKnowledgeEntries(learned.roles[0].knowledge, 'b')).toEqual([]);
    expect(learned.events).toEqual(original.events); expect(original).toEqual(before); expect(migrateKnowledge(learned)).toEqual(learned);
    expect(proposeKnowledgeObservation(learned, 'a', observation)).toEqual(learned);
    const withdrawn = proposeKnowledgeEdit(learned, { operation: 'retract', roleId: 'a', id: entry.id });
    expect(proposeKnowledgeObservation(withdrawn, 'a', observation)).toEqual(withdrawn);
    expect(() => proposeKnowledgeObservation(original, 'b', observation)).toThrow();
  });
  it('rejects forged event fields, foreign readers/material turns and receipt/version snapshots before knowledge is changed', () => {
    for (const mutate of [
      (session: ReturnType<typeof carrierFixture>) => { session.events[2].actor = 'a'; },
      (session: ReturnType<typeof carrierFixture>) => { session.events[2].audience = 'public'; },
      (session: ReturnType<typeof carrierFixture>) => { (session.events[2].data as any).extra = true; },
      (session: ReturnType<typeof carrierFixture>) => { (session.events[2].data as any).observerRoleIds = ['a', 'b']; },
      (session: ReturnType<typeof carrierFixture>) => { (session.events[2].data as any).viewId = 'foreign'; },
      (session: ReturnType<typeof carrierFixture>) => { session.textCarriers.views[0].readerRoleId = 'b'; },
      (session: ReturnType<typeof carrierFixture>) => { session.textCarriers.views[0].materialTurnId = 'foreign-turn'; },
      (session: ReturnType<typeof carrierFixture>) => { session.textCarriers.views[0].carrier.text = 'Forged text'; },
      (session: ReturnType<typeof carrierFixture>) => { session.textCarriers.carriers[0].versions[0].text = 'Forged canonical body'; },
      (session: ReturnType<typeof carrierFixture>) => { session.textCarriers.views[0].carrierVersion = 2; },
      (session: ReturnType<typeof carrierFixture>) => { (session.events[0].data as any).fingerprint = '0'.repeat(64); },
      (session: ReturnType<typeof carrierFixture>) => { session.textCarriers.commands[0].version = 2; },
      (session: ReturnType<typeof carrierFixture>) => { session.events[2].text = 'The rehearsal is cancelled.'; },
      (session: ReturnType<typeof carrierFixture>) => { session.events = session.events.filter(event => event.id !== 'world-commit'); },
    ]) { const session = carrierFixture(); mutate(session); const before = structuredClone(session); expect(() => proposeKnowledgeObservation(session, 'a', { eventId: 'carrier-view-event', sceneId: 'main' })).toThrow(); expect(session).toEqual(before); }
  });
});
