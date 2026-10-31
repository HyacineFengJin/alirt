import express, { type Request, type Response, type NextFunction } from 'express';
import { join, resolve } from 'node:path';
import type { Catalog, ImportDetail, ImportSummary, PromptModule } from '../shared/types';
import { ApiError, assertRevision, clone, project, SessionStore } from './store';
import { TurnEngine, type ImportedModuleSelector, type ImportedModuleResolver, type ModelProvider } from './engine';
import { DeepSeekProvider } from './provider';
import { createCreatorService } from './creator';
import { readRuntimeConfiguration, updateRuntimeConfiguration } from './runtime-config';
import { createCompatibilityManager } from './compatibility';
import type { ImportArtifact } from '../importer/types';
import { KnowledgeError } from './knowledge-runtime';
import { StateTransactionError } from './state-runtime';
import { AgentModuleError, AgentModuleRegistry, type AgentModule } from './agent-modules';
import { applyScenarioCommand } from './scenario';
import { readScenario, ScenarioError } from './scenario-runtime';
import { InitializationError } from './initialization-runtime';
import { applyWorldbookEdit } from './worldbook-edit';
import { SessionServiceRegistry, type SessionCommandService } from './session-services';
import { derivedMemoryModule } from './derived-memory';
import { proseReviewModule } from './prose-review';
import { textCarrierViewModule } from './text-carrier-module';
import { createVisualAssetsRuntime } from './visual-assets';
import { createVisualAssetsRouter } from './visual-assets-router';

export interface ImportService {
  list(): Promise<ImportSummary[]>;
  detail(id: string): Promise<ImportDetail | undefined>;
  importBytes(bytes: Uint8Array, filename: string): Promise<ImportDetail>;
  selectModules?: ImportedModuleSelector;
  runtimeModules?: ImportedModuleResolver;
  frontendAssets?(id: string): Promise<unknown>;
  /** Host-only immutable source capability; never returned by an HTTP route. */
  artifact?(id: string): Promise<ImportArtifact | undefined>;
}
export interface AppOptions {
  catalog: () => Promise<Catalog>;
  importService?: ImportService;
  dataRoot?: string;
  provider?: ModelProvider;
  staticRoot?: string;
  /** Trusted server-code extensions only; never loaded from imported card JSON. */
  agentModules?: AgentModule[];
  /** Optional synchronous session commands; separate from model-agent capabilities. */
  sessionServices?: readonly SessionCommandService[];
  /** Author upload/binding controls; existing image reads remain available. */
  visualAssets?: boolean;
}
/** Bind this application to loopback only. Reading perspectives are disclosure
 * filters for the local author, not multi-user authentication. */
