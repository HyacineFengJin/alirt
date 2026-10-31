export interface ErrorDiagnostic {
  name?: string; message?: string; code?: string; status?: number; statusCode?: number;
  cause?: ErrorDiagnostic; failure?: ErrorDiagnostic;
}
export function errorDiagnostic(error: unknown, credential?: string): ErrorDiagnostic;
export function observeAdapterErrors(Adapter: { prototype: any }, observer: {
  start?(): void; success?(): void; failure?(error: unknown): void;
  stream?(source: AsyncIterable<any>): AsyncIterable<any>;
}): () => void;
