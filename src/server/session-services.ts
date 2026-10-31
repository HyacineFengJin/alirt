import type { Json } from '../shared/types';
import { assertStateJson } from './state-runtime';
import { ApiError, clone, type SessionStore, type StoredSession } from './store';
import { validateWorldInputSelection, validateWorldInputEvidence, type WorldInputSelection, type WorldInputEvidence } from '../shared/world-input';

/** Trusted, explicitly installed server code. Domain parsing, CAS, receipts and
 * atomic persistence belong to apply; imported document data never supplies handlers.
 * Both handlers must finish synchronously, without model or network dispatch.
 */
export interface SessionCommandService {
  readonly id: string;
  readonly title: string;
  readonly read: (session: Readonly<StoredSession>) => unknown;
  readonly apply: (store: SessionStore, id: string, input: unknown) => unknown;
  readonly worldInput?: (session: Readonly<StoredSession>, selection: Pick<WorldInputSelection, 'referenceId' | 'parameters'>) => WorldInputEvidence;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function response(value: unknown): Json {
  // Async functions are rejected before invocation. Also reject accidental
  // Promise results from ordinary functions rather than serializing them as {}.
  if (value instanceof Promise) {
    void value.catch(() => {});
    throw new ApiError(500, 'SESSION_SERVICE_RESULT', 'Session service handlers must return synchronous JSON data');
  }
  try { assertStateJson(value); }
  catch { throw new ApiError(500, 'SESSION_SERVICE_RESULT', 'Session service returned invalid JSON data'); }
  return clone(value);
}

/** A routing map, independent of agentRuntime. Unknown services fail only their
 * own requests; removing an installation never interprets or deletes held data.
 */
export class SessionServiceRegistry {
  private readonly services = new Map<string, SessionCommandService>();
  constructor(services: readonly SessionCommandService[] = []) {
    if (!Array.isArray(services)) throw new ApiError(400, 'SESSION_SERVICE_INVALID', 'Session services must be an explicit list');
    for (const service of services) {
      if (!service || typeof service !== 'object' || Array.isArray(service)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(service)) || Object.getOwnPropertySymbols(service).length)
        throw new ApiError(400, 'SESSION_SERVICE_INVALID', 'Expected a trusted session service definition');
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(service)))
        if (!['id', 'title', 'read', 'apply', 'worldInput'].includes(key) || !('value' in descriptor))
          throw new ApiError(400, 'SESSION_SERVICE_INVALID', 'Unsupported session service definition field');
      if (typeof service.id !== 'string' || !service.id.trim() || service.id.trim() !== service.id
        || ['__proto__', 'prototype', 'constructor'].includes(service.id) || /[\/\\\u0000-\u0020\u007f-\u009f]/.test(service.id)
        || typeof service.title !== 'string' || !service.title.trim()
        || typeof service.read !== 'function' || typeof service.apply !== 'function'
        || service.worldInput !== undefined && typeof service.worldInput !== 'function'
        || [service.read, service.apply, service.worldInput].filter(Boolean).some(handler => ['[object AsyncFunction]', '[object GeneratorFunction]', '[object AsyncGeneratorFunction]'].includes(Object.prototype.toString.call(handler))))
        throw new ApiError(400, 'SESSION_SERVICE_INVALID', 'Session services require an ID, title and synchronous read/apply handlers');
      if (this.services.has(service.id)) throw new ApiError(400, 'SESSION_SERVICE_DUPLICATE', 'Session service IDs must be unique');
      this.services.set(service.id, Object.freeze({ id: service.id, title: service.title, read: service.read, apply: service.apply,
        ...(service.worldInput ? { worldInput: service.worldInput } : {}) }));
    }
  }
  catalog() { return [...this.services.values()].map(({ id, title }) => ({ id, title })); }
  assertInstalled(id: string): void { this.get(id); }
  private get(id: string) {
    const service = this.services.get(id);
    if (!service) throw new ApiError(404, 'SESSION_SERVICE_UNKNOWN', 'Session service is not installed');
    return service;
  }
  read(id: string, session: Readonly<StoredSession>): Json {
    return response(this.get(id).read(freeze(clone(session))));
  }
  worldInput(selection: WorldInputSelection, session: Readonly<StoredSession>): WorldInputEvidence {
    let selected: WorldInputSelection;
    try { selected = validateWorldInputSelection(selection); }
    catch { throw new ApiError(400, 'WORLD_INPUT_SELECTION', 'Provide an exact service, reference and JSON parameters selection'); }
    const service = this.get(selected.serviceId);
    if (!service.worldInput) throw new ApiError(404, 'WORLD_INPUT_UNAVAILABLE', 'This session service does not supply world inputs');
    const result = service.worldInput(freeze(clone(session)), freeze({ referenceId: selected.referenceId, parameters: selected.parameters }));
    let evidence: WorldInputEvidence;
    try { evidence = validateWorldInputEvidence(response(result)); }
    catch { throw new ApiError(500, 'WORLD_INPUT_EVIDENCE', 'Session service returned invalid world input evidence'); }
    if (evidence.serviceId !== selected.serviceId || evidence.referenceId !== selected.referenceId)
      throw new ApiError(500, 'WORLD_INPUT_EVIDENCE', 'Session service returned evidence for a different selection');
    return evidence;
  }
  apply(serviceId: string, store: SessionStore, id: string, input: unknown): Json {
    const service = this.get(serviceId);
    try { assertStateJson(input); }
    catch { throw new ApiError(400, 'SESSION_SERVICE_INPUT', 'Provide an ordinary JSON command object'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'SESSION_SERVICE_INPUT', 'Provide an ordinary JSON command object');
    return response(service.apply(store, id, clone(input)));
  }
}
