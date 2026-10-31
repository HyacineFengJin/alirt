import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createStreamDiagnostics, observeResponseBody, privateStreamDiagnostic } from './stream-observer.mjs';

const encode = new TextEncoder();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const sse = (event: unknown, newline = '\n') => `data: ${JSON.stringify(event)}${newline}${newline}`;
function demandBody(chunks: Uint8Array[], options: { fail?: Error; cancel?: (reason: unknown) => any } = {}) {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else if (options.fail) controller.error(options.fail);
      else controller.close();
    },
    cancel: options.cancel,
  }, { highWaterMark: 0 });
  return { body, pulls: () => pulls };
}
async function drain(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  while (true) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); }
  return chunks;
}
const ownerOf = (response: Response) => ({ fetch: vi.fn(async (..._args: Parameters<typeof fetch>) => response) as typeof fetch });
const post = { method: 'POST', headers: { authorization: 'PRIVATE_CREDENTIAL' }, body: 'PRIVATE_REQUEST_BODY' };

describe('worker stream observer transport', () => {
  it('preserves chunk identity and backpressure without a tee, prefetch or duplicate fetch', async () => {
    const a = encode.encode('data: {"type":"ping"}\n\n'), b = encode.encode('tail');
    const upstream = demandBody([a, b]);
    const response = new Response(upstream.body, { status: 201, headers: { 'x-private': 'PRIVATE_HEADER' } });
    const owner = ownerOf(response), original = owner.fetch, records: any[] = [];
    const observer = createStreamDiagnostics({ fetchOwner: owner, emit: record => records.push(record) });
    let received: Response | undefined;
    try {
      const source = (async function* () {
        received = await owner.fetch('https://fixture.invalid/messages', post);
        yield { type: 'ready' };
        yield { type: 'data', chunks: await drain(received.body!) };
      })();
      const stream = observer.stream(source)[Symbol.asyncIterator]();
      expect((await stream.next()).value.type).toBe('ready');
      await Promise.resolve();
      expect(upstream.pulls()).toBe(0);
      expect(received).toBeInstanceOf(Response); expect(received!.status).toBe(201);
      expect(received!.headers).toBe(response.headers); expect(received!.bodyUsed).toBe(false);
      const next = await stream.next();
      expect(next.value.chunks[0]).toBe(a); expect(next.value.chunks[1]).toBe(b);
      expect(await stream.next()).toMatchObject({ done: true });
      expect(original).toHaveBeenCalledTimes(1);
      expect((owner.fetch as any).mock?.calls).toBeUndefined(); // only the original fetch is called
      expect(original).toHaveBeenCalledWith('https://fixture.invalid/messages', post);
      expect(records[0].raw[0]).toMatchObject({ status: 201, terminal: 'eof', eventCounts: { ping: 1 } });
      expect(JSON.stringify(records)).not.toMatch(/PRIVATE_|authorization|headers|requestBody|responseBody/);
    } finally { observer.dispose(); }
    expect(owner.fetch).toBe(original);
  });

  it('forwards original read errors and cancellation reasons/rejections, even when diagnostic callbacks throw', async () => {
    const fault = new Error('read error');
    const source = demandBody([encode.encode('first')], { fail: fault });
    const wrapped = observeResponseBody(source.body, { bytes() { throw new Error('observer'); }, error() { throw new Error('observer'); } });
    const reader = wrapped.getReader();
    expect((await reader.read()).value).toEqual(encode.encode('first'));
    await expect(reader.read()).rejects.toBe(fault);
    const reason = { cancellation: true }, cancelFault = new Error('cancel rejection');
    const cancel = vi.fn(async () => { throw cancelFault; });
    const unconsumed = demandBody([], { cancel });
    const cancelled = observeResponseBody(unconsumed.body, { cancel() { throw new Error('observer'); } });
    expect(unconsumed.pulls()).toBe(0);
    await expect(cancelled.cancel(reason)).rejects.toBe(cancelFault);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason); expect(unconsumed.pulls()).toBe(0);
  });

  it('cancels a pending upstream read once without reporting a subsequent EOF', async () => {
    let pulled!: () => void;
    const demand = new Promise<void>(resolve => { pulled = resolve; });
    const cancel = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({ pull() { pulled(); }, cancel }, { highWaterMark: 0 });
    const ended = vi.fn(), cancelled = vi.fn();
    const reader = observeResponseBody(upstream, { end: ended, cancel: cancelled }).getReader();
    const pending = reader.read(); await demand;
    const reason = { pending: true };
    await reader.cancel(reason);
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
    expect(cancelled).toHaveBeenCalledTimes(1); expect(ended).not.toHaveBeenCalled();
  });

  it('leaves unrelated fetches and non-success bodies intact and preserves fetch exception identity', async () => {
    const response = new Response('PRIVATE_ERROR_RESPONSE', { status: 400 });
    const owner = ownerOf(response), original = owner.fetch, records: any[] = [];
    const observer = createStreamDiagnostics({ fetchOwner: owner, emit: value => records.push(value) });
    try {
      expect(await owner.fetch('https://fixture.invalid/messages', post)).toBe(response);
      for await (const _ of observer.stream((async function* () {
        expect(await owner.fetch('https://fixture.invalid/files', post)).toBe(response);
        expect(await owner.fetch('https://fixture.invalid/messages', post)).toBe(response);
        expect(response.bodyUsed).toBe(false);
        yield { type: 'test' };
      })())) { /* consume */ }
      expect(original).toHaveBeenCalledTimes(3);
      expect(records[0].raw).toHaveLength(1);
      expect(records[0].raw[0]).toMatchObject({ status: 400, terminal: 'not-observed', messageStop: false });
      expect(JSON.stringify(records)).not.toContain('PRIVATE_ERROR_RESPONSE');
    } finally { observer.dispose(); }
    const fault = new Error('fetch rejected');
    const failureOwner = { fetch: vi.fn(async () => { throw fault; }) as typeof fetch };
    const failureObserver = createStreamDiagnostics({ fetchOwner: failureOwner, emit() { throw new Error('observer'); } });
    try {
      const source = (async function* () { await failureOwner.fetch('https://fixture.invalid/messages', post); yield {}; })();
      await expect(failureObserver.stream(source)[Symbol.asyncIterator]().next()).rejects.toBe(fault);
    } finally { failureObserver.dispose(); }
  });
});

