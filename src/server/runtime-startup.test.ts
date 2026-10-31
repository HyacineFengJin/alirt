import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset } from '../shared/types';
import { acquireServerLock } from './server-lock';
import { DeepSeekProvider } from './provider';
import { createApp } from './app';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function root() { const root = await mkdtemp(join(tmpdir(), 'alirt-startup-')); cleanup.push(() => rm(root, { recursive: true, force: true })); return root; }
it('owns a data directory without any DSH addon and refuses a live duplicate owner', async () => {
  const path = await root(), release = await acquireServerLock(path); cleanup.push(release);
  await expect(acquireServerLock(path)).rejects.toThrow('Another server');
  await release(); const second = await acquireServerLock(path); await second();
  await writeFile(join(path, 'server.lock'), JSON.stringify({ pid: 2147483647, token: 'dead' }));
  const recovered = await acquireServerLock(path); expect(JSON.parse(await readFile(join(path, 'server.lock'), 'utf8')).pid).toBe(process.pid); await recovered();
});
it('keeps configuration and local stories readable with no runtime, but generation fails explicitly before creating native files', async () => {
  const path = await root(), provider = new DeepSeekProvider(path, { apiKey: 'offline-unused-credential', runtime: join(path, 'absent-runtime') });
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  const service = await createApp({ dataRoot: path, provider, catalog: async () => ({ cards: [card], presets: [preset] }) }); cleanup.push(service.close);
  const server: Server = await new Promise(resolve => { const listener = service.app.listen(0, '127.0.0.1', () => resolve(listener)); });
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected local listener');
  const base = `http://127.0.0.1:${address.port}/api`, id = service.store.create(card, preset).id;
  const status = await (await fetch(base + '/status')).json(); expect(status).toMatchObject({ configured: true, runtimeReady: false }); expect(status.runtimeMessage).toContain('setup-dsh.mjs');
  expect((await fetch(base + `/sessions/${id}`)).status).toBe(200); expect((await fetch(base + '/catalog')).status).toBe(200);
  await expect(provider.run({ sessionId: 'synthetic-world', kind: 'world', system: 'Fixture only', input: {}, resultSchema: { type: 'object' }, tools: [], signal: new AbortController().signal }))
    .rejects.toMatchObject({ status: 503, code: 'DSH_RUNTIME_UNAVAILABLE' });
});
