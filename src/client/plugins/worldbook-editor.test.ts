import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { api, type RuntimeConfiguration } from '../api';
import type { PanelContext } from './registry';
import { WorldbookEditor } from './WorldbookEditor';
import { registerBuiltins, registry } from './builtin';
import { createWorldbookDraft, worldbookDraftCommand, worldbookEntries, type WorldbookEntry } from './worldbook-editor';

const module = { id: 'lore', title: '港口', category: 'supplement' as const, content: '原始正文', enabled: true, targets: ['world' as const], phase: 'coordinate' as const, priority: 2 };
const binding = { id: 'port', moduleId: 'lore', purpose: 'reference' as const };
const entry: WorldbookEntry = { key: 'card:lore', source: 'card', module, binding, chapterTitles: [] };
const edited = (value = entry) => ({ ...createWorldbookDraft(7, value), title: '新标题', reason: '核对原稿' });
afterEach(() => vi.unstubAllGlobals());

describe('worldbook editor commands', () => {
  it('lists bound non-world entries and unbound world modules with source-local identities', () => {
    const runtime = { revision: 7, card: { modules: [module, { ...module, id: 'role-only', targets: ['role'] }, { ...module, id: 'hidden', targets: ['prose'] }], worldbook: { bindings: [binding, { ...binding, id: 'role-binding', moduleId: 'role-only' }] }, scenario: { chapters: [{ title: '第一章', bindingIds: ['port'] }] } }, preset: { modules: [module] } } as unknown as RuntimeConfiguration;
    const entries = worldbookEntries(runtime);
    expect(entries.map(item => item.key)).toEqual(['card:lore', 'card:role-only', 'preset:lore']);
    expect(entries[0].chapterTitles).toEqual(['第一章']);
    expect(entries[2].binding).toBeUndefined();
  });
  it('uses original draft CAS and sends only changed fields so unknown extensions remain untouched', () => {
    const extended = { ...entry, module: { ...module, extension: { original: '保留' }, activation: { keys: ['Harbor'], extension: '保留', secondaryKeys: ['Ship'], selective: true, match: 'word' as const }, inject: { slot: 'before-context' as const, order: 3, extension: '保留' } }, binding: { ...binding, extension: { source: '原件' }, source: { importId: 'sample', sourceHash: 'a'.repeat(64), pointer: '/entries/1', extension: '保留' } } };
    const command = worldbookDraftCommand(edited(extended));
    expect(command).toEqual({ source: 'card', operation: 'edit', expectedRevision: 7, reason: '核对原稿', moduleId: 'lore', bindingId: 'port', module: { title: '新标题' } });
    expect(extended.module.extension.original).toBe('保留');
  });
  it('preserves activation extensions when editing keywords and explicitly removes optional metadata', () => {
    const activation = { keys: ['port'], extension: 'preserved' };
    const draft = edited({ ...entry, module: { ...module, condition: { path: 'world.variables.ready', equals: true }, activation } });
    draft.keywords = '船\n船\n港口';
    draft.moduleMetadata = JSON.stringify({ category: 'supplement' });
    expect(worldbookDraftCommand(draft)).toMatchObject({ module: { condition: null, activation: { keys: ['船', '港口'], extension: 'preserved' } } });
    draft.keywords = '';
    expect(worldbookDraftCommand(draft)).toMatchObject({ module: { activation: null } });
  });
  it('rejects overlapping basic fields in advanced JSON and malformed conditions', () => {
    const draft = edited();
    draft.moduleMetadata = '{"title":"隐藏标题"}';
    expect(() => worldbookDraftCommand(draft)).toThrow('基本字段请使用上方表单');
    draft.moduleMetadata = '{"category":"supplement"}';
    draft.when = '[]';
    expect(() => worldbookDraftCommand(draft)).toThrow('绑定条件 必须是 JSON 对象');
    draft.when = '{';
    expect(() => worldbookDraftCommand(draft)).toThrow('绑定条件 不是有效 JSON');
  });
  it('requires a reviewed complete roleStage replacement after a body change', () => {
    const staged = { ...entry, binding: { ...binding, purpose: 'entity-profile' as const, roleStage: { schema: 'rp.role-stage/0.1', roleId: 'a', stages: [] } } } as unknown as WorldbookEntry;
    const draft = edited(staged);
    draft.content = '改动后的正文';
    expect(() => worldbookDraftCommand(draft)).toThrow('已审阅');
    draft.stageReviewed = true;
    expect(worldbookDraftCommand(draft)).toMatchObject({ module: { content: '改动后的正文' }, binding: { roleStage: staged.binding!.roleStage } });
    draft.roleStage = '';
    expect(() => worldbookDraftCommand(draft)).toThrow('已审阅');
  });
  it('requires title, reason, target, numeric priority and an actual edit', () => {
    const draft = createWorldbookDraft(7, entry);
    draft.reason = '核对';
    expect(() => worldbookDraftCommand(draft)).toThrow('尚未修改');
    draft.title = '';
    expect(() => worldbookDraftCommand(draft)).toThrow('标题');
    draft.title = '新标题'; draft.reason = '';
    expect(() => worldbookDraftCommand(draft)).toThrow('原因');
    draft.reason = '核对'; draft.targets = [];
    expect(() => worldbookDraftCommand(draft)).toThrow('投递目标');
    draft.targets = ['world']; draft.priority = '';
    expect(() => worldbookDraftCommand(draft)).toThrow('优先级');
  });
  it('builds a manual entry for the selected bound document with its reviewed conditions', () => {
    const draft = createWorldbookDraft(11, undefined, 'preset');
    draft.title = '新地名'; draft.content = '港口东侧'; draft.reason = '补充设定'; draft.when = '{"path":"world.variables.open","equals":true}';
    expect(worldbookDraftCommand(draft)).toMatchObject({ operation: 'add', source: 'preset', expectedRevision: 11, module: { title: '新地名', content: '港口东侧', enabled: true, targets: ['world'], phase: 'coordinate' }, binding: { purpose: 'reference', when: { path: 'world.variables.open', equals: true } } });
  });
});

