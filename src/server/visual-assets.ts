import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { validVisualImageRef, type VisualImageAsset, type VisualUploadInput, type VisualUploadResult } from '../shared/visual-assets';
import { validateStateJson } from '../shared/state-value-schema';
import type { SessionCommandService } from './session-services';
import { createRoleVisualsService } from './role-visuals';
import { ApiError } from './store';

/** Upload resource limits are independent of model/runtime token limits. */
export const VISUAL_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const VISUAL_INPUT_MAX_PIXELS = 16 * 1024 * 1024;
export const VISUAL_INPUT_MAX_SIDE = 8192;
export const VISUAL_NORMALIZED_MAX_SIDE = 2048;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const imageError = (message: string, status = 400): never => { throw new ApiError(status, 'VISUAL_ASSET_INPUT', message); };
type UploadMime = 'image/png' | 'image/jpeg' | 'image/webp';
export interface NormalizedVisualImage {
  bytes: Buffer; sourceHash: string; hash: string; mimeType: 'image/webp'; width: number; height: number;
}

/** Decode pixels locally rather than trusting extensions or MIME. Metadata is
 * never retained in display bytes; source provenance stays host-private. */
export async function normalizeVisualImage(raw: Uint8Array, mimeType: string): Promise<NormalizedVisualImage> {
  if (!(Buffer.isBuffer(raw) || raw instanceof Uint8Array && Object.getPrototypeOf(raw) === Uint8Array.prototype)) return imageError('Upload image bytes only');
  if (!raw.byteLength || raw.byteLength > VISUAL_UPLOAD_MAX_BYTES) return imageError('Image upload exceeds the 8 MiB limit', 413);
  const bytes = Buffer.from(raw);
  const format = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpeg'
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' ? 'webp' : undefined;
  if (!format || mimeType !== `image/${format}`) return imageError('Only matching PNG, JPEG or WebP uploads are accepted');
  try {
    const options = { limitInputPixels: VISUAL_INPUT_MAX_PIXELS, failOn: 'warning' as const, animated: true, sequentialRead: true };
    const metadata = await sharp(bytes, options).metadata();
    if (metadata.format !== format || !metadata.width || !metadata.height || metadata.width > VISUAL_INPUT_MAX_SIDE || metadata.height > VISUAL_INPUT_MAX_SIDE
      || metadata.width * metadata.height > VISUAL_INPUT_MAX_PIXELS || (metadata.pages ?? 1) !== 1 || metadata.pageHeight !== undefined && metadata.pageHeight !== metadata.height)
      return imageError('Use one static image within the supported pixel dimensions');
    const normalized = await sharp(bytes, options).autoOrient().resize({ width: VISUAL_NORMALIZED_MAX_SIDE, height: VISUAL_NORMALIZED_MAX_SIDE,
      fit: 'inside', withoutEnlargement: true }).webp({ quality: 90, effort: 4 }).toBuffer({ resolveWithObject: true });
    return { bytes: normalized.data, sourceHash: hash(bytes), hash: hash(normalized.data), mimeType: 'image/webp', width: normalized.info.width, height: normalized.info.height };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return imageError('Image decoding failed or the image exceeds supported resource limits');
  }
}

