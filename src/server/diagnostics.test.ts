import { describe, expect, it } from 'vitest';
import { errorDiagnostic, observeAdapterErrors } from './diagnostics.mjs';

describe('private native error diagnostics', () => {
  it('preserves bounded nested Error causes and failure classification while omitting arbitrary secret fields', () => {
    const credential = 'test-only-private-key';
    const cause = Object.assign(new Error('connect failed for ' + credential), { code: 'ECONNRESET', statusCode: 503,
      headers: { Authorization: credential }, config: { apiKey: credential }, request: { body: 'PRIVATE_REQUEST_CONTENT' } });
    const error = Object.assign(new Error('DeepSeek Messages transport failed', { cause }), { code: 'TRANSPORT', status: 502,
      failure: { code: 'TRANSPORT', message: 'Provider request failed', cause, body: 'PRIVATE_BODY_CONTENT', env: { key: credential } },
      response: { headers: { key: credential } }, toJSON() { throw new Error('Must never serialize the original object'); } });
    const diagnostic = errorDiagnostic(error, credential);
    expect(diagnostic.name).toBe('Error'); expect(diagnostic.code).toBe('TRANSPORT'); expect(diagnostic.status).toBe(502);
    expect(diagnostic.cause).toMatchObject({ name: 'Error', message: 'connect failed for [redacted]', code: 'ECONNRESET', statusCode: 503 });
    expect(diagnostic.failure?.code).toBe('TRANSPORT');
    const json = JSON.stringify(diagnostic);
    for (const forbidden of [credential, '"headers":', 'Authorization', '"config":', '"request":', 'PRIVATE_REQUEST_CONTENT', 'PRIVATE_BODY_CONTENT', '"env":', '"response":', 'toJSON']) expect(json).not.toContain(forbidden);
  });
  it('bounds deep/cyclic diagnostics, ignores object-valued code/message and never invokes toString', () => {
    const cycle: any = { name: 'Error', message: 'x'.repeat(4000) }; cycle.cause = cycle;
    const diagnostic = errorDiagnostic({ message: { toString() { throw new Error('Do not coerce'); } }, code: { secret: 'hidden' }, cause: cycle });
    expect(diagnostic.message).toBeUndefined(); expect(diagnostic.code).toBeUndefined();
    expect(diagnostic.cause?.message).toHaveLength(1024);
    expect(diagnostic.cause?.cause?.message).toBe('[diagnostic cycle]');
    let deep: unknown = new Error('innermost'); for (let i = 0; i < 20; ++i) deep = new Error('outer', { cause: deep });
    expect(JSON.stringify(errorDiagnostic(deep))).toContain('[diagnostic depth limit]');
  });
  it('reapplies credential redaction and the allowlist to an already serialized worker IPC object', () => {
    const incoming = { name: 'Error', message: 'public compact', cause: { name: 'TypeError', message: 'fetch failed: KEY_SENTINEL', code: 'ECONNRESET', headers: { key: 'KEY_SENTINEL' } }, failure: { code: 'TRANSPORT', request: 'PRIVATE_PAYLOAD' } };
    const saved = errorDiagnostic(incoming, 'KEY_SENTINEL');
    expect(saved.cause?.message).toBe('fetch failed: [redacted]');
    expect(JSON.stringify(saved)).not.toContain('KEY_SENTINEL'); expect(JSON.stringify(saved)).not.toContain('PRIVATE_PAYLOAD');
    expect(incoming.cause.message).toContain('KEY_SENTINEL');
    const bodyInMessage = errorDiagnostic(new Error('HTTP rejected', { cause: new Error('{"headers":{"Authorization":"HIDDEN"},"body":"PRIVATE_JSON"}') }));
    expect(bodyInMessage.cause?.message).toBe('[structured message payload omitted]');
    expect(JSON.stringify(bodyInMessage)).not.toContain('PRIVATE_JSON');
  });
  it('observes the same thrown boundary error without changing binding or retry inputs, then clears stale failure on success', async () => {
    const originalError = new Error('original boundary exception', { cause: new Error('root cause') });
    class Adapter {
      label = 'bound-instance';
      async prepareCall(provider: string) {
        const label = this.label;
        return { model: { provider, label }, async *stream(options: { fail: boolean }) { if (options.fail) throw originalError; yield { label, options }; } };
      }
    }
    const original = Adapter.prototype.prepareCall;
    let captured: unknown;
    const restore = observeAdapterErrors(Adapter, { start: () => { captured = undefined; }, failure: error => { captured = error; }, success: () => { captured = undefined; } });
    try {
      const call = await new Adapter().prepareCall('unchanged-provider');
      expect(call.model).toEqual({ provider: 'unchanged-provider', label: 'bound-instance' });
      let caught: unknown;
      try { for await (const _chunk of call.stream({ fail: true })) {} } catch (error) { caught = error; }
      expect(caught).toBe(originalError); expect(captured).toBe(originalError);
      const options = { fail: false }, chunks = [];
      for await (const chunk of call.stream(options)) chunks.push(chunk);
      expect(chunks).toEqual([{ label: 'bound-instance', options }]); expect(chunks[0].options).toBe(options);
      expect(captured).toBeUndefined();
    } finally { restore(); }
    expect(Adapter.prototype.prepareCall).toBe(original);
  });
  it('does not restore over another observer owner and contains diagnostic callback failures', async () => {
    const originalError = new Error('original exception');
    class Adapter { async prepareCall(): Promise<{ stream(): AsyncGenerator<never, void, unknown> }> { return { async *stream() { throw originalError; } }; } }
    const original = Adapter.prototype.prepareCall;
    const restore = observeAdapterErrors(Adapter, { failure: () => { throw new Error('diagnostic observer failure'); } });
    const call = await new Adapter().prepareCall();
    let caught: unknown; try { for await (const _chunk of call.stream()) {} } catch (error) { caught = error; }
    expect(caught).toBe(originalError);
    const otherOwner = async () => ({ async *stream() {} });
    Adapter.prototype.prepareCall = otherOwner;
    restore(); expect(Adapter.prototype.prepareCall).toBe(otherOwner);
    Adapter.prototype.prepareCall = original;
  });
});
