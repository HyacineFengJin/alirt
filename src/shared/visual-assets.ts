import { validateStateJson } from './state-value-schema';
export const ROLE_VISUAL_SERVICE_ID = 'rp.role-visuals';
/** Other source surfaces (book A/B, status icon, album) have independent rules. */
export type VisualSlot = 'dialogue-avatar';
/** Cover-crop focus across the available overflow, not a pixel offset. */
export interface VisualCrop { x: number; y: number; zoom: number }
export const DEFAULT_VISUAL_CROP: Readonly<VisualCrop> = Object.freeze({ x: .5, y: .5, zoom: 1 });
export interface VisualImageRef {
  assetId: string; sha256: string; mimeType: 'image/webp'; width: number; height: number; bytes: number;
}
export interface VisualImageAsset extends VisualImageRef {
  title: string; originalSha256: string;
  origin: { kind: 'upload' } | { kind: 'builtin'; importId: string; pointer: string; sourceSha256: string };
}
export interface VisualUploadInput { requestId: string; title: string; mimeType: string; bytes: Uint8Array }
export interface VisualUploadResult { asset: VisualImageAsset; duplicate: boolean }
export interface CardVisualDefaults {
  schema: 'rp.card-visuals/0.1'; enabled: boolean;
  source: { importId: string; pointer: string; sha256: string };
  defaults: { roleId: string; roleName: string; slot: VisualSlot; image: VisualImageRef; crop: VisualCrop }[];
}
export type VisualBinding = { kind: 'asset'; image: VisualImageRef; crop: VisualCrop } | { kind: 'default' } | { kind: 'none' };
export interface VisualBindingVersion {
  version: number; revision: number; sourceEventId: string; value: VisualBinding;
}
export interface RoleVisualRecord { roleId: string; slot: VisualSlot; versions: VisualBindingVersion[] }
export interface VisualCommandReceipt { requestId: string; fingerprint: string; roleId: string; slot: VisualSlot; version: number; revision: number }
export interface RoleVisualState { schema: 'rp.role-visuals/0.1'; bindings: RoleVisualRecord[]; commands: VisualCommandReceipt[] }
export type VisualCommand = { requestId: string; expectedRevision: number; reason: string; roleId: string; slot: VisualSlot; expectedVersion: number }
  & ({ operation: 'bind'; assetId: string; crop: VisualCrop } | { operation: 'reset' | 'hide' });
export interface ResolvedRoleVisual {
  roleId: string; slot: VisualSlot; image: VisualImageRef; crop: VisualCrop;
  provenance: { kind: 'source'; importId: string; pointer: string; sha256: string }
    | { kind: 'author'; version: number; revision: number; sourceEventId: string };
}
export interface RoleVisualsSnapshot { schema: 'rp.role-visuals-view/0.1'; visuals: ResolvedRoleVisual[] }
export interface RoleVisualsView {
  revision: number; roles: { id: string; name: string }[]; assets: VisualImageAsset[];
  bindings: RoleVisualRecord[]; current: RoleVisualsSnapshot;
}
export interface VisualCommandResult { revision: number; roleId: string; slot: VisualSlot; version: number; duplicate: boolean }
export interface EntryVisuals { schema: 'rp.entry-visuals/0.1'; speakers: { ref: string; visual: ResolvedRoleVisual }[] }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function validVisualCrop(v: unknown): v is VisualCrop {
  return !validateStateJson(v).length && object(v) && exact(v, ['x', 'y', 'zoom']) && typeof v.x === 'number' && v.x >= 0 && v.x <= 1
    && typeof v.y === 'number' && v.y >= 0 && v.y <= 1 && typeof v.zoom === 'number' && v.zoom >= 1 && v.zoom <= 4;
}
export function validVisualImageRef(v: unknown): v is VisualImageRef {
  return !validateStateJson(v).length && object(v) && exact(v, ['assetId', 'sha256', 'mimeType', 'width', 'height', 'bytes'])
    && hash(v.assetId) && v.assetId === v.sha256 && v.mimeType === 'image/webp'
    && ['width', 'height', 'bytes'].every(key => Number.isSafeInteger(v[key]) && (v[key] as number) > 0);
}
export function validCardVisualDefaults(v: unknown): v is CardVisualDefaults {
  if (validateStateJson(v).length || !object(v) || !exact(v, ['schema', 'enabled', 'source', 'defaults']) || v.schema !== 'rp.card-visuals/0.1'
    || typeof v.enabled !== 'boolean' || !object(v.source) || !exact(v.source, ['importId', 'pointer', 'sha256'])
    || !text(v.source.importId) || !text(v.source.pointer) || !hash(v.source.sha256) || !Array.isArray(v.defaults)) return false;
  const seen = new Set<string>();
  return v.defaults.every(d => {
    if (!object(d) || !exact(d, ['roleId', 'roleName', 'slot', 'image', 'crop']) || !text(d.roleId) || !text(d.roleName)
      || d.slot !== 'dialogue-avatar' || !validVisualImageRef(d.image) || !validVisualCrop(d.crop)) return false;
    const key = JSON.stringify([d.roleId, d.slot]); if (seen.has(key)) return false; seen.add(key); return true;
  });
}
export function validResolvedRoleVisual(v: unknown): v is ResolvedRoleVisual {
  if (validateStateJson(v).length || !object(v) || !exact(v, ['roleId', 'slot', 'image', 'crop', 'provenance']) || !text(v.roleId)
    || v.slot !== 'dialogue-avatar' || !validVisualImageRef(v.image) || !validVisualCrop(v.crop) || !object(v.provenance)) return false;
  const p = v.provenance;
  return p.kind === 'source' && exact(p, ['kind', 'importId', 'pointer', 'sha256']) && text(p.importId) && text(p.pointer) && hash(p.sha256)
    || p.kind === 'author' && exact(p, ['kind', 'version', 'revision', 'sourceEventId']) && Number.isSafeInteger(p.version) && (p.version as number) > 0
      && Number.isSafeInteger(p.revision) && (p.revision as number) > 0 && text(p.sourceEventId);
}
export const visualImageUrl = (image: VisualImageRef) => `/api/visual-assets/images/${encodeURIComponent(image.assetId)}`;
export function visualCropStyle(image: Pick<VisualImageRef, 'width' | 'height'>, crop: VisualCrop) {
  const ratio = image.width / image.height, width = Math.max(1, ratio) * crop.zoom, height = Math.max(1, 1 / ratio) * crop.zoom;
  return { position: 'absolute' as const, width: `${width * 100}%`, height: `${height * 100}%`, maxWidth: 'none',
    left: `${-(width - 1) * crop.x * 100}%`, top: `${-(height - 1) * crop.y * 100}%` };
}
