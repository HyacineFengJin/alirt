import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '../shared/types';
import { DEFAULT_VISUAL_CROP, type RoleVisualsView, type VisualImageAsset } from '../shared/visual-assets';
import { api } from './api';
import { recoverVisualDraft, saveVisualCommand, uploadTicketMatches, ViewImage, VisualAssetForm, visualAssetRef, VisualAssetsDialog, VisualAssetsInline, visualCommand, visualFileFingerprint, type VisualDraft } from './VisualAssets';

const digest = 'a'.repeat(64);
const asset: VisualImageAsset = { assetId: digest, sha256: digest, mimeType: 'image/webp', width: 512, height: 256, bytes: 120, title: '本地图片', originalSha256: 'b'.repeat(64), origin: { kind: 'upload' } };
const view = (): RoleVisualsView => ({ revision: 7, roles: [{ id: 'role-one', name: '同名' }, { id: 'role-two', name: '同名' }], assets: [asset], bindings: [{ roleId: 'role-two', slot: 'dialogue-avatar', versions: [{ version: 2, revision: 6, sourceEventId: 'saved', value: { kind: 'none' } }] }], current: { schema: 'rp.role-visuals-view/0.1', visuals: [] } });
const draft = (): VisualDraft => ({ roleId: 'role-two', assetId: digest, crop: { x: .25, y: .75, zoom: 2 }, reason: '明确修改第二位同名角色头像', uploadTitle: '本地图片', expectedRevision: 7, expectedVersion: 2 });
afterEach(() => vi.unstubAllGlobals());

it('binds an exact role ID and both revisions, with distinct hide/reset operations and no mutation of input', () => {
  const state = view(), d = draft(), before = JSON.stringify([state, d]);
  const command = visualCommand(state, d, 'bind', 'stable-bind');
  expect(command).toEqual({ requestId: 'stable-bind', expectedRevision: 7, expectedVersion: 2, roleId: 'role-two', slot: 'dialogue-avatar', reason: d.reason, operation: 'bind', assetId: digest, crop: d.crop });
  const hidden = visualCommand(state, d, 'hide', 'hide');
  expect(hidden).toMatchObject({ requestId: 'hide', operation: 'hide', roleId: 'role-two', expectedVersion: 2 }); expect(hidden).not.toHaveProperty('assetId'); expect(hidden).not.toHaveProperty('crop');
  expect(visualCommand(state, d, 'reset', 'reset')).toMatchObject({ operation: 'reset', roleId: 'role-two', expectedVersion: 2 });
  for (const changed of [{ expectedRevision: 6 }, { expectedVersion: 1 }, { reason: '' }, { roleId: 'unknown' }, { applied: true }, { assetId: 'c'.repeat(64) }, { crop: { x: 1.1, y: 0, zoom: 1 } }]) expect(() => visualCommand(state, { ...d, ...changed }, 'bind', 'new')).toThrow();
  expect(JSON.stringify([state, d])).toBe(before);
});

it('retains an unknown binding request for exact manual retry and blocks corrupt or inconsistent recovered drafts', async () => {
  const d = draft(), command = visualCommand(view(), d, 'bind', 'stable-bind');
  const saved = recoverVisualDraft(JSON.stringify({ ...d, pending: command }));
  expect(saved.pending).toEqual(command); expect(() => visualCommand(view(), saved, 'bind', 'replacement-id')).toThrow();
  for (const changed of [{ pending: { ...command, extra: true } }, { pending: { ...command, expectedRevision: 8 } }, { roleId: 'role-one' }, { reason: 'changed' }, { crop: DEFAULT_VISUAL_CROP }, { applied: true }]) expect(() => recoverVisualDraft(JSON.stringify({ ...d, pending: command, ...changed }))).toThrow();
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError('unknown network outcome')).mockResolvedValueOnce({ ok: true, json: async () => ({ revision: 8, roleId: 'role-two', slot: 'dialogue-avatar', version: 3, duplicate: true }) }); vi.stubGlobal('fetch', fetch);
  await expect(saveVisualCommand('session/one', command)).rejects.toThrow('unknown network outcome');
  await expect(saveVisualCommand('session/one', saved.pending!)).resolves.toMatchObject({ duplicate: true });
  expect(fetch.mock.calls[0][0]).toBe('/api/sessions/session%2Fone/services/rp.role-visuals/commands');
  expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
});

