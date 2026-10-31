import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset } from '../shared/types';
import { SessionStore } from './store';
import { applyTextCarrierCommand, parseTextCarrierSelection, readTextCarriers, readTextCarrierState, textCarrierTargets, textCarriersService } from './text-carriers';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rp-carrier-control-')); roots.push(root);
  const card = createNativeTemplate('card') as CharacterCard; card.opening = ''; card.world.location = 'Hall';
  for (const id of ['a', 'b']) card.roles.push({ id, name: id, persona: '', goals: [], peers: [], phase: 'active', presence: 'present', state: {}, knowledge: [] });
  const store = new SessionStore(root), id = store.create(card, createNativeTemplate('preset') as Preset).id;
  const content = { medium: 'paper' as const, title: 'A notice', text: 'CARRIER_BODY_CANARY states a claim, not its truth.', location: 'Hall', available: true };
  const expectedRevision = store.get(id).revision;
  const create = () => applyTextCarrierCommand(store, id, { requestId: 'create', expectedRevision, reason: 'Explicit author calibration.', operation: 'create', content });
  return { root, store, id, content, create, file: join(root, `session-${id}.json`) };
}

it('keeps an empty catalog inert and lists only metadata without creating or learning anything', () => {
  const f = fixture(), initial = readFileSync(f.file, 'utf8');
  expect(readTextCarriers(f.store.get(f.id))).toMatchObject({ carriers: [], views: [], targets: [] });
  expect(textCarrierTargets(f.store.get(f.id), 'a')).toEqual([]); expect(readFileSync(f.file, 'utf8')).toBe(initial);
  const applied = f.create(), before = readFileSync(f.file, 'utf8'), targets = textCarrierTargets(f.store.get(f.id), 'a');
  expect(applied.carrierId).toMatch(/^[0-9a-f-]{36}$/);
  expect(targets).toEqual([{ carrierId: applied.carrierId, version: 1, medium: 'paper', title: 'A notice', location: 'Hall' }]);
  expect(JSON.stringify(targets)).not.toContain('CARRIER_BODY_CANARY');
  targets[0].title = 'Caller alias'; expect(textCarrierTargets(f.store.get(f.id), 'a')[0].title).toBe('A notice');
  expect(readFileSync(f.file, 'utf8')).toBe(before); expect(f.store.get(f.id).roles.every(role => !role.knowledge.length)).toBe(true);
  expect(textCarriersService.id).toBe('rp.text-carrier-control');
});

it('uses author CAS and exact idempotence, preserves immutable history across update/retire/restart', () => {
  const f = fixture(), first = f.create(), before = readFileSync(f.file, 'utf8');
  expect(f.create()).toEqual({ ...first, duplicate: true }); expect(readFileSync(f.file, 'utf8')).toBe(before);
  const update = { requestId: 'update', expectedRevision: first.revision, reason: 'Explicit correction.', operation: 'update', carrierId: first.carrierId, expectedVersion: 1,
    content: { ...f.content, text: 'Corrected visible words.', medium: 'screen' } };
  const second = applyTextCarrierCommand(f.store, f.id, update), original = readTextCarrierState(f.store.get(f.id)).carriers[0].versions[0];
  expect(second).toMatchObject({ version: 2, revision: first.revision + 1 });
  const stable = readFileSync(f.file, 'utf8');
  expect(() => applyTextCarrierCommand(f.store, f.id, { ...update, reason: 'Changed same request.' })).toThrow();
  expect(() => applyTextCarrierCommand(f.store, f.id, { ...update, requestId: 'stale-revision' })).toThrow();
  expect(() => applyTextCarrierCommand(f.store, f.id, { ...update, requestId: 'stale-version', expectedRevision: second.revision })).toThrow();
  expect(readFileSync(f.file, 'utf8')).toBe(stable);
  expect(applyTextCarrierCommand(f.store, f.id, update)).toEqual({ ...second, duplicate: true });
  const retired = applyTextCarrierCommand(f.store, f.id, { requestId: 'retire', expectedRevision: second.revision, reason: 'Author withdrew the object.', operation: 'retire', carrierId: first.carrierId, expectedVersion: 2 });
  const state = readTextCarrierState(new SessionStore(f.root).get(f.id));
  expect(retired.version).toBe(3); expect(state.carriers[0].versions[0]).toEqual(original);
  expect(state.carriers[0].versions.map(version => [version.version, version.retired])).toEqual([[1, false], [2, false], [3, true]]);
  expect(state.carriers[0].versions[2]).toMatchObject({ text: 'Corrected visible words.', available: false });
  expect(textCarrierTargets(f.store.get(f.id), 'a')).toEqual([]);
  expect(() => applyTextCarrierCommand(f.store, f.id, { ...update, requestId: 'resurrect', expectedRevision: retired.revision, expectedVersion: 3 })).toThrow('retired');
});

