import { readdir, readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Catalog, CharacterCard, Preset } from '../shared/types';
import { createImportService } from '../importer/index';
import { createApp } from './app';
import { acquireServerLock } from './server-lock';
import { storyProgressControlService } from './story-progress-control';
import { parallelScenesService } from './parallel-scenes';
import { textCarriersService } from './text-carriers';

const root = resolve(process.env.RP_DATA_ROOT ?? process.env.RP_ALPHA_DATA ?? '.rp-data');
await mkdir(root, { recursive: true, mode: 0o700 });
const releaseLock = await acquireServerLock(root);
const imports = await createImportService({});
async function readCatalog<T>(directory: string): Promise<T[]> {
  const names = await readdir(directory);
  return Promise.all(names.filter(n => n.endsWith('.json')).sort().map(async name => JSON.parse(await readFile(join(directory, name), 'utf8')) as T));
}
const catalog = async (): Promise<Catalog> => {
  const [cards, presets, imported] = await Promise.all([readCatalog<CharacterCard>(resolve('content/cards')), readCatalog<Preset>(resolve('content/presets')), imports.catalog()]);
  return { cards: [...cards, ...imported.cards], presets: [...presets, ...imported.presets] };
};
const server = await createApp({ dataRoot: root, importService: imports, catalog, visualAssets: process.env.RP_DISABLE_VISUAL_ASSETS !== '1',
  sessionServices: [...(process.env.RP_DISABLE_STORY_PROGRESS_CONTROL === '1' ? [] : [storyProgressControlService]),
    ...(process.env.RP_DISABLE_PARALLEL_SCENES_CONTROL === '1' ? [] : [parallelScenesService]),
    ...(process.env.RP_DISABLE_TEXT_CARRIERS_CONTROL === '1' ? [] : [textCarriersService])] });
const port = Number(process.env.PORT ?? process.env.RP_ALPHA_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const listener = server.app.listen(port, '127.0.0.1', () => { console.log(`Alirt listening at http://127.0.0.1:${port}`); });
let closing = false;
async function close() {
  if (closing) return; closing = true;
  listener.close(); await server.close(); await releaseLock(); process.exit(0);
}
process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
listener.on('error', async error => { await releaseLock(); console.error(error.message); process.exit(1); });
