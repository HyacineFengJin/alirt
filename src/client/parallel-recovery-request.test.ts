import { afterEach, expect, it, vi } from 'vitest';
import { readerTurnRequest, recoverableParallelScene } from './Reader';
import { api } from './api';
import type { AuxiliaryOutput, ProseEntry } from '../shared/types';
import type { ParallelScenesOutput } from '../shared/parallel-output';
afterEach(() => vi.unstubAllGlobals());
const base = { requestId: 'exact-request', revision: 8, action: '  仅按原已提交材料重新整理该场外场景  ', narration: { person: 'auto' as const, pov: 'auto' as const } };
it('only adds a specific scene recovery to an explicit author request; normal action/dialogue have none', () => {
  expect(readerTurnRequest({ ...base, mode: 'author', perspective: 'author', parallelRunId: 'real-run' })).toEqual({ requestId: 'exact-request', expectedRevision: 8, mode: 'author', action: base.action.trim(), narration: base.narration, parallelRecovery: { runId: 'real-run' } });
  for (const mode of ['action', 'dialogue'] as const) {
    expect(readerTurnRequest({ ...base, mode, perspective: 'author' })).not.toHaveProperty('parallelRecovery');
    expect(() => readerTurnRequest({ ...base, mode, perspective: 'author', parallelRunId: 'real-run' })).toThrow();
  }
  expect(() => readerTurnRequest({ ...base, mode: 'author', perspective: 'npc', parallelRunId: 'real-run' })).toThrow();
});
it('the normal turn endpoint preserves the complete recovery payload under an explicit same-request retry', async () => {
  const request = readerTurnRequest({ ...base, mode: 'author', perspective: 'author', parallelRunId: 'real-run' });
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError('network uncertain')).mockResolvedValueOnce({ ok: true, json: async () => ({ turnId: 'recovery-turn' }) });
  vi.stubGlobal('fetch', fetch);
  await expect(api.turn('session/one', request)).rejects.toThrow('network uncertain');
  await expect(api.turn('session/one', request)).resolves.toEqual({ turnId: 'recovery-turn' });
  expect(fetch.mock.calls[0][0]).toBe('/api/sessions/session%2Fone/turns');
  expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(request);
});
it('only prepares a latest noncompleted private host run and never guesses by scene name or scene ID', () => {
  const value: ParallelScenesOutput = { schema: 'rp.parallel-scenes/0.1', materialTurnId: 'material', worldRevision: 8, scenes: [{ id: 'real-run', sceneId: 'scene-config', title: '办公室', location: '办公室', time: null, cast: [{ roleId: 'a', name: 'A' }], status: 'failed', error: 'writer failed' }] };
  const output: AuxiliaryOutput = { key: 'parallel', title: 'parallel', type: 'object', audience: 'author', placement: 'after-prose', display: { placement: 'after-prose', renderer: 'parallel-scenes' }, value: value as unknown as AuxiliaryOutput['value'], provenance: { kind: 'committed-parallel', materialTurnId: 'material', worldRevision: 8, sceneIds: ['scene-config'] } };
  const entry: ProseEntry = { id: 'entry', title: '', text: '主场', worldRevision: 8, attachments: [output] };
  expect(recoverableParallelScene({ prose: [entry] }, 'real-run')?.id).toBe('real-run');
  for (const guessed of ['办公室', 'scene-config', 'invented']) expect(recoverableParallelScene({ prose: [entry] }, guessed)).toBeUndefined();
  expect(recoverableParallelScene({ prose: [{ ...entry, attachments: [{ ...output, audience: 'public' }] }] }, 'real-run')).toBeUndefined();
  expect(recoverableParallelScene({ prose: [{ ...entry, attachments: [{ ...output, provenance: undefined }] }] }, 'real-run')).toBeUndefined();
  const completed = { ...value, scenes: [{ ...value.scenes[0], status: 'completed' as const, prose: { title: '', text: '原材料成文。', person: 'third' as const, pov: 'limited' as const } }] };
  expect(recoverableParallelScene({ prose: [entry, { ...entry, id: 'new-view', attachments: [{ ...output, value: completed as unknown as AuxiliaryOutput['value'] }] }] }, 'real-run')).toBeUndefined();
});
