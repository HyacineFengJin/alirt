import type { AuthorCatalog } from '../shared/catalog';
import type {
  AppStatus,
  Catalog,
  CreateSession,
  EditState,
  ImportDetail,
  ImportSummary,
  SessionSnapshot,
  SetLifecycle,
  SubmitTurn,
  CharacterCard,
  Preset,
  AgentKind,
} from "../shared/types";
import type { PromptPlan } from "../shared/prompt-runtime";
import type { AgentModuleManifest, AgentRuntimeConfig } from "../shared/agent-runtime";
export interface AgentModuleCatalog {
  modules: AgentModuleManifest[];
  profiles: Record<AgentRuntimeConfig['profile'], string[]>;
}
import type { WorldbookEditCommand } from "../shared/worldbook";
export type { WorldbookEditCommand } from "../shared/worldbook";
import type { RuntimeConfigurationUpdate } from "../shared/runtime-config";
export type { RuntimeConfigurationUpdate, RuntimeFieldPolicyPatch } from "../shared/runtime-config";
export interface RuntimeConfiguration {
  revision: number;
  card: CharacterCard;
  preset: Preset;
  agentRuntime: AgentRuntimeConfig;
}
export interface WorldbookData {
  revision: number;
  valid: boolean;
  items: { source: 'card' | 'preset'; documentId: string; bindingId: string; moduleId: string; content: string; promptEnabled: boolean; catalog?: AuthorCatalog }[];
  diagnostics: { message: string; severity: string }[];
}
import type { KnowledgeEdit, KnowledgeRegistry, ProvenancedKnowledge } from "../shared/knowledge";
import type { ScenarioCommand, ScenarioView } from "../shared/scenario";
export type { ScenarioCommand, ScenarioView } from "../shared/scenario";

export type EditKnowledgeRequest = KnowledgeEdit & { expectedRevision: number; reason: string };
export interface AuthorKnowledge {
  revision: number;
  roles: { id: string; name: string; knowledge: ProvenancedKnowledge[] }[];
  registry: KnowledgeRegistry;
}

export type ScenarioCommandResult = ScenarioView & { duplicate: boolean; appliedRevision: number };

