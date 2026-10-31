import type { AuxiliaryOutput } from '../shared/types';
import { validViewedCarriersOutput, type ViewedCarriersOutput } from '../shared/text-carriers';
import './ViewedCarriers.css';

export function committedViewedCarriers(output: AuxiliaryOutput): ViewedCarriersOutput | undefined {
  const stamp = output.provenance;
  if (output.audience !== 'public' || output.type !== 'object' || output.display?.renderer !== 'viewed-carriers' || stamp?.kind !== 'committed-carrier-views' || !validViewedCarriersOutput(output.value)) return undefined;
  const value = output.value;
  return stamp.materialTurnId === value.materialTurnId && stamp.worldRevision === value.worldRevision
    && Array.isArray(stamp.viewIds) && stamp.viewIds.length === value.views.length
    && stamp.viewIds.every((id, index) => id === value.views[index].id) ? value : undefined;
}
export function ViewedCarriers({ output, source }: { output: AuxiliaryOutput; source?: string }) {
  const value = committedViewedCarriers(output);
  if (!value) return <section className="auxiliary-output viewed-carriers"><h3>{output.title}</h3><p className="error" role="alert">载体查看记录格式或宿主来源不匹配，无法呈现。</p></section>;
  if (!value.views.length) return null;
  return <section className="auxiliary-output viewed-carriers" aria-label="已提交的载体查看">
    <h3>{output.title || '载体界面'}</h3>{source && <p className="fine output-source">{source}</p>}
    <p className="fine">来自已提交的查看 · 世界版本 {value.worldRevision}。记录查看时读到的文字，不证明文字内容为真。</p>
    {value.views.map(view => <article className={`viewed-carrier viewed-carrier-${view.carrier.medium}`} key={view.id} data-view-id={view.id}>
      <header><h4>{view.carrier.title}</h4><p className="fine">{view.carrier.medium === 'paper' ? '纸面' : '屏幕'} · 版本 {view.carrierVersion} · 查看者：{view.readerName} · 地点：{view.location} · 世界时间：{view.time?.trim() ? view.time : '未知'}</p></header>
      <p className="viewed-carrier-text">{view.carrier.text}</p>
    </article>)}
  </section>;
}
