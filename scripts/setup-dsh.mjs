#!/usr/bin/env node
// Fetch only public upstream source. Generated sources, packages and licenses
// stay in the ignored local runtime directory, never in application documents.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, realpathSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const UPSTREAM = 'https://github.com/deepseek-ai/deepseek-harness.git';
const SHA = 'd743267388641bc76f17c45ce8b4c231aed1d32c';
const VERSION = '0.2.1-alpha.2';
const PNPM = '11.28.5';
const { values } = parseArgs({ options: { source: { type: 'string' }, runtime: { type: 'string' }, plan: { type: 'boolean' }, help: { type: 'boolean' } } });
const source = resolve(values.source ?? '.rp-runtime/upstream'), runtime = resolve(values.runtime ?? '.rp-runtime/dsh');
if (values.help) {
  console.log('Usage: node scripts/setup-dsh.mjs [--source PATH] [--runtime PATH] [--plan]\nRequires Node.js 24+, git and the upstream native build toolchain. Builds the pinned public DSH source; no model calls.');
  process.exit(0);
}
if (values.plan) {
  console.log(JSON.stringify({ upstream: UPSTREAM, sourceSha: SHA, sourceVersion: VERSION, packageManager: `pnpm@${PNPM}`, source, runtime,
    steps: ['fetch pinned public source', 'install --frozen-lockfile', 'run build:native-system', 'run build:lib:host', 'link built workspace packages', 'retain LICENSE and THIRD_PARTY_NOTICES.md', 'validate module entry points and write build-manifest.json'] }, null, 2));
  process.exit(0);
}
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node.js 24 or newer to build the pinned DSH runtime');
if (source === runtime) throw new Error('Source and runtime directories must differ');
function run(command, args, cwd = process.cwd(), capture = false) {
  const result = spawnSync(command, args, { cwd, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.signal})`);
  return capture ? result.stdout.trim() : undefined;
}
mkdirSync(dirname(source), { recursive: true });
const reusedSource = existsSync(source);
if (!reusedSource) run('git', ['clone', '--filter=blob:none', '--no-checkout', UPSTREAM, source]);
if (!existsSync(join(source, '.git')) || run('git', ['remote', 'get-url', 'origin'], source, true) !== UPSTREAM)
  throw new Error('Source must be a dedicated checkout of the official upstream; existing directories are not overwritten');
if (reusedSource && run('git', ['status', '--porcelain'], source, true)) throw new Error('The upstream checkout has changes; use a clean dedicated source directory');
run('git', ['fetch', '--depth=1', 'origin', SHA], source);
run('git', ['checkout', '--detach', SHA], source);
if (run('git', ['rev-parse', 'HEAD'], source, true) !== SHA) throw new Error('Upstream commit verification failed');
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
if (manifest.version !== VERSION || manifest.packageManager !== `pnpm@${PNPM}`) throw new Error('Pinned upstream metadata changed');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
for (const args of [['install', '--frozen-lockfile'], ['run', 'build:native-system'], ['run', 'build:lib:host']])
  run(npx, ['--yes', `pnpm@${PNPM}`, ...args], source);
mkdirSync(join(runtime, 'node_modules'), { recursive: true });
function directories(path) { return existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(path, entry.name)) : []; }
const packages = [...directories(join(source, 'vendor')), ...directories(join(source, 'apps')), join(source, 'native/system'),
  ...directories(join(source, 'native/system/packages')), ...directories(join(source, 'packages')).flatMap(directories)];
for (const path of packages) {
  if (!existsSync(join(path, 'package.json'))) continue;
  const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
  if (typeof pkg.name !== 'string' || !/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/i.test(pkg.name)) continue;
  const target = join(runtime, 'node_modules', pkg.name); mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) { if (realpathSync(target) !== realpathSync(path)) throw new Error(`Runtime package already exists: ${pkg.name}`); }
  else symlinkSync(path, target, process.platform === 'win32' ? 'junction' : 'dir');
}
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) copyFileSync(join(source, name), join(runtime, name));
const require = createRequire(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'));
for (const name of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/node-addon-system/flock']) require.resolve(name);
if (!existsSync(join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))) throw new Error('The upstream CLI was not built');
writeFileSync(join(runtime, 'build-manifest.json'), JSON.stringify({ sourceSha: SHA, sourceVersion: VERSION, upstream: UPSTREAM, platform: process.platform, arch: process.arch }, null, 2) + '\n');
console.log(`DSH runtime ready. RP_DSH_RUNTIME=${runtime}`);
