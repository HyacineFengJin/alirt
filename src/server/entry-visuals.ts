import type { ProseBody } from '../shared/prose-body';
import type { EntryVisuals } from '../shared/visual-assets';
import type { StoredSession } from './store';
import { readRoleVisuals } from './role-visuals';

/** Visuals are captured after writing, not sent to a model or resolved from
 * today's bindings while rendering an old entry. No image is story evidence. */
export function snapshotEntryVisuals(session: StoredSession, body: ProseBody): EntryVisuals | undefined {
  if (!session.card.visuals?.enabled && !session.visuals?.bindings.length) return undefined;
  try {
    const current = readRoleVisuals(session).visuals;
    return { schema: 'rp.entry-visuals/0.1', speakers: body.blocks.flatMap(block => {
      if (block.kind !== 'speech') return [];
      const visual = current.find(visual => visual.roleId === block.roleId && visual.slot === 'dialogue-avatar');
      return visual ? [{ ref: block.ref, visual: structuredClone(visual) }] : [];
    }) };
  } catch { return undefined; } // Invalid optional display data never blocks prose.
}