export interface BuiltinVisualAsset { asset: VisualImageAsset; path: string }
export interface VisualAssetsRuntime {
  readonly service: SessionCommandService;
  upload(input: VisualUploadInput): Promise<VisualUploadResult>;
  list(): VisualImageAsset[];
  readImage(assetId: string): { bytes: Buffer; mimeType: 'image/webp'; sha256: string } | undefined;
}
interface UploadReceipt { requestId: string; fingerprint: string; assetId: string; sourceHash: string; title: string; mimeType: string }
interface Library { schema: 'rp.visual-assets/0.1'; assets: VisualImageAsset[]; uploads: UploadReceipt[] }
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonblank = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integrity = (message: string): never => { throw new ApiError(409, 'VISUAL_ASSET_INTEGRITY', message); };
function validAsset(value: unknown): value is VisualImageAsset {
  if (validateStateJson(value).length || !plain(value) || !exact(value, ['assetId', 'sha256', 'mimeType', 'width', 'height', 'bytes', 'title', 'originalSha256', 'origin'])
    || !validVisualImageRef({ assetId: value.assetId, sha256: value.sha256, mimeType: value.mimeType, width: value.width, height: value.height, bytes: value.bytes })
    || !nonblank(value.title) || !sha256(value.originalSha256) || !plain(value.origin)) return false;
  return value.origin.kind === 'upload' && exact(value.origin, ['kind']) || value.origin.kind === 'builtin' && exact(value.origin, ['kind', 'importId', 'pointer', 'sourceSha256'])
    && nonblank(value.origin.importId) && nonblank(value.origin.pointer) && sha256(value.origin.sourceSha256);
}
function atomicFile(path: string, bytes: string | Uint8Array) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' }); const fd = openSync(temp, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
function regularFile(path: string) {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) return integrity('Visual cache requires regular local files');
  return readFileSync(path);
}

/** A local content-addressed library, independent of stories and model calls.
 * The caller may omit the author service while retaining immutable image reads. */
