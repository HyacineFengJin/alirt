import type { AuxiliaryOutput, ProseEntry, WorldEvent } from '../shared/types';
import { ApprovedMessages } from './ApprovedMessages';
import { outputVisible } from './AuxiliaryOutputs';
import { committedViewedCarriers, ViewedCarriers } from './ViewedCarriers';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function audience(value: unknown): boolean {
  return value === 'public' || value === 'author'
    || Array.isArray(value) && value.every(role => typeof role === 'string' && role.length > 0);
}
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  if (!record(left) || !record(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

/** Inputs must be server-projected events and prose for the active perspective.
 * Event turnId identifies the compose attempt; materialTurnId identifies the saved
 * behaviors, so repeated recovery attempts replace only that material's output. */
function pendingOutputs(events: WorldEvent[], prose: ProseEntry[], renderer: 'messages' | 'viewed-carriers'): AuxiliaryOutput[] {
  const latest = new Map<string, { output: AuxiliaryOutput; index: number }>();
  for (const [index, event] of events.entries()) {
    if (!record(event) || event.kind !== 'host-output' || event.actor !== 'host' || typeof event.turnId !== 'string' || !event.turnId.trim()) continue;
    const data: unknown = event.data;
    if (!record(data) || Object.keys(data).length !== 2 || data.schema !== 'rp.host-output/0.1' || !record(data.output)) continue;
    const output = data.output, provenance = output.provenance;
    if (typeof output.key !== 'string' || !output.key || typeof output.title !== 'string'
      || !audience(event.audience) || !audience(output.audience) || !sameValue(event.audience, output.audience)) continue;
    const materialId = record(provenance) && ['committed-behaviors', 'committed-carrier-views'].includes(String(provenance.kind))
      && (provenance.materialTurnId === null || typeof provenance.materialTurnId === 'string')
      ? provenance.materialTurnId : `invalid-event:${event.id}`;
    latest.set(JSON.stringify([output.key, materialId]), { output: output as unknown as AuxiliaryOutput, index });
  }
  return [...latest.values()].sort((left, right) => left.index - right.index).flatMap(({ output }) => {
    // No prose-entry anchor exists yet, so native entry-distance rules cannot be
    // evaluated. Keep these outputs pending until their actual attachment exists.
    if (!record(output.display) || output.display.renderer !== renderer || output.display.history !== undefined
      || !['before-prose', 'after-prose'].includes(output.placement) || output.display.placement !== output.placement
      || !outputVisible(output, 0)
      || prose.some(entry => entry.attachments?.some(attachment => sameValue(attachment, output)
        || renderer === 'viewed-carriers' && attachment.key === output.key && !!committedViewedCarriers(output) && !!committedViewedCarriers(attachment)
          && sameValue(committedViewedCarriers(output), committedViewedCarriers(attachment))))) return [];
    return [output];
  });
}
export const pendingMessageOutputs = (events: WorldEvent[], prose: ProseEntry[]) => pendingOutputs(events, prose, 'messages');
export const pendingViewedCarrierOutputs = (events: WorldEvent[], prose: ProseEntry[]) => pendingOutputs(events, prose, 'viewed-carriers');

export function PendingHostOutputs({ events, prose }: { events: WorldEvent[]; prose: ProseEntry[] }) {
  const outputs = pendingMessageOutputs(events, prose);
  const carriers = pendingViewedCarrierOutputs(events, prose);
  if (!outputs.length && !carriers.length) return null;
  return <>{!!outputs.length && <section className="after-prose-outputs pending-host-outputs" aria-label="待成文的远程消息">
    <h3>待成文的远程消息</h3>
    <p className="fine">此处显示尚无对应正文的消息附件；数据无效时仅显示诊断。</p>
    {outputs.map((output, index) => <ApprovedMessages key={JSON.stringify([output.key, output.provenance?.kind === 'committed-behaviors' && output.provenance.materialTurnId, index])} output={output} />)}
  </section>}{!!carriers.length && <section className="after-prose-outputs pending-host-outputs" aria-label="待成文的载体查看"><h3>待成文的载体查看</h3><p className="fine">以下为尚未附加正文的宿主记录；无效数据仅显示诊断。这里不再次执行查看。</p>{carriers.map((output, index) => <ViewedCarriers key={`${output.key}:${index}`} output={output}/>)}</section>}</>;
}
