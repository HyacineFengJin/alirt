import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AgentRequest, ModelProvider } from './engine';
import { ApiError, clone } from './store';
import { CreatorEngine, CreatorStore, createCreatorService } from './creator';
import { patchCreatorDocument, assertCreatorDocument } from './creator-patch';
import { createNativeTemplate, validateNativeDocument } from '../shared/native';
import type { NativeDocument } from '../shared/creator';
import type { Preset } from '../shared/types';

const roots: string[] = [], cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rp-creator-test-')); roots.push(root);
  const store = new CreatorStore(root), session = store.create({ kind: 'preset' }, createNativeTemplate('preset'));
  return { root, store, session };
}
const runInput = (expectedRevision = 0, requestId = 'creator-request') => ({ requestId, expectedRevision, instruction: '修改当前草稿，并保留其他文字。' });
function tool(request: AgentRequest, name: string) { return request.tools.find(item => item.name === name)!.execute; }
/** Offline test provider only; production uses the shared native provider. */
class CreatorTestProvider implements ModelProvider {
  requests: AgentRequest[] = [];
  handler: (request: AgentRequest) => Promise<any> = async () => ({ message: '已检查当前草稿。' });
  configured() { return true; }
  async run(request: AgentRequest) { this.requests.push(request); return this.handler(request); }
}