it('admits only active present local readers and the current available version at the main location', () => {
  const f = fixture(); f.create(); const base = structuredClone(f.store.get(f.id));
  for (const mutate of [
    (session: typeof base) => { session.roles.find(role => role.id === 'a')!.presence = 'absent'; },
    (session: typeof base) => { session.roles.find(role => role.id === 'a')!.phase = 'dormant'; },
    (session: typeof base) => { session.roles.find(role => role.id === 'a')!.phase = 'retired'; },
    (session: typeof base) => { session.roles.find(role => role.id === 'a')!.interaction = { mode: 'remote', channel: 'screen' }; },
    (session: typeof base) => { session.world.location = 'Elsewhere'; },
    (session: typeof base) => { session.world.location = ''; },
  ]) { const session = structuredClone(base); mutate(session); expect(textCarrierTargets(session, 'a')).toEqual([]); }
  expect(textCarrierTargets(base, 'unknown')).toEqual([]);
  const latest = applyTextCarrierCommand(f.store, f.id, { requestId: 'unavailable', operation: 'update', expectedRevision: base.revision, reason: 'Object closed.',
    carrierId: base.textCarriers!.carriers[0].id, expectedVersion: 1, content: { ...f.content, available: false } });
  expect(latest.version).toBe(2); expect(textCarrierTargets(f.store.get(f.id), 'a')).toEqual([]);
});

it('rejects non-JSON selections and commands without executing accessors or partially saving, and detects altered retained versions', () => {
  const f = fixture(), applied = f.create(), before = readFileSync(f.file, 'utf8');
  for (const raw of [{ carrierId: applied.carrierId, version: 1, body: 'No' }, { carrierId: applied.carrierId, version: 1.2 },
    { carrierId: applied.carrierId, version: 0 }, { carrierId: '__proto__', version: 1 }]) expect(() => parseTextCarrierSelection(raw)).toThrow();
  let calls = 0; const raw = { carrierId: applied.carrierId, get version() { calls++; return 1; } };
  expect(() => parseTextCarrierSelection(raw)).toThrow('ordinary JSON'); expect(calls).toBe(0);
  expect(() => applyTextCarrierCommand(f.store, f.id, { requestId: 'bad', expectedRevision: applied.revision, operation: 'create', reason: '', content: f.content })).toThrow();
  expect(() => applyTextCarrierCommand(f.store, f.id, { requestId: 'extra', expectedRevision: applied.revision, operation: 'create', reason: 'Reason', content: { ...f.content, hidden: true } })).toThrow();
  expect(readFileSync(f.file, 'utf8')).toBe(before);
  const altered = structuredClone(f.store.get(f.id)); altered.textCarriers!.carriers[0].versions[0].text = 'Changed without author command';
  expect(() => readTextCarriers(altered)).toThrow('immutable command');
  const missing = structuredClone(f.store.get(f.id)); delete missing.textCarriers;
  expect(() => readTextCarriers(missing)).toThrow('missing');
});
