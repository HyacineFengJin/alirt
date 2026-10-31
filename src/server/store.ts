import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Audience, CharacterCard, EditState, InitializationSelection, Json, Preset, SessionSnapshot, SetLifecycle, WorldEvent } from '../shared/types';
import type { PromptActivationLedger } from '../shared/prompt-runtime';
import type { KnowledgeEdit, KnowledgeRegistry } from '../shared/knowledge';
import { migrateKnowledge, projectKnowledgeEntries, proposeKnowledgeEdit } from './knowledge-runtime';
import { applyStateTransaction, assertStateJson } from './state-runtime';
import type { StateChange } from '../shared/state-rules';
import type { AgentRuntimeConfig } from '../shared/agent-runtime';
import type { WorldInputTurnRecord } from '../shared/world-input';
import { validateStateFieldDefinition, validateStateFieldValue } from '../shared/state-value-schema';
import { initialScenarioProgress } from './scenario-runtime';
import type { ScenarioCommandReceipt } from './scenario';
import { initializeStory } from './initialization-runtime';
import { roleStageOwnsPersona } from './role-stage-runtime';
import { isRemoteInteraction } from '../shared/role-interaction';
import { publicFactEvent } from './world-facts-runtime';
import type { StoryProgressState } from '../shared/story-progress';
import type { ParallelAttempt, ParallelRun } from '../shared/parallel-output';
import { refreshParallelPresentations } from '../shared/parallel-output';
import { reconcileParallelRestart } from './parallel-journal';
import type { StoredProseReview } from '../shared/prose-review';
import type { TextCarrierState } from '../shared/text-carriers';
import type { RoleVisualState } from '../shared/visual-assets';
import { projectViewedCarrierOutput } from '../shared/text-carriers';
import { readRoleVisuals } from './role-visuals';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function fail(code: string, message: string, status = 400): never { throw new ApiError(status, code, message); }
export const clone = <T>(value: T): T => structuredClone(value);
export const now = () => new Date().toISOString();
export interface PeerMail {
  id: string; at: string; turnId: string; from: string; to: string; key: string;
  kind: 'request' | 'reply' | 'notice'; replyTo: string | null; body: string; causeId: string;
  state: 'pending' | 'consumed'; consumedAt?: string;
  sourceRefs?: string[];
}
export interface StoredSession extends SessionSnapshot {
  card: CharacterCard; preset: Preset;
  /** Canonical registry; expose only a validated domain view or host output. */
  storyProgress?: StoryProgressState;
  parallelRuns?: ParallelRun[];
  parallelAttempts?: ParallelAttempt[];
  /** Private reviewer inputs and opinions; not narrative/world/role authority. */
  proseReviews?: StoredProseReview[];
  /** Author-owned versions and private per-reader view receipts. */
  textCarriers?: TextCarrierState;
  visuals?: RoleVisualState;
  /** Private namespaced payloads interpreted only by explicitly installed trusted services. */
  hostServices?: Record<string, Json>;
  /** Private turn-scoped host evidence and retry bindings. */
  worldInputTurns?: WorldInputTurnRecord[];
  /** Author-owned assembly settings; disabled modules retain their domain data. */
  agentRuntime?: AgentRuntimeConfig;
  roleContexts?: Record<string, { generation: number; retained: string[] }>;
  promptContexts?: Record<string, { baseSessionId: string; fingerprint: string; sessionId: string; generation: number }>;
  promptActivations?: Record<string, PromptActivationLedger>;
  mailbox?: PeerMail[];
  knowledgeRegistry?: KnowledgeRegistry;
  scenarioRequests?: ScenarioCommandReceipt[];
}
export function mayRead(audience: Audience, perspective: string) {
  return perspective === 'author' || audience === 'public' || Array.isArray(audience) && audience.includes(perspective);
}
export function project(source: StoredSession, perspective = 'author'): SessionSnapshot {
  if (perspective !== 'author' && !source.roles.some(r => r.id === perspective)) fail('PERSPECTIVE', 'Unknown reading perspective');
  const { card: _card, preset: _preset, storyProgress: _storyProgress, parallelRuns: _parallelRuns, parallelAttempts: _parallelAttempts, proseReviews: _proseReviews, textCarriers: _textCarriers, visuals: _visuals, roleVisuals: _roleVisuals, hostServices: _hostServices, worldInputTurns: _worldInputTurns, agentRuntime: _agentRuntime, roleContexts: _contexts, promptContexts: _promptContexts, promptActivations: _activations, mailbox: _mailbox, knowledgeRegistry: _knowledgeRegistry, scenarioRequests: _scenarioRequests, ...snapshot } = clone(source);
  snapshot.perspective = perspective;
  // Optional presentation metadata cannot make an otherwise readable story fail.
  try { const visuals = readRoleVisuals(source); if (visuals.visuals.length) (snapshot as SessionSnapshot).roleVisuals = visuals; } catch {}
  if (perspective === 'author') {
    snapshot.prose = refreshParallelPresentations(snapshot.prose, source.parallelRuns ?? []);
    return snapshot;
  }
  delete snapshot.scenario;
  delete snapshot.initialization;
  snapshot.fields = snapshot.fields.filter(f => mayRead(f.audience, perspective));
  const keys = new Set(snapshot.fields.map(f => f.key));
  snapshot.world.variables = Object.fromEntries(Object.entries(snapshot.world.variables).filter(([key]) => keys.has(key)));
  // Linked source text has one admission path through prompt modules. Keeping
  // its copy out of tools also prevents a removed module from restoring it.
  snapshot.roles = snapshot.roles.map(({ stateMirrors: _stateMirrors, ...role }) => ({ ...role,
    // Scene interaction/channel is public actor metadata, like physical presence;
    // retain it while persona, private state and knowledge follow their own gates.
    persona: role.id === perspective && !role.personaSourcePointer && !roleStageOwnsPersona(source.card, role.id, role.persona) ? role.persona : '', goals: role.id === perspective ? role.goals : [],
    state: Object.fromEntries(Object.entries(role.state).filter(([key]) => keys.has(key))),
    knowledge: projectKnowledgeEntries(role.knowledge, perspective),
  }));
  snapshot.events = snapshot.events.filter(event => mayRead(event.audience, perspective) && !event.kind.startsWith('parallel-')).flatMap(event => {
    if (event.kind !== 'host-output') return [publicFactEvent(event)];
    const data = event.data as { schema?: string; output?: import('../shared/types').AuxiliaryOutput } | undefined;
    if (!data || data.schema !== 'rp.host-output/0.1' || !data.output) return [];
    const output = projectViewedCarrierOutput(data.output, perspective);
    return output ? [{ ...event, data: { schema: 'rp.host-output/0.1', output } as unknown as Json }] : [];
  });
  snapshot.prose = snapshot.prose.map(entry => ({ ...entry, ...(entry.attachments ? { attachments: entry.attachments.filter(output => mayRead(output.audience, perspective)
    && output.display?.renderer !== 'parallel-scenes' && output.provenance?.kind !== 'committed-parallel').flatMap(output => { const visible = projectViewedCarrierOutput(output, perspective); return visible ? [visible] : []; }) } : {}) }));
  // Prose is composed only from public disclosure material. Private prompts and mail never enter it.
  snapshot.turns = snapshot.turns.map(({ parallelRecovery: _parallelRecovery, proseReview: _proseReview, viewCarrier: _viewCarrier, ...turn }) => ({ ...turn, action: turn.mode === 'author' ? '[作者指令]' : turn.action }));
  return snapshot;
}