describe('persistent creator harness', () => {
  it('edits one draft over multiple runs with the same native session, tools and complete revision history', async () => {
    const { root, store, session } = await fixture(), provider = new CreatorTestProvider(), engine = new CreatorEngine(store, provider);
    const original = clone(session.document);
    provider.handler = async request => {
      const draft = await tool(request, 'read_draft')({});
      const operations = draft.revision === 0 ? [{ op: 'replace', path: '/title', value: '新的预设标题' }, { op: 'replace', path: '/description', value: '首版说明' }]
        : [{ op: 'add', path: '/unknown/source~1field', value: 'will-not-apply' }];
      if (draft.revision === 0) await tool(request, 'apply_patch')({ key: 'title-and-description', expectedRevision: draft.revision, operations, summary: '修改标题与说明' });
      else await tool(request, 'apply_patch')({ key: 'preserved-extra', expectedRevision: draft.revision, operations: [{ op: 'add', path: '/unknown', value: { 'source/field': '原文保持', enabled: false } }], summary: '保留未知来源字段' });
      await tool(request, 'validate_draft')({}); return { message: '已保存工具实际修改。' };
    };
    engine.submit(session.id, runInput()); await engine.idle(session.id);
    engine.submit(session.id, runInput(1, 'second-run')); await engine.idle(session.id);
    const current = store.read(session.id);
    expect(current.revision).toBe(2); expect(current.revisions.map(r => r.origin)).toEqual(['seed', 'agent', 'agent']);
    expect(current.revisions[0].document).toEqual(original);
    expect((current.document as any).unknown).toEqual({ 'source/field': '原文保持', enabled: false });
    expect(current.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(provider.requests.map(r => r.sessionId)).toEqual(['creator-' + session.id, 'creator-' + session.id]);
    expect(provider.requests.every(r => r.tools.map(t => t.name).join(',') === 'describe_format,read_draft,validate_draft,apply_patch')).toBe(true);
    expect(Object.keys(provider.requests[0].input as object).at(-1)).toBe('instruction');
    expect(new CreatorStore(root).read(session.id).document).toEqual(current.document);
  });
  it('provides a stable read-only format guide for the current kind, with valid examples and no draft/session leaks', async () => {
    const { store, session } = await fixture(), provider = new CreatorTestProvider(), engine = new CreatorEngine(store, provider);
    const card = store.create({ kind: 'card' }, createNativeTemplate('card'));
    const secretDraft = clone(store.get(session.id)); (secretDraft.document as any).privateMarker = 'OTHER_DRAFT_PRIVATE_MARKER'; store.save(secretDraft);
    provider.handler = async request => {
      const before = store.read(request.sessionId.replace('creator-', ''));
      const describe = tool(request, 'describe_format'), guide = await describe({});
      expect(guide.kind).toBe(before.kind); expect(guide.schema).toBe(before.kind === 'card' ? 'rp.card/0.1' : 'rp.preset/0.1');
      expect(guide.modules.stageAlignment).toEqual([{ target: 'role', phase: 'decide', purpose: 'Character decisions and behavior' }, { target: 'world', phase: 'coordinate', purpose: 'World adjudication and state constraints' }, { target: 'prose', phase: 'compose', purpose: 'Narration, style and disclosure constraints' }]);
      expect(JSON.stringify(guide)).not.toContain('OTHER_DRAFT_PRIVATE_MARKER'); expect(JSON.stringify(guide)).not.toContain(session.id); expect(JSON.stringify(guide)).not.toContain(card.id);
      if (before.kind === 'preset') {
        expect(guide.card).toBeUndefined(); expect(validateNativeDocument('preset', guide.preset.minimalExample)).toEqual([]);
      } else {
        expect(guide.preset).toBeUndefined(); expect(guide.card.roles.phases).toContain('retired');
        const sample = createNativeTemplate('card') as any;
        sample.roles = guide.card.roles.examples; sample.playerRoleId = 'player'; sample.fields = [guide.card.fields.example]; sample.panels = [guide.card.panels.example]; sample.modules = [guide.modules.example];
        expect(validateNativeDocument('card', sample)).toEqual([]);
      }
      guide.modules.example.content = 'Attempt to mutate returned guide';
      expect((await describe({})).modules.example.content).not.toBe('Attempt to mutate returned guide');
      expect(store.read(before.id).document).toEqual(before.document); expect(store.read(before.id).revision).toBe(before.revision);
      expect(store.read(before.id).runs.at(-1)?.phase).toBe('describe_format');
      return { message: '已读取格式说明，未修改草稿。' };
    };
    engine.submit(session.id, runInput()); await engine.idle(session.id);
    engine.submit(card.id, runInput()); await engine.idle(card.id);
    expect(store.read(session.id).runs[0].status).toBe('completed'); expect(store.read(card.id).runs[0].status).toBe('completed');
  });
  it('deduplicates patch effect keys across retries, canonicalizes object key order, and rejects conflicts/CAS', async () => {
    const { root, store, session } = await fixture(), provider = new CreatorTestProvider(), engine = new CreatorEngine(store, provider);
    let args: any;
    provider.handler = async request => {
      args = { key: 'logical-edit', expectedRevision: 0, operations: [{ op: 'add', path: '/unknown', value: { a: 1, b: 2 } }], summary: '添加来源数据' };
      const patch = tool(request, 'apply_patch'), first = await patch(args);
      expect(first.revision).toBe(1);
      expect((await patch({ summary: args.summary, operations: [{ path: '/unknown', value: { b: 2, a: 1 }, op: 'add' }], expectedRevision: 0, key: args.key })).duplicate).toBe(true);
      expect(() => patch({ ...args, summary: '不同效果' })).toThrow('different patch');
      expect(() => patch({ ...args, key: 'stale-revision' })).toThrow('draft changed');
      return { message: '已保存一次逻辑修改。' };
    };
    const submitted = engine.submit(session.id, runInput()); await engine.idle(session.id);
    expect(engine.submit(session.id, runInput()).duplicate).toBe(true);
    expect(() => engine.submit(session.id, { ...runInput(), instruction: '不同请求' })).toThrow('different instruction');
    expect(store.read(session.id).revision).toBe(1);
    const recovered = new CreatorStore(root);
    expect(recovered.patch(session.id, submitted.runId, args).duplicate).toBe(true);
    expect(recovered.read(session.id).revision).toBe(1);
  });
  it('keeps successful tool mutations if a later generation fails and rejects stale tool handles', async () => {
    const { store, session } = await fixture(), provider = new CreatorTestProvider(), engine = new CreatorEngine(store, provider);
    let staleTool!: (args: any) => any;
    provider.handler = async request => {
      staleTool = tool(request, 'apply_patch');
      await staleTool({ key: 'saved-before-failure', expectedRevision: 0, operations: [{ op: 'replace', path: '/title', value: '已保存的标题' }], summary: '已保存' });
      throw new Error('Controlled offline failure after save');
    };
    engine.submit(session.id, runInput()); await engine.idle(session.id);
    expect(store.read(session.id).runs[0].status).toBe('failed'); expect(store.read(session.id).revision).toBe(1);
    expect(store.read(session.id).document.title).toBe('已保存的标题'); expect(store.read(session.id).messages).toHaveLength(1);
    expect(() => staleTool({})).toThrow('cancelled');
  });
  it('allows schema-invalid JSON drafts for multi-step repair, then validates publication and preserves unknown text', async () => {
    const { store, session } = await fixture(), invalid = clone(session.document) as any;
    invalid.title = 123; invalid.unknown = { content: 'UNTOUCHED_SOURCE_TEXT' };
    store.replace(session.id, { expectedRevision: 0, document: invalid, summary: '暂存待修复草稿' });
    expect(store.read(session.id).issues.length).toBeGreaterThan(0);
    expect(() => store.publish(session.id, { expectedRevision: 1 })).toThrow('validation issue');
    expect(store.read(session.id).published).toHaveLength(0);
    const provider = new CreatorTestProvider(), engine = new CreatorEngine(store, provider);
    provider.handler = async request => {
      await tool(request, 'apply_patch')({ key: 'repair-title', expectedRevision: 1, operations: [{ op: 'replace', path: '/title', value: '修复后的标题' }], summary: '修复标题类型' }); return { message: '已修复。' };
    };
    engine.submit(session.id, runInput(1)); await engine.idle(session.id);
    expect(store.read(session.id).issues).toEqual([]);
    const published = store.publish(session.id, { expectedRevision: 2 });
    expect(store.publish(session.id, { expectedRevision: 2 })).toEqual(published);
    expect(store.catalog().presets[0].id).toBe(published.id); expect(published.id).not.toBe(session.document.id);
    expect((store.catalog().presets[0] as any).unknown.content).toBe('UNTOUCHED_SOURCE_TEXT');
    expect(store.read(session.id).document.id).toBe(session.document.id);
  });
  it('restores as a new revision, publishes immutable copies, and restores the catalog after restart', async () => {
    const { root, store, session } = await fixture();
    const first = store.publish(session.id, { expectedRevision: 0 });
    const replacement = clone(session.document); replacement.title = '第二版本';
    store.replace(session.id, { expectedRevision: 0, document: replacement, summary: '修改标题' });
    const second = store.publish(session.id, { expectedRevision: 1 });
    expect(first.id).not.toBe(second.id); expect(store.catalog().presets[0].title).toBe(session.document.title);
    const restored = store.restore(session.id, { expectedRevision: 1, revision: 0 });
    expect(restored.revision).toBe(2); expect(restored.revisions.at(-1)?.origin).toBe('restore'); expect(restored.document).toEqual(session.document);
    expect(new CreatorStore(root).catalog()).toEqual(store.catalog());
  });
  it('marks unfinished runs interrupted on restart without replay and keeps saved draft revisions', async () => {
    const { root, store, session } = await fixture(), saved = clone(store.get(session.id));
    saved.runs.push({ id: 'unfinished', requestId: 'old', instruction: '旧请求', status: 'running', phase: 'editing', startedAt: '' }); store.save(saved);
    const recovered = new CreatorStore(root), provider = new CreatorTestProvider(); new CreatorEngine(recovered, provider);
    expect(recovered.read(session.id).runs[0].status).toBe('interrupted'); expect(provider.requests).toHaveLength(0);
    expect(recovered.read(session.id).revisions).toEqual(session.revisions);
  });
  it('refuses unconfigured generation before saving a run or producing an assistant message', async () => {
    const { store, session } = await fixture();
    const engine = new CreatorEngine(store, { configured: () => false, run: async () => { throw new Error('Must never generate'); } });
    expect(() => engine.submit(session.id, runInput())).toThrow('Configure a model provider');
    expect(store.read(session.id).runs).toEqual([]); expect(store.read(session.id).messages).toEqual([]); expect(store.read(session.id).revision).toBe(0);
  });
  it('cancels active work, blocks concurrent edits, and leaves completed patch revisions intact', async () => {
    const { store, session } = await fixture(), provider = new CreatorTestProvider(), engine = new CreatorEngine(store, provider);
    let began!: () => void; const ready = new Promise<void>(done => { began = done; });
    provider.handler = async request => {
      await tool(request, 'apply_patch')({ key: 'before-cancel', expectedRevision: 0, operations: [{ op: 'replace', path: '/title', value: '取消前已保存' }], summary: '先保存' });
      began(); return new Promise((_done, reject) => request.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    };
    engine.submit(session.id, runInput()); await ready;
    expect(() => engine.assertIdle(session.id)).toThrow('Wait for the creator');
    engine.cancel(session.id); await engine.idle(session.id);
    expect(store.read(session.id).runs[0].status).toBe('interrupted'); expect(store.read(session.id).revision).toBe(1);
  });
});

describe('atomic creator patch boundary', () => {
  it('rolls back every earlier operation when a later pointer or test fails', async () => {
    const { store, session } = await fixture();
    const input = { key: 'atomic-patch', expectedRevision: 0, summary: '事务测试', operations: [{ op: 'replace' as const, path: '/title', value: '不能残留' }, { op: 'test' as const, path: '/description', value: '不匹配' }] };
    expect(() => store.patch(session.id, 'test-run', input)).toThrow('test failed');
    expect(store.read(session.id).document).toEqual(session.document); expect(store.read(session.id).revision).toBe(0);
    expect(() => patchCreatorDocument(session.document, [{ op: 'replace', path: '/title', value: '不能残留' }, { op: 'remove', path: '/missing/child' }])).toThrow('does not exist');
    expect(session.document.title).not.toBe('不能残留');
  });
  it('rejects prototype pollution, malformed pointers/non-JSON values and oversized drafts', async () => {
    const { session } = await fixture();
    for (const path of ['/__proto__/polluted', '/constructor/prototype/polluted', '/modules/00', '/bad~2escape']) expect(() => patchCreatorDocument(session.document, [{ op: 'add', path, value: true }])).toThrow();
    expect(({} as any).polluted).toBeUndefined();
    expect(() => assertCreatorDocument({ title: undefined })).toThrow('JSON');
    expect(() => assertCreatorDocument({ payload: 'x'.repeat(32 * 1024 * 1024) })).toThrow('32 MiB');
    expect(() => patchCreatorDocument(session.document, [{ op: 'remove', path: '' }])).toThrow('whole draft');
  });
  it('supports escaped object keys, array append/insert/removal, and preserves all unrelated JSON', async () => {
    const { session } = await fixture();
    const document = clone(session.document) as any; document.unknown = { 'a/b~c': 'old', nested: [1, 2], source: 'PRESERVE_VERBATIM' };
    const result = patchCreatorDocument(document, [{ op: 'replace', path: '/unknown/a~1b~0c', value: 'new' }, { op: 'add', path: '/unknown/nested/-', value: 3 }, { op: 'add', path: '/unknown/nested/1', value: 9 }, { op: 'remove', path: '/unknown/nested/0' }]) as any;
    expect(result.unknown).toEqual({ 'a/b~c': 'new', nested: [9, 2, 3], source: 'PRESERVE_VERBATIM' });
    expect(document.unknown.nested).toEqual([1, 2]);
  });
});

describe('creator router', () => {
  it('forks catalog sources into independent sessions and returns full snapshots from edit/restore', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-creator-api-test-')); roots.push(root);
    const source = createNativeTemplate('preset') as Preset, original = clone(source), provider = new CreatorTestProvider();
    const service = createCreatorService({ root, provider, catalog: async () => ({ cards: [], presets: [source] }) });
    const app = express(); app.use(express.json()); app.use('/api/creator', service.router);
    app.use((error: any, _req: any, response: any, _next: any) => response.status(error instanceof ApiError ? error.status : 500).json({ error: { code: error.code, message: error.message } }));
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
    cleanup.push(async () => { await service.close(); await new Promise<void>(done => server.close(() => done())); });
    const base = `http://127.0.0.1:${(server.address() as any).port}/api/creator`;
    const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async response => ({ status: response.status, body: await response.json() }));
    const created = await post('/sessions', { kind: 'preset', sourceId: source.id }); expect(created.status).toBe(201);
    const document = clone(created.body.document); document.title = '路由编辑标题';
    const edited = await post(`/sessions/${created.body.id}/draft`, { expectedRevision: 0, document, summary: '手动编辑' });
    expect(edited.body.revision).toBe(1); expect(edited.body.revisions).toHaveLength(2);
    const restored = await post(`/sessions/${created.body.id}/restore`, { expectedRevision: 1, revision: 0 });
    expect(restored.body.revision).toBe(2); expect(restored.body.messages).toEqual([]); expect(source).toEqual(original);
    const publication = await post(`/sessions/${created.body.id}/publish`, { expectedRevision: 2 }); expect(publication.status).toBe(201);
    expect((await service.catalog()).presets).toHaveLength(1); expect(source).toEqual(original);
    const fork = await post('/sessions', { kind: 'preset', sourceId: publication.body.id });
    expect(fork.status).toBe(201); expect(fork.body.id).not.toBe(created.body.id); expect(fork.body.sourceId).toBe(publication.body.id);
    const forkDocument = clone(fork.body.document); forkDocument.title = '派生版本不覆盖已发布素材';
    await post(`/sessions/${fork.body.id}/draft`, { expectedRevision: 0, document: forkDocument, summary: '编辑派生草稿' });
    expect((await service.catalog()).presets[0].title).toBe(publication.body.title);
  });
});