describe('body-free provider and translated correlation', () => {
  it('handles every-byte UTF8/SSE fragmentation, CRLF, multiline data, initial input and split surrogate deltas', async () => {
    const partials = ['{"汉字":"', '\ud83d', '\ude03', '"}'];
    const argument = partials.join('');
    const events = [
      { type: 'message_start', message: { id: 'PRIVATE_MESSAGE_ID', usage: { input_tokens: 37, cache_read_input_tokens: 41 }, thinking: 'PRIVATE_REASONING' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'PRIVATE_REASONING' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 5, content_block: { type: 'tool_use', id: 'PRIVATE_TOOL_ID', name: 'submit_result', input: { initial: '汉' } } },
      ...partials.map(partial_json => ({ type: 'content_block_delta', index: 5, delta: { type: 'input_json_delta', partial_json } })),
      { type: 'content_block_stop', index: 5 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 43, cache_creation_input_tokens: 47 } },
      { type: 'message_stop' },
    ];
    const wire = '\uFEFF: comment\r\n\r\n' + events.map(event => sse(event, '\r\n')).join('') + 'data: {"type":\r\ndata: "ping"}\r\n\r\n';
    const bytes = encode.encode(wire), chunks = [...bytes].map(value => Uint8Array.of(value));
    const owner = ownerOf(new Response(demandBody(chunks).body)), records: any[] = [];
    const observer = createStreamDiagnostics({ fetchOwner: owner, toolNames: ['submit_result'], emit: value => records.push(value) });
    const translatedChunk = { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'PRIVATE_TOOL_ID', name: 'submit_result', arguments: argument } };
    try {
      const source = (async function* () {
        const response = await owner.fetch('https://fixture.invalid/messages', post);
        expect(Buffer.concat(await drain(response.body!))).toEqual(Buffer.from(bytes));
        yield translatedChunk;
        yield { type: 'usage', usage: { inputTokens: 37, outputTokens: 43 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { reasoning: 'PRIVATE_REASONING' } };
      })();
      const output = []; for await (const chunk of observer.stream(source)) output.push(chunk);
      expect(output[0]).toBe(translatedChunk);
      expect(records).toHaveLength(1);
      const record = records[0], raw = record.raw[0], tool = raw.tools[0], translated = record.translated.tools[0];
      expect(raw).toMatchObject({ terminal: 'eof', stopReason: 'tool_use', messageStop: true, invalidFrames: 0,
        eventCounts: { message_start: 1, content_block_delta: 4, message_stop: 1, ping: 1 }, usage: { input_tokens: 37, output_tokens: 43, cache_read_input_tokens: 41, cache_creation_input_tokens: 47 },
        providerMessageIdSha256: hash('PRIVATE_MESSAGE_ID'),
        blockOrder: [{ event: 'start', index: 0 }, { event: 'stop', index: 0 }, { event: 'start', index: 5 }, { event: 'stop', index: 5 }] });
      expect(tool).toMatchObject({ index: 5, translatedIndex: 1, idSha256: hash('PRIVATE_TOOL_ID'), name: 'submit_result', closed: true,
        initial: { sha256: hash('{"initial":"汉"}'), chars: '{"initial":"汉"}'.length, bytes: Buffer.byteLength('{"initial":"汉"}'), fragments: 1 },
        delta: { sha256: hash(argument), chars: argument.length, bytes: Buffer.byteLength(argument), fragments: 4 } });
      expect(translated).toMatchObject({ index: 1, idSha256: tool.idSha256, arguments: { sha256: tool.delta.sha256, chars: tool.delta.chars, bytes: tool.delta.bytes }, transportId: raw.transportId, json: { valid: true } });
      expect(record.translated).toMatchObject({ terminal: 'complete', finish: 'tool-calls', usage: { inputTokens: 37, outputTokens: 43 } });
      expect(JSON.stringify(record)).not.toMatch(/PRIVATE_|汉字|partial_json|replayState|thinking|authorization|headers/);
    } finally { observer.dispose(); }
  });

  it('retains raw completed terminal facts when translated JSON validation throws, without retaining parser text', async () => {
    const invalid = '{"PRIVATE_VALUE":';
    const wire = sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 73 } }) + sse({ type: 'message_stop' });
    const owner = ownerOf(new Response(wire)), records: any[] = [], fault = new Error('original adapter failure');
    const observer = createStreamDiagnostics({ fetchOwner: owner, toolNames: ['submit_result'], emit: record => records.push(record) });
    try {
      const source = (async function* () {
        await drain((await owner.fetch('https://fixture.invalid/messages', post)).body!);
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'id', name: 'submit_result', arguments: invalid } };
        throw fault;
      })();
      const iterator = observer.stream(source)[Symbol.asyncIterator](); await iterator.next(); await expect(iterator.next()).rejects.toBe(fault);
      expect(records[0].raw[0]).toMatchObject({ stopReason: 'end_turn', messageStop: true, usage: { output_tokens: 73 } });
      expect(records[0].translated).toMatchObject({ terminal: 'error', tools: [{ json: { valid: false, category: 'unexpected-end' } }] });
      expect(JSON.stringify(records)).not.toContain('PRIVATE_VALUE'); expect(JSON.stringify(records)).not.toContain('original adapter failure');
    } finally { observer.dispose(); }
  });

  it('bounds frames, tool counts and event order without dropping consumer bytes, then resumes after an oversized frame', async () => {
    let wire = sse({ type: 'ping', ignored: 'PRIVATE_REASONING'.repeat(20000) });
    for (let index = 0; index < 140; index++) wire += sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: String(index), name: 'submit_result', input: {} } }) + sse({ type: 'content_block_stop', index });
    wire += sse({ type: 'message_stop' });
    const bytes = encode.encode(wire), owner = ownerOf(new Response(bytes)), records: any[] = [];
    const observer = createStreamDiagnostics({ fetchOwner: owner, toolNames: ['submit_result'], emit: record => records.push(record) });
    try {
      const source = (async function* () { const body = (await owner.fetch('https://fixture.invalid/messages', post)).body!; expect(Buffer.concat(await drain(body))).toEqual(Buffer.from(bytes)); yield {}; })();
      for await (const _ of observer.stream(source)) { /* consume */ }
      const raw = records[0].raw[0];
      expect(raw.tools).toHaveLength(128); expect(raw.blockOrder).toHaveLength(256); expect(raw.messageStop).toBe(true);
      expect(raw.incomplete).toEqual(expect.arrayContaining(['frame-limit', 'tool-limit', 'block-order-limit']));
      expect(JSON.stringify(records)).not.toContain('PRIVATE_REASONING'); expect(JSON.stringify(records).length).toBeLessThan(100000);
    } finally { observer.dispose(); }
  });

  it('reports unavailable raw metadata for an offline adapter, separates concurrent demands, and observes retries once each', async () => {
    const records: any[] = [], owner = { fetch: vi.fn(async () => new Response(sse({ type: 'message_stop' }))) as typeof fetch };
    const original = owner.fetch, observer = createStreamDiagnostics({ fetchOwner: owner, emit: value => records.push(value) });
    try {
      const offline = (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })();
      for await (const _ of observer.stream(offline)) { /* consume */ }
      expect(records[0]).toMatchObject({ rawAvailable: false, raw: [] });
      const source = (requests: number) => (async function* () { for (let index = 0; index < requests; index++) await drain((await owner.fetch('https://fixture.invalid/messages', post)).body!); yield {}; })();
      await Promise.all([ (async () => { for await (const _ of observer.stream(source(2))) {} })(), (async () => { for await (const _ of observer.stream(source(1))) {} })() ]);
      expect(original).toHaveBeenCalledTimes(3);
      expect(records.slice(1).map(record => record.raw.length).sort()).toEqual([1, 2]);
      expect(new Set(records.map(record => record.requestId)).size).toBe(3);
      for (const record of records.slice(1)) for (const raw of record.raw) expect(raw.transportId.startsWith(record.requestId + ':')).toBe(true);
    } finally { observer.dispose(); }
  });

  it('bounds retained transports and translated JSON inspection while forwarding every call and chunk', async () => {
    const records: any[] = [], owner = { fetch: vi.fn(async () => new Response(sse({ type: 'message_stop' }))) as typeof fetch };
    const original = owner.fetch, observer = createStreamDiagnostics({ fetchOwner: owner, toolNames: ['submit_result'], emit: value => records.push(value) });
    const argument = JSON.stringify({ value: '汉😃'.repeat(100000) });
    try {
      const source = (async function* () {
        for (let index = 0; index < 10; index++) await drain((await owner.fetch('https://fixture.invalid/messages', post)).body!);
        for (let index = 0; index < 129; index++) yield { type: 'block-end', index, block: { type: 'tool-call', id: 'id', name: 'submit_result', arguments: index === 0 ? argument : '{}' } };
      })();
      let chunks = 0; for await (const _ of observer.stream(source)) chunks++;
      expect(chunks).toBe(129); expect(original).toHaveBeenCalledTimes(10);
      expect(records[0]).toMatchObject({ rawLimit: true, translated: { incomplete: true } });
      expect(records[0].raw).toHaveLength(8); expect(records[0].translated.tools).toHaveLength(128);
      expect(records[0].translated.tools[0]).toMatchObject({ arguments: { chars: argument.length, bytes: Buffer.byteLength(argument), sha256: hash(argument), fragments: 1 }, json: { checked: false } });
      expect(records[0].translated.tools[0].transportId).toBeUndefined();
    } finally { observer.dispose(); }
  });

  it('reapplies the IPC allowlist, omitting unknown names, arbitrary fields and injected stop text', () => {
    const result = privateStreamDiagnostic({ requestId: 'BAD_PRIVATE_ID', headers: 'PRIVATE_HEADER', body: 'PRIVATE_BODY', raw: [{ status: 200, stopReason: 'PRIVATE_STOP', tools: [{ name: 'PRIVATE_CREDENTIAL', arguments: 'PRIVATE_ARGS' }], eventCounts: { PRIVATE_EVENT: 3 }, usage: { input_tokens: 5, SECRET: 7 } }], translated: { tools: [{ name: 'PRIVATE_NAME', json: { valid: false, category: 'PRIVATE_JSON_ERROR' } }] } }, ['submit_result']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    expect(result.raw[0]).toMatchObject({ status: 200, usage: { input_tokens: 5 }, tools: [{ name: '[unregistered]' }] });
  });
});