export async function createApp(options: AppOptions) {
  const root = resolve(options.dataRoot ?? process.env.RP_DATA_ROOT ?? process.env.RP_ALPHA_DATA ?? '.rp-data');
  const modules = new AgentModuleRegistry([derivedMemoryModule, proseReviewModule, textCarrierViewModule, ...(options.agentModules ?? [])]);
  const visuals = createVisualAssetsRuntime(join(root, 'visual-assets'));
  const sessionServices = new SessionServiceRegistry([...(options.sessionServices ?? []), ...(options.visualAssets ? [visuals.service] : [])]);
  const store = new SessionStore(root), provider = options.provider ?? new DeepSeekProvider(root), engine = new TurnEngine(store, provider, options.importService?.runtimeModules, { modules, sessionServices });
  const creator = createCreatorService({ root: join(root, 'creator'), provider, catalog: options.catalog });
  const compatibility = createCompatibilityManager({ root: join(root, 'compatibility'), store: creator.store, artifact: async id => options.importService?.artifact?.(id) });
  creator.engine.provider = compatibility.wrapProvider(provider);
  creator.store.publicationGuard = (id, document) => compatibility.assertPublishable(id, document);
  const catalog = async (): Promise<Catalog> => {
    const [base, authored] = await Promise.all([options.catalog(), creator.catalog()]);
    return { cards: [...base.cards, ...authored.cards], presets: [...base.presets, ...authored.presets] };
  };
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // Reject DNS rebinding and cross-site requests to this local author console.
    const host = request.headers.host;
    let hostname: string;
    try { hostname = new URL('http://' + host).hostname; } catch { return next(new ApiError(403, 'HOST_FORBIDDEN', 'Invalid local host')); }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return next(new ApiError(403, 'HOST_FORBIDDEN', 'This application accepts local hosts only'));
    const origin = request.headers.origin;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && origin) {
      let allowed = false;
      try {
        const parsed = new URL(origin);
        allowed = ['http:', 'https:'].includes(parsed.protocol) && parsed.host === host;
        // Vite's development frontend proxies to the loopback API.
        allowed ||= process.env.NODE_ENV !== 'production' && parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.port === '5173';
      } catch {}
      if (!allowed) return next(new ApiError(403, 'ORIGIN_FORBIDDEN', 'Cross-origin mutations are not allowed'));
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['sec-fetch-site'] === 'cross-site') return next(new ApiError(403, 'ORIGIN_FORBIDDEN', 'Cross-site mutations are not allowed'));
    next();
  });
  app.post('/api/imports', express.raw({ type: 'application/octet-stream', limit: '32mb' }), async (req, res) => {
    if (!options.importService) throw new ApiError(503, 'IMPORT_UNAVAILABLE', 'The import service is unavailable');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ApiError(400, 'IMPORT_EMPTY', 'Upload a nonempty file as application/octet-stream');
    let filename: string;
    try { filename = decodeURIComponent(String(req.headers['x-filename'] ?? 'import.json')); } catch { throw new ApiError(400, 'IMPORT_FILENAME', 'Invalid filename encoding'); }
    res.status(201).json(await options.importService.importBytes(req.body, filename));
  });
  app.use('/api/creator', express.json({ limit: '32mb' }), creator.router);
  app.use('/api/visual-assets', createVisualAssetsRouter(visuals, { authorControlEnabled: !!options.visualAssets }));
  app.use(express.json({ limit: '2mb' }));
  app.get('/api/status', async (_req, res) => {
    const runtime = provider instanceof DeepSeekProvider ? await provider.runtimeStatus() : { ready: true };
    res.json({ version: '0.1.0-alpha.5', provider: 'deepseek-official', model: 'deepseek-flash', configured: provider.configured(),
      runtime: 'DSH 0.2.1-alpha.2', runtimeReady: runtime.ready, ...(runtime.message ? { runtimeMessage: runtime.message } : {}) });
  });
  app.get('/api/sessions/:id/prose-reviews', (req, res) => res.json(engine.proseReviews(req.params.id)));
  app.get('/api/sessions/:id/text-carrier-targets', (req, res) => res.json(engine.carrierTargets(req.params.id)));
  app.post('/api/config', (req, res) => {
    if (!(provider instanceof DeepSeekProvider)) throw new ApiError(400, 'PROVIDER_CONFIG', 'This injected provider does not support credentials');
    provider.configure(req.body?.apiKey); res.json({ configured: provider.configured() });
  });
  app.get('/api/catalog', async (_req, res) => res.json(await catalog()));
  app.get('/api/runtime/modules', (_req, res) => res.json({ modules: modules.catalog(), profiles: Object.fromEntries(
    (['full', 'compact', 'minimal'] as const).map(profile => [profile, [...modules.resolve({ profile }).enabled]])) }));
  app.get('/api/imports', async (_req, res) => res.json(options.importService ? await options.importService.list() : []));
  app.get('/api/imports/:id', async (req, res) => {
    const detail = await options.importService?.detail(req.params.id);
    if (!detail) throw new ApiError(404, 'IMPORT_UNKNOWN', 'Import not found');
    res.json(detail);
  });
  app.get('/api/imports/:id/frontend', async (req, res) => res.json(await options.importService?.frontendAssets?.(req.params.id) ?? []));
  app.post('/api/imports/:id/conversions', async (req, res) => res.status(201).json(await compatibility.create(req.params.id, req.body)));
  app.get('/api/imports/:id/conversions', (req, res) => res.json(compatibility.list(req.params.id)));
  app.get('/api/creator/sessions/:id/conversion', (req, res) => { creator.store.get(req.params.id); res.json({ report: compatibility.has(req.params.id) ? compatibility.report(req.params.id) : null }); });
  app.get('/api/sessions', (_req, res) => res.json(store.list()));
  app.post('/api/sessions', async (req, res) => {
    const available = await catalog();
    const card = available.cards.find(c => c.id === req.body?.cardId), preset = available.presets.find(p => p.id === req.body?.presetId);
    if (!card || !preset) throw new ApiError(400, 'CATALOG_SELECTION', 'Select an existing card and preset');
    res.status(201).json(store.create(card, preset, {
      ...(Object.hasOwn(req.body ?? {}, 'openingId') ? { openingId: req.body.openingId } : {}),
      ...(Object.hasOwn(req.body ?? {}, 'playerProfileId') ? { playerProfileId: req.body.playerProfileId } : {}),
      ...(Object.hasOwn(req.body ?? {}, 'selectedRoleIds') ? { selectedRoleIds: req.body.selectedRoleIds } : {}),
      ...(Object.hasOwn(req.body ?? {}, 'selectedRoleGroups') ? { selectedRoleGroups: req.body.selectedRoleGroups } : {}),
    }));
  });
  app.get('/api/sessions/:id', (req, res) => res.json(project(store.get(req.params.id), typeof req.query.perspective === 'string' ? req.query.perspective : 'author')));
  app.get('/api/sessions/:id/services', (req, res) => {
    store.get(req.params.id);
    res.json({ services: sessionServices.catalog() });
  });
  app.get('/api/sessions/:id/services/:serviceId', (req, res) => res.json(sessionServices.read(req.params.serviceId, store.get(req.params.id))));
  app.post('/api/sessions/:id/services/:serviceId/commands', (req, res) => {
    store.get(req.params.id);
    sessionServices.assertInstalled(req.params.serviceId);
    if (engine.busy(req.params.id)) throw new ApiError(409, 'TURN_BUSY', 'Wait for this turn before applying a session service command');
    res.json(sessionServices.apply(req.params.serviceId, store, req.params.id, req.body));
  });
  app.post('/api/sessions/:id/turns', (req, res) => res.status(202).json(engine.submit(req.params.id, req.body ?? {})));
  app.post('/api/sessions/:id/cancel', (req, res) => res.json(engine.cancel(req.params.id)));
  app.get('/api/sessions/:id/runtime', (req, res) => res.json(readRuntimeConfiguration(store, req.params.id)));
  app.get('/api/sessions/:id/runtime/modules', (req, res) => res.json(engine.runtime(req.params.id)));
  app.get('/api/sessions/:id/runtime/worldbook/data', async (req, res) => res.json(await engine.worldbookData(req.params.id)));
  app.post('/api/sessions/:id/runtime/worldbook/commands', async (req, res) => {
    if (engine.busy(req.params.id)) throw new ApiError(409, 'TURN_BUSY', 'Wait for this turn before changing worldbook entries');
    let sourceModules: PromptModule[] | undefined;
    const source: unknown = req.body?.source;
    if (req.body?.operation === 'edit' && typeof req.body.module?.content === 'string' && (source === 'card' || source === 'preset')) {
      const current = store.get(req.params.id);
      assertRevision(current, req.body.expectedRevision);
      const document = current[source], importId = document.compatibility?.importId;
      if (importId && options.importService?.runtimeModules) sourceModules = await options.importService.runtimeModules(importId, clone(document.modules));
    }
    // Source hydration is read-only and asynchronous. A turn or another author
    // edit may have started while it ran; both guards must still hold at commit.
    if (engine.busy(req.params.id)) throw new ApiError(409, 'TURN_BUSY', 'Wait for this turn before changing worldbook entries');
    res.json(applyWorldbookEdit(store, req.params.id, req.body ?? {}, modules, sourceModules ? { sourceModules } : undefined));
  });
  app.get('/api/sessions/:id/scenario', (req, res) => res.json(readScenario(store.get(req.params.id))));
  app.post('/api/sessions/:id/scenario/commands', (req, res) => {
    if (engine.busy(req.params.id)) throw new ApiError(409, 'TURN_BUSY', 'Wait for this turn before changing chapter progress');
    res.json(applyScenarioCommand(store, req.params.id, req.body ?? {}));
  });
  app.post('/api/sessions/:id/runtime/preview', async (req, res) => res.json(await engine.preview(req.params.id, req.body ?? {})));
  app.post('/api/sessions/:id/runtime', (req, res) => {
    if (engine.busy(req.params.id)) throw new ApiError(409, 'TURN_BUSY', 'Wait for this turn before changing runtime definitions');
    res.json(updateRuntimeConfiguration(store, req.params.id, req.body, modules));
  });
  app.post('/api/sessions/:id/state', (req, res) => {
    if (engine.busy(req.params.id)) throw new ApiError(409, 'TURN_BUSY', 'Wait for the turn to finish before editing state');
    res.json(store.edit(req.params.id, req.body ?? {}));
  });
  app.post('/api/sessions/:id/state/transactions', (req, res) => {
    if (engine.busy(req.params.id)) throw new ApiError(409, 'TURN_BUSY', 'Wait for the turn before changing state');
    res.json(store.stateTransaction(req.params.id, req.body ?? {}));
  });
  app.post('/api/sessions/:id/lifecycle', (req, res) => {
    if (engine.busy(req.params.id)) throw new ApiError(409, 'TURN_BUSY', 'Wait for the turn to finish before changing lifecycle');
    res.json(store.lifecycle(req.params.id, req.body ?? {}));
  });
  app.get('/api/sessions/:id/knowledge', (req, res) => {
    const session = store.get(req.params.id);
    res.json({ revision: session.revision, roles: session.roles.map(role => ({ id: role.id, name: role.name, knowledge: role.knowledge })), registry: session.knowledgeRegistry });
  });
  app.post('/api/sessions/:id/knowledge', (req, res) => {
    if (engine.busy(req.params.id)) throw new ApiError(409, 'TURN_BUSY', 'Wait for the turn before editing knowledge');
    res.json(store.knowledge(req.params.id, req.body ?? {}));
  });
  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'API_UNKNOWN', 'API route not found')));
  app.use(express.static(options.staticRoot ?? resolve('build/web')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(options.staticRoot ?? 'build/web', 'index.html')));
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AgentModuleError) error = new ApiError(400, error.code, error.message);
    if (error instanceof ScenarioError) error = new ApiError(error.status, error.code, error.message);
    if (error instanceof InitializationError) error = new ApiError(400, error.code, error.message);
    if (error instanceof KnowledgeError || error instanceof StateTransactionError) error = new ApiError(/CONFLICT$/.test(error.code) ? 409 : 400, error.code, error.message);
    const status = error instanceof ApiError ? error.status : error?.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 500;
    const issues = error instanceof ApiError && Array.isArray((error as any).issues)
      ? (error as any).issues.filter((issue: any) => typeof issue?.path === 'string' && typeof issue?.message === 'string')
        .map((issue: any) => ({ path: issue.path, message: issue.message })) : undefined;
    res.status(status).json({ error: { code: error instanceof ApiError ? error.code : status === 413 ? 'UPLOAD_TOO_LARGE' : status === 400 ? 'INVALID_JSON' : 'INTERNAL_ERROR',
      message: error instanceof ApiError ? error.message : status === 413 ? 'Uploaded file is too large' : status === 400 ? 'Invalid JSON request' : 'The server could not complete this request',
      ...(issues ? { issues } : {}) } });
  });
  return { app, store, engine, provider, creator, compatibility, modules, sessionServices, close: async () => { await creator.close(); await engine.close(); } };
}