export function assertRevision(session: StoredSession, expected: number) {
  if (!Number.isSafeInteger(expected) || expected !== session.revision) fail('REVISION_CONFLICT', 'State changed; refresh before submitting again', 409);
}
export function validateChange(session: StoredSession, change: { roleId: string; key: string; value: Json }, owner?: string, author = false) {
  if (typeof change.roleId !== 'string' || typeof change.key !== 'string') fail('STATE_CHANGE', 'Invalid state target');
  if (owner && change.roleId !== owner) fail('STATE_OWNER', 'A role may propose changes only to its own state');
  const target = change.roleId === 'world' ? session.world.variables : session.roles.find(r => r.id === change.roleId)?.state;
  if (!target) fail('ROLE_UNKNOWN', 'Unknown state owner');
  assertStateJson(session.fields);
  for (const declaration of session.fields) {
    const error = validateStateFieldDefinition(declaration)[0];
    if (error) fail('STATE_FIELD', `${error.message}: ${declaration.key}${error.path}`);
  }
  const field = session.fields.find(f => f.key === change.key);
  if (!field || !Object.hasOwn(target, change.key)) fail('STATE_FIELD', 'Unknown state field');
  if (author && !field.editable) fail('STATE_READONLY', 'This state field is not editable');
  const value = change.value;
  if (field.writableBy === 'derived' || !author && field.writableBy === 'author') fail('STATE_AUTHORITY', 'This field does not permit direct writes by this actor');
  const error = validateStateFieldValue(field, value)[0];
  if (error) fail(error.code === 'schema' ? 'STATE_FIELD' : error.code === 'json' ? 'STATE_JSON' : error.code === 'range' ? 'STATE_RANGE' : 'STATE_TYPE', `${error.message}${error.path ? `: ${error.path}` : ''}`);
  return target!;
}
export function validateWorldRules(session: StoredSession) {
  applyStateTransaction(session, [], { authority: 'model', rules: session.card.stateRules ?? [] });
}
export function event(session: StoredSession, entry: Omit<WorldEvent, 'id' | 'at'>) {
  session.events.push({ id: randomUUID(), at: now(), ...entry });
}

