// Offline integration fixture only. Never mounted by the production profile.
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { llm, mountKernel } from './dsh-runtime.mjs';
import { own } from './worker.mjs';
export const name = 'rp-alpha-offline-worker-test';
export const inject = ['appReady', 'appExit'];
export async function apply(ctx, config) {
  if (process.env.RP_ALPHA_TEST_ONLY !== '1') throw new Error('Offline test fixture requires explicit test environment');
  class OfflineAdapter extends llm.LlmAdapter {
    async *stream(options) {
      if (config.diagnosticFailure) {
        const socket = Object.assign(new Error('Offline socket closed'), { code: 'ECONNRESET', statusCode: 503, headers: { Authorization: 'PRIVATE_FIXTURE_HEADER' } });
        const cause = Object.assign(new TypeError('Offline fetch failed: offline-test-placeholder', { cause: socket }), { request: { body: 'PRIVATE_FIXTURE_BODY' } });
        // Non-retryable fixture classification avoids spending time on native
        // retry backoff; production retry policy is never changed by this test.
        throw new llm.LlmError('Controlled offline diagnostic failure', 'INVALID_REQUEST', { cause });
      }
      if (config.block) {
        process.send?.({ type: 'probe-started' });
        await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
        throw new Error('Offline probe cancelled');
      }
      const block = { type: 'tool-call', id: llm.ToolCallId('offline-' + randomUUID()), name: 'submit_result', arguments: JSON.stringify({ probe: true }) };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    }
  }
  await ctx.effect(async function* () {
    yield* mountKernel(ctx, join(config.root, 'transcripts'), { useDshDefaults: true });
    const adapter = ctx.plugin({ name: 'rp-alpha-offline-adapter', inject: ['llm'], apply(c) { c.llm.registerAdapter(['deepseek-official'], new OfflineAdapter()); } });
    yield adapter.dispose; await adapter.await();
    const owner = ctx.plugin({ name: 'rp-alpha-offline-owner', inject: ['appReady', 'appExit', 'llm', 'sessions', 'sessionPersistence', 'agents', 'agentLoop', 'tools', 'systemPrompt', 'workingDirectory', 'deepseekLlmApiExtensions'], apply: own }, config);
    yield owner.dispose; await owner.await();
  }, 'rp-alpha-offline-test');
}