it('resumes upload identity only with the original bytes, MIME, size and title after a lost receipt', async () => {
  const file = new File([new Uint8Array([1, 2, 3])], 'local.png', { type: 'image/png' });
  const sha256 = await visualFileFingerprint(file), ticket = { requestId: 'stable-upload', title: '保留原上传标题', fileName: file.name, mimeType: file.type, size: file.size, sha256 };
  const saved = recoverVisualDraft(JSON.stringify({ ...draft(), uploadTitle: ticket.title, pendingUpload: ticket }));
  expect(uploadTicketMatches(saved.pendingUpload!, file, sha256)).toBe(true);
  expect(uploadTicketMatches(ticket, file, '0'.repeat(64))).toBe(false);
  expect(uploadTicketMatches(ticket, { size: file.size, type: 'image/webp' }, sha256)).toBe(false);
  expect(() => recoverVisualDraft(JSON.stringify({ ...saved, uploadTitle: '不能换标题' }))).toThrow();
  await expect(visualFileFingerprint(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }))).rejects.toThrow('PNG');
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError('lost receipt')).mockResolvedValueOnce({ ok: true, json: async () => ({ asset, duplicate: true }) }); vi.stubGlobal('fetch', fetch);
  await expect(api.visualUpload(ticket.requestId, file, ticket.title)).rejects.toThrow('lost receipt');
  await expect(api.visualUpload(saved.pendingUpload!.requestId, file, saved.pendingUpload!.title)).resolves.toMatchObject({ duplicate: true });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][1]).toEqual(fetch.mock.calls[1][1]);
  expect(fetch.mock.calls[1][1].headers['X-Request-ID']).toBe('stable-upload');
  expect(fetch.mock.calls[1][1].body).toBe(file);
});

it('renders the shared cover crop with local asset URLs and an escaped initial fallback for invalid images', () => {
  const image = visualAssetRef(asset), html = renderToStaticMarkup(createElement(ViewImage, { image, crop: { x: .25, y: .75, zoom: 2 }, name: '<同名>', diagnostic: true }));
  expect(html).toContain(`/api/visual-assets/images/${digest}`); expect(html).toContain('width:400%'); expect(html).toContain('height:200%'); expect(html).toContain('left:-75%'); expect(html).toContain('top:-75%');
  expect(html).not.toContain('http'); expect(html).not.toContain('srcset');
  const invalid = renderToStaticMarkup(createElement(ViewImage, { image: { ...image, assetId: 'https://external/image' }, name: '<名字>', diagnostic: true }));
  expect(invalid).not.toContain('<img'); expect(invalid).toContain('&lt;'); expect(invalid).toContain('图片不可用');
});

it('offers an explicit role-scoped editor without fetching or mounting author tools in read-only/role views', () => {
  const html = renderToStaticMarkup(createElement(VisualAssetForm, { view: view(), draft: draft(), disabled: true, change: () => {}, submit: () => { throw new Error('Rendering must not write'); } }));
  expect(html).toContain('同名 · role-one'); expect(html).toContain('同名 · role-two'); expect(html).toContain('256方头像裁剪预览');
  expect(html).toContain('缩放 2.00×'); expect(html).toContain('横向焦点 25%'); expect(html).toContain('纵向焦点 75%');
  expect(html).toContain('来源图片未缓存'); expect(html).toContain('编辑不会回写旧对白'); expect(html).toContain('当前故事与精确角色 ID'); expect(html).not.toContain('type="url"');
  for (const props of [{ session: { id: 's', perspective: 'role-one' } as SessionSnapshot, readOnly: false }, { session: { id: 's', perspective: 'author' } as SessionSnapshot, readOnly: true }]) {
    expect(renderToStaticMarkup(createElement(VisualAssetsInline, { ...props, refresh: async () => {} }))).toBe('');
    expect(renderToStaticMarkup(createElement(VisualAssetsDialog, { ...props, refresh: async () => {}, close: () => {} }))).toBe('');
  }
});
