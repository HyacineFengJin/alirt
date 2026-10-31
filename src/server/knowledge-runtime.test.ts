import { describe, expect, it } from 'vitest';
import type { Knowledge, RoleDefinition } from '../shared/types';
import type { ProvenancedKnowledge } from '../shared/knowledge';
import { eligibleKnowledgeReferences, migrateKnowledge, projectKnowledgeEntries, projectRoleKnowledge, proposeKnowledgeDelivery, proposeKnowledgeEdit, validateKnowledgeDelivery, type KnowledgeSession } from './knowledge-runtime';

const role = (id: string, knowledge: Knowledge[] = []): RoleDefinition => ({ id, name: id, persona: '', goals: [], peers: [], phase: 'active', presence: 'present', state: {}, knowledge });
const fixture = (): KnowledgeSession => ({ roles: [role('alice', [
  { id: 'bell', text: 'The bell is broken.', audience: ['alice'], status: 'known' },
  { id: 'private', text: 'Author-only secret.', audience: 'author', status: 'known' },
]), role('bob'), role('cara')] });
const source = (session: KnowledgeSession, roleId: string, id: string) => (session.roles.find(role => role.id === roleId)!.knowledge.find(entry => entry.id === id) as ProvenancedKnowledge).provenance!.sourceId;
const claim = (session: KnowledgeSession, roleId: string, id: string) => session.roles.find(role => role.id === roleId)!.knowledge.find(entry => entry.id === id) as ProvenancedKnowledge;

