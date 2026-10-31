// Error diagnostics are private data. Never serialize an arbitrary error object:
// request/config/headers/body/env and custom fields are deliberately excluded.
export function errorDiagnostic(error, credential) {
  const seen = new WeakSet();
  const read = (value, key) => { try { return value[key]; } catch { return undefined; } };
  const text = (value, limit) => {
    if (typeof value !== 'string') return undefined;
    const redacted = credential ? value.replaceAll(credential, '[redacted]') : value;
    return redacted.replaceAll('\0', '').slice(0, limit);
  };
  const visit = (value, depth) => {
    if (depth > 4) return { message: '[diagnostic depth limit]' };
    if (!value || typeof value !== 'object') {
      const message = text(value, 1024); return message === undefined ? {} : { message };
    }
    if (seen.has(value)) return { message: '[diagnostic cycle]' };
    seen.add(value);
    const result = {};
    for (const key of ['name', 'message', 'code']) {
      let field = text(read(value, key), key === 'message' ? 1024 : 128);
      // Some HTTP adapters stash a whole response body inside Error.message.
      // It remains payload data even though its property is allowlisted.
      if (key === 'message' && field && /^[\s]*[\[{]/.test(field)) field = '[structured message payload omitted]';
      if (field !== undefined) result[key] = field;
    }
    for (const key of ['status', 'statusCode']) {
      const field = read(value, key);
      if (typeof field === 'number' && Number.isSafeInteger(field)) result[key] = field;
    }
    for (const key of ['cause', 'failure']) {
      const field = read(value, key);
      if (field !== undefined && field !== null) result[key] = visit(field, depth + 1);
    }
    seen.delete(value);
    return result;
  };
  return visit(error, 0);
}

// Observe the public adapter boundary before LlmRuntime normalizes the live
// exception into a serializable finish chunk. Requests and exceptions pass
// through unchanged, including native provider retry behavior.
export function observeAdapterErrors(Adapter, observer) {
  const prototype = Adapter.prototype, original = prototype.prepareCall;
  if (typeof original !== 'function') throw new Error('Native adapter prepareCall boundary is unavailable');
  const notify = (name, error) => { try { observer[name]?.(error); } catch {} };
  async function observedPrepareCall(...args) {
    let prepared;
    try { prepared = await original.apply(this, args); }
    catch (error) { notify('start'); notify('failure', error); throw error; }
    return { ...prepared, stream(options) {
      return (async function* () {
        notify('start');
        try {
          const stream = prepared.stream(options);
          yield* observer.stream ? observer.stream(stream) : stream;
          notify('success');
        }
        catch (error) { notify('failure', error); throw error; }
      })();
    } };
  }
  prototype.prepareCall = observedPrepareCall;
  return () => { if (prototype.prepareCall === observedPrepareCall) prototype.prepareCall = original; };
}
