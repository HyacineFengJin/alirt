import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const runtime = resolve(process.env.RP_DSH_RUNTIME ?? '.rp-runtime/dsh'), bin = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const schema = { type: 'object', properties: { summary: { type: 'string' }, changes: { type: 'array', items: {} }, acceptedBehaviorIds: { type: 'array', items: { type: 'string' } },
  facts: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, sources: { type: 'array', minItems: 1,
    items: { anyOf: [{ type: 'object', properties: { kind: { const: 'world-development' } }, required: ['kind'], additionalProperties: false },
      { type: 'object', properties: { kind: { const: 'state' }, roleId: { type: 'string' }, key: { type: 'string' } }, required: ['kind', 'roleId', 'key'], additionalProperties: false }] } } },
    required: ['text', 'sources'], additionalProperties: false } } }, required: ['summary', 'changes', 'acceptedBehaviorIds', 'facts'], additionalProperties: false };

describe.skipIf(!existsSync(bin))('native completion validation (synthetic loopback endpoint only)', () => {
  it('feeds schema errors back in the same delivery, accepts only the corrected result, and rejects bad schemas before any model request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-submit-schema-native-')), requests: any[] = [], children: ReturnType<typeof spawn>[] = [];
    const valid = { summary: 'Neutral audit.', changes: [], acceptedBehaviorIds: [], facts: Array.from({ length: 7 }, () => ({ text: 'The rehearsal is quiet.', sources: [{ kind: 'world-development' }] })) };
    const invalid: any = structuredClone(valid); invalid.facts[6].sources_placeholder = null;
    const server = createServer(async (request, response) => {
      let body = ''; for await (const bytes of request) body += bytes; requests.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const argument = JSON.stringify(requests.length === 1 ? invalid : valid);
      const events = [
        { type: 'message_start', message: { id: `fixture-${requests.length}`, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `fixture-call-${requests.length}`, name: 'submit_result', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: argument } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
      ];
      response.end(events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''));
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as { port: number }).port;
    try {
      const home = join(root, 'home'), profile = join(home, 'profiles/rp-submit-schema'), requestPath = join(root, 'request.json');
      await mkdir(profile, { recursive: true });
      await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'rp-submit-schema', private: true, type: 'module', dependencies: {}, dsh: { profile: { bundles: [] } } }));
      await writeFile(join(profile, 'cordis.patch.yml'), '- insert:\n    - id: rp-submit-schema-test\n      name: ' + JSON.stringify(resolve('src/server/worker.mjs')) + '\n      config: ' + JSON.stringify({ root, request: requestPath }) + '\n');
      const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key) && !/^(DSH_|RP_DSH_|DEEPSEEK_|NODE_OPTIONS$)/.test(key)));
      const run = async (resultSchema: unknown) => {
        await writeFile(requestPath, JSON.stringify({ sessionId: `schema-native-${randomUUID()}`, system: 'Synthetic fixture. Submit the declared result.', input: { fixture: true }, resultSchema, tools: [] }));
        const child = spawn(process.execPath, [bin, '--profile', 'rp-submit-schema'], { cwd: root, env: { ...environment, RP_DSH_RUNTIME: runtime,
          DSH_HOME: home, DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}`, DEEPSEEK_API_KEY: 'offline-schema-fixture' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        children.push(child); const messages: any[] = []; child.on('message', value => messages.push(value));
        const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
        try { const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done); }); return { code, messages }; }
        finally { clearTimeout(timer); }
      };
      const result = await run(schema);
      expect(result.code, JSON.stringify(result.messages.filter(message => message.type === 'failure'))).toBe(0);
      expect(requests).toHaveLength(2);
      const feedback = JSON.stringify(requests[1]); expect(feedback).toContain('/facts/6/sources_placeholder'); expect(feedback).toContain('invalid arguments');
      expect(feedback).toContain('"is_error":true');
      expect(result.messages.filter(message => message.type === 'result')).toEqual([expect.objectContaining({ result: valid })]);
      expect(invalid.facts[6]).toHaveProperty('sources_placeholder', null);
      const badSchema = await run({ type: 'object', unsupportedKeyword: true });
      expect(badSchema.code).toBe(1); expect(badSchema.messages.some(message => message.type === 'result')).toBe(false);
      expect(badSchema.messages.find(message => message.type === 'failure')?.message).toContain('Invalid or unsupported submit_result schema');
      expect(requests).toHaveLength(2); // No model dispatch at all for an unsupported schema.
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      await rm(root, { recursive: true, force: true });
    }
  }, 45000);
});
