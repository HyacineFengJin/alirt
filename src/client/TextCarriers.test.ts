import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionSnapshot } from '../shared/types';
import type { TextCarriersView } from '../shared/text-carriers';
import { emptyTextCarrierDraft, recoverTextCarrierDraft, sendTextCarrierCommand, textCarrierCommand, TextCarrierEditor, TextCarrierForm, TextCarrierTargets, type TextCarrierDraft } from './TextCarriers';
import { readerTurnRequest } from './Reader';

const content = { medium: 'paper' as const, title: '公开告示', text: '请按现场标线等候。', location: '站台', available: true };
const view = (): TextCarriersView => ({ revision: 7, carriers: [{ id: 'carrier-real', versions: [{ ...content, version: 1, retired: false, sourceEventId: 'author-setting', revision: 7 }] }], views: [], targets: [{ carrierId: 'carrier-real', version: 1, medium: 'paper', title: content.title, location: '站台' }] });
const draft = (): TextCarrierDraft => ({ ...emptyTextCarrierDraft(), content: { ...content }, expectedRevision: 7, reason: '设置公开告示原文' });
afterEach(() => vi.unstubAllGlobals());
it('builds author-only setting commands with exact CAS/version and leaves viewing to a separate action', () => {
  const d = draft(), state = view(), before = JSON.stringify([d, state]);
  expect(textCarrierCommand(state, d, 'create')).toEqual({ requestId: 'create', expectedRevision: 7, reason: d.reason, operation: 'create', content });
  const editing = { ...d, operation: 'update' as const, carrierId: 'carrier-real', expectedVersion: 1 };
  expect(textCarrierCommand(state, editing, 'update')).toMatchObject({ operation: 'update', carrierId: 'carrier-real', expectedVersion: 1 });
  expect(textCarrierCommand(state, editing, 'retire', true)).toEqual({ requestId: 'retire', expectedRevision: 7, reason: d.reason, operation: 'retire', carrierId: 'carrier-real', expectedVersion: 1 });
  for (const change of [{ expectedRevision: 6 }, { reason: '' }, { applied: true }]) expect(() => textCarrierCommand(state, { ...d, ...change }, 'request')).toThrow();
  expect(() => textCarrierCommand(state, { ...editing, expectedVersion: 2 }, 'request')).toThrow('版本已改变');
  expect(JSON.stringify([d, state])).toBe(before);
});
it('preserves an unknown command for exact manual retry and blocks damaged pending recovery', async () => {
  const command = textCarrierCommand(view(), draft(), 'stable-command');
  const saved = recoverTextCarrierDraft(JSON.stringify({ ...draft(), pending: command }));
  expect(saved.pending).toEqual(command); expect(() => textCarrierCommand(view(), saved, 'new-id')).toThrow();
  for (const pending of [{ ...command, extra: true }, { ...command, expectedRevision: -1 }, { ...command, operation: 'view' }]) expect(() => recoverTextCarrierDraft(JSON.stringify({ ...draft(), pending }))).toThrow();
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError('unknown')).mockResolvedValueOnce({ ok: true, json: async () => ({ revision: 8, carrierId: 'carrier-real', version: 1, duplicate: true }) }); vi.stubGlobal('fetch', fetch);
  await expect(sendTextCarrierCommand('session/one', command)).rejects.toThrow('unknown');
  await expect(sendTextCarrierCommand('session/one', saved.pending!)).resolves.toMatchObject({ duplicate: true });
  expect(fetch.mock.calls[0][0]).toBe('/api/sessions/session%2Fone/services/rp.text-carrier-control/commands');
  expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
});
it('shows author setting/history separately from a metadata-only prepare picker and mounts no editor in role view', () => {
  const state = view(), extraTarget = { ...state.targets[0], text: '不得预读的正文哨兵' };
  const picker = renderToStaticMarkup(createElement(TextCarrierTargets, { targets: [extraTarget], disabled: true, prepare: () => { throw new Error('Rendering never prepares a view'); } }));
  expect(picker).toContain('公开告示'); expect(picker).not.toContain('不得预读的正文哨兵'); expect(picker).not.toContain(content.text); expect(picker).toContain('disabled=""');
  const form = renderToStaticMarkup(createElement(TextCarrierForm, { view: state, draft: draft(), disabled: true, change: () => {}, submit: () => { throw new Error('Rendering never writes'); } }));
  expect(form).toContain('是作者设定'); expect(form).toContain('保存不代表任何角色已查看'); expect(form).toContain('版本档案 · 1'); expect(form).toContain(content.text);
  expect(renderToStaticMarkup(createElement(TextCarrierEditor, { session: { id: 's', perspective: 'role' } as SessionSnapshot, readOnly: false, refresh: async () => {} }))).toBe('');
});
it('only submits an explicit version-bound player action target, excluding review and recovery', () => {
  const base = { requestId: 'view-request', revision: 7, mode: 'action' as const, action: '查看告示', narration: { person: 'auto' as const, pov: 'auto' as const }, perspective: 'author' };
  const target = { ...view().targets[0], text: 'not sent' };
  const payload = readerTurnRequest({ ...base, viewCarrier: target });
  expect(payload).toMatchObject({ mode: 'action', action: '查看告示', viewCarrier: { carrierId: 'carrier-real', version: 1 } });
  expect(payload.viewCarrier).not.toHaveProperty('text'); expect(payload.viewCarrier).not.toHaveProperty('title');
  for (const change of [{ mode: 'author' as const }, { perspective: 'role' }, { parallelRunId: 'run' }, { proseReview: { kind: 'main' as const, entryId: 'entry' } }]) expect(() => readerTurnRequest({ ...base, ...change, viewCarrier: target })).toThrow();
});
