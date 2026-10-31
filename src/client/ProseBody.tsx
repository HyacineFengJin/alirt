import { Fragment } from 'react';
import type { ProseEntry } from '../shared/types';
import { proseBodyText, validProseBody } from '../shared/prose-body';
import { validResolvedRoleVisual, type ResolvedRoleVisual } from '../shared/visual-assets';
import { ViewImage } from './VisualAssets';
import './ProseBody.css';

function paragraphs(text: string) {
  return text.split(/\n\s*\n|\n/).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>);
}

/** Saved blocks are presentation snapshots, not a lookup into today's cast or
 * source settings. If they cannot reproduce the saved text, use that text alone. */
export function entrySpeechVisual(entry: Pick<ProseEntry, 'body' | 'visuals'>, ref: string, roleId: string): { visual?: ResolvedRoleVisual; invalid: boolean } {
  const value: unknown = entry.visuals;
  if (value === undefined) return { invalid: false };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'schema,speakers'
    || !('schema' in value) || value.schema !== 'rp.entry-visuals/0.1' || !('speakers' in value) || !Array.isArray(value.speakers) || !validProseBody(entry.body)) return { invalid: true };
  const seen = new Set<string>();
  for (const item of value.speakers) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join() !== 'ref,visual' || typeof item.ref !== 'string' || seen.has(item.ref)
      || !validResolvedRoleVisual(item.visual) || !entry.body.blocks.some(block => block.kind === 'speech' && block.ref === item.ref && block.roleId === item.visual.roleId)) return { invalid: true };
    seen.add(item.ref);
  }
  const match = value.speakers.find(item => item.ref === ref && item.visual.roleId === roleId);
  return { visual: match?.visual, invalid: false };
}
export function ProseBody({ entry, onEditVisual }: { entry: Pick<ProseEntry, 'text' | 'body' | 'visuals'>; onEditVisual?: (roleId: string) => void }) {
  const body = validProseBody(entry.body) && proseBodyText(entry.body) === entry.text ? entry.body : undefined;
  if (!body) return <>{paragraphs(entry.text)}</>;
  return <div className="prose-body">
    {body.blocks.map((block, index) => {
      if (block.kind === 'narration') return <Fragment key={index}>{paragraphs(block.text)}</Fragment>;
      const saved = entrySpeechVisual(entry, block.ref, block.roleId);
      const avatar = <ViewImage image={saved.visual?.image} crop={saved.visual?.crop} name={block.name} diagnostic/>;
      return <div className={`prose-dialogue prose-dialogue-${block.speaker}`} key={index} data-role-id={block.roleId} data-speech-ref={block.ref} role="group" aria-label={`${block.name} · ${block.speaker === 'player' ? '玩家' : '角色'}本地对白`}>
        {entry.visuals !== undefined && <div className="prose-dialogue-avatar-row">{onEditVisual ? <button type="button" className="prose-dialogue-avatar" aria-label={`编辑${block.name}对白头像`} onClick={() => onEditVisual(block.roleId)}>{avatar}</button> : <span className="prose-dialogue-avatar">{avatar}</span>}{saved.invalid && <small className="fine">头像快照不可用，显示姓名占位</small>}</div>}
        <div className="prose-dialogue-label"><span>{block.name}</span><small>{block.speaker === 'player' ? '玩家' : '角色'} · 本地对白</small></div>
        <p className="prose-dialogue-text">{block.text}</p>
      </div>;
    })}
  </div>;
}
