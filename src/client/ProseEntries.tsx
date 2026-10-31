import type { ProseEntry } from "../shared/types";
import { EntryOutputs } from "./AuxiliaryOutputs";
import { ProseBody } from './ProseBody';

export function ProseEntries({ entries, chooseAction, onParallelRecovery, onEditVisual }: { entries: ProseEntry[]; chooseAction?: (text: string) => void; onParallelRecovery?: (runId: string) => void; onEditVisual?: (roleId: string) => void }) {
  return (
    <>
      {entries.map((entry, index) => (
        <section key={entry.id}>
          {entry.title && <h2>{entry.title}</h2>}
          <EntryOutputs entry={entry} placement="before-prose" entriesAgo={entries.length - index - 1} chooseAction={chooseAction} onParallelRecovery={onParallelRecovery} />
          <ProseBody entry={entry} onEditVisual={onEditVisual}/>
          <EntryOutputs entry={entry} placement="after-prose" entriesAgo={entries.length - index - 1} chooseAction={chooseAction} onParallelRecovery={onParallelRecovery} />
          <details className="entry-meta">
            <summary>成文记录 {index + 1}</summary>
            <span>
              世界版本 {entry.worldRevision}
              {entry.person ? ` · ${entry.person}` : ""}
              {entry.pov ? ` · ${entry.pov}` : ""}
              {entry.turnId ? ` · 回合 ${entry.turnId}` : ""}
            </span>
          </details>
        </section>
      ))}
    </>
  );
}
