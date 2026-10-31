import type { ImportDetail, Json } from '../shared/types';

export interface SourceText { pointer: string; text: string; role: 'prompt' | 'frontend' | 'metadata'; }
export interface SourceControl {
  enabled: boolean | null; order: number; constant?: boolean; keys?: string[]; secondaryKeys?: string[];
  injection?: { position?: Json; depth?: Json; order?: Json; role?: Json };
  selective?: boolean; selectiveLogic?: number; orderEntries?: Json; extensions?: Json;
}
export interface NativeMapping {
  pointer: string; moduleId: string; target: 'role' | 'world' | 'prose' | 'panel' | 'archive';
  control: SourceControl; admission: 'admitted' | 'isolated' | 'adapter'; reasons: string[];
}
export interface FrontendAsset {
  pointer: string; kind: 'html' | 'css' | 'javascript' | 'regex' | 'extension';
  source: Json; executable: false; missingApis: string[]; remoteReferences: string[]; previewHtml?: string;
}
export interface ConversionConflict { code: string; pointers: string[]; resolution: 'unresolved'; detail: string; }
export interface ImportArtifact {
  schema: 'rp.import/0.1'; sourceFormat?: 'native' | 'tavern'; id: string; sourceHash: string; source: Json; texts: SourceText[];
  hostRoleIds: string[]; detail: ImportDetail; mappings: NativeMapping[]; frontend: FrontendAsset[]; conflicts: ConversionConflict[];
  container: { canonicalRoot: string; aliases: string[]; retainedOuterFields: string[]; conflicts: string[] };
}
