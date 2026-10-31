// Worker-local, demand-driven diagnostics. No request body, headers, response
// body, text or reasoning is retained. Bounds affect observation only.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

const MAX_FRAME_CHARS = 262144;
const MAX_TOOLS = 128;
const MAX_ORDER = 256;
const MAX_TRANSPORTS = 8;
const OBSERVATION_SLICE = 16384;
const KNOWN_EVENTS = new Set(['message_start', 'message_delta', 'message_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'ping', 'error']);
const STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'tool_use', 'max_tokens']);
const FINISH_REASONS = new Set(['stop', 'tool-calls', 'max-tokens', 'error', 'aborted']);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const usage = value => Object.fromEntries(['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'].flatMap(key => count(value?.[key]) === undefined ? [] : [[key, value[key]]]));

// Keep a trailing surrogate until the next fragment so digest/bytes describe
// concatenated JSON, including a Unicode pair split between provider deltas.
function stringDigest() {
  const hash = createHash('sha256');
  let chars = 0, bytes = 0, fragments = 0, trailing = '';
  return {
    add(value) {
      chars += value.length; fragments++;
      for (let offset = 0; offset < value.length; offset += OBSERVATION_SLICE) {
        let text = trailing + value.slice(offset, offset + OBSERVATION_SLICE); trailing = '';
        if (text.length && /[\uD800-\uDBFF]/.test(text.at(-1))) { trailing = text.at(-1); text = text.slice(0, -1); }
        const buffer = Buffer.from(text); bytes += buffer.length; hash.update(buffer);
      }
    },
    snapshot() { return { chars, bytes: bytes + Buffer.byteLength(trailing), fragments, sha256: hash.copy().update(trailing).digest('hex') }; },
  };
}
function digest(value) { const result = stringDigest(); result.add(value); return result.snapshot(); }
function jsonDiagnostic(text) {
  if (text.length > MAX_FRAME_CHARS) return { checked: false };
  try { JSON.parse(text); return { checked: true, valid: true }; }
  catch (error) {
    const message = typeof error?.message === 'string' ? error.message : '';
    const offset = /position (\d+)/.exec(message);
    const category = /Unexpected end|end of JSON/i.test(message) ? 'unexpected-end'
      : /after JSON/.test(message) ? 'extra-data'
      : /Expected.*colon|Expected ':'/.test(message) ? 'expected-colon'
      : /Expected.*comma|Expected ','/.test(message) ? 'expected-comma'
      : /property name/.test(message) ? 'expected-property'
      : /Unterminated string/.test(message) ? 'unterminated-string' : 'invalid-json';
    return { checked: true, valid: false, category, ...(offset ? { offset: Number(offset[1]) } : category === 'unexpected-end' ? { offset: text.length } : {}) };
  }
}

// Parse SSE framing incrementally without retaining an unterminated frame over
// the limit. Oversized/malformed frames make the audit partial, never the stream.
function sseObserver(onEvent, onLimit, onInvalid) {
  const decoder = new TextDecoder();
  let line = '', data = '', frameChars = 0, skip = false, cr = false, first = true;
  const dispatchLine = () => {
    if (!line) {
      if (!skip && data) {
        try { onEvent(JSON.parse(data.slice(0, -1))); } catch { onInvalid(); }
      }
      data = ''; frameChars = 0; skip = false;
    } else if (!skip && (line === 'data' || line.startsWith('data:'))) {
      let value = line.slice(4); if (value.startsWith(':')) value = value.slice(1); if (value.startsWith(' ')) value = value.slice(1);
      data += value + '\n';
    }
    line = '';
  };
  const feed = text => {
    for (const char of text) {
      if (first) { first = false; if (char === '\uFEFF') continue; }
      if (cr) { cr = false; if (char === '\n') continue; }
      if (char === '\n' || char === '\r') { dispatchLine(); cr = char === '\r'; continue; }
      frameChars += char.length;
      if (frameChars > MAX_FRAME_CHARS && !skip) { skip = true; line = ''; data = ''; onLimit(); }
      if (!skip) line += char;
      // Even while skipping, distinguish an empty boundary line.
      else line = 'x';
    }
  };
  return { bytes(value) {
    for (let offset = 0; offset < value.byteLength; offset += OBSERVATION_SLICE) feed(decoder.decode(value.subarray(offset, offset + OBSERVATION_SLICE), { stream: true }));
  }, end() { feed(decoder.decode()); line = ''; data = ''; frameChars = 0; skip = false; } };
}

