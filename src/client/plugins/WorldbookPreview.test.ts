import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PromptPlan } from '../../shared/prompt-runtime';
import { api, type RuntimeConfiguration } from '../api';
import { WorldbookPreviewResult } from './WorldbookPreview';

afterEach(() => vi.unstubAllGlobals());
describe('saved worldbook preview', () => {
  it('shows admitted identities and exclusion reasons without exposing compiled bodies', () => {
    const included = { source: 'card', moduleId: 'included', key: 'card:included', documentId: 'card' };
    const excluded = { source: 'preset', moduleId: 'excluded', key: 'preset:excluded', documentId: 'preset' };
    const plan = { snapshotRevision: 7, valid: true, modules: [{ ref: included, content: '不得在预览中渲染的完整正文' }], decisions: [{ ref: included, status: 'included', reasons: [] }, { ref: excluded, status: 'excluded', reasons: [{ code: 'keywords', severity: 'info', message: 'No keys' }] }], diagnostics: [{ code: 'bad-config', severity: 'error', message: '配置不完整' }] } as unknown as PromptPlan;
    const runtime = { revision: 7, card: { modules: [{ id: 'included', title: '港口资料' }] }, preset: { modules: [{ id: 'excluded', title: '航行规则' }] } } as RuntimeConfiguration;
    const html = renderToStaticMarkup(createElement(WorldbookPreviewResult, { plan, runtime }));
    expect(html).toContain('港口资料'); expect(html).toContain('角色卡');
    expect(html).toContain('航行规则'); expect(html).toContain('预设');
    expect(html).toContain('关键词触发条件未满足'); expect(html).toContain('配置不完整');
    expect(html).not.toContain('不得在预览中渲染的完整正文');
  });
  it('posts only target, role and test text to the saved runtime preview and supports cancellation', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ snapshotRevision: 7 }) });
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    await api.runtimePreview('story/one', { target: 'role', roleId: 'player', text: '港口' }, controller.signal);
    expect(fetch.mock.calls[0][0]).toBe('/api/sessions/story%2Fone/runtime/preview');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ target: 'role', roleId: 'player', text: '港口' });
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
  });
});
