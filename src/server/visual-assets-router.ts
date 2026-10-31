import express, { Router } from 'express';
import { ApiError } from './store';
import { VISUAL_UPLOAD_MAX_BYTES, type VisualAssetsRuntime } from './visual-assets';

/** Mount below /api/visual-assets after the application's loopback/origin
 * checks. This router accepts raw image bodies, never URLs or filesystem paths. */
export function createVisualAssetsRouter(runtime: VisualAssetsRuntime, options: { authorControlEnabled?: boolean } = {}): Router {
  const router = Router();
  const enabled = options.authorControlEnabled !== false;
  router.get('/images/:assetId', (req, res) => {
    const image = runtime.readImage(req.params.assetId);
    if (!image) throw new ApiError(404, 'VISUAL_ASSET_UNKNOWN', 'Local visual asset is unavailable');
    const etag = `"${image.sha256}"`;
    res.setHeader('Content-Type', image.mimeType); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); res.setHeader('ETag', etag);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
    res.setHeader('Content-Length', image.bytes.byteLength); res.status(200).end(image.bytes);
  });
  router.get('/library', (_req, res) => {
    if (!enabled) throw new ApiError(404, 'VISUAL_ASSET_CONTROL_DISABLED', 'Visual author controls are not installed');
    res.setHeader('Cache-Control', 'no-store'); res.json({ assets: runtime.list() });
  });
  router.post('/uploads', (req, _res, next) => {
    if (!enabled) return next(new ApiError(404, 'VISUAL_ASSET_CONTROL_DISABLED', 'Visual author controls are not installed'));
    next();
  }, express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: VISUAL_UPLOAD_MAX_BYTES }), async (req, res) => {
    const requestId = req.headers['x-request-id'], encodedTitle = req.headers['x-title'];
    let title: string;
    try { if (typeof encodedTitle !== 'string') throw new Error(); title = decodeURIComponent(encodedTitle); }
    catch { throw new ApiError(400, 'VISUAL_ASSET_INPUT', 'Provide a URI-encoded x-title header'); }
    if (typeof requestId !== 'string' || !Buffer.isBuffer(req.body)) throw new ApiError(400, 'VISUAL_ASSET_INPUT', 'Upload PNG/JPEG/WebP bytes with x-request-id');
    const result = await runtime.upload({ requestId, title, mimeType: req.get('Content-Type')?.split(';')[0].trim().toLowerCase() ?? '', bytes: req.body });
    res.setHeader('Cache-Control', 'no-store'); res.status(result.duplicate ? 200 : 201).json(result);
  });
  return router;
}
