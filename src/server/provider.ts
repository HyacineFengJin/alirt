import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile, readFile, unlink, chmod } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { AgentRequest, ModelProvider } from './engine';
import { ApiError } from './store';
import { errorDiagnostic, type ErrorDiagnostic } from './diagnostics.mjs';
import { privateStreamDiagnostic } from './stream-observer.mjs';

const sourceRoot = dirname(fileURLToPath(import.meta.url));
export interface RequestPolicyMetadata {
  sessionId: string | null; purpose: 'compaction' | 'session-title' | null; toolNames: string[];
  choice: { type: 'any' } | { type: 'tool'; name: 'submit_result' } | null;
}
/** Policy-only IPC allowlist, independent of error and request content.
 * Named submit_result is retained for historical failure diagnostics only;
 * production worker request selection currently uses any, including sole-tool tasks.
 */
export function privateRequestPolicies(value: unknown, credential?: string): RequestPolicyMetadata[] {
  if (!Array.isArray(value)) return [];
  const text = (value: string, limit: number) => (credential ? value.replaceAll(credential, '[redacted]') : value).replaceAll('\0', '').slice(0, limit);
  return value.flatMap((record: any) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
    const choice = record.choice?.type === 'any' ? { type: 'any' as const }
      : record.choice?.type === 'tool' && record.choice.name === 'submit_result' ? { type: 'tool' as const, name: 'submit_result' as const } : null;
    return [{ sessionId: typeof record.sessionId === 'string' ? text(record.sessionId, 256) : null,
      purpose: record.purpose === 'compaction' || record.purpose === 'session-title' ? record.purpose : null,
      toolNames: Array.isArray(record.toolNames) ? record.toolNames.flatMap((name: unknown) => typeof name === 'string' ? [text(name, 128)] : []) : [], choice }];
  });
}
export class DeepSeekProvider implements ModelProvider {
  private apiKey: string | undefined;
  private children = new Set<ChildProcess>();
  private lane: Promise<void> = Promise.resolve();
  readonly runtime: string;
  constructor(public root: string, options: { apiKey?: string; runtime?: string } = {}) {
    this.apiKey = options.apiKey?.trim() || process.env.DEEPSEEK_API_KEY?.trim();
    this.runtime = resolve(options.runtime ?? process.env.RP_DSH_RUNTIME ?? '.rp-runtime/dsh');
  }
  configured() { return !!this.apiKey; }
  async runtimeStatus(): Promise<{ ready: boolean; message?: string }> {
    try {
      const manifest = JSON.parse(await readFile(join(this.runtime, 'build-manifest.json'), 'utf8'));
      if (manifest.sourceSha !== 'd743267388641bc76f17c45ce8b4c231aed1d32c' || manifest.sourceVersion !== '0.2.1-alpha.2') throw new Error('Runtime version differs from the pinned upstream release');
      await readFile(join(this.runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'));
      return { ready: true };
    } catch {
      return { ready: false, message: 'DSH runtime is not ready. Run node scripts/setup-dsh.mjs, or set RP_DSH_RUNTIME to an equivalent pinned built distribution.' };
    }
  }
  configure(apiKey: string) {
    if (this.children.size) throw new ApiError(409, 'PROVIDER_BUSY', 'Wait for the current request or cancel it before changing credentials');
    if (typeof apiKey !== 'string') throw new ApiError(400, 'PROVIDER_KEY', 'API key must be a string');
    this.apiKey = apiKey.trim() || undefined;
  }
  private redact(value: unknown) { const text = String(value ?? 'Model request failed'); return this.apiKey ? text.replaceAll(this.apiKey, '[redacted]') : text; }
  async run(request: AgentRequest): Promise<any> {
    // DSH is a native process with a substantial resident set. Serialize all
    // stories on this local alpha host rather than exhausting desktop memory.
    const before = this.lane;
    let release!: () => void;
    this.lane = new Promise<void>(done => { release = done; });
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('Turn cancelled'));
      request.signal.addEventListener('abort', onAbort, { once: true });
      if (request.signal.aborted) onAbort();
    });
    let ownsLane = false;
    try {
      await Promise.race([before, aborted]); ownsLane = true;
      return await this.runOwned(request);
    } finally {
      request.signal.removeEventListener('abort', onAbort);
      if (ownsLane) release(); else void before.finally(release);
    }
  }
  private async runOwned(request: AgentRequest): Promise<any> {
    if (!this.apiKey) throw new ApiError(503, 'PROVIDER_UNCONFIGURED', 'DeepSeek API key is missing');
    if (request.signal.aborted) throw new Error('Turn cancelled');
    if (!request.sessionId || /[\/\\\u0000-\u001f\u007f]/u.test(request.sessionId))
      throw new ApiError(400, 'SESSION_IDENTIFIER', 'Agent session identifiers cannot contain path separators or control characters');
    const runtime = await this.runtimeStatus();
    if (!runtime.ready) throw new ApiError(503, 'DSH_RUNTIME_UNAVAILABLE', runtime.message!);
    const storyId = request.sessionId.split('-role-')[0].replace(/-(world|prose)(?:-p[0-9]+)?$/, '');
    const root = join(this.root, 'native', storyId), home = join(root, 'home'), profile = join(home, 'profiles/rp-alpha');
    await mkdir(profile, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'rp-alpha-private-profile', private: true, type: 'module', dependencies: {}, dsh: { profile: { bundles: [] } } }), { mode: 0o600 });
    const path = join(root, 'request-' + randomUUID() + '.json');
    await writeFile(path, JSON.stringify({ sessionId: request.sessionId, system: request.system, input: request.input, promptLayout: request.promptLayout, resultSchema: request.resultSchema,
      tools: request.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) }), { mode: 0o600, flag: 'wx' });
    await writeFile(join(profile, 'cordis.patch.yml'), '- insert:\n    - id: rp-alpha-agent-worker\n      name: ' + JSON.stringify(join(sourceRoot, 'worker.mjs')) + '\n      config: ' + JSON.stringify({ root, request: path }) + '\n', { mode: 0o600 });
    // The only credential crossing is the ephemeral child launch environment.
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key) && !/^(DSH_|RP_DSH_|DEEPSEEK_|NODE_OPTIONS$)/.test(key)));
    const child = spawn(process.execPath, [join(this.runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'rp-alpha'], {
      cwd: root, env: { ...environment, RP_DSH_RUNTIME: this.runtime, DSH_HOME: home, DEEPSEEK_API_KEY: this.apiKey }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.children.add(child);
    let diagnostic = '', result: any, failure: string | undefined, nativeFailure: ErrorDiagnostic | undefined, nativeAdapterFailure: ErrorDiagnostic | undefined;
    let requestPolicies: RequestPolicyMetadata[] = [];
    const streamDiagnostics: ReturnType<typeof privateStreamDiagnostic>[] = [];
    let streamDiagnosticBytes = 0, streamDiagnosticsOmitted = 0;
    // Retain private diagnostics only; the key is redacted before every write or response.
    child.stdout?.on('data', bytes => { diagnostic += this.redact(bytes.toString()); });
    child.stderr?.on('data', bytes => { diagnostic += this.redact(bytes.toString()); });
    child.on('message', async (message: any) => {
      if (message.type === 'stream-diagnostic') {
        const metadata = privateStreamDiagnostic(message.diagnostic, [...request.tools.map(tool => tool.name), 'submit_result']);
        const bytes = Buffer.byteLength(JSON.stringify(metadata));
        if (streamDiagnosticBytes + bytes <= 2 * 1024 * 1024 && streamDiagnostics.length < 128) {
          streamDiagnostics.push(metadata); streamDiagnosticBytes += bytes;
        } else streamDiagnosticsOmitted++;
      }
      if (message.type === 'request-policy') requestPolicies.push(...privateRequestPolicies([message.policy], this.apiKey));
      if (message.type === 'result' || message.type === 'failure') requestPolicies = privateRequestPolicies(message.requestPolicies, this.apiKey);
      if (message.type === 'result') result = message.result;
      if (message.type === 'failure') {
        failure = this.redact(message.message).slice(0, 300);
        // Reapply the allowlist and redaction at the persistence boundary even
        // though the worker already filtered its private IPC diagnostic.
        nativeFailure = errorDiagnostic(message.diagnostic ?? { message: message.message, code: message.code }, this.apiKey);
        if (message.adapterDiagnostic) nativeAdapterFailure = errorDiagnostic(message.adapterDiagnostic, this.apiKey);
      }
      if (message.type === 'tool') {
        try {
          if (request.signal.aborted) throw new Error('Turn cancelled');
          const tool = request.tools.find(t => t.name === message.name);
          if (!tool) throw new Error('Unknown host tool');
          const value = await tool.execute(message.args);
          if (child.connected) child.send({ type: 'tool-result', id: message.id, result: value });
        } catch (error) { if (child.connected) child.send({ type: 'tool-result', id: message.id, error: this.redact(error instanceof Error ? error.message : error) }); }
      }
    });
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (child.connected) child.send({ type: 'cancel' });
      // Cancellation is a user action, not a request budget. Stop a stuck subprocess.
      cancelTimer = setTimeout(() => child.kill('SIGKILL'), 2000); cancelTimer.unref();
    };
    request.signal.addEventListener('abort', abort, { once: true });
    try {
      const exit = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', code => done(code)); });
      const privateLog = this.redact(diagnostic + (nativeFailure ? '\n' + JSON.stringify({ source: 'final-normalized-error', nativeFailure }) + '\n' : '')
        + (nativeAdapterFailure ? JSON.stringify({ source: 'observed-adapter-boundary', nativeFailure: nativeAdapterFailure }) + '\n' : '')
        + JSON.stringify({ source: 'messages-request-policy', requestPolicies }) + '\n'
        + streamDiagnostics.map(diagnostic => JSON.stringify({ source: 'provider-stream', diagnostic })).join('\n') + '\n'
        + (streamDiagnosticsOmitted ? JSON.stringify({ source: 'provider-stream-limit', omitted: streamDiagnosticsOmitted }) + '\n' : ''));
      await writeFile(join(root, 'worker-' + new Date().toISOString().replaceAll(':', '-') + '-' + request.kind + '.log'), privateLog, { mode: 0o600 });
      await writeFile(join(root, 'last-worker.log'), privateLog, { mode: 0o600 });
      if (request.signal.aborted) throw new Error('Turn cancelled');
      if (failure) throw new Error(failure);
      if (exit !== 0 || result === undefined) throw new Error('Native DSH worker failed before returning a result. Private diagnostics are saved on the server.');
      return result;
    } finally {
      request.signal.removeEventListener('abort', abort); if (cancelTimer) clearTimeout(cancelTimer);
      this.children.delete(child); await unlink(path).catch(() => {});
    }
  }
  async close() { for (const child of this.children) child.kill('SIGTERM'); }
}
