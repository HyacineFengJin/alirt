import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it } from 'vitest';
import { createVisualAssetsRuntime, normalizeVisualImage, VISUAL_UPLOAD_MAX_BYTES } from './visual-assets';
import type { VisualImageAsset } from '../shared/visual-assets';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const path = mkdtempSync(join(tmpdir(), 'rp-visual-assets-')); roots.push(path); return path; }
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const png = () => sharp({ create: { width: 8, height: 4, channels: 4, background: { r: 12, g: 80, b: 170, alpha: .6 } } }).png().toBuffer();

it('fully decodes and auto-orients JPEG into a metadata-free static WebP with byte-addressed identity', async () => {
  const source = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#123456' } })
    .withMetadata({ orientation: 6 }).withExif({ IFD0: { Artist: 'PRIVATE_EXIF_CANARY' } }).jpeg().toBuffer();
  const normalized = await normalizeVisualImage(source, 'image/jpeg'), metadata = await sharp(normalized.bytes).metadata();
  expect(normalized).toMatchObject({ width: 4, height: 8, mimeType: 'image/webp', sourceHash: digest(source), hash: digest(normalized.bytes) });
  expect(metadata.format).toBe('webp'); expect(metadata.exif).toBeUndefined(); expect(metadata.icc).toBeUndefined(); expect(metadata.xmp).toBeUndefined();
  expect(metadata.orientation).toBeUndefined(); expect(metadata.pages ?? 1).toBe(1); expect(normalized.bytes.includes(Buffer.from('PRIVATE_EXIF_CANARY'))).toBe(false);
});

it('rejects MIME spoofing, SVG, corrupt payloads, multi-frame WebP and oversized input before library publication', async () => {
  const directory = root(), runtime = createVisualAssetsRuntime(directory), input = await png();
  const red = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const blue = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#0000ff' } }).png().toBuffer();
  const animated = await sharp([red, blue], { join: { animated: true } }).webp({ loop: 0 }).toBuffer();
  expect((await sharp(animated, { animated: true }).metadata()).pages).toBe(2);
  const wide = await sharp({ create: { width: 9000, height: 1, channels: 3, background: '#aabbcc' } }).png().toBuffer();
  for (const [bytes, mimeType] of [[input, 'image/jpeg'], [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>'), 'image/png'],
    [Buffer.concat([input.subarray(0, 8), Buffer.from('broken png')]), 'image/png'], [animated, 'image/webp'], [wide, 'image/png'],
    [Buffer.alloc(VISUAL_UPLOAD_MAX_BYTES + 1), 'image/png']] as const) {
    await expect(runtime.upload({ requestId: 'bad', title: 'Rejected', mimeType, bytes })).rejects.toThrow();
    expect(runtime.list()).toEqual([]);
  }
  expect(readdirSync(join(directory, 'visual-assets', 'images'))).toEqual([]);
  expect(readdirSync(join(directory, 'visual-assets', 'originals'))).toEqual([]);
});

it('serializes stable upload identities, retains first metadata and private original proofs across restart', async () => {
  const directory = root(), runtime = createVisualAssetsRuntime(directory), bytes = await png(), input = { requestId: 'upload', title: 'First title', mimeType: 'image/png', bytes };
  const [first, duplicate] = await Promise.all([runtime.upload(input), runtime.upload(input)]);
  expect(first.duplicate).toBe(false); expect(duplicate).toEqual({ ...first, duplicate: true });
  const filename = join(directory, 'visual-assets', 'library.json'), stable = readFileSync(filename, 'utf8');
  await expect(runtime.upload({ ...input, title: 'Changed same request' })).rejects.toThrow('different'); expect(readFileSync(filename, 'utf8')).toBe(stable);
  const samePixels = await sharp(bytes).withExif({ IFD0: { Artist: 'Different original metadata' } }).png().toBuffer();
  expect(digest(samePixels)).not.toBe(digest(bytes));
  const second = await runtime.upload({ ...input, requestId: 'second', title: 'Later title', bytes: samePixels });
  expect(second.asset.assetId).toBe(first.asset.assetId); expect(second.asset.title).toBe('First title'); expect(second.asset.originalSha256).toBe(digest(bytes));
  expect(runtime.list()).toHaveLength(1); expect(readdirSync(join(directory, 'visual-assets', 'originals'))).toHaveLength(2);
  const restarted = createVisualAssetsRuntime(directory); expect(await restarted.upload(input)).toEqual({ ...first, duplicate: true });
  const image = restarted.readImage(first.asset.assetId)!; expect(image.sha256).toBe(digest(image.bytes)); expect(image.mimeType).toBe('image/webp');
  first.asset.title = 'Caller mutation'; image.bytes.fill(0); expect(restarted.list()[0].title).toBe('First title'); expect(restarted.readImage(second.asset.assetId)!.bytes[0]).not.toBe(0);
  expect(readdirSync(directory).some(name => name.startsWith('session-'))).toBe(false);
});

it('keeps trusted builtin cache available independently of the source path or later builtin installation', async () => {
  const directory = root(), normalized = await normalizeVisualImage(await png(), 'image/png'), sourcePath = join(directory, 'builtin.webp'); writeFileSync(sourcePath, normalized.bytes);
  const asset: VisualImageAsset = { assetId: normalized.hash, sha256: normalized.hash, mimeType: 'image/webp', width: normalized.width, height: normalized.height,
    bytes: normalized.bytes.byteLength, title: 'Reviewed source image', originalSha256: normalized.sourceHash,
    origin: { kind: 'builtin', importId: 'reviewed', pointer: '/images/0', sourceSha256: 'a'.repeat(64) } };
  const runtime = createVisualAssetsRuntime(directory, { builtins: [{ asset, path: sourcePath }] });
  rmSync(sourcePath); expect(createVisualAssetsRuntime(directory).readImage(asset.assetId)?.bytes).toEqual(normalized.bytes);
  expect(runtime.readImage('../../etc/passwd')).toBeUndefined(); expect(runtime.readImage('f'.repeat(64))).toBeUndefined();
  writeFileSync(join(directory, 'visual-assets', 'images', `${asset.assetId}.webp`), 'altered');
  expect(() => runtime.readImage(asset.assetId)).toThrow('altered');
});

it('rejects hidden/accessor upload metadata without reading it', async () => {
  const runtime = createVisualAssetsRuntime(root()), bytes = await png(); let calls = 0;
  const input = { requestId: 'getter', get title() { calls++; return 'Title'; }, mimeType: 'image/png', bytes };
  await expect(runtime.upload(input)).rejects.toThrow('exact'); expect(calls).toBe(0);
  await expect(runtime.upload({ requestId: 'url', title: 'Remote', mimeType: 'image/png', bytes: 'https://invalid.test/image.png' as unknown as Uint8Array })).rejects.toThrow();
  expect(runtime.list()).toEqual([]);
});
