import type { AuxiliaryOutput, Json } from './types';
export const TEXT_CARRIER_SERVICE_ID = 'rp.text-carrier-control';
export const TEXT_CARRIER_VIEW_MODULE_ID = 'rp.carrier-view';
export interface TextCarrierContent {
  medium: 'paper' | 'screen'; title: string; text: string;
  location: string; available: boolean;
}
export interface TextCarrierVersion extends TextCarrierContent {
  version: number; retired: boolean; sourceEventId: string; revision: number;
}
export interface TextCarrierRecord { id: string; versions: TextCarrierVersion[] }
/** A visible, local target. Body text is deliberately absent. */
export interface TextCarrierTarget {
  carrierId: string; version: number; medium: 'paper' | 'screen'; title: string; location: string;
}
export interface TextCarrierSelection { carrierId: string; version: number }
export interface TextCarrierViewIntent extends TextCarrierSelection {
  id: string; readerRoleId: string; location: string;
  origin: { kind: 'player' } | { kind: 'behavior'; behaviorId: string };
}
export interface TextCarrierViewOutcome { intentId: string; outcome: 'viewed' | 'blocked' }
export interface TextCarrierViewReceipt {
  id: string; intentId: string; materialTurnId: string; worldRevision: number;
  carrierId: string; carrierVersion: number;
  readerRoleId: string; readerName: string;
  location: string; time: string | null;
  origin: TextCarrierViewIntent['origin'];
  carrier: { medium: 'paper' | 'screen'; title: string; text: string; sourceEventId: string };
  observationEventId: string;
}
export interface TextCarrierCommandReceipt {
  requestId: string; fingerprint: string; carrierId: string; version: number; revision: number;
}
export interface TextCarrierState {
  schema: 'rp.text-carriers/0.1'; carriers: TextCarrierRecord[];
  views: TextCarrierViewReceipt[]; commands: TextCarrierCommandReceipt[];
}
export type TextCarrierCommand = {
  requestId: string; expectedRevision: number; reason: string;
} & ({ operation: 'create'; content: TextCarrierContent }
  | { operation: 'update'; carrierId: string; expectedVersion: number; content: TextCarrierContent }
  | { operation: 'retire'; carrierId: string; expectedVersion: number });
export interface TextCarriersView {
  revision: number; carriers: TextCarrierRecord[]; views: TextCarrierViewReceipt[];
  targets: TextCarrierTarget[];
}
export interface TextCarrierCommandResult { revision: number; carrierId: string; version: number; duplicate: boolean }
export interface ViewedCarriersOutput {
  schema: 'rp.viewed-carriers/0.1'; materialTurnId: string | null; worldRevision: number;
  views: TextCarrierViewReceipt[];
}
/** A known observation occurrence, not independent confirmation of its text. */
export function textCarrierObservationText(view: TextCarrierViewReceipt): string {
  return `查看「${view.carrier.title}」（版本 ${view.carrierVersion}）时读到的文字：${view.carrier.text}`;
}

function shape(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) return false;
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value));
  return entries.length === keys.length && entries.every(([key, descriptor]) => keys.includes(key) && 'value' in descriptor);
}
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const integer = (value: unknown, min: number): value is number => Number.isSafeInteger(value) && (value as number) >= min;
/** Validate a detached immutable display artifact, without resolving current
 * carrier text, actor names, availability or locations. */
export function validViewedCarriersOutput(value: unknown): value is ViewedCarriersOutput {
  if (!shape(value, ['schema', 'materialTurnId', 'worldRevision', 'views']) || value.schema !== 'rp.viewed-carriers/0.1'
    || !(value.materialTurnId === null || nonempty(value.materialTurnId)) || !integer(value.worldRevision, 0) || !Array.isArray(value.views)
    || value.materialTurnId === null && value.views.length !== 0) return false;
  const ids = new Set<string>(), intents = new Set<string>(), observations = new Set<string>();
  for (const view of value.views) {
    if (!shape(view, ['id', 'intentId', 'materialTurnId', 'worldRevision', 'carrierId', 'carrierVersion', 'readerRoleId', 'readerName', 'location', 'time', 'origin', 'carrier', 'observationEventId'])
      || !['id', 'intentId', 'carrierId', 'readerRoleId', 'readerName', 'location', 'observationEventId'].every(key => nonempty(view[key]))
      || view.materialTurnId !== value.materialTurnId || view.worldRevision !== value.worldRevision || !integer(view.carrierVersion, 1)
      || !(view.time === null || typeof view.time === 'string')
      || !(shape(view.origin, ['kind']) && view.origin.kind === 'player'
        || shape(view.origin, ['kind', 'behaviorId']) && view.origin.kind === 'behavior' && nonempty(view.origin.behaviorId))
      || !shape(view.carrier, ['medium', 'title', 'text', 'sourceEventId']) || !['paper', 'screen'].includes(view.carrier.medium as string)
      || !nonempty(view.carrier.title) || typeof view.carrier.text !== 'string' || !nonempty(view.carrier.sourceEventId)) return false;
    const id = view.id as string, intent = view.intentId as string, observation = view.observationEventId as string;
    if (ids.has(id) || intents.has(intent) || observations.has(observation)) return false;
    ids.add(id); intents.add(intent); observations.add(observation);
  }
  return true;
}
/** UI reading rights do not make another actor's observed body public. The
 * author retains the whole archive; each actor sees only its own receipts. */
export function projectViewedCarrierOutput(output: AuxiliaryOutput, perspective: string): AuxiliaryOutput | undefined {
  if (output.display?.renderer !== 'viewed-carriers' && output.provenance?.kind !== 'committed-carrier-views') return output;
  const stamp = output.provenance;
  const value: unknown = output.value;
  if (output.type !== 'object' || output.display?.renderer !== 'viewed-carriers' || stamp?.kind !== 'committed-carrier-views'
    || !validViewedCarriersOutput(value) || stamp.materialTurnId !== value.materialTurnId || stamp.worldRevision !== value.worldRevision
    || !Array.isArray(stamp.viewIds) || stamp.viewIds.length !== value.views.length || stamp.viewIds.some((id, i) => id !== value.views[i].id)) return undefined;
  if (perspective === 'author') return output;
  const views = value.views.filter(view => view.readerRoleId === perspective);
  if (!views.length) return undefined;
  return { ...output, value: { ...value, views } as unknown as Json, provenance: { ...stamp, viewIds: views.map(view => view.id) } };
}
