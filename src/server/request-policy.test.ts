import { describe, expect, it } from 'vitest';
import { privateRequestPolicies } from './provider';

describe('private native request-policy metadata', () => {
  it('retains historical named-policy facts and redacts credentials without serializing request contents', () => {
    const saved = privateRequestPolicies([{ sessionId: 'story-KEY-prose', purpose: null, toolNames: ['submit_result'], choice: { type: 'tool', name: 'submit_result', body: 'PRIVATE_BODY' },
      messages: 'PRIVATE_CONTENT', headers: { authorization: 'KEY' }, tools: [{ parameters: 'PRIVATE_SCHEMA' }], config: 'PRIVATE_CONFIG' },
    { sessionId: 'story-role-npc', purpose: 'compaction', toolNames: ['read_draft', 'KEY'], choice: null }], 'KEY');
    expect(saved).toEqual([{ sessionId: 'story-[redacted]-prose', purpose: null, toolNames: ['submit_result'], choice: { type: 'tool', name: 'submit_result' } },
      { sessionId: 'story-role-npc', purpose: 'compaction', toolNames: ['read_draft', '[redacted]'], choice: null }]);
    const json = JSON.stringify(saved);
    for (const omitted of ['KEY', 'PRIVATE_', 'headers', 'authorization', 'parameters', 'config', 'messages']) expect(json).not.toContain(omitted);
  });
  it('retains the current any policy for sole-tool and multi-tool deliveries', () => {
    const records = [
      { sessionId: 'story-prose', purpose: null, toolNames: ['submit_result'], choice: { type: 'any' } },
      { sessionId: 'story-role-npc', purpose: null, toolNames: ['peer_send', 'submit_result'], choice: { type: 'any' } },
    ];
    expect(privateRequestPolicies(records)).toEqual(records);
  });
  it('does not accept arbitrary named tools or malformed values into policy metadata', () => {
    expect(privateRequestPolicies(null)).toEqual([]);
    const saved = privateRequestPolicies([null, [], { sessionId: {}, purpose: 'unrecognized', toolNames: [{ body: 'PRIVATE' }, 'submit_result'], choice: { type: 'tool', name: 'terminal' } }]);
    expect(saved).toEqual([{ sessionId: null, purpose: null, toolNames: ['submit_result'], choice: null }]);
  });
});
