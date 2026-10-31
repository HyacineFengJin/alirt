import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, Preset } from '../shared/types';
import { TurnEngine, type AgentRequest, type ModelProvider } from './engine';
import { clone, SessionStore } from './store';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
class Writer implements ModelProvider {
  calls: AgentRequest[] = [];
  failures = 0;
  text = 'Current permitted continuation.';
  configured() { return true; }
  async run(request: AgentRequest): Promise<any> {
    this.calls.push(request);
    if (request.kind !== 'prose') throw new Error('Author recovery must call only the prose writer');
    if (this.failures-- > 0) throw new Error('Controlled writer failure after the new binding was saved');
    return { title: 'Continuation', text: this.text, person: 'third', pov: 'limited' };
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rp-prose-continuation-boundary-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  card.fields = [{ key: 'public-detail', label: 'Public detail', type: 'string', audience: 'public', editable: true }];
  card.world.variables['public-detail'] = 'Earlier public context';
  const store = new SessionStore(root), id = store.create(card, preset).id, writer = new Writer(), engine = new TurnEngine(store, writer);
  cleanups.push(() => engine.close());
  let sequence = 0;
  const turn = async (selectedEngine = engine, selectedStore = store) => {
    selectedEngine.submit(id, { requestId: `continuation-${++sequence}`, expectedRevision: selectedStore.get(id).revision, mode: 'author', action: 'Rewrite only the currently permitted scene.' });
    await selectedEngine.idle(id);
  };
  return { root, store, id, writer, engine, turn };
}
const material = (writer: Writer) => writer.calls.at(-1)!.input as any;

describe('durable prose continuation admission boundary', () => {
  it.each(['public-contract', 'authorized-context'] as const)('keeps pre-boundary text withheld through writer failure, retry and restart after %s changes', async kind => {
    const f = await fixture(); f.writer.text = 'ARCHIVED_PRE_BOUNDARY_PRIVATE_DETAIL'; await f.turn();
    const before = clone(f.store.get(f.id)), oldProse = clone(before.prose.at(-1)!), oldBinding = clone(before.promptContexts!.prose);
    const changed = clone(before);
    if (kind === 'public-contract') changed.promptContexts!.prose.fingerprint = 'pre-public-reference-contract';
    else {
      changed.fields.find(field => field.key === 'public-detail')!.audience = 'author';
      changed.card.fields.find(field => field.key === 'public-detail')!.audience = 'author';
    }
    f.store.save(changed); f.writer.failures = 2;
    await f.turn();
    expect(f.store.get(f.id).turns.at(-1)?.status).toBe('failed');
    const newBinding = clone(f.store.get(f.id).promptContexts!.prose);
    expect(newBinding.sessionId).not.toBe(oldBinding.sessionId); expect(material(f.writer).previousProse).toBe('');
    expect(material(f.writer).narrationBrief.previousProse).toBeNull();
    await f.turn();
    expect(f.store.get(f.id).promptContexts!.prose).toEqual(newBinding);
    expect(material(f.writer).previousProse).toBe('');
    expect(JSON.stringify(f.writer.calls.at(-1)!.input)).not.toContain(oldProse.text);
    expect(material(f.writer).narrationBrief.previousProse).toBeNull();
    expect(f.store.get(f.id).prose).toEqual(before.prose);
    expect(f.store.get(f.id).events.slice(0, before.events.length)).toEqual(before.events);
    await f.engine.close();
    const restartedStore = new SessionStore(f.root), restartedWriter = new Writer(), restarted = new TurnEngine(restartedStore, restartedWriter);
    cleanups.push(() => restarted.close());
    await f.turn(restarted, restartedStore);
    expect(restartedStore.get(f.id).turns.at(-1)?.status).toBe('completed');
    expect(restartedWriter.calls[0].sessionId).toBe(newBinding.sessionId);
    expect(material(restartedWriter).previousProse).toBe(''); expect(material(restartedWriter).narrationBrief.previousProse).toBeNull();
    expect(restartedStore.get(f.id).prose.find(entry => entry.id === oldProse.id)).toEqual(oldProse);
    const permitted = clone(restartedStore.get(f.id).prose.at(-1)!);
    await f.turn(restarted, restartedStore);
    expect(material(restartedWriter).previousProse).toBe(permitted.text);
    expect(material(restartedWriter).narrationBrief.previousProse.entryId).toBe(permitted.id);
    expect(restartedWriter.calls.at(-1)!.sessionId).toBe(newBinding.sessionId);
    expect(restartedStore.get(f.id).revision).toBe(before.revision);
  });

  it('preserves ordinary same-contract continuation across restart using existing completion history', async () => {
    const f = await fixture(); f.writer.text = 'Safe ordinary scene continuity.'; await f.turn();
    const first = clone(f.store.get(f.id).prose.at(-1)!), binding = clone(f.store.get(f.id).promptContexts!.prose);
    await f.turn(); expect(material(f.writer).previousProse).toBe(first.text);
    await f.engine.close();
    const store = new SessionStore(f.root), writer = new Writer(), engine = new TurnEngine(store, writer); cleanups.push(() => engine.close());
    const previous = clone(store.get(f.id).prose.at(-1)!); await f.turn(engine, store);
    expect(writer.calls[0].sessionId).toBe(binding.sessionId); expect(material(writer).previousProse).toBe(previous.text);
    expect(material(writer).narrationBrief.previousProse.entryId).toBe(previous.id);
  });
});
