import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionSnapshot } from '../../shared/types';
import type { ParallelScenesView } from '../../shared/parallel-scenes';
import { emptyParallelScenesDraft, parallelScenesCommand, ParallelScenesEditor, ParallelScenesForm, recoverParallelScenesDraft, sendParallelScenesCommand, type ParallelScenesDraft } from './ParallelScenesEditor';

const view = (): ParallelScenesView => ({ schema: 'rp.parallel-scenes-control/0.1', revision: 8,
  grants: [{ id: 'office', title: '办公室', enabled: true, participantRoleIds: ['a'], locationKey: 'position', goal: '核对已公布通知', generation: 2 }],
  archives: [{ id: 'office', title: '旧办公室授权', enabled: false, participantRoleIds: ['a'], locationKey: 'position', goal: '原始私有目标', generation: 1 }], selectedSceneIds: ['office'],
  roles: [{ roleId: 'a', name: 'A', phase: 'active', presence: 'absent', interaction: null, appearanceEvidence: [{ kind: 'approved-behavior', roleId: 'a', eventId: 'approved-a', turnId: 't1', behaviorId: 'b1' }], heldStringKeys: ['position'], readableStringFields: [{ key: 'position', label: '位置', value: '办公室', known: true }], ready: true, diagnostics: [] },
    { roleId: 'b', name: 'B', phase: 'dormant', presence: 'absent', interaction: null, appearanceEvidence: [], heldStringKeys: [], readableStringFields: [{ key: 'position', label: '位置', value: null, known: false }], ready: false, diagnostics: [{ code: 'role-dormant', message: 'Dormant role is not dispatched.', roleId: 'b' }] }],
  sceneReadiness: [{ sceneId: 'office', ready: true, location: '办公室', participants: [], diagnostics: [] }],
});
const draft = (): ParallelScenesDraft => ({ ...emptyParallelScenesDraft(), scene: { id: 'office', title: '办公室', enabled: true, participantRoleIds: ['a'], locationKey: 'position', goal: '核对已公布通知' }, selectedSceneIds: ['office'], expectedRevision: 8, reason: '授权独立场景' });
afterEach(() => vi.unstubAllGlobals());

it('builds exact separate grant/select/remove commands without lifecycle writes or assigning a host generation', () => {
  const state = view(), form = draft(), before = JSON.stringify([state, form]);
  const upsert = parallelScenesCommand(state, form, 'upsert', 'stable-id');
  expect(upsert).toEqual({ requestId: 'stable-id', expectedRevision: 8, reason: form.reason, operation: 'upsert', scene: form.scene });
  expect(upsert).not.toHaveProperty('phase'); expect(upsert).not.toHaveProperty('presence');
  expect(upsert).not.toHaveProperty('generation');
  expect(parallelScenesCommand(state, { ...form, selectedSceneIds: [] }, 'select', 'select')).toMatchObject({ operation: 'select', selectedSceneIds: [] });
  expect(parallelScenesCommand(state, form, 'remove', 'remove')).toEqual({ requestId: 'remove', expectedRevision: 8, reason: form.reason, operation: 'remove', sceneId: 'office' });
  expect(parallelScenesCommand(state, { ...form, scene: { ...form.scene, enabled: false } }, 'upsert', 'disable')).toMatchObject({ operation: 'upsert', scene: { enabled: false } });
  expect(JSON.stringify([state, form])).toBe(before);
});

it('blocks stale drafts, forged participants, absent reasons, removed selections and overlapping selected casts', () => {
  for (const change of [{ expectedRevision: 7 }, { applied: true }, { reason: '' }, { scene: { ...draft().scene, participantRoleIds: ['invented'] } }]) expect(() => parallelScenesCommand(view(), { ...draft(), ...change }, 'upsert', 'request')).toThrow();
  expect(() => parallelScenesCommand(view(), { ...draft(), selectedSceneIds: ['removed'] }, 'select', 'request')).toThrow('已撤销场景');
  expect(() => parallelScenesCommand(view(), { ...draft(), selectedSceneIds: ['a', 'b', 'c'] }, 'select', 'request')).toThrow();
  const state = view(); state.grants.push({ ...state.grants[0], id: 'second' });
  expect(() => parallelScenesCommand(state, { ...draft(), selectedSceneIds: ['office', 'second'] }, 'select', 'request')).toThrow('同一角色');
});