describe('provenance-aware character knowledge proposals', () => {
  it('migrates old card claims once, without mutating input or replaying anything', () => {
    const old = fixture(), migrated = migrateKnowledge(old);
    expect(old.knowledgeRegistry).toBeUndefined(); expect(old.roles[0].knowledge[0]).not.toHaveProperty('provenance');
    expect(migrated.knowledgeRegistry!.sources).toHaveLength(2);
    expect(migrateKnowledge(migrated)).toEqual(migrated);
    expect(projectRoleKnowledge(migrated, 'alice', 'bob')).toEqual([]);
    expect(eligibleKnowledgeReferences(migrated, 'alice')).toEqual([{ id: source(migrated, 'alice', 'bell'), text: 'The bell is broken.', status: 'known' }]);
  });

  it('invalidates multi-hop peer claims and derived summaries after root withdrawal', () => {
    let session = migrateKnowledge(fixture());
    session = proposeKnowledgeDelivery(session, { id: 'mail-1', from: 'alice', to: 'bob', body: 'Alice says the bell is broken.', sourceRefs: [source(session, 'alice', 'bell')] });
    session = proposeKnowledgeEdit(session, { operation: 'upsert', roleId: 'bob', id: 'summary', text: 'Reported bell problem.', status: 'known', sourceRefs: [source(session, 'bob', 'peer:mail-1')] });
    session = proposeKnowledgeDelivery(session, { id: 'mail-2', from: 'bob', to: 'cara', body: 'Bob reports a bell problem.', sourceRefs: [source(session, 'bob', 'summary')] });
    const before = structuredClone(session);
    const withdrawn = proposeKnowledgeEdit(session, { operation: 'retract', roleId: 'alice', id: 'bell' });
    expect(session).toEqual(before);
    expect(claim(withdrawn, 'alice', 'bell').lifecycle).toBe('withdrawn');
    expect(claim(withdrawn, 'bob', 'peer:mail-1').lifecycle).toBe('stale');
    expect(claim(withdrawn, 'bob', 'summary').lifecycle).toBe('stale');
    expect(claim(withdrawn, 'cara', 'peer:mail-2').lifecycle).toBe('stale');
    expect(projectRoleKnowledge(withdrawn, 'alice', 'alice')).toEqual([]);
    expect(projectRoleKnowledge(withdrawn, 'bob', 'bob')).toEqual([]);
    expect(projectRoleKnowledge(withdrawn, 'cara', 'cara')).toEqual([]);
    expect(projectRoleKnowledge(withdrawn, 'cara', 'author')[0].text).toBe('Bob reports a bell problem.');
    expect(withdrawn.knowledgeRegistry!.history).toHaveLength(4);
  });

  it('never turns a received or derived rumor into known truth and never copies sender memory', () => {
    let session = migrateKnowledge(fixture());
    session = proposeKnowledgeDelivery(session, { id: '1', from: 'alice', to: 'bob', body: 'A bell might be broken.', sourceRefs: [source(session, 'alice', 'bell')] });
    expect(session.roles[1].knowledge).toHaveLength(1);
    expect(claim(session, 'bob', 'peer:1')).toMatchObject({ text: 'A bell might be broken.', status: 'uncertain', audience: ['bob'] });
    session = proposeKnowledgeEdit(session, { operation: 'upsert', roleId: 'bob', id: 'summary', text: 'Bell report.', status: 'known', sourceRefs: [source(session, 'bob', 'peer:1')] });
    expect(claim(session, 'bob', 'summary').status).toBe('uncertain');
    session = proposeKnowledgeDelivery(session, { id: '2', from: 'bob', to: 'cara', body: 'Bell report.', sourceRefs: [source(session, 'bob', 'summary')] });
    expect(claim(session, 'cara', 'peer:2').status).toBe('uncertain');
    const publicView = projectRoleKnowledge(session, 'bob', 'bob');
    expect(JSON.stringify(publicView)).not.toContain('sourceRefs');
    expect(JSON.stringify(publicView)).not.toContain(source(session, 'alice', 'bell'));
    expect(publicView).not.toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Author-only secret.' })]));
  });

  it('validates source permission for sender, while explicit speech does not grant the recipient source access', () => {
    const session = migrateKnowledge(fixture()), bell = source(session, 'alice', 'bell'), secret = source(session, 'alice', 'private');
    expect(() => proposeKnowledgeDelivery(session, { id: 'bad', from: 'alice', to: 'bob', body: 'Secret.', sourceRefs: [secret] })).toThrow('not available to the sender');
    expect(() => proposeKnowledgeDelivery(session, { id: 'bad', from: 'bob', to: 'cara', body: 'A claim.', sourceRefs: [bell] })).toThrow('not available to the sender');
    const delivered = proposeKnowledgeDelivery(session, { id: 'good', from: 'alice', to: 'bob', body: 'A claim.', sourceRefs: [bell] });
    expect(eligibleKnowledgeReferences(delivered, 'bob').map(item => item.text)).toEqual(['A claim.']);
    expect(projectRoleKnowledge(delivered, 'alice', 'bob')).toEqual([]);
    expect(projectRoleKnowledge(delivered, 'bob', 'cara')).toEqual([]);
  });

  it('returns atomic proposals when replacement would depend on its withdrawn version', () => {
    let session = migrateKnowledge(fixture());
    session = proposeKnowledgeEdit(session, { operation: 'upsert', roleId: 'bob', id: 'summary', text: 'Summary.', sourceRefs: [source(session, 'alice', 'bell')] });
    const before = structuredClone(session);
    expect(() => proposeKnowledgeEdit(session, { operation: 'upsert', roleId: 'alice', id: 'bell', text: 'New bell claim.', sourceRefs: [source(session, 'bob', 'summary')] })).toThrow('no longer active');
    expect(session).toEqual(before);
    expect(() => proposeKnowledgeEdit(session, { operation: 'upsert', roleId: 'alice', id: 'new', text: 'Nope.', sourceRefs: ['missing'] })).toThrow('Unknown knowledge source');
    expect(session).toEqual(before);
  });

  it('archives replacement text and stales descendants without deleting history', () => {
    let session = migrateKnowledge(fixture());
    const oldSource = source(session, 'alice', 'bell');
    session = proposeKnowledgeDelivery(session, { id: 'mail', from: 'alice', to: 'bob', body: 'Old claim.', sourceRefs: [oldSource] });
    const next = proposeKnowledgeEdit(session, { operation: 'upsert', roleId: 'alice', id: 'bell', text: 'The bell was repaired.', status: 'known' });
    expect(claim(next, 'alice', 'bell')).toMatchObject({ text: 'The bell was repaired.', lifecycle: 'active' });
    expect(source(next, 'alice', 'bell')).not.toBe(oldSource);
    expect(next.knowledgeRegistry!.sources.find(entry => entry.id === oldSource)).toMatchObject({ text: 'The bell is broken.', lifecycle: 'withdrawn' });
    expect(next.knowledgeRegistry!.history.map(entry => entry.knowledge.text)).toContain('The bell is broken.');
    expect(projectRoleKnowledge(next, 'bob', 'bob')).toEqual([]);
  });

  it('deduplicates delivery receipts and source refs, including after withdrawal', () => {
    let session = migrateKnowledge(fixture()), bell = source(session, 'alice', 'bell');
    const delivery = { id: 'once', from: 'alice', to: 'bob', body: 'A claim.', sourceRefs: [bell, bell] };
    session = proposeKnowledgeDelivery(session, delivery);
    expect(claim(session, 'bob', 'peer:once').provenance!.sourceRefs).toEqual([bell]);
    expect(proposeKnowledgeDelivery(session, delivery)).toEqual(session);
    expect(() => proposeKnowledgeDelivery(session, { ...delivery, body: 'Changed.' })).toThrow('already used');
    session = proposeKnowledgeEdit(session, { operation: 'retract', roleId: 'alice', id: 'bell' });
    expect(proposeKnowledgeDelivery(session, delivery)).toEqual(session);
    expect(projectRoleKnowledge(session, 'bob', 'bob')).toEqual([]);
  });

  it('accepts unlinked speech conservatively without inventing dependencies', () => {
    let session = proposeKnowledgeDelivery(fixture(), { id: 'legacy', from: 'alice', to: 'bob', body: 'I heard a bell.' });
    session = proposeKnowledgeEdit(session, { operation: 'retract', roleId: 'alice', id: 'bell' });
    expect(projectRoleKnowledge(session, 'bob', 'bob')).toEqual([{ id: 'peer:legacy', text: 'I heard a bell.', audience: ['bob'], status: 'uncertain' }]);
  });

  it('validates queued mail without learning and rejects stale sources at a later receipt', () => {
    let session = migrateKnowledge(fixture());
    const delivery = { id: 'queued', from: 'alice', to: 'bob', body: 'A claim.', sourceRefs: [source(session, 'alice', 'bell')] };
    const before = structuredClone(session);
    validateKnowledgeDelivery(session, delivery);
    expect(session).toEqual(before); expect(session.roles[1].knowledge).toEqual([]);
    session = proposeKnowledgeEdit(session, { operation: 'retract', roleId: 'alice', id: 'bell' });
    expect(() => proposeKnowledgeDelivery(session, delivery)).toThrow('no longer active');
    expect(session.roles[1].knowledge).toEqual([]);
  });

  it('preserves legacy empty audiences and provides isolated fast projections', () => {
    const old = fixture(); old.roles[0].knowledge[0].audience = [];
    const session = migrateKnowledge(old);
    expect(projectKnowledgeEntries(session.roles[0].knowledge, 'alice')).toEqual([]);
    const author = projectKnowledgeEntries(session.roles[0].knowledge, 'author');
    author[0].text = 'Modified';
    expect(session.roles[0].knowledge[0].text).toBe('The bell is broken.');
    expect(eligibleKnowledgeReferences(session, 'alice')).toEqual([]);
  });

  it('preserves dependencies on ordinary edits and does not invalidate identical upserts', () => {
    let session = migrateKnowledge(fixture());
    const bell = source(session, 'alice', 'bell');
    session = proposeKnowledgeEdit(session, { operation: 'upsert', roleId: 'bob', id: 'summary', text: 'Summary.', sourceRefs: [bell] });
    const before = structuredClone(session);
    expect(proposeKnowledgeEdit(session, { operation: 'upsert', roleId: 'bob', id: 'summary', text: 'Summary.' })).toEqual(before);
    session = proposeKnowledgeEdit(session, { operation: 'upsert', roleId: 'bob', id: 'summary', text: 'Reworded summary.' });
    expect(claim(session, 'bob', 'summary').provenance!.sourceRefs).toEqual([bell]);
    session = proposeKnowledgeEdit(session, { operation: 'retract', roleId: 'alice', id: 'bell' });
    expect(projectRoleKnowledge(session, 'bob', 'bob')).toEqual([]);
  });

  it('rejects unknown graph refs, cycles, duplicate ids and prototype keys without mutating inputs', () => {
    const session = migrateKnowledge(fixture());
    const malformed = structuredClone(session);
    malformed.knowledgeRegistry!.sources[0].sourceRefs = ['unknown'];
    const before = structuredClone(malformed);
    expect(() => migrateKnowledge(malformed)).toThrow('Unknown knowledge source'); expect(malformed).toEqual(before);
    const cyclic = structuredClone(session), id = cyclic.knowledgeRegistry!.sources[0].id;
    cyclic.knowledgeRegistry!.sources[0].sourceRefs = [id];
    expect(() => migrateKnowledge(cyclic)).toThrow('cycle');
    const duplicate = fixture(); duplicate.roles[0].knowledge.push(structuredClone(duplicate.roles[0].knowledge[0]));
    expect(() => migrateKnowledge(duplicate)).toThrow('Duplicate');
    for (const id of ['__proto__', 'constructor', 'prototype']) {
      expect(() => proposeKnowledgeEdit(session, { operation: 'upsert', roleId: 'alice', id, text: 'Bad.' })).toThrow('Invalid knowledge id');
      expect(() => proposeKnowledgeDelivery(session, { id: 'bad', from: 'alice', to: 'bob', body: 'Bad.', sourceRefs: [id] })).toThrow('Invalid knowledge source');
    }
    expect(session.knowledgeRegistry!.sources).toHaveLength(2);
  });
});
