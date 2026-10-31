import { clone, event, type SessionStore } from './store';

export interface PromptContextBinding {
  sessionId: string;
  generation: number;
  changed: boolean;
  previousSessionId?: string;
}

/** Bind one logical agent to the current admitted context before dispatch.
 * Old native transcripts remain archived; a replacement receives no copied memory.
 * This is a synchronous store save, not a transaction with the native runtime.
 */
export function bindPromptContext(store: SessionStore, storyId: string, logicalKey: string, baseSessionId: string, fingerprint: string): PromptContextBinding {
  const current = store.get(storyId);
  const previous = current.promptContexts && Object.hasOwn(current.promptContexts, logicalKey)
    ? current.promptContexts[logicalKey] : undefined;
  if (previous?.baseSessionId === baseSessionId && previous.fingerprint === fingerprint) {
    return { sessionId: previous.sessionId, generation: previous.generation, changed: false };
  }
  const generation = (previous?.generation ?? 0) + 1;
  // Even the first binding avoids a legacy transcript whose admissions are unknown.
  const sessionId = `${baseSessionId}-p${generation}`;
  const next = clone(current);
  next.promptContexts ??= {};
  Object.defineProperty(next.promptContexts, logicalKey, { value: { baseSessionId, fingerprint, sessionId, generation }, enumerable: true, writable: true, configurable: true });
  event(next, { kind: 'context-rebound', actor: logicalKey, audience: 'author', text: `Agent context bound to generation ${generation}.`, data: {
    logicalKey, sessionId, generation, previousSessionId: previous?.sessionId ?? null,
  } });
  store.save(next);
  return { sessionId, generation, changed: true, ...(previous ? { previousSessionId: previous.sessionId } : {}) };
}
