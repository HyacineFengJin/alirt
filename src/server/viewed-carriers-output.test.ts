import { describe, expect, it } from 'vitest';
import { createNativeTemplate } from '../shared/native';
import type { CharacterCard, OutputContract, Preset, WorldEvent } from '../shared/types';
import type { TextCarrierState, TextCarrierViewReceipt, ViewedCarriersOutput } from '../shared/text-carriers';
import { textCarrierObservationText } from '../shared/text-carriers';
import { compilePromptPlan, publicPromptView, runtimeFingerprint } from './prompt-compiler';
import { clone, type StoredSession } from './store';
import { acceptOutputs, compileOutputPlan, outputInstructions, outputResultSchema } from './output-runtime';

const output = (): OutputContract => ({ id: 'carriers', title: 'Viewed carriers', instruction: 'SOURCE_HTML_RULE_MUST_NOT_REACH_WRITER', type: 'object', enabled: true, required: false, priority: 1, audience: 'public',
  module: 'carrier-format', valueFrom: { kind: 'viewed-carriers' }, display: { placement: 'after-prose', renderer: 'viewed-carriers' } });
function fixture() {
  const card = createNativeTemplate('card') as CharacterCard, preset = createNativeTemplate('preset') as Preset, reader = card.roles.find(role => role.id === card.playerRoleId)!;
  card.modules = [{ id: 'carrier-format', title: 'Carrier format', category: 'protocol', content: 'Host owns viewed carrier rendering.', enabled: true, targets: ['prose'], phase: 'compose', priority: 1 }];
  card.outputs = [output()];
  const content = { medium: 'paper' as const, title: 'Retained notice', text: 'UNTRUSTED_CARRIER_BODY: tomorrow is cancelled.', location: 'Room', available: true };
  const command = { requestId: 'create-carrier', expectedRevision: 0, reason: 'Author-provided local notice.', operation: 'create' as const, content };
  const receipt: TextCarrierViewReceipt = { id: 'view-1', intentId: 'intent-1', materialTurnId: 'material-turn', worldRevision: 2, carrierId: 'carrier-1', carrierVersion: 1,
    readerRoleId: reader.id, readerName: reader.name, location: 'Room', time: 'Afternoon', origin: { kind: 'player' },
    carrier: { medium: content.medium, title: content.title, text: content.text, sourceEventId: 'carrier-version-event' }, observationEventId: 'view-event' };
  const state: TextCarrierState = { schema: 'rp.text-carriers/0.1', carriers: [{ id: 'carrier-1', versions: [{ ...content, version: 1, retired: false, sourceEventId: 'carrier-version-event', revision: 1 }] }], views: [receipt],
    commands: [{ requestId: command.requestId, fingerprint: runtimeFingerprint(command), carrierId: 'carrier-1', version: 1, revision: 1 }] };
  const events: WorldEvent[] = [{ id: 'carrier-version-event', at: '', kind: 'text-carrier-control', actor: 'author', audience: 'author', text: 'Carrier calibrated.',
    data: { schema: 'rp.text-carrier-control-audit/0.1', carrierId: 'carrier-1', version: 1, revision: 1, fingerprint: runtimeFingerprint(command), command } },
  { id: 'world-commit', at: '', turnId: 'material-turn', kind: 'world-adjudication', actor: 'world', audience: 'author', text: 'Committed view occurrence.' },
  { id: 'view-event', at: '', turnId: 'material-turn', kind: 'text-carrier-view-observation', actor: 'host', audience: 'author', text: textCarrierObservationText(receipt),
    data: { schema: 'rp.text-carrier-view-observation/0.1', sceneId: 'main', observerRoleIds: [reader.id], viewId: receipt.id } }];
  const session = { id: 'carrier-output-test', revision: 2, card, preset, roles: clone(card.roles), fields: clone(card.fields), playerRoleId: card.playerRoleId,
    world: clone(card.world), events, prose: [], turns: [], textCarriers: state, title: 'Test', narration: clone(preset.narration) } as unknown as StoredSession;
  const compile = (materialTurnId: string | null = 'material-turn') => {
    const snapshot = publicPromptView(session), prompt = compilePromptPlan(session, 'prose', 'compose', { snapshot, text: '' });
    return compileOutputPlan(session, prompt, snapshot, { materialTurnId, acceptedBehaviors: [] });
  };
  return { session, receipt, compile, content };
}
describe('host viewed carrier output', () => {
  it('uses only exact committed batch receipts outside model instructions, schema and returned values', () => {
    const f = fixture(), before = clone(f.session), plan = f.compile();
    expect(plan.valid).toBe(true); expect(plan.contracts.map(contract => contract.key)).toEqual(['card:carriers']);
    expect(outputInstructions(plan)).toBe(''); expect(JSON.stringify(outputResultSchema({ type: 'object', properties: {}, required: [] }, plan))).not.toMatch(/outputs|UNTRUSTED_CARRIER_BODY|SOURCE_HTML_RULE/);
    const attachment = acceptOutputs(undefined, plan)[0];
    expect(attachment.value).toEqual({ schema: 'rp.viewed-carriers/0.1', materialTurnId: 'material-turn', worldRevision: 2, views: [f.receipt] });
    expect(attachment.provenance).toEqual({ kind: 'committed-carrier-views', materialTurnId: 'material-turn', viewIds: ['view-1'], worldRevision: 2 });
    expect(() => acceptOutputs({ 'card:carriers': { title: 'Forged', text: 'Forged HTML' } }, plan)).toThrow('Undeclared auxiliary output');
    expect(f.session).toEqual(before);
    (attachment.value as unknown as ViewedCarriersOutput).views[0].carrier.text = 'Caller mutation';
    expect((acceptOutputs(undefined, plan)[0].value as unknown as ViewedCarriersOutput).views[0].carrier.text).toBe(f.receipt.carrier.text);
  });
  it('preserves the original version and revision after live carrier edits and an author recovery at a later revision', () => {
    const f = fixture(), original = acceptOutputs(undefined, f.compile())[0];
    const command = { requestId: 'update-carrier', expectedRevision: 8, reason: 'New author text after the read.', operation: 'update', carrierId: 'carrier-1', expectedVersion: 1, content: { ...f.content, text: 'LATER_LIVE_BODY' } };
    f.session.revision = 9;
    f.session.textCarriers!.carriers[0].versions.push({ ...command.content, version: 2, retired: false, sourceEventId: 'later-version-event', revision: 9 });
    f.session.textCarriers!.commands.push({ requestId: command.requestId, fingerprint: runtimeFingerprint(command), carrierId: 'carrier-1', version: 2, revision: 9 });
    f.session.events.push({ id: 'later-version-event', at: '', kind: 'text-carrier-control', actor: 'author', audience: 'author', text: 'Carrier updated.',
      data: { schema: 'rp.text-carrier-control-audit/0.1', carrierId: 'carrier-1', version: 2, revision: 9, fingerprint: runtimeFingerprint(command), command } });
    const recovered = acceptOutputs(undefined, f.compile())[0]; expect(recovered).toEqual(original);
    expect(JSON.stringify(recovered)).not.toContain('LATER_LIVE_BODY');
  });
  it('keeps source switches and module admission effective, returns no unrelated views and allows an empty optional host artifact', () => {
    const f = fixture(); f.session.card.outputs![0].enabled = false; expect(f.compile().contracts).toEqual([]);
    f.session.card.outputs![0].enabled = true; f.session.card.modules[0].enabled = false; expect(f.compile().contracts).toEqual([]);
    f.session.card.modules[0].enabled = true;
    for (const batch of [null, 'different-material-turn']) expect((acceptOutputs(undefined, f.compile(batch))[0].value as unknown as ViewedCarriersOutput).views).toEqual([]);
    delete f.session.textCarriers; f.session.events = [];
    expect(acceptOutputs(undefined, f.compile())[0].value).toEqual({ schema: 'rp.viewed-carriers/0.1', materialTurnId: 'material-turn', worldRevision: 2, views: [] });
  });
  it('rejects mismatched receipt snapshots, missing audits and forged host contracts without accepting a partial output', () => {
    for (const mutate of [
      (session: StoredSession) => { session.textCarriers!.views[0].carrier.text = 'Forged snapshot'; },
      (session: StoredSession) => { session.events = session.events.filter(event => event.id !== 'view-event'); },
      (session: StoredSession) => { session.textCarriers!.views[0].materialTurnId = 'foreign-turn'; },
      (session: StoredSession) => { session.card.outputs![0].display.renderer = 'sandbox-html'; },
    ]) { const f = fixture(); mutate(f.session); const plan = f.compile(); expect(plan.contracts).toEqual([]); expect(plan.diagnostics).toHaveLength(1); }
  });
});
