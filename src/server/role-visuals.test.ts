import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset } from '../shared/types';
import type { VisualImageAsset, VisualImageRef } from '../shared/visual-assets';
import { SessionStore } from './store';
import { applyRoleVisualCommand, createRoleVisualsService, readRoleVisuals, readRoleVisualState } from './role-visuals';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const image = (digit: string): VisualImageRef => ({ assetId: digit.repeat(64), sha256: digit.repeat(64), mimeType: 'image/webp', width: 100, height: 200, bytes: 500 });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rp-role-visuals-')); roots.push(root);
  const card = createNativeTemplate('card') as CharacterCard; card.opening = '';
  for (const id of ['a', 'b']) card.roles.push({ id, name: 'Same display name', persona: 'Unaffected persona.', goals: [], peers: [], phase: 'active', presence: 'present', state: {}, knowledge: [] });
  card.visuals = { schema: 'rp.card-visuals/0.1', enabled: true, source: { importId: 'reviewed', pointer: '/source/avatars', sha256: 'c'.repeat(64) },
    defaults: [{ roleId: 'a', roleName: 'Original source name', slot: 'dialogue-avatar', image: image('a'), crop: { x: .2, y: .4, zoom: 1.5 } }] };
  const store = new SessionStore(root), id = store.create(card, createNativeTemplate('preset') as Preset).id;
  let assets: VisualImageAsset[] = [{ ...image('b'), title: 'Author image', originalSha256: 'd'.repeat(64), origin: { kind: 'upload' } }];
  const library = { list: () => structuredClone(assets) };
  const bind = { operation: 'bind', requestId: 'bind', expectedRevision: store.get(id).revision, reason: 'Author explicitly chooses this role image.', roleId: 'b', slot: 'dialogue-avatar', expectedVersion: 0,
    assetId: 'b'.repeat(64), crop: { x: 0, y: 1, zoom: 2 } };
  return { root, store, id, library, bind, file: join(root, `session-${id}.json`), removeAsset: () => { assets = []; } };
}
const protectedState = (session: ReturnType<SessionStore['get']>) => structuredClone({ world: session.world, roles: session.roles, knowledge: session.knowledgeRegistry, prose: session.prose,
  modules: session.card.modules, outputs: session.card.outputs, preset: session.preset });

it('resolves source defaults by stable role identity without reading names, creating bindings or touching the story', () => {
  const f = fixture(), before = readFileSync(f.file, 'utf8'), current = readRoleVisuals(f.store.get(f.id));
  expect(current.visuals).toHaveLength(1); expect(current.visuals[0]).toMatchObject({ roleId: 'a', image: image('a'), provenance: { kind: 'source', importId: 'reviewed' } });
  expect(current.visuals.some(visual => visual.roleId === 'b')).toBe(false); expect(f.store.get(f.id).visuals).toBeUndefined();
  current.visuals[0].crop.x = 1; expect(readRoleVisuals(f.store.get(f.id)).visuals[0].crop.x).toBe(.2);
  expect(readFileSync(f.file, 'utf8')).toBe(before);
  const off = structuredClone(f.store.get(f.id)); off.card.visuals!.enabled = false; expect(readRoleVisuals(off).visuals).toEqual([]);
});