export interface FrontendAsset {
  pointer: string;
  kind: string;
  executable: false;
  missingApis: string[];
  remoteReferences: string[];
  previewHtml?: string;
  sourceText?: string;
  sourceAdmitted?: boolean;
  sourceEnabled?: boolean | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public issues: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      payload?.error?.message ??
        payload?.error ??
        payload?.message ??
        `请求失败 (${response.status})`,
      response.status,
      payload?.error?.issues ?? payload?.issues ?? [],
    );
  return payload as T;
}
export const api = {
  visualUpload: async (requestId: string, file: File, title: string): Promise<import('../shared/visual-assets').VisualUploadResult> => {
    const response = await fetch('/api/visual-assets/uploads', { method: 'POST', headers: {
      'Content-Type': file.type || 'application/octet-stream', 'X-Request-ID': requestId, 'X-Title': encodeURIComponent(title),
    }, body: file });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(payload?.error?.message ?? payload?.error ?? `图片上传失败 (${response.status})`, response.status);
    return payload;
  },
  textCarrierTargets: (id: string, signal?: AbortSignal) => request<{ revision: number; targets: import('../shared/text-carriers').TextCarrierTarget[] }>(`/sessions/${encodeURIComponent(id)}/text-carrier-targets`, undefined, signal),
  proseReviews: (id: string, signal?: AbortSignal) => request<import('../shared/prose-review').ProseReviewsView>(`/sessions/${encodeURIComponent(id)}/prose-reviews`, undefined, signal),
  agentModules: (signal?: AbortSignal) => request<AgentModuleCatalog>('/runtime/modules', undefined, signal),
  status: () => request<AppStatus>("/status"),
  catalog: () => request<Catalog>("/catalog"),
  sessions: () => request<SessionSnapshot[]>("/sessions"),
  sessionServices: (id: string) => request<{ services: { id: string; title: string }[] }>(`/sessions/${encodeURIComponent(id)}/services`),
  sessionService: <T>(id: string, serviceId: string, signal?: AbortSignal) => request<T>(`/sessions/${encodeURIComponent(id)}/services/${encodeURIComponent(serviceId)}`, undefined, signal),
  sessionServiceCommand: <T>(id: string, serviceId: string, command: unknown) => request<T>(`/sessions/${encodeURIComponent(id)}/services/${encodeURIComponent(serviceId)}/commands`, command),
  session: (id: string, perspective = "author", signal?: AbortSignal) =>
    request<SessionSnapshot>(
      `/sessions/${encodeURIComponent(id)}?perspective=${encodeURIComponent(perspective)}`,
      undefined,
      signal,
    ),
  createSession: (body: CreateSession) =>
    request<SessionSnapshot>("/sessions", body),
  turn: (id: string, body: SubmitTurn) =>
    request<{ turnId: string }>(
      `/sessions/${encodeURIComponent(id)}/turns`,
      body,
    ),
  editState: (id: string, body: EditState) =>
    request<SessionSnapshot>(`/sessions/${encodeURIComponent(id)}/state`, body),
  knowledge: (id: string) =>
    request<AuthorKnowledge>(`/sessions/${encodeURIComponent(id)}/knowledge`),
  runtime: (id: string, signal?: AbortSignal) =>
    request<RuntimeConfiguration>(`/sessions/${encodeURIComponent(id)}/runtime`, undefined, signal),
  configureRuntime: (id: string, body: RuntimeConfigurationUpdate) =>
    request<RuntimeConfiguration>(`/sessions/${encodeURIComponent(id)}/runtime`, body),
  worldbookData: (id: string, signal?: AbortSignal) =>
    request<WorldbookData>(`/sessions/${encodeURIComponent(id)}/runtime/worldbook/data`, undefined, signal),
  worldbookCommand: (id: string, body: WorldbookEditCommand) =>
    request<RuntimeConfiguration>(`/sessions/${encodeURIComponent(id)}/runtime/worldbook/commands`, body),
  runtimePreview: (id: string, body: { target: AgentKind; roleId?: string; text: string }, signal?: AbortSignal) =>
    request<PromptPlan>(`/sessions/${encodeURIComponent(id)}/runtime/preview`, body, signal),
  scenario: (id: string, signal?: AbortSignal) =>
    request<ScenarioView>(`/sessions/${encodeURIComponent(id)}/scenario`, undefined, signal),
  scenarioCommand: (id: string, body: ScenarioCommand) =>
    request<ScenarioCommandResult>(`/sessions/${encodeURIComponent(id)}/scenario/commands`, body),
  editKnowledge: (id: string, body: EditKnowledgeRequest) =>
    request<SessionSnapshot>(`/sessions/${encodeURIComponent(id)}/knowledge`, body),
  lifecycle: (id: string, body: SetLifecycle) =>
    request<SessionSnapshot>(
      `/sessions/${encodeURIComponent(id)}/lifecycle`,
      body,
    ),
  configure: async (apiKey: string) => {
    await request<{ configured: boolean }>("/config", { apiKey });
    return request<AppStatus>("/status");
  },
  cancel: (id: string) =>
    request<{ cancelled: boolean }>(
      `/sessions/${encodeURIComponent(id)}/cancel`,
      {},
    ),
  imports: () => request<ImportSummary[]>("/imports"),
  importDetail: (id: string) =>
    request<ImportDetail>(`/imports/${encodeURIComponent(id)}`),
  frontendAssets: (id: string) =>
    request<FrontendAsset[]>(`/imports/${encodeURIComponent(id)}/frontend`),
  importFile: async (file: File): Promise<ImportDetail> => {
    const response = await fetch("/api/imports", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Filename": encodeURIComponent(file.name),
      },
      body: file,
    });
    const payload = await response.json();
    if (!response.ok)
      throw new ApiError(
        payload?.error?.message ??
          (typeof payload?.error === "string"
            ? payload.error
            : `导入失败 (${response.status})`),
        response.status,
      );
    return payload as ImportDetail;
  },
};
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : "请求未完成，请稍后重试";
}
