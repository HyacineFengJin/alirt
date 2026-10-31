export function observeResponseBody(body: ReadableStream<Uint8Array>, observer: {
  bytes?(value: Uint8Array): void; end?(): void; error?(): void; cancel?(): void;
}): ReadableStream<Uint8Array>;
export function privateStreamDiagnostic(value: unknown, toolNames?: string[]): {
  schema: string; requestId?: string; rawAvailable: boolean; rawLimit: boolean; raw: any[]; translated: any;
};
export function createStreamDiagnostics(options?: {
  emit?(diagnostic: ReturnType<typeof privateStreamDiagnostic>): void;
  toolNames?: string[]; fetchOwner?: { fetch: typeof fetch };
}): { stream(source: AsyncIterable<any>): AsyncIterable<any>; dispose(): void };