/** One process owns the store. Snapshot rename + fsync is durable on the local filesystem;
 * it is not a distributed transaction with native model transcripts. */
export class SessionStore {
  private sessions = new Map<string, StoredSession>();
  constructor(public root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(root)) {
      if (!/^session-[a-f0-9-]+\.json$/.test(name)) continue;
      const saved = JSON.parse(readFileSync(join(root, name), 'utf8')) as StoredSession;
      let value = migrateKnowledge(saved);
      this.sessions.set(value.id, value);
      let changed = !saved.knowledgeRegistry;
      for (const turn of value.turns) if (['queued', 'running', 'committed'].includes(turn.status)) {
        turn.status = 'interrupted'; turn.phase = 'interrupted'; turn.finishedAt = now();
        turn.error = 'The server stopped during this turn. No model request was replayed. Any committed world event remains visible.';
        event(value, { kind: 'turn-interrupted', actor: 'host', text: turn.error, turnId: turn.id, audience: 'author' }); changed = true;
      }
      if (value.parallelAttempts?.some(attempt => attempt.status === 'prepared')
        || value.parallelRuns?.some(run => run.render.status === 'running')) {
        value = reconcileParallelRestart(value); this.sessions.set(value.id, value); changed = true;
      }
      if (changed) this.save(value);
    }
  }
  list() { return [...this.sessions.values()].map(s => project(s)); }
  get(id: string) { return this.sessions.get(id) ?? fail('SESSION_UNKNOWN', 'Session not found', 404); }
  save(value: StoredSession) {
    value.updatedAt = now();
    const path = join(this.root, 'session-' + value.id + '.json'), temporary = path + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, path);
    const directory = openSync(this.root, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
    this.sessions.set(value.id, value);
  }
  create(card: CharacterCard, preset: Preset, selection: InitializationSelection = {}) {
    const initialized = initializeStory(card, selection);
    const createdAt = now();
    let value: StoredSession = { id: randomUUID(), revision: 0, title: card.title, cardId: card.id, presetId: preset.id,
      playerRoleId: card.playerRoleId, createdAt, updatedAt: createdAt, world: initialized.world, roles: initialized.roles,
      fields: clone(card.fields), panels: clone(card.panels), events: [], prose: initialized.opening ? [{ id: randomUUID(), title: '开场', text: initialized.opening, worldRevision: 0 }] : [],
      turns: [], narration: clone(preset.narration), perspective: 'author', card: clone(card), preset: clone(preset) };
    if (initialized.receipt) value.initialization = initialized.receipt;
    if ((card.compatibility || preset.compatibility) && !value.panels.some(panel => panel.kind === 'source')) {
      let panelId = 'runtime.source';
      while (value.panels.some(panel => panel.id === panelId)) panelId += '.compatibility';
      value.panels.push({ id: panelId, title: '兼容运行', kind: 'source', side: 'right' });
    }
    value = migrateKnowledge(value);
    validateWorldRules(value);
    if (card.scenario) {
      value.scenario = initialScenarioProgress(value.card);
      if (!value.panels.some(panel => panel.kind === 'scenario')) {
        let panelId = 'runtime.scenario';
        while (value.panels.some(panel => panel.id === panelId)) panelId += '.chapter';
        value.panels.unshift({ id: panelId, title: '章节进度', kind: 'scenario', side: 'right' });
      }
    }
    event(value, { kind: 'session-created', actor: 'host', text: '故事已创建；初始场景与人物已就绪。', audience: 'public' });
    if (initialized.receipt) event(value, { kind: 'session-initialized', actor: 'host', text: '所选开场与玩家人设已作为一次性初始配置。', audience: 'author', data: JSON.parse(JSON.stringify(initialized.receipt)) });
    this.save(value); return project(value);
  }
  edit(id: string, input: EditState) {
    return this.stateTransaction(id, { expectedRevision: input.expectedRevision, reason: input.reason, changes: [{ roleId: input.roleId, key: input.key, value: input.value }] });
  }
  stateTransaction(id: string, input: { expectedRevision: number; reason: string; changes: StateChange[] }) {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['expectedRevision', 'reason', 'changes'].includes(key)) || !Array.isArray(input.changes) || !input.changes.length
      || input.changes.some(change => !change || typeof change !== 'object' || Object.keys(change).some(key => !['roleId', 'key', 'value', 'expectedValue'].includes(key)))) fail('STATE_CHANGE', 'Provide a nonempty declared state transaction');
    const current = this.get(id); assertRevision(current, input.expectedRevision);
    if (typeof input.reason !== 'string' || !input.reason.trim()) fail('STATE_REASON', 'A reason is required');
    const transaction = applyStateTransaction(current, input.changes, { authority: 'author', rules: current.card.stateRules ?? [], expectedRevision: input.expectedRevision });
    const next = transaction.nextState;
    ++next.revision;
    for (const change of input.changes) {
      const field = next.fields.find(field => field.key === change.key)!;
      event(next, { kind: 'state-edit', actor: 'author', text: input.reason, audience: field.audience, data: { roleId: change.roleId, key: change.key, value: change.value } });
    }
    for (const write of transaction.audit.filter(entry => entry.origin === 'rule')) event(next, { kind: 'state-commit', actor: 'rule', text: `${write.roleId}.${write.key}`, audience: write.audience, data: { roleId: write.roleId, key: write.key, value: write.after } });
    event(next, { kind: 'state-transaction', actor: 'author', text: input.reason, audience: 'author', data: JSON.parse(JSON.stringify({ audit: transaction.audit })) });
    this.save(next); return project(next);
  }
  knowledge(id: string, input: KnowledgeEdit & { expectedRevision: number; reason: string }) {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['operation', 'roleId', 'id', 'text', 'audience', 'status', 'sourceRefs', 'expectedRevision', 'reason'].includes(key))) fail('KNOWLEDGE_INPUT', 'Invalid knowledge edit');
    const current = this.get(id); assertRevision(current, input.expectedRevision);
    if (typeof input.reason !== 'string' || !input.reason.trim()) fail('KNOWLEDGE_REASON', 'A knowledge edit requires a reason');
    const next = proposeKnowledgeEdit(current, input);
    if (JSON.stringify(next) === JSON.stringify(current)) fail('KNOWLEDGE_UNCHANGED', 'Knowledge edit must change the current record');
    ++next.revision;
    event(next, { kind: 'knowledge-edit', actor: 'author', audience: 'author', text: input.reason, data: { roleId: input.roleId, knowledgeId: input.id, operation: input.operation } });
    this.save(next); return project(next);
  }
  lifecycle(id: string, input: SetLifecycle) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['expectedRevision', 'roleId', 'phase', 'presence', 'interaction', 'reason'].includes(key))) fail('LIFECYCLE', 'Provide declared lifecycle fields only');
    let next = clone(this.get(id)); assertRevision(next, input.expectedRevision);
    if (!['active', 'dormant', 'faded', 'retired'].includes(input.phase) || !['present', 'absent'].includes(input.presence)) fail('LIFECYCLE', 'Invalid lifecycle or presence');
    if (typeof input.roleId !== 'string' || !input.roleId.trim()) fail('LIFECYCLE', 'Provide a role id');
    if (Object.hasOwn(input, 'reason') && (typeof input.reason !== 'string' || !input.reason.trim())) fail('LIFECYCLE', 'A supplied reason must be nonempty text');
    const changesInteraction = Object.hasOwn(input, 'interaction');
    if (changesInteraction && input.interaction !== null) {
      const local = input.interaction && typeof input.interaction === 'object' && !Array.isArray(input.interaction)
        && input.interaction.mode === 'local' && Object.keys(input.interaction).length === 1;
      if (!local && !isRemoteInteraction(input.interaction)) fail('LIFECYCLE_INTERACTION', 'Select a local interaction, a remote channel, or null');
      if (isRemoteInteraction(input.interaction) && input.presence !== 'absent') fail('LIFECYCLE_INTERACTION', 'A remote grant requires explicit physical absence');
    }
    let role = next.roles.find(r => r.id === input.roleId) ?? fail('ROLE_UNKNOWN', 'Unknown role');
    const previous = role.phase, previousPresence = role.presence, previousInteraction = clone(role.interaction ?? null);
    if (input.phase === 'faded' && previous !== 'faded') {
      next.roleContexts ??= {};
      next.roleContexts[role.id] = { generation: (next.roleContexts[role.id]?.generation ?? 0) + 1,
        retained: next.events.filter(e => e.kind === 'role-result' && e.actor === role.id).map(e => e.text) };
    }
    role.phase = input.phase;
    if (role.stateMirrors !== undefined) {
      const key = role.stateMirrors.presence, value = input.presence === 'present';
      // A declared state mirror is the reducer's write path. Its write synchronizes
      // structural presence before rule evaluation; readonly/derived/rules keep
      // their existing authority, and failure leaves the original session intact.
      const changes = role.state[key] !== value || role.presence !== input.presence ? [{ roleId: role.id, key, value }] : [];
      const transaction = applyStateTransaction(next, changes, { authority: 'author', owner: role.id, rules: next.card.stateRules ?? [], expectedRevision: input.expectedRevision });
      next = transaction.nextState; role = next.roles.find(candidate => candidate.id === input.roleId)!;
      for (const write of transaction.audit) event(next, { kind: write.origin === 'rule' ? 'state-commit' : 'state-edit', actor: write.origin === 'rule' ? 'rule' : 'author',
        text: `${role.name}: lifecycle state synchronization`, audience: write.audience, data: { roleId: write.roleId, key: write.key, value: write.after } });
      event(next, { kind: 'state-transaction', actor: 'author', audience: 'author', text: 'Validated lifecycle presence mirror transaction.',
        data: JSON.parse(JSON.stringify({ cause: 'lifecycle', roleId: role.id, audit: transaction.audit })) });
    } else role.presence = input.presence;
    if (changesInteraction) {
      if (input.interaction === null) delete role.interaction;
      else role.interaction = clone(input.interaction!);
    }
    // An explicit author arrival ends the remote scene grant. Returning to
    // absent later must not silently restore remote participation.
    if (input.presence === 'present' && isRemoteInteraction(role.interaction)) delete role.interaction;
    ++next.revision;
    event(next, { kind: 'lifecycle', actor: 'author', text: `${role.name}: ${previous} → ${role.phase}; ${role.presence}`, audience: 'public',
      data: { roleId: role.id, phase: role.phase, presence: role.presence, previousPhase: previous, previousPresence, previousInteraction, interaction: clone(role.interaction ?? null) } });
    if (input.reason !== undefined) event(next, { kind: 'lifecycle-reason', actor: 'author', audience: 'author', text: input.reason,
      data: { roleId: role.id, phase: role.phase, presence: role.presence, previousInteraction, interaction: clone(role.interaction ?? null) } });
    this.save(next); return project(next);
  }
}
