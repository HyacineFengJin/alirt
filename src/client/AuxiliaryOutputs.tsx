import type { AuxiliaryOutput, Json, ProseEntry } from "../shared/types";
import { safeFrontendPreview } from '../shared/html-preview';
import { ApprovedMessages, approvedMessageTranscript } from './ApprovedMessages';
import './AuxiliaryOutputs.css';
import { ParallelSceneOutput } from './ParallelSceneOutput';
import { committedViewedCarriers, ViewedCarriers } from './ViewedCarriers';

function plainValue(value: Json): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** Untrusted output text stays literal; imported presentation scripts never run. */
export function outputText(output: AuxiliaryOutput): string { return plainValue(output.value); }

function OutputValue({ output, chooseAction }: { output: AuxiliaryOutput; chooseAction?: (text: string) => void }) {
  if (output.display?.renderer === 'sandbox-html' && typeof output.value === 'string') return <iframe title={output.title} sandbox="" referrerPolicy="no-referrer" className="frontend-preview output-html" srcDoc={safeFrontendPreview(output.value)} />;
  if (output.type === "list" && Array.isArray(output.value)) {
    if (output.display?.renderer === "choices") return <div className="output-choices">
      <p className="fine">选择后填入行动框，由你决定是否提交。</p>
      {output.value.map((item, index) => typeof item === "string" && <button type="button" key={index} disabled={!chooseAction || !item.trim()} onClick={() => chooseAction?.(item)}>{item}</button>)}
    </div>;
    return output.value.length ? (
      <ul>
        {output.value.map((item, index) => (
          <li key={index}>{plainValue(item)}</li>
        ))}
      </ul>
    ) : (
      <p className="muted">暂无条目。</p>
    );
  }
  return output.type === "text" ? (
    <p className="output-text">{outputText(output)}</p>
  ) : (
    <pre className="source-text">{JSON.stringify(output.value, null, 2)}</pre>
  );
}

function Output({ output, source, chooseAction, onParallelRecovery }: { output: AuxiliaryOutput; source?: string; chooseAction?: (text: string) => void; onParallelRecovery?: (runId: string) => void }) {
  if (output.display?.renderer === 'messages') return <ApprovedMessages output={output} source={source} />;
  if (output.display?.renderer === 'parallel-scenes') return <ParallelSceneOutput output={output} source={source} onParallelRecovery={onParallelRecovery} />;
  if (output.display?.renderer === 'viewed-carriers') return <ViewedCarriers output={output} source={source} />;
  const contents = <>{source && <p className="fine output-source">{source}</p>}{output.display?.source && <p className="fine output-source">来源格式 · {output.display.source.importId}</p>}{output.provenance?.kind === 'state' && <p className="fine output-source">来自已提交状态 · 世界版本 {output.provenance.worldRevision}{!output.provenance.known ? ' · 未设定' : ''}</p>}{output.provenance?.kind === 'committed-progress' && <p className="fine output-source">已提交世界进展 · 修订 {output.provenance.sequence} · 世界版本 {output.provenance.worldRevision}</p>}<OutputValue output={output} chooseAction={chooseAction} /></>;
  if (output.display?.renderer === "folded") return <details className="auxiliary-output"><summary>{output.title}</summary>{contents}</details>;
  return (
    <section className="auxiliary-output" aria-label={output.title}>
      <h3>{output.title}</h3>
      {contents}
    </section>
  );
}

export function outputVisible(output: AuxiliaryOutput, entriesAgo: number) {
  if (output.display?.renderer === 'messages' && approvedMessageTranscript(output)?.messages.length === 0) return false;
  if (output.display?.renderer === 'viewed-carriers' && committedViewedCarriers(output)?.views.length === 0) return false;
  const history = output.display?.history;
  return !history || (history.minEntriesAgo === undefined || entriesAgo >= history.minEntriesAgo)
    && (history.maxEntriesAgo === undefined || entriesAgo <= history.maxEntriesAgo);
}

function entryAttachments(entry: ProseEntry) { return entry.attachments ?? []; }

/** Receives only backend-projected prose; audience filtering stays on the server. */
export function EntryOutputs({ entry, placement, entriesAgo = 0, chooseAction, onParallelRecovery }: { entry: ProseEntry; placement: 'before-prose' | 'after-prose'; entriesAgo?: number; chooseAction?: (text: string) => void; onParallelRecovery?: (runId: string) => void }) {
  const outputs = entryAttachments(entry).filter(
    (output) => output.placement === placement && outputVisible(output, entriesAgo),
  );
  return outputs?.length ? (
    <aside className={`${placement}-outputs`} aria-label={placement === 'before-prose' ? '本段前置输出' : '本段附加输出'}>
      {outputs.map((output, index) => <Output key={`${output.key}:${index}`} output={output} chooseAction={chooseAction} onParallelRecovery={onParallelRecovery} />)}
    </aside>
  ) : null;
}
export function AfterProseOutputs(props: { entry: ProseEntry; entriesAgo?: number; chooseAction?: (text: string) => void }) {
  return <EntryOutputs {...props} placement="after-prose" />;
}

export function latestSidePanelOutputs(prose: ProseEntry[]) {
  const seen = new Set<string>();
  const latest: { output: AuxiliaryOutput; entry: ProseEntry }[] = [];
  for (const [entriesAgo, entry] of [...prose].reverse().entries()) {
    for (const output of entryAttachments(entry)) {
      if (seen.has(output.key)) continue;
      seen.add(output.key);
      if (output.placement === "side-panel" && outputVisible(output, entriesAgo)) latest.push({ output, entry });
    }
  }
  return latest;
}

export function SidePanelOutputs({ prose, chooseAction }: { prose: ProseEntry[]; chooseAction?: (text: string) => void }) {
  const outputs = latestSidePanelOutputs(prose);
  return outputs.length ? (
    <>
      <p className="fine">各项附加输出的最近记录。</p>
      {outputs.map(({ output, entry }) => (
        <Output
          key={output.key}
          output={output}
          chooseAction={chooseAction}
          source={`${entry.title ? `${entry.title} · ` : ""}${entry.turnId ? `回合 ${entry.turnId}` : "开篇"} · 世界版本 ${entry.worldRevision}`}
        />
      ))}
    </>
  ) : (
    <p className="muted">尚无可显示的侧栏输出。</p>
  );
}