it('binds, hides and resets with immutable audit versions while preserving world/roles/knowledge/prose', () => {
  const f = fixture(), protectedBefore = protectedState(f.store.get(f.id)), first = applyRoleVisualCommand(f.store, f.id, f.bind, f.library);
  expect(first).toMatchObject({ version: 1, revision: 1, roleId: 'b', slot: 'dialogue-avatar' });
  const initialBinding = structuredClone(readRoleVisualState(f.store.get(f.id)).bindings[0].versions[0]);
  expect(readRoleVisuals(f.store.get(f.id)).visuals.map(visual => visual.roleId)).toEqual(['a', 'b']);
  f.removeAsset(); expect(readRoleVisuals(f.store.get(f.id)).visuals.find(visual => visual.roleId === 'b')).toMatchObject({ image: image('b'), crop: f.bind.crop });
  const hidden = applyRoleVisualCommand(f.store, f.id, { operation: 'hide', requestId: 'hide', expectedRevision: first.revision, expectedVersion: 1,
    roleId: 'b', slot: 'dialogue-avatar', reason: 'Explicitly hide this role picture.' }, f.library);
  expect(readRoleVisuals(f.store.get(f.id)).visuals.map(visual => visual.roleId)).toEqual(['a']);
  applyRoleVisualCommand(f.store, f.id, { operation: 'reset', requestId: 'reset', expectedRevision: hidden.revision, expectedVersion: 2,
    roleId: 'b', slot: 'dialogue-avatar', reason: 'Restore source default, which is absent for this role.' }, f.library);
  const aHidden = applyRoleVisualCommand(f.store, f.id, { operation: 'hide', requestId: 'hide-a', expectedRevision: f.store.get(f.id).revision, expectedVersion: 0,
    roleId: 'a', slot: 'dialogue-avatar', reason: 'Hide source default.' }, f.library);
  expect(readRoleVisuals(f.store.get(f.id)).visuals).toEqual([]);
  applyRoleVisualCommand(f.store, f.id, { operation: 'reset', requestId: 'reset-a', expectedRevision: aHidden.revision, expectedVersion: 1,
    roleId: 'a', slot: 'dialogue-avatar', reason: 'Restore exact source default.' }, f.library);
  const restarted = new SessionStore(f.root).get(f.id);
  expect(readRoleVisuals(restarted).visuals.map(visual => visual.roleId)).toEqual(['a']);
  expect(readRoleVisualState(restarted).bindings.find(record => record.roleId === 'b')!.versions[0]).toEqual(initialBinding);
  expect(protectedState(restarted)).toEqual(protectedBefore);
});

it('is exact-request idempotent and rejects stale versions, unknown roles/assets, invalid crops and accessors atomically', () => {
  const f = fixture(), applied = applyRoleVisualCommand(f.store, f.id, f.bind, f.library), before = readFileSync(f.file, 'utf8');
  expect(applyRoleVisualCommand(f.store, f.id, f.bind, f.library)).toEqual({ ...applied, duplicate: true });
  for (const update of [{ reason: 'Changed same request' }, { requestId: 'stale-revision' },
    { requestId: 'stale-version', expectedRevision: applied.revision }, { requestId: 'unknown-role', expectedRevision: applied.revision, roleId: 'Same display name' },
    { requestId: 'unknown-asset', expectedRevision: applied.revision, expectedVersion: 1, assetId: 'e'.repeat(64) },
    { requestId: 'crop-outside', expectedRevision: applied.revision, expectedVersion: 1, crop: { x: -1, y: .5, zoom: 1 } },
    { requestId: 'book-is-separate', expectedRevision: applied.revision, expectedVersion: 1, slot: 'book-portrait' },
    { requestId: 'url', expectedRevision: applied.revision, expectedVersion: 1, url: 'https://invalid.test' }])
    expect(() => applyRoleVisualCommand(f.store, f.id, { ...f.bind, ...update }, f.library)).toThrow();
  let calls = 0; const accessor = { ...f.bind, get reason() { calls++; return 'Reason'; } };
  expect(() => applyRoleVisualCommand(f.store, f.id, accessor, f.library)).toThrow(); expect(calls).toBe(0);
  expect(readFileSync(f.file, 'utf8')).toBe(before);
});

it('returns only library metadata and detects altered held presentation references without rewriting audit', () => {
  const f = fixture(); applyRoleVisualCommand(f.store, f.id, f.bind, f.library);
  const service = createRoleVisualsService(f.library), view = service.read(f.store.get(f.id)) as any;
  expect(service.id).toBe('rp.role-visuals'); expect(view.roles.filter((role: any) => role.name === 'Same display name').map((role: any) => role.id)).toEqual(['a', 'b']);
  expect(view.assets[0].assetId).toBe(f.bind.assetId); expect(JSON.stringify(view)).not.toMatch(/\.webp|\/originals\/|data:image|"path"/);
  const altered = structuredClone(f.store.get(f.id)); const binding = altered.visuals!.bindings[0].versions[0].value;
  if (binding.kind !== 'asset') throw new Error('Expected author asset'); binding.image.width = 999;
  expect(() => readRoleVisuals(altered)).toThrow('differs');
});