describe('worldbook access boundary', () => {
  it('does not mount author API consumers for role perspectives', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(renderToStaticMarkup(createElement(WorldbookEditor, { session: { perspective: 'role:a' } } as PanelContext))).toBe('');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('removes catalog module snapshots from Lore in every perspective', () => {
    const dispose = registerBuiltins();
    try {
      const Lore = registry.find('lore')!.render;
      for (const perspective of ['author', 'role:a']) {
        const context = { session: { id: 'story', perspective, turns: [] }, catalog: { cards: [{ modules: [{ ...module, content: '过期的作者秘密' }] }], presets: [] } } as unknown as PanelContext;
        const html = renderToStaticMarkup(createElement(Lore, context));
        expect(html).not.toContain('过期的作者秘密');
        expect(html.includes('管理世界资料')).toBe(perspective === 'author');
      }
    } finally { dispose(); }
  });
  it('uses runtime endpoints and preserves backend validation errors for the caller', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ revision: 7 }) }).mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: { message: '故事版本冲突', issues: [{ path: 'expectedRevision', message: '请重新读取' }] } }) });
    vi.stubGlobal('fetch', fetch);
    await expect(api.runtime('story/one')).resolves.toMatchObject({ revision: 7 });
    const command = worldbookDraftCommand(edited());
    await expect(api.worldbookCommand('story/one', command)).rejects.toMatchObject({ status: 409, message: '故事版本冲突', issues: [{ path: 'expectedRevision', message: '请重新读取' }] });
    expect(fetch.mock.calls[0][0]).toBe('/api/sessions/story%2Fone/runtime');
    expect(fetch.mock.calls[1][0]).toBe('/api/sessions/story%2Fone/runtime/worldbook/commands');
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(command);
  });
});
