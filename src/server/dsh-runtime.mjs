// Resolve the pinned runtime explicitly; imported documents cannot choose code.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { guardJsonlProvider } from './transcript-guard.mjs';

const root = process.env.RP_DSH_RUNTIME;
if (!root || !isAbsolute(root)) throw new Error('RP_DSH_RUNTIME must identify the built DSH distribution');
export const manifest = JSON.parse(await readFile(join(root, 'build-manifest.json'), 'utf8'));
if (manifest.sourceSha !== 'd743267388641bc76f17c45ce8b4c231aed1d32c'
  || manifest.sourceVersion !== '0.2.1-alpha.2') throw new Error('Unexpected pinned DSH runtime version');
const require = createRequire(join(root, 'node_modules/@deepseek-ai/dsh/package.json'));
export const load = name => import(pathToFileURL(require.resolve(name)).href);
export const [llm, sessions] = await Promise.all(['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session'].map(load));

export async function* mountKernel(ctx, sessionRoot, { useDshDefaults = false } = {}) {
  // Yield original disposers into ONE composite: ordinary fiber teardown is parallel.
  const entries = [
    ['@deepseek-ai/dsh-llm', {}],
    ['@deepseek-ai/dsh-deepseek-llm-api-extensions', {}],
    ['@deepseek-ai/dsh-session', {}],
    ['@deepseek-ai/dsh-session-projection', {}],
    ['@deepseek-ai/dsh-system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false }],
    ['@deepseek-ai/dsh-fs-local', {}],
    ['@deepseek-ai/dsh-working-directory', {}],
    ['@deepseek-ai/dsh-tools', { mode: 'native' }],
    ['@deepseek-ai/dsh-agent', {}],
    ['@deepseek-ai/dsh-session-persistence-jsonl', { root: sessionRoot, compression: 'none' }],
    ['@deepseek-ai/dsh-agent-loop', useDshDefaults ? { agents: [] } : { agents: [], maxParallelToolCalls: 1 }],
    ['@deepseek-ai/dsh-session-checkpoint-policy', {}],
  ];
  for (const [name, config] of entries) {
    const module = await load(name);
    const provider = module.default ?? module;
    const child = ctx.plugin(name === '@deepseek-ai/dsh-session-persistence-jsonl' ? guardJsonlProvider(provider) : provider, config);
    yield child.dispose;
    await child.await();
  }
  return entries.map(([name]) => name);
}
