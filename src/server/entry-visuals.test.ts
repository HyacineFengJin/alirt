import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createNativeTemplate } from '../shared/native';
import type { ProseBody } from '../shared/prose-body';
import type { CharacterCard, Preset } from '../shared/types';
import type { VisualImageAsset, VisualImageRef } from '../shared/visual-assets';
import { SessionStore } from './store';
import { snapshotEntryVisuals } from './entry-visuals';
import { applyRoleVisualCommand } from './role-visuals';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const image = (digit: string): VisualImageRef => ({ assetId: digit.repeat(64), sha256: digit.repeat(64), mimeType: 'image/webp', width: 100, height: 150, bytes: 400 });
const body: ProseBody = { schema: 'rp.prose-body/0.1', materialTurnId: 'material', renderer: 'character-dialogue', blocks: [
  { kind: 'narration', text: 'A quiet room.' },
  { kind: 'speech', ref: 'speech-a', roleId: 'a', name: 'Same name', text: 'A approved line.', channel: 'local', speaker: 'npc' },
  { kind: 'speech', ref: 'speech-b', roleId: 'b', name: 'Same name', text: 'B approved line.', channel: 'local', speaker: 'npc' },
] };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rp-entry-visuals-')); roots.push(root);
  const card = createNativeTemplate('card') as CharacterCard; card.opening = '';
  card.roles.push(...['a', 'b'].map(id => ({ id, name: 'Same name', persona: '', goals: [], peers: [], phase: 'active' as const, presence: 'present' as const, state: {}, knowledge: [] })));
  card.visuals = { schema: 'rp.card-visuals/0.1', enabled: true, source: { importId: 'visual-fixture', pointer: '/images', sha256: 'c'.repeat(64) },
    defaults: [{ roleId: 'a', roleName: 'Same name', slot: 'dialogue-avatar', image: image('a'), crop: { x: .1, y: .2, zoom: 1.2 } }] };
  const store = new SessionStore(root), id = store.create(card, createNativeTemplate('preset') as Preset).id;
  const asset: VisualImageAsset = { ...image('b'), title: 'Author image', originalSha256: 'd'.repeat(64), origin: { kind: 'upload' } };
  const bind = () => applyRoleVisualCommand(store, id, { requestId: 'bind', expectedRevision: store.get(id).revision, reason: 'Choose an author picture.', roleId: 'b',
    slot: 'dialogue-avatar', expectedVersion: 0, operation: 'bind', assetId: asset.assetId, crop: { x: .8, y: .7, zoom: 2 } }, { list: () => [asset] });
  return { store, id, bind };
}

it('captures exact current host speech references and role identities into detached immutable presentation metadata', () => {
  const f = fixture(); f.bind(); const session = structuredClone(f.store.get(f.id)), before = structuredClone(session), first = snapshotEntryVisuals(session, body)!;
  expect(first.speakers.map(speaker => [speaker.ref, speaker.visual.roleId, speaker.visual.image.assetId])).toEqual([
    ['speech-a', 'a', 'a'.repeat(64)], ['speech-b', 'b', 'b'.repeat(64)],
  ]);
  expect(first.speakers[0].visual.crop).toEqual({ x: .1, y: .2, zoom: 1.2 }); expect(first.speakers[1].visual.crop).toEqual({ x: .8, y: .7, zoom: 2 });
  session.card.visuals!.defaults[0].crop.x = 1;
  const current = session.visuals!.bindings[0].versions[0].value; if (current.kind !== 'asset') throw new Error('Expected author binding'); current.crop.x = 0;
  expect(first.speakers[0].visual.crop.x).toBe(.1); expect(first.speakers[1].visual.crop.x).toBe(.8);
  first.speakers[0].visual.image.width = 1; expect(f.store.get(f.id)).toEqual(before);
});

it('honors explicit source-off over author bindings, but permits native author bindings without a source descriptor', () => {
  const f = fixture(); f.bind(); const session = structuredClone(f.store.get(f.id));
  session.card.visuals!.enabled = false; expect(snapshotEntryVisuals(session, body)).toBeUndefined();
  delete session.card.visuals;
  expect(snapshotEntryVisuals(session, body)?.speakers.map(speaker => speaker.visual.roleId)).toEqual(['b']);
  delete session.visuals; expect(snapshotEntryVisuals(session, body)).toBeUndefined();
});

it('keeps empty enabled defaults as an honest fallback and treats corrupt optional visual data as unavailable', () => {
  const f = fixture(), session = structuredClone(f.store.get(f.id)); session.card.visuals!.defaults = [];
  expect(snapshotEntryVisuals(session, body)).toEqual({ schema: 'rp.entry-visuals/0.1', speakers: [] });
  session.visuals = { schema: 'rp.role-visuals/0.1', bindings: [], commands: [{ requestId: 'broken' } as never] };
  const before = structuredClone(session); expect(snapshotEntryVisuals(session, body)).toBeUndefined(); expect(session).toEqual(before);
});
