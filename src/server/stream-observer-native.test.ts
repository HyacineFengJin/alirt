import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const runtime = resolve(process.env.RP_DSH_RUNTIME ?? '.rp-runtime/dsh');
const bin = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe.skipIf(!existsSync(bin))('native Messages diagnostic IPC (loopback only)', () => {
  it('captures completed invalid JSON before native validation and preserves successful structured results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-stream-observer-'));
    let body = '', requests = 0;
    const server = createServer(async (request, response) => {
      for await (const _ of request) { /* discard synthetic request */ }
      requests++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [
        { type: 'message_start', message: { id: 'fixture-provider-id', usage: { input_tokens: 31, output_tokens: 0, cache_read_input_tokens: 37 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'FIXTURE_REASONING_OMIT' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'fixture-tool-id', name: 'submit_result', input: {} } },
        ...[body.slice(0, 5), body.slice(5)].map(partial_json => ({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json } })),
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 41 } },
        { type: 'message_stop' },
      ];
      const bytes = Buffer.from(events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''));
      for (let index = 0; index < bytes.length; index += 7) response.write(bytes.subarray(index, index + 7));
      response.end();
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as { port: number }).port;
    const children: ReturnType<typeof spawn>[] = [];
    try {
      const home = join(root, 'home'), profile = join(home, 'profiles/rp-stream-observer-test');
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'rp-stream-observer-test', private: true, type: 'module', dependencies: {}, dsh: { profile: { bundles: [] } } }));
      const requestPath = join(root, 'request.json');
      await writeFile(join(profile, 'cordis.patch.yml'), '- insert:\n    - id: rp-stream-observer-test\n      name: ' + JSON.stringify(resolve('src/server/worker.mjs')) + '\n      config: ' + JSON.stringify({ root, request: requestPath }) + '\n');
      const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key) && !/^(DSH_|RP_DSH_|DEEPSEEK_|NODE_OPTIONS$)/.test(key)));
      const run = async (argumentsText: string) => {
        body = argumentsText;
        await writeFile(requestPath, JSON.stringify({ sessionId: 'offline-stream-' + randomUUID(), system: 'Synthetic local fixture. Finish with submit_result.', input: { fixture: true }, tools: [], resultSchema: { type: 'object', properties: { delivery: { type: 'string' } }, required: ['delivery'], additionalProperties: false } }), { mode: 0o600 });
        const child = spawn(process.execPath, [bin, '--profile', 'rp-stream-observer-test'], { cwd: root,
          env: { ...environment, RP_DSH_RUNTIME: runtime, DSH_HOME: home, DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}`, DEEPSEEK_API_KEY: 'offline-fixture-credential' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        children.push(child);
        const messages: any[] = [];
        child.on('message', message => messages.push(message));
        const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
        try {
          const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done); });
          const diagnostics = messages.filter(message => message.type === 'stream-diagnostic');
          expect(diagnostics).toHaveLength(1);
          const diagnostic = diagnostics[0].diagnostic;
          expect(diagnostic).toMatchObject({ rawAvailable: true, rawLimit: false });
          expect(diagnostic.raw).toHaveLength(1);
          const raw = diagnostic.raw[0], translated = diagnostic.translated.tools[0];
          expect(raw).toMatchObject({ status: 200, stopReason: 'tool_use', messageStop: true,
            eventCounts: { message_start: 1, message_delta: 1, message_stop: 1, content_block_delta: 2 },
            usage: { input_tokens: 31, output_tokens: 41, cache_read_input_tokens: 37 },
            tools: [{ index: 1, translatedIndex: 1, initial: { sha256: hash('{}') }, delta: { chars: argumentsText.length, bytes: Buffer.byteLength(argumentsText), fragments: 2, sha256: hash(argumentsText) }, closed: true }] });
          expect(translated).toMatchObject({ index: 1, transportId: raw.transportId, arguments: { sha256: raw.tools[0].delta.sha256 }, idSha256: raw.tools[0].idSha256 });
          expect(JSON.stringify(diagnostic)).not.toMatch(/FIXTURE_REASONING_OMIT|offline-fixture-credential|fixture-provider-id|fixture-tool-id|FIXTURE_ARGUMENT_OMIT/);
          return { code, messages, diagnostic };
        } finally { clearTimeout(timer); }
      };
      const malformed = await run('{"delivery":"FIXTURE_ARGUMENT_OMIT"');
      expect(malformed.code).toBe(1);
      expect(malformed.messages.find(message => message.type === 'failure')?.adapterDiagnostic?.code).toBe('MALFORMED_RESPONSE');
      expect(malformed.messages.some(message => message.type === 'result')).toBe(false);
      expect(malformed.diagnostic.translated).toMatchObject({ terminal: 'error', usage: {}, tools: [{ json: { valid: false } }] });
      const successful = await run('{"delivery":"汉字😃"}');
      expect(successful.code).toBe(0);
      expect(successful.messages.find(message => message.type === 'result')?.result).toEqual({ delivery: '汉字😃' });
      expect(successful.diagnostic.translated).toMatchObject({ terminal: 'complete', finish: 'tool-calls', usage: { inputTokens: 31, outputTokens: 41, cacheReadTokens: 37, totalTokens: 109 }, tools: [{ json: { valid: true } }] });
      expect(requests).toBe(2); // Native retry/quality behavior is unchanged.
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      await rm(root, { recursive: true, force: true });
    }
  }, 35000);
});
