import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import sharp from 'sharp';
import { afterEach, expect, it } from 'vitest';
import { ApiError } from './store';
import { createVisualAssetsRuntime } from './visual-assets';
import { createVisualAssetsRouter } from './visual-assets-router';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture(enabled = true, reuse?: { root: string }) {
  const root = reuse?.root ?? await mkdtemp(join(tmpdir(), 'rp-visual-router-')); if (!reuse) cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = createVisualAssetsRuntime(root), app = express(); app.use(express.json());
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api/visual-assets', createVisualAssetsRouter(runtime, { authorControlEnabled: enabled }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof ApiError ? error.status : 400).json({ error: { message: error instanceof Error ? error.message : 'Invalid request' } }));
  const server: Server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected loopback server');
  return { root, runtime, url: `http://127.0.0.1:${address.port}/api/visual-assets` };
}

it('uploads raw image bytes and serves only local normalized hashes with immutable cache and correct MIME', async () => {
  const f = await fixture(), bytes = await sharp({ create: { width: 4, height: 6, channels: 3, background: '#123456' } }).png().toBuffer();
  const upload = () => fetch(f.url + '/uploads', { method: 'POST', headers: { 'Content-Type': 'image/png', 'x-request-id': 'upload', 'x-title': encodeURIComponent('作者头像') }, body: bytes });
  const response = await upload(); expect(response.status).toBe(201); const result = await response.json(); expect(result.asset.title).toBe('作者头像');
  const duplicate = await upload(); expect(duplicate.status).toBe(200); expect((await duplicate.json()).duplicate).toBe(true);
  const imageUrl = f.url + '/images/' + result.asset.assetId, image = await fetch(imageUrl);
  expect(image.status).toBe(200); expect(image.headers.get('Content-Type')).toBe('image/webp'); expect(image.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(image.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  expect((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).format).toBe('webp');
  expect((await fetch(imageUrl, { headers: { 'If-None-Match': image.headers.get('ETag')! } })).status).toBe(304);
  const list = await (await fetch(f.url + '/library')).json(); expect(list.assets).toHaveLength(1); expect(JSON.stringify(list)).not.toContain('"path"');
  for (const path of ['../../etc/passwd', '%2Fetc%2Fpasswd', 'f'.repeat(64), 'https%3A%2F%2Finvalid.test%2Fa.png']) expect((await fetch(f.url + '/images/' + path)).status).toBe(404);
  const disabled = await fixture(false, f);
  expect((await fetch(disabled.url + '/library')).status).toBe(404);
  expect((await fetch(disabled.url + '/uploads', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: bytes })).status).toBe(404);
  expect((await fetch(disabled.url + '/images/' + result.asset.assetId)).status).toBe(200);
});

it('does not accept SVG, JSON URLs, or malformed upload metadata', async () => {
  const f = await fixture();
  for (const [mime, bytes, title] of [['image/svg+xml', '<svg><script>bad()</script></svg>', 'Title'], ['application/json', JSON.stringify({ url: 'https://invalid.test/image.png' }), 'Title'],
    ['image/png', 'not image bytes', '%ZZ']] as const) {
    const response = await fetch(f.url + '/uploads', { method: 'POST', headers: { 'Content-Type': mime, 'x-request-id': 'invalid', 'x-title': title }, body: bytes });
    expect(response.status).toBe(400); expect(f.runtime.list()).toEqual([]);
  }
});
