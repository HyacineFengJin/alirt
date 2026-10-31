import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset } from '../shared/types';
import { createApp } from './app';
import { textCarriersService } from './text-carriers';
import type { ModelProvider } from './engine';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

it('serves metadata-only GET targets without dispatch and preserves the private author ledger when the controller is removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rp-carrier-api-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.opening = ''; card.world.location = 'Hall';
  let calls = 0;
  const provider: ModelProvider = { configured: () => true, async run() { calls++; throw new Error('Metadata must never call a model'); } };
  async function start(installed: boolean) {
    const app = await createApp({ dataRoot: root, provider, catalog: async () => ({ cards: [card], presets: [preset] }), sessionServices: installed ? [textCarriersService] : [] });
    const server: Server = await new Promise(resolve => { const listener = app.app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const close = async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await app.close(); };
    let closed = false; const once = async () => { if (!closed) { closed = true; await close(); } }; cleanup.push(once);
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected loopback server');
    return { ...app, close: once, base: `http://127.0.0.1:${address.port}/api/sessions` };
  }
  const first = await start(true), id = first.store.create(card, preset).id, url = `${first.base}/${id}`, servicePath = '/services/rp.text-carrier-control';
  const send = (base: string, body: unknown) => fetch(base + servicePath + '/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(await (await fetch(url + '/text-carrier-targets')).json()).toEqual({ revision: 0, targets: [] });
  const command = { requestId: 'author-create', expectedRevision: 0, reason: 'Author explicitly registers this paper.', operation: 'create',
    content: { medium: 'paper', title: 'Notice', text: 'AUTHOR_LITERAL_BODY_CANARY', location: 'Hall', available: true } };
  const response = await send(url, command); expect(response.status).toBe(200); const created = await response.json();
  const bytes = await readFile(join(root, `session-${id}.json`), 'utf8');
  const targets = await (await fetch(url + '/text-carrier-targets')).json();
  expect(targets).toEqual({ revision: 1, targets: [{ carrierId: created.carrierId, version: 1, medium: 'paper', title: 'Notice', location: 'Hall' }] });
  expect(JSON.stringify(targets)).not.toContain('AUTHOR_LITERAL_BODY_CANARY');
  expect((await send(url, command)).status).toBe(200);
  expect((await send(url, { ...command, reason: 'Different same request.' })).status).toBe(409);
  expect((await send(url, { ...command, requestId: 'stale' })).status).toBe(409);
  const authorView = await (await fetch(url + servicePath)).json(); expect(authorView.carriers[0].versions[0].text).toBe('AUTHOR_LITERAL_BODY_CANARY');
  const ordinary = await (await fetch(url)).json(); expect(ordinary.textCarriers).toBeUndefined();
  const player = await (await fetch(url + `?perspective=${first.store.get(id).playerRoleId}`)).json();
  expect(JSON.stringify(player)).not.toContain('AUTHOR_LITERAL_BODY_CANARY');
  expect(await readFile(join(root, `session-${id}.json`), 'utf8')).toBe(bytes); expect(calls).toBe(0);
  await first.close();
  const removed = await start(false), removedUrl = `${removed.base}/${id}`;
  expect((await fetch(removedUrl + servicePath)).status).toBe(404); expect((await send(removedUrl, command)).status).toBe(404);
  expect((await fetch(removedUrl)).status).toBe(200);
  expect(await (await fetch(removedUrl + '/text-carrier-targets')).json()).toEqual(targets);
  expect(await readFile(join(root, `session-${id}.json`), 'utf8')).toBe(bytes); expect(calls).toBe(0);
});
