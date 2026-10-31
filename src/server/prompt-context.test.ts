import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CharacterCard, Preset } from '../shared/types';
import cardJson from '../../content/cards/harbor.json';
import presetJson from '../../content/presets/basic.json';
import { bindPromptContext } from './prompt-context';
import { clone, project, SessionStore } from './store';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rp-prompt-context-test-')); roots.push(root);
  const store = new SessionStore(root), session = store.create(cardJson as CharacterCard, presetJson as Preset);
  const bind = (fingerprint: string, base = `${session.id}-role-liang-du`) => bindPromptContext(store, session.id, 'role:liang-du', base, fingerprint);
  return { root, store, session, bind };
}

describe('durable native context bindings', () => {
  it('avoids unknown legacy transcripts and reuses an unchanged binding without saving an event', async () => {
    const { store, session, bind } = await fixture();
    const first = bind('admitted-a');
    expect(first).toEqual({ sessionId: `${session.id}-role-liang-du-p1`, generation: 1, changed: true });
    const events = clone(store.get(session.id).events);
    expect(bind('admitted-a')).toEqual({ sessionId: first.sessionId, generation: 1, changed: false });
    expect(store.get(session.id).events).toEqual(events);
    expect(store.get(session.id).promptContexts?.['role:liang-du'].sessionId).toBe(first.sessionId);
  });

  it('never reuses an older transcript after withdrawal and re-enabling', async () => {
    const { store, session, bind } = await fixture();
    const first = bind('includes-source');
    const withdrawn = bind('source-withdrawn');
    const enabledAgain = bind('includes-source');
    expect(withdrawn).toMatchObject({ generation: 2, changed: true, previousSessionId: first.sessionId });
    expect(enabledAgain).toMatchObject({ generation: 3, changed: true, previousSessionId: withdrawn.sessionId });
    expect(new Set([first.sessionId, withdrawn.sessionId, enabledAgain.sessionId]).size).toBe(3);
    expect(Object.keys(store.get(session.id).promptContexts!)).toEqual(['role:liang-du']);
    expect(store.get(session.id).promptContexts?.['role:liang-du'].fingerprint).toBe('includes-source');
  });

  it('advances when a faded role changes its base session identity', async () => {
    const { session, bind } = await fixture();
    const first = bind('same-admission');
    const next = bind('same-admission', `${session.id}-role-liang-du-g1`);
    expect(next).toEqual({ sessionId: `${session.id}-role-liang-du-g1-p2`, generation: 2, changed: true, previousSessionId: first.sessionId });
  });

  it('persists reuse and monotonic replacement across server restarts', async () => {
    const { root, session, bind } = await fixture();
    const first = bind('current');
    const recovered = new SessionStore(root);
    expect(bindPromptContext(recovered, session.id, 'role:liang-du', `${session.id}-role-liang-du`, 'current')).toEqual({ sessionId: first.sessionId, generation: 1, changed: false });
    expect(bindPromptContext(recovered, session.id, 'role:liang-du', `${session.id}-role-liang-du`, 'new')).toMatchObject({ generation: 2, changed: true, previousSessionId: first.sessionId });
    expect(new SessionStore(root).get(session.id).promptContexts?.['role:liang-du'].generation).toBe(2);
  });

  it('keeps bindings private and records only author-visible body-free diagnostics', async () => {
    const { store, session, bind } = await fixture();
    bind('PRIVATE_ADMISSION_FINGERPRINT');
    const current = store.get(session.id);
    expect(project(current)).not.toHaveProperty('promptContexts');
    expect(project(current, session.playerRoleId)).not.toHaveProperty('promptContexts');
    const diagnostic = current.events.find(entry => entry.kind === 'context-rebound')!;
    expect(diagnostic.audience).toBe('author');
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_ADMISSION_FINGERPRINT');
    expect(project(current, session.playerRoleId).events.some(entry => entry.kind === 'context-rebound')).toBe(false);
  });

  it('does not change world revision, copy memory, or affect another agent binding', async () => {
    const { store, session, bind } = await fixture();
    const before = clone(store.get(session.id));
    const role = bind('role-a');
    const prose = bindPromptContext(store, session.id, 'prose', `${session.id}-prose`, 'prose-a');
    bind('role-b');
    const after = store.get(session.id);
    expect(after.revision).toBe(before.revision);
    expect(after.world).toEqual(before.world); expect(after.roles).toEqual(before.roles);
    expect(after.roleContexts).toEqual(before.roleContexts); expect(after.prose).toEqual(before.prose);
    expect(after.promptContexts?.prose.sessionId).toBe(prose.sessionId);
    expect(after.promptContexts?.['role:liang-du'].sessionId).not.toBe(role.sessionId);
    expect(after.promptContexts?.['role:liang-du']).not.toHaveProperty('retained');
  });
});