it('recovers incomplete form values and an exact unknown request, but never repairs invalid pending payloads', () => {
  expect(recoverParallelScenesDraft(JSON.stringify(emptyParallelScenesDraft()))).toEqual(emptyParallelScenesDraft());
  const form = draft(), pending = parallelScenesCommand(view(), form, 'upsert', 'uncertain');
  expect(recoverParallelScenesDraft(JSON.stringify({ ...form, pending }))).toEqual({ ...form, pending });
  expect(() => parallelScenesCommand(view(), { ...form, pending }, 'upsert', 'replacement')).toThrow();
  for (const command of [{ ...pending, expectedRevision: -1 }, { ...pending, unexpected: true }, { ...pending, requestId: '' }, { ...pending, operation: 'start' }]) expect(() => recoverParallelScenesDraft(JSON.stringify({ ...form, pending: command }))).toThrow();
  expect(() => recoverParallelScenesDraft('{broken')).toThrow();
});

it('manual retry uses the generic service route and exact original request identity/body', async () => {
  const command = parallelScenesCommand(view(), draft(), 'select', 'retry-stable');
  const recovered = recoverParallelScenesDraft(JSON.stringify({ ...draft(), pending: command })).pending!;
  const fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: { message: 'unknown' } }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ ...view(), requestId: command.requestId, duplicate: true, appliedRevision: 8 }) });
  vi.stubGlobal('fetch', fetch);
  await expect(sendParallelScenesCommand('session/one', command)).rejects.toMatchObject({ status: 503 });
  await expect(sendParallelScenesCommand('session/one', recovered)).resolves.toMatchObject({ duplicate: true });
  expect(fetch.mock.calls[0][0]).toBe('/api/sessions/session%2Fone/services/rp.parallel-scenes/commands');
  expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
});

it('shows server readiness and held locations without treating dormant/unknown as ready or erasing archives', () => {
  const state = view(); state.sceneReadiness[0].ready = false; state.sceneReadiness[0].location = null;
  state.sceneReadiness[0].diagnostics = [{ code: 'location-mismatch', message: 'Participants hold different locations.' }];
  const html = renderToStaticMarkup(createElement(ParallelScenesForm, { view: state, draft: draft(), disabled: false, change: () => {}, submit: () => { throw new Error('Render never dispatches'); } }));
  expect(html).toContain('location-mismatch'); expect(html).toContain('Participants hold different locations.');
  expect(html).toContain('role-dormant'); expect(html).toContain('出场证据：未证实 · 地点：未知');
  expect(html).toContain('原始私有目标'); expect(html).toContain('档案版本 1');
  expect(html).toContain('关闭保留档案与已保存选择'); expect(html).toContain('场景目标（作者私有）');
  expect(html).toContain('value="position"'); expect(html).not.toContain('更新生命周期');
});

it('never mounts private editor content for role/read-only views, and author service is lazy behind inline details', () => {
  const props = { session: { id: 's', perspective: 'role' } as SessionSnapshot, readOnly: false, refresh: async () => {} };
  expect(renderToStaticMarkup(createElement(ParallelScenesEditor, props))).toBe('');
  expect(renderToStaticMarkup(createElement(ParallelScenesEditor, { ...props, session: { ...props.session, perspective: 'author' }, readOnly: true }))).toBe('');
  const html = renderToStaticMarkup(createElement(ParallelScenesEditor, { ...props, session: { ...props.session, perspective: 'author' } }));
  expect(html).toContain('<details class="parallel-scenes-editor">'); expect(html).not.toContain('<dialog'); expect(html).not.toContain('场景目标');
});
