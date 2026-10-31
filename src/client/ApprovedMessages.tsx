import type { AuxiliaryOutput } from '../shared/types';
import './ApprovedMessages.css';

interface ApprovedMessage {
  behaviorId: string;
  roleId: string;
  name: string;
  text: string;
  channel: 'message';
}
interface ApprovedMessageTranscript {
  schema: 'rp.approved-messages/0.1';
  materialTurnId: string | null;
  worldRevision: number;
  messages: ApprovedMessage[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** This view consumes the host's committed transcript, never prose or role reports.
 * Reject the entire attachment when its envelope or provenance is inconsistent. */
export function approvedMessageTranscript(output: AuxiliaryOutput): ApprovedMessageTranscript | null {
  const value: unknown = output.value;
  const provenance: unknown = output.provenance;
  if (output.type !== 'object' || !record(value)
    || !exactKeys(value, ['schema', 'materialTurnId', 'worldRevision', 'messages'])
    || value.schema !== 'rp.approved-messages/0.1'
    || !(value.materialTurnId === null || typeof value.materialTurnId === 'string' && !!value.materialTurnId.trim())
    || !Number.isSafeInteger(value.worldRevision) || (value.worldRevision as number) < 0
    || !Array.isArray(value.messages)
    || (value.messages.length > 0 && (typeof value.materialTurnId !== 'string' || !value.materialTurnId.trim()))
    || !record(provenance) || !exactKeys(provenance, ['kind', 'materialTurnId', 'behaviorIds', 'worldRevision'])
    || provenance.kind !== 'committed-behaviors'
    || provenance.materialTurnId !== value.materialTurnId || provenance.worldRevision !== value.worldRevision
    || !Array.isArray(provenance.behaviorIds) || provenance.behaviorIds.length !== value.messages.length) return null;

  const seen = new Set<string>();
  for (const [index, message] of value.messages.entries()) {
    if (!record(message) || !exactKeys(message, ['behaviorId', 'roleId', 'name', 'text', 'channel'])
      || typeof message.behaviorId !== 'string' || !message.behaviorId.trim()
      || typeof message.roleId !== 'string' || !message.roleId.trim()
      || typeof message.name !== 'string' || typeof message.text !== 'string' || !message.text.trim() || message.channel !== 'message'
      || seen.has(message.behaviorId) || provenance.behaviorIds[index] !== message.behaviorId) return null;
    seen.add(message.behaviorId);
  }
  return value as unknown as ApprovedMessageTranscript;
}

function MessageIcon() {
  return <svg className="approved-messages-icon" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" /><path d="M8 10h8M8 14h5" /></svg>;
}

export function ApprovedMessages({ output, source }: { output: AuxiliaryOutput; source?: string }) {
  const transcript = approvedMessageTranscript(output);
  if (!transcript) return <section className="auxiliary-output approved-messages approved-messages-unavailable" aria-label="远程消息">
    <h3><MessageIcon />远程消息</h3>
    <p className="muted">消息记录暂不可用，记录格式或来源不完整。</p>
  </section>;
  if (!transcript.messages.length) return null;

  return <details className="auxiliary-output approved-messages">
    <summary>
      <span className="approved-messages-heading"><MessageIcon /><span>远程消息{output.title && output.title !== '远程消息' && <small>{output.title}</small>}</span></span>
      <span className="approved-messages-count">{transcript.messages.length} 条短信</span>
      <span className="approved-messages-chevron" aria-hidden="true">›</span>
    </summary>
    <div className="approved-messages-content">
      {source && <p className="fine output-source">{source}</p>}
      <p className="approved-messages-context">本段已确认 · 世界版本 {transcript.worldRevision}</p>
      <ol className="approved-messages-list" aria-label="按确认顺序排列的远程消息">
        {transcript.messages.map(message => <li key={message.behaviorId} className="approved-message">
          <span className="approved-message-avatar" aria-hidden="true">{Array.from(message.name)[0] || '·'}</span>
          <div className="approved-message-main">
            <span className="approved-message-sender">{message.name}</span>
            <p className="approved-message-text">{message.text}</p>
          </div>
        </li>)}
      </ol>
    </div>
  </details>;
}