/** Pass bytes through on demand, preserving chunk identity, errors and cancel.
 * The callback observes only chunks requested by the consumer; it cannot fail delivery.
 */
export function observeResponseBody(body, observer) {
  let reader, cancelled = false;
  const getReader = () => reader ??= body.getReader();
  const notify = (name, value) => { try { observer[name]?.(value); } catch {} };
  return new ReadableStream({
    async pull(controller) {
      let next;
      try { next = await getReader().read(); }
      catch (error) { if (!cancelled) { notify('error'); controller.error(error); } return; }
      if (cancelled) return;
      if (next.done) { notify('end'); controller.close(); return; }
      notify('bytes', next.value); controller.enqueue(next.value);
    },
    cancel(reason) { cancelled = true; notify('cancel'); return getReader().cancel(reason); },
  }, { highWaterMark: 0 });
}

/** Installs a worker-local fetch observer, active only inside wrapped adapter
 * iterator demands. Fetch arguments, retries, returned bytes and errors pass through.
 */
export function createStreamDiagnostics({ emit, toolNames = [], fetchOwner = globalThis } = {}) {
  const storage = new AsyncLocalStorage();
  const originalFetch = fetchOwner.fetch;
  const names = new Set(toolNames);
  const notify = value => { try { emit?.(privateStreamDiagnostic(value, toolNames)); } catch {} };
  let enabled = true;
  function rawState(context, status) {
    const record = { transportId: `${context.requestId}:${context.raw.length + 1}`, status, terminal: 'open', messageStop: false,
      eventCounts: {}, blockOrder: [], tools: [], usage: {}, incomplete: [], invalidFrames: 0 };
    const tools = new Map(), digests = new WeakMap(); let blockIndex = 0;
    const limit = value => { if (!record.incomplete.includes(value)) record.incomplete.push(value); };
    const parser = sseObserver(event => {
      event = object(event); const type = KNOWN_EVENTS.has(event.type) ? event.type : 'other';
      record.eventCounts[type] = (record.eventCounts[type] ?? 0) + 1;
      if (type === 'message_start') {
        const message = object(event.message);
        if (typeof message.id === 'string') record.providerMessageIdSha256 = sha256(message.id);
        Object.assign(record.usage, usage(message.usage));
      }
      if (type === 'message_delta') {
        const reason = event.delta?.stop_reason;
        if (typeof reason === 'string') {
          record.stopReason = STOP_REASONS.has(reason) ? reason : 'unrecognized';
          if (!STOP_REASONS.has(reason)) record.stopReasonSha256 = sha256(reason);
        }
        Object.assign(record.usage, usage(event.usage));
      }
      if (type === 'message_stop') record.messageStop = true;
      if (type === 'content_block_start' || type === 'content_block_stop') {
        if (record.blockOrder.length < MAX_ORDER) record.blockOrder.push({ event: type === 'content_block_start' ? 'start' : 'stop', index: count(event.index) ?? null });
        else limit('block-order-limit');
      }
      if (type === 'content_block_start') {
        const index = blockIndex++, block = object(event.content_block);
        if (block.type !== 'tool_use') return;
        if (record.tools.length >= MAX_TOOLS) { limit('tool-limit'); return; }
        const item = { index: count(event.index) ?? null, translatedIndex: index, idSha256: typeof block.id === 'string' ? sha256(block.id) : undefined,
          name: names.has(block.name) ? block.name : '[unregistered]', initial: digest(JSON.stringify(object(block.input))), closed: false };
        const delta = stringDigest(); tools.set(event.index, { item, delta }); digests.set(item, delta); record.tools.push(item);
      }
      if (type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && typeof event.delta.partial_json === 'string') {
        const tool = tools.get(event.index); tool?.delta.add(event.delta.partial_json);
      }
      if (type === 'content_block_stop') { const tool = tools.get(event.index); if (tool) tool.item.closed = true; }
    }, () => limit('frame-limit'), () => record.invalidFrames++);
    const snapshot = () => ({ ...record, tools: record.tools.map(item => ({ ...item, delta: digests.get(item)?.snapshot() })) });
    const end = terminal => {
      if (record.terminal !== 'open') return;
      try { parser.end(); } finally { record.terminal = terminal; }
    };
    context.raw.push({ snapshot, transportId: record.transportId });
    return { bytes: value => parser.bytes(value), end: () => end('eof'), error: () => end('error'), cancel: () => end('cancelled'), unobserved: () => end('not-observed') };
  }
  async function observedFetch(...args) {
    const context = enabled ? storage.getStore() : undefined;
    const response = await originalFetch.apply(this, args);
    if (!context) return response;
    // File uploads/resolution may occur under the same adapter demand. Only
    // observe Messages POSTs; their URL is used for matching and never retained.
    try {
      const input = args[0];
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (!url.pathname.endsWith('/messages') || (args[1]?.method ?? input?.method ?? 'GET').toUpperCase() !== 'POST') return response;
      if (context.raw.length >= MAX_TRANSPORTS) { context.rawLimit = true; return response; }
    } catch { return response; }
    let body;
    try {
      // Do not inspect request bodies, credentials or headers. ALS scopes
      // this solely to the native adapter's currently demanded model step.
      const raw = rawState(context, response.status);
      if (!response.ok || response.body === null) { raw.unobserved(); return response; }
      body = observeResponseBody(response.body, raw);
    } catch { return response; }
    return new Proxy(response, { get(target, key) {
      if (key === 'body') return body;
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
  fetchOwner.fetch = observedFetch;
  return {
    async *stream(source) {
      const context = { requestId: randomUUID(), raw: [] };
      const translated = { tools: [], usage: {}, terminal: 'open' };
      const iterator = source[Symbol.asyncIterator]();
      let settled = false;
      try {
        while (true) {
          const next = await storage.run(context, () => iterator.next());
          if (next.done) { settled = true; translated.terminal = 'complete'; break; }
          try {
            const chunk = next.value;
            if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
              if (translated.tools.length < MAX_TOOLS) translated.tools.push({ index: chunk.index, idSha256: sha256(chunk.block.id),
                name: names.has(chunk.block.name) ? chunk.block.name : '[unregistered]', arguments: digest(chunk.block.arguments), json: jsonDiagnostic(chunk.block.arguments),
                transportId: context.rawLimit ? undefined : context.raw.at(-1)?.transportId });
              else translated.incomplete = true;
            } else if (chunk.type === 'usage') Object.assign(translated.usage, usage(chunk.usage));
            else if (chunk.type === 'finish') translated.finish = FINISH_REASONS.has(chunk.reason?.kind) ? chunk.reason.kind : 'unrecognized';
          } catch { translated.incomplete = true; }
          yield next.value;
        }
      } catch (error) { settled = true; translated.terminal = 'error'; throw error; }
      finally {
        try {
          if (!settled) {
            translated.terminal = 'cancelled';
            if (iterator.return) await storage.run(context, () => iterator.return());
          }
        } finally {
          try {
            notify({ schema: 'rp.provider-stream/0.1', requestId: context.requestId, rawAvailable: context.raw.length > 0, rawLimit: context.rawLimit === true,
              raw: context.raw.map(raw => raw.snapshot()), translated });
          } catch { /* Diagnostic collection cannot replace iterator errors. */ }
        }
      }
    },
    dispose() { enabled = false; if (fetchOwner.fetch === observedFetch) fetchOwner.fetch = originalFetch; },
  };
}

// Reapply an explicit allowlist on both sides of private IPC. No arbitrary
// strings from stream data are accepted, including tool names not predeclared.
export function privateStreamDiagnostic(value, toolNames = []) {
  const names = new Set(toolNames);
  const record = object(value);
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
  const index = value => count(value) ?? null;
  const metric = value => ({ chars: count(value?.chars) ?? 0, bytes: count(value?.bytes) ?? 0, fragments: count(value?.fragments) ?? 0, sha256: hash(value?.sha256) });
  const name = value => typeof value === 'string' && names.has(value) && /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(value) ? value : '[unregistered]';
  const terminal = value => ['open', 'eof', 'error', 'cancelled', 'complete', 'not-observed'].includes(value) ? value : 'unavailable';
  const id = value => typeof value === 'string' && /^[0-9a-f-]{36}(?::\d+)?$/.test(value) ? value : undefined;
  return {
    schema: 'rp.provider-stream/0.1', requestId: id(record.requestId), rawAvailable: record.rawAvailable === true, rawLimit: record.rawLimit === true,
    raw: Array.isArray(record.raw) ? record.raw.slice(0, MAX_TRANSPORTS).map(raw => ({ transportId: id(raw?.transportId), status: count(raw?.status),
      terminal: terminal(raw?.terminal), messageStop: raw?.messageStop === true, providerMessageIdSha256: hash(raw?.providerMessageIdSha256),
      stopReason: STOP_REASONS.has(raw?.stopReason) ? raw.stopReason : raw?.stopReason === 'unrecognized' ? 'unrecognized' : undefined,
      stopReasonSha256: hash(raw?.stopReasonSha256), invalidFrames: count(raw?.invalidFrames) ?? 0,
      eventCounts: Object.fromEntries([...KNOWN_EVENTS, 'other'].flatMap(key => count(raw?.eventCounts?.[key]) === undefined ? [] : [[key, raw.eventCounts[key]]])),
      blockOrder: Array.isArray(raw?.blockOrder) ? raw.blockOrder.slice(0, MAX_ORDER).map(item => ({ event: item?.event === 'start' ? 'start' : 'stop', index: index(item?.index) })) : [],
      usage: usage(raw?.usage), incomplete: Array.isArray(raw?.incomplete) ? raw.incomplete.filter(item => ['block-order-limit', 'tool-limit', 'frame-limit'].includes(item)).slice(0, 3) : [],
      tools: Array.isArray(raw?.tools) ? raw.tools.slice(0, MAX_TOOLS).map(tool => ({ index: index(tool?.index), translatedIndex: index(tool?.translatedIndex), idSha256: hash(tool?.idSha256), name: name(tool?.name), initial: metric(tool?.initial), delta: metric(tool?.delta), closed: tool?.closed === true })) : [],
    })) : [],
    translated: {
      terminal: terminal(record.translated?.terminal), finish: FINISH_REASONS.has(record.translated?.finish) ? record.translated.finish : undefined,
      usage: usage(record.translated?.usage), incomplete: record.translated?.incomplete === true,
      tools: Array.isArray(record.translated?.tools) ? record.translated.tools.slice(0, MAX_TOOLS).map(tool => ({ index: index(tool?.index), idSha256: hash(tool?.idSha256), name: name(tool?.name),
        arguments: metric(tool?.arguments), transportId: id(tool?.transportId), json: tool?.json?.checked !== true ? { checked: false } : { checked: true, valid: tool.json.valid === true,
          ...tool.json.valid === true ? {} : { category: ['unexpected-end', 'extra-data', 'expected-colon', 'expected-comma', 'expected-property', 'unterminated-string', 'invalid-json'].includes(tool?.json?.category) ? tool.json.category : 'invalid-json', ...(count(tool?.json?.offset) === undefined ? {} : { offset: tool.json.offset }) } } })) : [],
    },
  };
}
