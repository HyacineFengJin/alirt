import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeConfigurationCanSave, runtimeConfigurationDirty, runtimeConfigurationUpdate, toggleRuntimeOutput } from './NativeRuntimeControls';
import { createNativeTemplate } from '../../shared/native';
import type { CharacterCard, Preset } from '../../shared/types';
import { api, type RuntimeConfiguration } from '../api';
afterEach(() => vi.unstubAllGlobals());

it('enables a selected output with only its local protocol and leaves original snapshots intact', () => {
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset;
  preset.modules = [{ id: 'summary', title: 'Summary protocol', content: 'Summarize public facts.', enabled: false, targets: ['prose'], phase: 'compose', category: 'protocol', priority: 0 }];
  preset.outputs = [{ id: 'summary', title: 'Summary', instruction: 'Summarize public facts.', enabled: false, required: true, module: 'preset:summary', type: 'text', priority: 0, audience: 'public', display: { placement: 'after-prose' } }];
  const runtime: RuntimeConfiguration = { revision: 4, card, preset, agentRuntime: { profile: 'full' } };
  const next = toggleRuntimeOutput(runtime, 'preset', 'summary', true);
  expect(next.preset.outputs![0].enabled).toBe(true); expect(next.preset.modules[0].enabled).toBe(true);
  expect(runtime.preset.outputs![0].enabled).toBe(false); expect(runtime.preset.modules[0].enabled).toBe(false);
  const disabled = toggleRuntimeOutput(next, 'preset', 'summary', false);
  expect(disabled.preset.outputs![0].enabled).toBe(false); expect(disabled.preset.modules[0].enabled).toBe(true);
  next.preset.outputs![0].module = 'card:summary'; next.preset.modules[0].enabled = false;
  expect(toggleRuntimeOutput(next, 'preset', 'summary', true).preset.modules[0].enabled).toBe(false);
});
it('recognizes agent-only changes and saves them in the same reason/CAS runtime patch', async () => {
  const base: RuntimeConfiguration = { revision: 7, card: createNativeTemplate('card') as CharacterCard, preset: createNativeTemplate('preset') as Preset, agentRuntime: { profile: 'minimal' } };
  const draft = structuredClone(base); draft.agentRuntime.modules = { 'rp.role-agents': true, 'rp.derived-memory': true };
  expect(runtimeConfigurationDirty(base, base)).toBe(false); expect(runtimeConfigurationDirty(base, draft)).toBe(true);
  const update = runtimeConfigurationUpdate(base, draft, '  开启有来源笔记  ');
  expect(update).toMatchObject({ expectedRevision: 7, reason: '开启有来源笔记', agentRuntime: draft.agentRuntime });
  expect(update.cardModules).toEqual(draft.card.modules); expect(update.preset).toEqual(draft.preset);
  expect(base.agentRuntime).toEqual({ profile: 'minimal' });
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...draft, revision: 8 }) }); vi.stubGlobal('fetch', fetch);
  await api.configureRuntime('session/one', update);
  expect(fetch.mock.calls[0][0]).toBe('/api/sessions/session%2Fone/runtime');
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(update);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('keeps discarded runtime drafts unsavable when the module catalog finishes before a slower runtime reload', () => {
  const base: RuntimeConfiguration = { revision: 7, card: createNativeTemplate('card') as CharacterCard, preset: createNativeTemplate('preset') as Preset, agentRuntime: { profile: 'minimal' } };
  const discarded = structuredClone(base); discarded.agentRuntime = { profile: 'compact' };
  const state = { base, draft: discarded, revision: 7, loading: false, busy: false, readOnly: false, invalid: false, reason: '明确修改代理装配' };
  expect(runtimeConfigurationCanSave(state)).toBe(true);
  // Catalog validation may already succeed and the author may enter a reason,
  // but the discarded session snapshot is not a fresh read result.
  expect(runtimeConfigurationCanSave({ ...state, loading: true })).toBe(false);
  expect(runtimeConfigurationCanSave({ ...state, base: undefined, draft: undefined, loading: true })).toBe(false);
  // Failure ends loading, without reinstating the discarded form.
  expect(runtimeConfigurationCanSave({ ...state, base: undefined, draft: undefined, loading: false })).toBe(false);
  // A successful retry loads the saved snapshot, not those discarded changes.
  expect(runtimeConfigurationCanSave({ ...state, base, draft: structuredClone(base), loading: false })).toBe(false);
  const changed = structuredClone(base); changed.agentRuntime = { profile: 'full' };
  expect(runtimeConfigurationCanSave({ ...state, draft: changed })).toBe(true);
  expect(runtimeConfigurationCanSave({ ...state, draft: changed, readOnly: true })).toBe(false);
  expect(runtimeConfigurationCanSave({ ...state, draft: changed, revision: 8 })).toBe(false);
  expect(runtimeConfigurationCanSave({ ...state, draft: changed, invalid: true })).toBe(false);
});

it('saves the source avatar default switch atomically with the runtime reason and CAS while retaining source evidence', () => {
  const base: RuntimeConfiguration = { revision: 7, card: createNativeTemplate('card') as CharacterCard, preset: createNativeTemplate('preset') as Preset, agentRuntime: { profile: 'minimal' } };
  base.card.visuals = { schema: 'rp.card-visuals/0.1', enabled: true, source: { importId: 'reviewed', pointer: '/visuals/defaults', sha256: 'a'.repeat(64) }, defaults: [] };
  const draft = structuredClone(base); draft.card.visuals!.enabled = false;
  expect(runtimeConfigurationDirty(base, draft)).toBe(true);
  const patch = runtimeConfigurationUpdate(base, draft, '关闭未来来源默认头像');
  expect(patch).toMatchObject({ expectedRevision: 7, reason: '关闭未来来源默认头像', cardVisuals: { ...base.card.visuals, enabled: false } });
  expect(patch).not.toHaveProperty('roleVisuals'); expect(base.card.visuals.enabled).toBe(true); expect(base.card.visuals.defaults).toEqual([]);
});
