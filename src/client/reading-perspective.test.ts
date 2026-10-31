import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '../shared/types';
import { readingPanelContext } from './App';
import { currentReadingSnapshot, Reader, readingProjectionKey, type ReadingView } from './Reader';
import { PanelHost } from './plugins/PanelHost';
import { registerBuiltins, registry } from './plugins/builtin';
import type { PanelContext } from './plugins/registry';

function snapshots() {
  const author: SessionSnapshot = { id: 'reading-story', revision: 4, updatedAt: '2026-10-31T12:00:00Z', createdAt: '', title: 'Reading', cardId: 'original-card', presetId: 'basic', playerRoleId: 'player', perspective: 'author',
    world: { time: 'AUTHOR_WORLD_LABEL', location: 'AUTHOR_LOCATION_LABEL', variables: { privateField: 'AUTHOR_PRIVATE_WORLD' } },
    roles: [
      { id: 'player', name: 'Player', persona: '', goals: [], peers: [], phase: 'active', presence: 'present', state: {}, knowledge: [] },
      { id: 'role-20', name: 'Viewer', persona: 'AUTHOR_PRIVATE_PERSONA', goals: [], peers: [], phase: 'active', presence: 'absent', state: { publicField: 'AUTHOR_OLD_VALUE', privateField: 'AUTHOR_PRIVATE_STATE' }, knowledge: [] },
    ], fields: [{ key: 'publicField', label: '公共字段', type: 'string', audience: 'public', editable: true }, { key: 'privateField', label: '作者字段', type: 'string', audience: 'author', editable: true }],
    panels: [], events: [], prose: [{ id: 'raw-prose', title: '', text: 'AUTHOR_ONLY_PROSE', worldRevision: 4 }],
    turns: [{ id: 't', requestId: 'r', action: 'PRIVATE_AUTHOR_INSTRUCTION', mode: 'author', status: 'completed', phase: 'done', startedAt: '' }], narration: { person: 'auto', pov: 'limited' } };
  const projection = structuredClone(author);
  projection.perspective = 'role-20';
  projection.world = { time: 'PROJECTED_WORLD_LABEL', location: 'PROJECTED_LOCATION_LABEL', variables: {} };
  projection.fields = projection.fields.filter(field => field.audience === 'public');
  projection.roles[1].persona = '';
  projection.roles[1].state = { publicField: 'PROJECTED_ROLE_VALUE' };
  projection.roles[1].knowledge = [{ id: 'known', text: 'ROLE_KNOWLEDGE', audience: ['role-20'], status: 'known' }];
  projection.prose[0].text = 'ROLE_PERMITTED_PROSE';
  projection.turns[0].action = '[作者指令]';
  return { author, projection };
}
function controls(): Omit<PanelContext, 'session' | 'selectedRole'> {
  return { catalog: { cards: [], presets: [] }, selectRole: vi.fn(), editState: vi.fn(), editKnowledge: vi.fn(), setLifecycle: vi.fn(), refresh: vi.fn(), readOnly: false, chooseAction: vi.fn() };
}
beforeEach(() => vi.stubGlobal('localStorage', { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

describe('shared Reader and panel reading perspective', () => {
  it('never falls back to author data for pending, failed, wrong-role or obsolete projection snapshots', () => {
    const { author, projection } = snapshots();
    expect(currentReadingSnapshot(author, 'author')).toBe(author);
    expect(currentReadingSnapshot(author, 'role-20')).toBeUndefined();
    expect(currentReadingSnapshot(author, 'role-20', author)).toBeUndefined();
    expect(currentReadingSnapshot(author, 'role-20', projection)).toBe(projection);
    for (const patch of [{ id: 'different-story' }, { perspective: 'player' }, { revision: 3 }, { revision: 5 }, { updatedAt: 'earlier' }]) {
      expect(currentReadingSnapshot(author, 'role-20', { ...projection, ...patch })).toBeUndefined();
    }
    expect(currentReadingSnapshot({ ...author, updatedAt: 'later-status-with-same-revision' }, 'role-20', projection)).toBeUndefined();
    expect(readingProjectionKey(author, 'author')).not.toBe(readingProjectionKey(author, 'role-20'));
    expect(readingProjectionKey(author, 'role-20')).not.toBe(readingProjectionKey({ ...author, id: 'other' }, 'role-20'));
    expect(readingProjectionKey(author, 'role-20')).not.toBe(readingProjectionKey({ ...author, updatedAt: 'later' }, 'role-20'));
  });

  it('builds readonly panel context and selected role from the exact projected snapshot, then restores author controls explicitly', async () => {
    const { author, projection } = snapshots(), base = controls();
    expect(readingPanelContext(author, 'role-20', undefined, 'role-20', base)).toBeUndefined();
    const role = readingPanelContext(author, 'role-20', projection, 'role-20', base)!;
    expect(role.session).toBe(projection);
    expect(role.selectedRole).toBe(projection.roles[1]);
    expect(role.selectedRole).not.toBe(author.roles[1]);
    expect(role.selectedRole!.state).toEqual({ publicField: 'PROJECTED_ROLE_VALUE' });
    expect(role.readOnly).toBe(true); expect(role.chooseAction).toBeUndefined();
    await expect(role.editState({ expectedRevision: 4, roleId: 'role-20', key: 'publicField', value: 'x', reason: 'x' })).rejects.toThrow('只读');
    expect(base.editState).not.toHaveBeenCalled();
    const restored = readingPanelContext(author, 'author', projection, 'role-20', base)!;
    expect(restored.session).toBe(author); expect(restored.selectedRole).toBe(author.roles[1]);
    expect(restored.readOnly).toBe(false); expect(restored.editState).toBe(base.editState);
    expect(readingPanelContext(author, 'role-20', projection, 'missing', base)?.selectedRole).toBeUndefined();
    expect(readingPanelContext({ ...author, revision: 5 }, 'role-20', projection, 'role-20', base)).toBeUndefined();
    expect(readingPanelContext({ ...author, id: 'new-story' }, 'role-20', projection, 'role-20', base)).toBeUndefined();
  });

  it('renders generic state and source panels with the role context without author controls or private selected-role fields', () => {
    const { author, projection } = snapshots();
    const context = readingPanelContext(author, 'role-20', projection, 'role-20', controls())!;
    const dispose = registerBuiltins();
    try {
      const state = { id: 'state', title: '角色状态', kind: 'state' as const, side: 'right' as const, pluginId: 'host.state' };
      const source = { id: 'source', title: '来源', kind: 'source' as const, side: 'right' as const };
      const html = renderToStaticMarkup(createElement(Fragment, null,
        createElement(PanelHost, { panel: state, plugin: registry.find('state', state.pluginId), context, move: () => {}, close: () => {} }),
        createElement(PanelHost, { panel: source, plugin: registry.find('source'), context, move: () => {}, close: () => {} })));
      expect(html).toContain('PROJECTED_ROLE_VALUE');
      expect(html).toContain('当前视角不读取作者工具或来源档案');
      expect(html).not.toContain('AUTHOR_PRIVATE'); expect(html).not.toContain('AUTHOR_OLD_VALUE');
      expect(html).not.toContain('>修正</button>');
      expect(html).not.toContain('运行设置 · 提示与附加输出');
    } finally { dispose(); }
  });

  it('keeps the Reader present during role loading/errors and never shows raw author prose or turn instructions as a fallback', () => {
    const { author, projection } = snapshots();
    const reading: ReadingView = { perspective: 'role-20', error: '', changePerspective: vi.fn(), retry: vi.fn() };
    const render = (view: ReadingView) => renderToStaticMarkup(createElement(Reader, { session: author, reading: view, refresh: async () => {} }));
    const pending = render(reading);
    expect(pending).toContain('aria-label="阅读与创作"');
    expect(pending).toContain('读取中…'); expect(pending).toContain('下一步内容');
    expect(pending).not.toContain('AUTHOR_ONLY_PROSE'); expect(pending).not.toContain('PRIVATE_AUTHOR_INSTRUCTION');
    expect(pending).toContain('侧栏为只读'); expect(pending).not.toContain('侧栏仍为作者工作区');
    const failed = render({ ...reading, error: '投影请求失败' });
    expect(failed).toContain('重试读取角色投影'); expect(failed).not.toContain('AUTHOR_ONLY_PROSE');
    const ready = render({ ...reading, projection });
    expect(ready).toContain('ROLE_KNOWLEDGE'); expect(ready).toContain('ROLE_PERMITTED_PROSE');
    expect(ready).not.toContain('PRIVATE_AUTHOR_INSTRUCTION');
    expect(render({ ...reading, projection: { ...projection, revision: 3 } })).not.toContain('ROLE_KNOWLEDGE');
    expect(render({ ...reading, perspective: 'author' })).toContain('AUTHOR_ONLY_PROSE');
  });
});
