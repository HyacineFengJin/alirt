import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CharacterCard, Preset } from '../shared/types';
import cardJson from '../../content/cards/harbor.json';
import presetJson from '../../content/presets/basic.json';
import { createApp } from './app';
import type { AgentRequest, ModelProvider } from './engine';

const card = cardJson as CharacterCard, preset = presetJson as Preset;
const roots: string[] = [], closeups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closeups.splice(0)) await close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function server(root?: string) {
  root ??= await mkdtemp(join(tmpdir(), 'rp-creator-integration-'));
  if (!roots.includes(root)) roots.push(root);
  const calls: AgentRequest[] = [];
  const provider: ModelProvider = { configured: () => true, run: async request => {
    calls.push(request);
    if (request.kind === 'creator') {
      const current = await request.tools.find(t => t.name === 'read_draft')!.execute({});
      await request.tools.find(t => t.name === 'apply_patch')!.execute({ key: 'title-' + current.revision, expectedRevision: current.revision,
        operations: [{ op: 'replace', path: '/title', value: '创作工坊发布的预设' }], summary: '只改标题，原提示保留' });
      return { message: '已保存标题，其他内容保持。' };
    }
    if (request.kind === 'role') return { summary: '停在当前场景。', expression: '', proposals: [] };
    if (request.kind === 'world') return { summary: '仍在栈桥。', changes: [], events: [] };
    return { title: '栈桥', text: '潮声沿栈桥传来。', person: 'third', pov: 'limited' };
  } };
  const service = await createApp({ dataRoot: root, provider, catalog: async () => ({ cards: [card], presets: [preset] }) });
  const listener = service.app.listen(0, '127.0.0.1');
  await new Promise<void>(done => listener.once('listening', done));
  const base = `http://127.0.0.1:${(listener.address() as any).port}/api`;
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await service.close(); await new Promise<void>(done => listener.close(() => done())); };
  closeups.push(close);
  async function api(path: string, body?: unknown) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  return { root, service, calls, api, close };
}

describe('creator publication and story integration', () => {
  it('resumes a separate creator conversation, publishes to catalog and retains existing story snapshots across restart', async () => {
    const first = await server();
    const original = (await first.api('/sessions', { cardId: card.id, presetId: preset.id })).body;
    const draft = (await first.api('/creator/sessions', { kind: 'preset', sourceId: preset.id })).body;
    expect(draft.document.modules).toEqual(preset.modules);
    const submitted = await first.api(`/creator/sessions/${draft.id}/runs`, { requestId: 'creator-first', expectedRevision: 0, instruction: '只改标题' });
    expect(submitted.status).toBe(202); await first.service.creator.engine.idle(draft.id);
    const edited = (await first.api(`/creator/sessions/${draft.id}`)).body;
    expect(edited.revision).toBe(1); expect(edited.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(edited.document.modules).toEqual(preset.modules);
    expect(first.calls.map(c => c.kind)).toEqual(['creator']);
    const published = await first.api(`/creator/sessions/${draft.id}/publish`, { expectedRevision: 1 });
    expect(published.status).toBe(201);
    const catalog = (await first.api('/catalog')).body;
    expect(catalog.presets.some((p: Preset) => p.id === published.body.id && p.title === '创作工坊发布的预设')).toBe(true);
    const newStory = await first.api('/sessions', { cardId: card.id, presetId: published.body.id });
    expect(newStory.status).toBe(201); expect(first.service.store.get(original.id).preset).toEqual(preset);
    await first.close();
    const recovered = await server(first.root);
    expect((await recovered.api(`/creator/sessions/${draft.id}`)).body.messages).toEqual(edited.messages);
    expect((await recovered.api('/catalog')).body.presets.some((p: Preset) => p.id === published.body.id)).toBe(true);
    expect(recovered.calls).toHaveLength(0);
    const fork = await recovered.api('/creator/sessions', { kind: 'preset', sourceId: published.body.id });
    expect(fork.status).toBe(201); expect(fork.body.document.title).toBe('创作工坊发布的预设');
  });

  it('retains invalid manual drafts for repair and exposes bounded publication diagnostics through the HTTP boundary', async () => {
    const { api } = await server();
    const draft = (await api('/creator/sessions', { kind: 'card', sourceId: card.id })).body;
    const document = structuredClone(draft.document); document.playerRoleId = 'missing-player';
    const saved = await api(`/creator/sessions/${draft.id}/draft`, { expectedRevision: 0, document, summary: '测试待修正引用' });
    expect(saved.status).toBe(200); expect(saved.body.issues.length).toBeGreaterThan(0);
    const publication = await api(`/creator/sessions/${draft.id}/publish`, { expectedRevision: 1 });
    expect(publication.status).toBe(422); expect(publication.body.error.issues).toContainEqual(expect.objectContaining({ path: '/playerRoleId' }));
    const restored = await api(`/creator/sessions/${draft.id}/restore`, { expectedRevision: 1, revision: 0 });
    expect(restored.status).toBe(200); expect(restored.body.revision).toBe(2); expect(restored.body.document).toEqual(draft.document);
    expect(restored.body.issues).toEqual([]);
  });
});
