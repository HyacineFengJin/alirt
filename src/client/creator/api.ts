import type {
  CreateCreatorSession,
  CreatorSession,
  PublishedDocument,
  PublishCreatorDraft,
  ReplaceCreatorDraft,
  RestoreCreatorDraft,
  SubmitCreatorRun,
} from "../../shared/creator";
import { request } from "../api";
import type { ConversionMetadata, ConversionReport, CreateImportConversion } from "../../server/compatibility";
const path = (id: string) => `/creator/sessions/${encodeURIComponent(id)}`;
export const creatorApi = {
  list: () => request<CreatorSession[]>("/creator/sessions"),
  create: (body: CreateCreatorSession) =>
    request<CreatorSession>("/creator/sessions", body),
  get: (id: string) => request<CreatorSession>(path(id)),
  convert: (importId: string, body: CreateImportConversion) =>
    request<{ conversion: ConversionMetadata; session: CreatorSession; report: ConversionReport; duplicate: boolean }>(
      `/imports/${encodeURIComponent(importId)}/conversions`, body,
    ),
  conversion: (id: string) => request<{ report: ConversionReport | null }>(`${path(id)}/conversion`),
  run: (id: string, body: SubmitCreatorRun) =>
    request<{ runId: string; status: string; duplicate: boolean }>(
      `${path(id)}/runs`,
      body,
    ),
  cancel: (id: string) => request<unknown>(`${path(id)}/cancel`, {}),
  save: (id: string, body: ReplaceCreatorDraft) =>
    request<CreatorSession>(`${path(id)}/draft`, body),
  restore: (id: string, body: RestoreCreatorDraft) =>
    request<CreatorSession>(`${path(id)}/restore`, body),
  publish: (id: string, body: PublishCreatorDraft) =>
    request<PublishedDocument>(`${path(id)}/publish`, body),
};
