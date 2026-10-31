import type { KnowledgeLifecycle, KnowledgeProvenance } from './knowledge';
import type { StateRule, StateWriteAuthority } from './state-rules';
import type { Worldbook } from './worldbook';
import type { ScenarioDefinition, ScenarioProgress } from './scenario';
import type { InitializationDefinition, InitializationReceipt, InitializationSelection } from './initialization';
import type { ImportRuntimeReport } from './import-runtime';
import type { WorldInputSelection } from './world-input';
import type { StateValueSchema } from './state-value-schema';
import type { ProseBody, ProseFormat } from './prose-body';
import type { ProseReviewTarget } from './prose-review';
import type { TextCarrierSelection } from './text-carriers';
import type { CardVisualDefaults, EntryVisuals, RoleVisualsSnapshot } from './visual-assets';
export type { StateValueSchema } from './state-value-schema';
export type { ScenarioChapter, ScenarioDefinition, ScenarioProgress, ScenarioCommand, ScenarioChapterView, ScenarioView } from './scenario';
export type { InitialStateChange, OpeningDefinition, OpeningRoleSelectionGroup, PlayerProfileDefinition, InitializationDefinition, InitializationSelection, InitializationReceipt } from './initialization';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type AgentKind = 'role' | 'world' | 'prose';
export type RolePhase = 'active' | 'dormant' | 'faded' | 'retired';
export type Audience = 'public' | 'author' | string[];
export type Condition =
  | { path: string; equals: Json }
  | { path: string; op: 'exists' }
  | { path: string; op: 'eq' | 'neq' | 'in' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte'; value: Json }
  | { all: Condition[] } | { any: Condition[] } | { not: Condition };
export type PromptInjectionSlot = 'system' | 'before-context' | 'after-context' | 'before-action';
export interface PromptActivation {
  keys: string[]; secondaryKeys?: string[]; selective?: boolean;
  caseSensitive?: boolean; match?: 'substring' | 'word';
}
export interface PromptModule {
  id: string; title: string; category: 'model' | 'style' | 'constraint' | 'supplement' | 'protocol';
  content: string; enabled: boolean; targets: AgentKind[]; phase: 'decide' | 'coordinate' | 'compose';
  priority: number; condition?: Condition; sourcePointer?: string;
  activation?: PromptActivation;
  lifetime?: { once?: boolean; stickyTurns?: number; cooldownTurns?: number; delayTurns?: number; probability?: number; recursive?: boolean };
  audience?: Audience;
  inject?: { slot: PromptInjectionSlot; order?: number };
  dependsOn?: string[]; exclusiveGroup?: string; required?: boolean;
}
export interface OutputContract {
  id: string; title: string; type: 'text' | 'list' | 'object'; instruction: string;
  enabled: boolean; required: boolean; priority: number; audience: Audience;
  display: OutputDisplay;
  condition?: Condition; module?: string;
  /** A host-rendered value from permitted committed material. Omission uses the model. */
  valueFrom?: OutputValueSource;
}
export type OutputValueSource = { kind: 'world-time' } | { kind: 'world-location' }
  | { kind: 'state'; roleId: string; key: string } | { kind: 'approved-messages' } | { kind: 'world-publications' } | { kind: 'story-progress' } | { kind: 'parallel-scenes' } | { kind: 'viewed-carriers' };
export interface ApprovedMessages {
  schema: 'rp.approved-messages/0.1';
  materialTurnId: string | null;
  worldRevision: number;
  messages: { behaviorId: string; roleId: string; name: string; text: string; channel: 'message' }[];
}
/** Display metadata is snapshotted with each committed output. It never grants
 * model input access or execution permission to imported UI code. */
export interface OutputDisplay {
  placement: 'before-prose' | 'after-prose' | 'side-panel' | 'hidden';
  renderer?: 'plain' | 'choices' | 'folded' | 'sandbox-html' | 'messages' | 'parallel-scenes' | 'viewed-carriers';
  /** Native prose-entry distance; source chat depth is retained separately. */
  history?: { minEntriesAgo?: number; maxEntriesAgo?: number };
  source?: { importId: string; pointer: string; tag?: string; minDepth?: number; maxDepth?: number };
}
export interface Preset {
  schema: 'rp.preset/0.1'; id: string; title: string; description: string; modules: PromptModule[];
  outputs?: OutputContract[];
  worldbook?: Worldbook;
  proseFormat?: ProseFormat;
  narration: { person: 'auto' | 'first' | 'third'; pov: 'auto' | 'limited' | 'omniscient' };
  compatibility?: { importId: string; status: string; warnings: string[] };
}
export interface Knowledge { id: string; text: string; audience: Audience; status: 'known' | 'uncertain'; lifecycle?: KnowledgeLifecycle; provenance?: KnowledgeProvenance; }
/** Author-declared participation in this scene, independent of physical presence.
 * Omission preserves legacy local scheduling; remote grants never permit physical actions. */
export type RoleInteraction = { mode: 'local' } | { mode: 'remote'; channel: 'message' | 'screen' | 'audio' };
export interface RoleDefinition {
  id: string; name: string; persona: string; goals: string[]; peers: string[];
  personaSourcePointer?: string;
  interaction?: RoleInteraction;
  /** Explicit structural mirrors. Ordinary same-named state fields are not inferred. */
  stateMirrors?: { presence: string };
  phase: RolePhase; presence: 'present' | 'absent'; state: Record<string, Json>; knowledge: Knowledge[];
}
export interface StateField {
  key: string; label: string; type: 'number' | 'string' | 'boolean' | 'list';
  min?: number; max?: number; audience: Audience; editable: boolean;
  writableBy?: StateWriteAuthority;
  /** Initial null remains an unresolved value; subsequent null writes require this explicit declaration. */
  nullable?: boolean;
  valueSchema?: StateValueSchema;
}
export interface PanelDefinition { id: string; title: string; /** Selects an installed trusted renderer; imported code is never executed. */ pluginId?: string; kind: 'scene' | 'roles' | 'state' | 'lore' | 'events' | 'source' | 'outputs' | 'scenario'; side: 'left' | 'right'; }
export interface CharacterCard {
  schema: 'rp.card/0.1'; id: string; title: string; description: string; opening: string;
  playerRoleId: string; world: { location: string; time: string; variables: Record<string, Json> };
  roles: RoleDefinition[]; fields: StateField[]; modules: PromptModule[]; panels: PanelDefinition[];
  outputs?: OutputContract[];
  proseFormat?: ProseFormat;
  visuals?: CardVisualDefaults;
  worldbook?: Worldbook;
  stateRules?: StateRule[];
  scenario?: ScenarioDefinition;
  initialization?: InitializationDefinition;
  compatibility?: { importId: string; status: string; warnings: string[] };
}
export interface NarrationSettings { person: 'auto' | 'first' | 'third'; pov: 'auto' | 'limited' | 'omniscient'; focalRoleId?: string; }
export interface WorldEvent { id: string; at: string; turnId?: string; kind: string; actor: string; text: string; audience: Audience; data?: Json; }
export interface AuxiliaryOutput {
  key: string; title: string; type: 'text' | 'list' | 'object'; value: Json; audience: Audience;
  placement: OutputDisplay['placement'];
  display?: OutputDisplay;
  provenance?: { kind: 'state'; selector: Exclude<OutputValueSource, { kind: 'approved-messages' | 'world-publications' | 'story-progress' | 'parallel-scenes' | 'viewed-carriers' }>; known: boolean; worldRevision: number }
    | { kind: 'committed-behaviors'; materialTurnId: string | null; behaviorIds: string[]; worldRevision: number }
    | { kind: 'committed-facts'; materialTurnId: string | null; factIds: string[]; worldRevision: number }
    | { kind: 'committed-progress'; sequence: number; worldRevision: number }
    | { kind: 'committed-parallel'; materialTurnId: string | null; sceneIds: string[]; worldRevision: number }
    | { kind: 'committed-carrier-views'; materialTurnId: string | null; viewIds: string[]; worldRevision: number };
}
export interface ProseEntry { id: string; turnId?: string; title: string; text: string; worldRevision: number; person?: string; pov?: string; body?: ProseBody; visuals?: EntryVisuals; attachments?: AuxiliaryOutput[]; }
export interface TurnRecord {
  id: string; requestId: string; action: string; mode: 'action' | 'dialogue' | 'author';
  status: 'queued' | 'running' | 'committed' | 'completed' | 'failed' | 'interrupted';
  phase: string; error?: string; startedAt: string; finishedAt?: string; activationTurn?: number;
  /** Author-only request identity; removed from other reading projections. */
  parallelRecovery?: { runId: string; requestFingerprint?: string };
  /** Author-only request identity for a read-only review, never world action. */
  proseReview?: { target: ProseReviewTarget; requestFingerprint: string };
  /** Host-bound request identity; selection alone never performs a view. */
  viewCarrier?: { selection: TextCarrierSelection; requestFingerprint: string };
}
export interface SessionSnapshot {
  id: string; revision: number; title: string; cardId: string; presetId: string; playerRoleId: string;
  createdAt: string; updatedAt: string; world: CharacterCard['world']; roles: RoleDefinition[];
  fields: StateField[]; panels: PanelDefinition[]; events: WorldEvent[]; prose: ProseEntry[]; turns: TurnRecord[];
  narration: NarrationSettings; perspective: 'author' | string;
  scenario?: ScenarioProgress;
  initialization?: InitializationReceipt;
  /** Read-only presentation metadata; never model/world authority. */
  roleVisuals?: RoleVisualsSnapshot;
}
export interface AppStatus { version: string; provider: string; model: string; configured: boolean; runtime: string; }
export interface Catalog { cards: CharacterCard[]; presets: Preset[]; }
export interface CreateSession extends InitializationSelection { cardId: string; presetId: string; }
export interface SubmitTurn { requestId: string; expectedRevision: number; action: string; mode: 'action' | 'dialogue' | 'author'; narration?: NarrationSettings;
  parallelRecovery?: { runId: string };
  proseReview?: ProseReviewTarget;
  viewCarrier?: TextCarrierSelection;
  /** Explicit author submission of immutable trusted evidence, not player speech/action. */
  worldInput?: WorldInputSelection;
}
export interface EditState { expectedRevision: number; roleId: string; key: string; value: Json; reason: string; }
export interface SetLifecycle {
  expectedRevision: number; roleId: string; phase: RolePhase; presence: 'present' | 'absent';
  /** Omit to retain the current grant; null explicitly ends it. Author-only API. */
  interaction?: RoleInteraction | null;
  reason?: string;
}
export interface ImportSummary {
  id: string; title: string; kind: 'card' | 'preset'; importedAt: string; sourceFile: string;
  promptCount: number; frontendCount: number; status: string; warnings: string[];
}
export interface ImportModule {
  id: string; title: string; kind: string; pointer: string; content: string; sourceEnabled: boolean | null;
  disposition: 'native' | 'preserved' | 'needs-adapter' | 'isolated'; notes: string[];
}
export interface ImportDetail extends ImportSummary {
  modules: ImportModule[]; nativeCard?: CharacterCard; nativePreset?: Preset;
  preservation: { exactPromptTexts: boolean; inputPrompts: number; retainedPrompts: number; missingPointers: string[]; addedPromptCharacters: number; };
  runtime?: ImportRuntimeReport;
}
