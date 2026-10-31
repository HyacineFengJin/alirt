import type { AuxiliaryOutput } from '../shared/types';
import { validParallelScenesOutput, type ParallelScenesOutput } from '../shared/parallel-output';

/** Schema-shaped prose is not a host scene record. Match the host stamp as well
 * before displaying a canonical run identity or offering its recovery action. */
export function committedParallelScenes(output: AuxiliaryOutput): ParallelScenesOutput | undefined {
  const provenance = output.provenance;
  if (output.audience !== 'author' || output.type !== 'object' || output.display?.renderer !== 'parallel-scenes'
    || provenance?.kind !== 'committed-parallel' || !validParallelScenesOutput(output.value)) return undefined;
  const value = output.value;
  return provenance.materialTurnId === value.materialTurnId && provenance.worldRevision === value.worldRevision
    && Array.isArray(provenance.sceneIds) && provenance.sceneIds.length === value.scenes.length
    && provenance.sceneIds.every((id, index) => id === value.scenes[index].sceneId) ? value : undefined;
}

export function ParallelSceneOutput({ output, source, onParallelRecovery }: { output: AuxiliaryOutput; source?: string; onParallelRecovery?: (runId: string) => void }) {
  const value = committedParallelScenes(output);
  if (!value) return <section className="auxiliary-output"><h3>{output.title}</h3><p className="error" role="alert">平行场景输出格式或作者权限标记无效，或宿主提交标记不匹配，无法呈现。</p></section>;
  return <section className="auxiliary-output parallel-scene-output" aria-label={output.title}><h3>{output.title} · 作者附加场景</h3>
    {source && <p className="fine output-source">{source}</p>}<p className="fine output-source">世界版本 {value.worldRevision} · 原素材回合 {value.materialTurnId ?? '未记录'}。独立场景成文；主场正文与短信分开保留。</p>
    {!value.scenes.length && <p className="muted">本轮没有可呈现的平行场景。</p>}
    {value.scenes.map(scene => <details key={scene.id}><summary>{scene.title} · {{ pending: '等待成文', completed: '成文完成', failed: '成文失败' }[scene.status]}</summary>
      <p className="fine output-source">场景 {scene.sceneId} · 记录 {scene.id}</p><p>地点：{scene.location} · 时间：{scene.time?.trim() ? scene.time : '未知'}</p>
      <p>参与者：{scene.cast.map(role => `${role.name}（${role.roleId}）`).join('、')}</p>
      {scene.status === 'completed' && scene.prose && <div className="parallel-scene-prose">{scene.prose.title && <h4>{scene.prose.title}</h4>}{scene.prose.text.split('\n').map((line, index) => line.trim() && <p key={index}>{line}</p>)}<p className="fine">{scene.prose.person === 'first' ? '第一人称' : '第三人称'} · {scene.prose.pov === 'limited' ? '限知' : '全知'}</p></div>}
      {scene.status !== 'completed' && <p className="notice">{scene.status === 'failed' ? '此场景成文失败；原记录保留，未自动重试。' : '此场景尚未完成成文；未自动重试。'}</p>}
      {scene.error && <p className="error output-text">{scene.error}</p>}
      {scene.status !== 'completed' && onParallelRecovery && <button type="button" onClick={() => onParallelRecovery(scene.id)}>准备按原材料重新成文</button>}
    </details>)}
  </section>;
}
