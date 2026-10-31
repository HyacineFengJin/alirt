import { runtimeFingerprint } from './prompt-compiler';
import type { StoredSession } from './store';

/** New information is supplied with each task. Only lost/replaced disclosure must
 * abandon native history, so ordinary learning keeps persistent sessions useful. */
export function knowledgeBoundary(session: StoredSession, perspective: string): string {
  return runtimeFingerprint((session.knowledgeRegistry?.sources ?? [])
    .filter(source => source.lifecycle !== 'active' && (perspective === 'author' || source.audience === 'public' || perspective !== 'public' && Array.isArray(source.audience) && source.audience.includes(perspective)))
    .map(source => ({ id: source.id, lifecycle: source.lifecycle })).sort((a, b) => a.id.localeCompare(b.id)));
}
