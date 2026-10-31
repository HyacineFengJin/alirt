import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { AuxiliaryOutput } from '../shared/types';
import type { ParallelScenesOutput } from '../shared/parallel-output';
import { ParallelSceneOutput } from './ParallelSceneOutput';
import { ProseEntries } from './ProseEntries';

function attachment(): AuxiliaryOutput {
  const value: ParallelScenesOutput = { schema: 'rp.parallel-scenes/0.1', materialTurnId: 'main-turn', worldRevision: 9, scenes: [
    { id: 'run-office', sceneId: 'office', title: '办公室', location: '站务室', time: null, cast: [{ roleId: 'a', name: 'A' }], status: 'completed', prose: { title: '查看通知', text: 'A 核对通知。\n<script>只是文字</script>', person: 'third', pov: 'limited' } },
    { id: 'run-hall', sceneId: 'hall', title: '大厅', location: '大厅', time: '傍晚', cast: [{ roleId: 'b', name: 'B' }], status: 'failed', error: '<b>成文格式错误</b>' },
  ] };
  return { key: 'preset:parallel', title: '平行事件', type: 'object', audience: 'author', placement: 'after-prose', value: value as unknown as AuxiliaryOutput['value'], display: { placement: 'after-prose', renderer: 'parallel-scenes' }, provenance: { kind: 'committed-parallel', materialTurnId: value.materialTurnId, sceneIds: value.scenes.map(scene => scene.sceneId), worldRevision: value.worldRevision } };
}
it('renders each run as its own native scene card after main prose, with true IDs, cast, time and separate failure', () => {
  const output = attachment(), before = JSON.stringify(output);
  const html = renderToStaticMarkup(createElement(ProseEntries, { entries: [{ id: 'entry', title: '主场', text: '玩家仍在站台。', turnId: 'main-turn', worldRevision: 9, attachments: [output] }] }));
  expect(html.indexOf('玩家仍在站台。')).toBeLessThan(html.indexOf('作者附加场景'));
  expect(html).toContain('<summary>办公室 · 成文完成</summary>'); expect(html).toContain('<summary>大厅 · 成文失败</summary>');
  expect(html).toContain('场景 office · 记录 run-office'); expect(html).toContain('A（a）'); expect(html).toContain('地点：站务室 · 时间：未知');
  expect(html).toContain('此场景成文失败；原记录保留，未自动重试。');
  expect(html).toContain('&lt;b&gt;成文格式错误&lt;/b&gt;'); expect(html).toContain('&lt;script&gt;只是文字&lt;/script&gt;');
  expect(html).not.toContain('<script'); expect(html).not.toContain('<button'); expect(JSON.stringify(output)).toBe(before);
});
it('shows pending and invalid diagnostics explicitly without treating either as completed or auto retrying', () => {
  const output = attachment(), value = output.value as unknown as ParallelScenesOutput;
  const { error: _, ...pending } = value.scenes[1];
  value.scenes = [{ ...pending, status: 'pending' }];
  output.provenance = { kind: 'committed-parallel', materialTurnId: value.materialTurnId, sceneIds: ['hall'], worldRevision: value.worldRevision };
  let html = renderToStaticMarkup(createElement(ParallelSceneOutput, { output }));
  expect(html).toContain('等待成文'); expect(html).toContain('尚未完成成文'); expect(html).not.toContain('成文完成');
  value.scenes[0].status = 'completed';
  html = renderToStaticMarkup(createElement(ParallelSceneOutput, { output }));
  expect(html).toContain('输出格式或作者权限标记无效'); expect(html).not.toContain('记录 run-hall');
});
it('refuses a public parallel attachment instead of exposing private scene content', () => {
  const output = { ...attachment(), audience: 'public' as const };
  const html = renderToStaticMarkup(createElement(ParallelSceneOutput, { output }));
  expect(html).toContain('作者权限标记无效'); expect(html).not.toContain('站务室'); expect(html).not.toContain('A 核对通知');
});
it('passes an optional preparation callback through prose/attachments without calling it or offering completed-run recovery', () => {
  const html = renderToStaticMarkup(createElement(ProseEntries, { entries: [{ id: 'p', title: '主场', text: '站台', worldRevision: 9, attachments: [attachment()] }], onParallelRecovery: () => { throw new Error('Rendering must not prepare or dispatch recovery'); } }));
  expect(html.match(/准备按原材料重新成文/g)).toHaveLength(1);
  expect(html).not.toContain('onclick=');
});
it('rejects missing/mismatched host stamps without showing private scene bodies or recovery controls', () => {
  for (const provenance of [undefined, { kind: 'committed-parallel' as const, materialTurnId: 'other', sceneIds: ['office', 'hall'], worldRevision: 9 },
    { kind: 'committed-parallel' as const, materialTurnId: 'main-turn', sceneIds: ['office'], worldRevision: 9 },
    { kind: 'committed-parallel' as const, materialTurnId: 'main-turn', sceneIds: ['office', 'hall'], worldRevision: 10 }]) {
    const html = renderToStaticMarkup(createElement(ParallelSceneOutput, { output: { ...attachment(), provenance }, onParallelRecovery: () => {} }));
    expect(html).toContain('宿主提交标记不匹配'); expect(html).not.toContain('A 核对通知'); expect(html).not.toContain('<button');
  }
});