export function createVisualAssetsRuntime(root: string, options: { builtins?: readonly BuiltinVisualAsset[] } = {}): VisualAssetsRuntime {
  const directory = join(root, 'visual-assets'), normalized = join(directory, 'images'), originals = join(directory, 'originals'), filename = join(directory, 'library.json');
  mkdirSync(normalized, { recursive: true, mode: 0o700 }); mkdirSync(originals, { recursive: true, mode: 0o700 });
  let library: Library = { schema: 'rp.visual-assets/0.1', assets: [], uploads: [] };
  const existing = regularFile(filename);
  if (existing) {
    let raw: unknown; try { raw = JSON.parse(existing.toString('utf8')); } catch { return integrity('Invalid visual library JSON'); }
    if (validateStateJson(raw).length || !plain(raw) || !exact(raw, ['schema', 'assets', 'uploads']) || raw.schema !== 'rp.visual-assets/0.1'
      || !Array.isArray(raw.assets) || !raw.assets.every(validAsset) || new Set(raw.assets.map(asset => asset.assetId)).size !== raw.assets.length || !Array.isArray(raw.uploads)) return integrity('Invalid retained visual library');
    const requests = new Set<string>();
    for (const receipt of raw.uploads) {
      if (!plain(receipt) || !exact(receipt, ['requestId', 'fingerprint', 'assetId', 'sourceHash', 'title', 'mimeType']) || !nonblank(receipt.requestId) || requests.has(receipt.requestId)
        || !sha256(receipt.fingerprint) || !sha256(receipt.assetId) || !raw.assets.some(asset => asset.assetId === receipt.assetId) || !sha256(receipt.sourceHash)
        || !nonblank(receipt.title) || !['image/png', 'image/jpeg', 'image/webp'].includes(receipt.mimeType as string)
        || receipt.fingerprint !== hash(Buffer.from(JSON.stringify({ sourceHash: receipt.sourceHash, title: receipt.title, mimeType: receipt.mimeType })))) return integrity('Invalid retained visual upload receipt');
      const original = regularFile(join(originals, `${receipt.sourceHash}.bin`)); if (!original || hash(original) !== receipt.sourceHash) return integrity('Original upload provenance is unavailable');
      requests.add(receipt.requestId);
    }
    library = structuredClone(raw) as unknown as Library;
  }
  const putNormalized = (asset: VisualImageAsset, bytes: Buffer) => {
    if (!validAsset(asset) || bytes.byteLength !== asset.bytes || hash(bytes) !== asset.sha256 || bytes.subarray(0, 4).toString('ascii') !== 'RIFF'
      || bytes.subarray(8, 12).toString('ascii') !== 'WEBP') return integrity('Normalized visual bytes do not match their local reference');
    const path = join(normalized, `${asset.assetId}.webp`), previous = regularFile(path);
    if (previous && hash(previous) !== asset.sha256) return integrity('Normalized visual cache was altered');
    if (!previous) atomicFile(path, bytes);
  };
  let changed = false;
  for (const builtin of options.builtins ?? []) {
    if (!validAsset(builtin.asset) || builtin.asset.origin.kind !== 'builtin' || typeof builtin.path !== 'string') return integrity('Invalid trusted builtin visual asset');
    const bytes = regularFile(builtin.path); if (!bytes) return integrity('Builtin visual asset is unavailable');
    putNormalized(builtin.asset, bytes);
    if (!library.assets.some(asset => asset.assetId === builtin.asset.assetId)) { library.assets.push(structuredClone(builtin.asset)); changed = true; }
  }
  if (changed) atomicFile(filename, JSON.stringify(library));
  let queue = Promise.resolve();
  const list = () => structuredClone(library.assets);
  const runtime: VisualAssetsRuntime = {
    service: createRoleVisualsService({ list }), list,
    readImage(assetId) {
      if (!sha256(assetId) || !library.assets.some(asset => asset.assetId === assetId)) return undefined;
      const bytes = regularFile(join(normalized, `${assetId}.webp`)); if (!bytes) return undefined;
      if (hash(bytes) !== assetId) return integrity('Normalized visual cache was altered');
      return { bytes, mimeType: 'image/webp', sha256: assetId };
    },
    upload(input) {
      // Inspect descriptors before reading, and detach bytes before queuing.
      if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
        || Reflect.ownKeys(input).length !== 4 || Object.entries(Object.getOwnPropertyDescriptors(input)).some(([key, field]) => !['requestId', 'title', 'mimeType', 'bytes'].includes(key) || !field.enumerable || !('value' in field))
        || !nonblank(input.requestId) || input.requestId !== input.requestId.trim() || !nonblank(input.title) || !['image/png', 'image/jpeg', 'image/webp'].includes(input.mimeType)
        || !(Buffer.isBuffer(input.bytes) || input.bytes instanceof Uint8Array && Object.getPrototypeOf(input.bytes) === Uint8Array.prototype)) return Promise.reject(new ApiError(400, 'VISUAL_ASSET_INPUT', 'Provide exact requestId, title, MIME and image bytes'));
      if (!input.bytes.byteLength || input.bytes.byteLength > VISUAL_UPLOAD_MAX_BYTES) return Promise.reject(new ApiError(413, 'VISUAL_ASSET_INPUT', 'Image upload exceeds the 8 MiB limit'));
      const bytes = Buffer.from(input.bytes), { requestId, title, mimeType } = input, sourceHash = hash(bytes);
      const fingerprint = hash(Buffer.from(JSON.stringify({ sourceHash, title, mimeType })));
      const task = queue.then(async (): Promise<VisualUploadResult> => {
        const previous = library.uploads.find(receipt => receipt.requestId === requestId);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new ApiError(409, 'VISUAL_ASSET_REQUEST', 'This request ID identifies a different image upload');
          return { asset: structuredClone(library.assets.find(asset => asset.assetId === previous.assetId)!), duplicate: true };
        }
        const image = await normalizeVisualImage(bytes, mimeType);
        const asset = library.assets.find(asset => asset.assetId === image.hash) ?? { assetId: image.hash, sha256: image.hash, mimeType: 'image/webp',
          width: image.width, height: image.height, bytes: image.bytes.byteLength, title, originalSha256: image.sourceHash, origin: { kind: 'upload' } } satisfies VisualImageAsset;
        putNormalized(asset, image.bytes);
        const sourcePath = join(originals, `${sourceHash}.bin`), original = regularFile(sourcePath);
        if (original && hash(original) !== sourceHash) return integrity('Original upload provenance was altered');
        if (!original) atomicFile(sourcePath, bytes);
        const next = structuredClone(library);
        if (!next.assets.some(entry => entry.assetId === asset.assetId)) next.assets.push(structuredClone(asset));
        next.uploads.push({ requestId, fingerprint, assetId: asset.assetId, sourceHash, title, mimeType });
        atomicFile(filename, JSON.stringify(next)); library = next;
        return { asset: structuredClone(asset), duplicate: false };
      });
      queue = task.then(() => undefined, () => undefined); return task;
    },
  };
  return runtime;
}
