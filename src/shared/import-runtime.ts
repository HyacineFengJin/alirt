/** Public, body-free compatibility information. Preservation is reported separately. */
export interface ImportRuntimeReport {
  schema: 'rp.import-runtime/0.1';
  adapter: string;
  sourceHash: string;
  status: 'partial';
  counts: { roles: number; openings: number; chapters: number; modules: number; enabledModules: number; outputs: number; enabledOutputs: number; dataBindings: number };
  features: { id: string; title: string; status: 'available' | 'partial' | 'unavailable'; entry: string; detail: string }[];
  limitations: string[];
}
