import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Value } from '@sinclair/typebox/value';
import type { App } from '../app.ts';
import { AppConfig } from '../config/schema.ts';
import { ConfigError, parseConfig } from '../config/store.ts';
import type { ApprovalView } from '../tools/approvals.ts';
import { searchHistory } from '../memory/history.ts';
import { MemoryError } from '../memory/store.ts';
import { defaultOrigins, WebAuth } from './auth.ts';
import { HttpProblem, readBody, readJson, requireObject, requireString, Router, sendJson } from './http.ts';
import { attachmentBlock, MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, stripAttachments, UploadError } from '../uploads/store.ts';
import type { AttachmentMeta, ImageRef } from '../engine/types.ts';
import { registerReviewRoutes } from './routes-review.ts';
import { registerTaskRoutes } from './routes-tasks.ts';
import { LiveStreams } from './sse.ts';
import { serveStatic } from './static.ts';

const MAX_MESSAGE_CHARS = 100_000;

export interface WebServer {
  server: Server;
  streams: LiveStreams;
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  setOrigins: (origins: readonly string[]) => void;
}

function settingsView(app: App) {
  const config = app.config();
  const env = process.env;
  const keys = [...new Set(config.providers.map(p => p.apiKeyEnv ?? (p.kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : undefined)).filter((k): k is string => Boolean(k)))];
  return {
    config,
    apiKeys: Object.fromEntries(keys.map(k => [k, Boolean(env[k]?.trim())])),
    configError: app.configStore.lastError ? { message: app.configStore.lastError.message, problems: app.configStore.lastError.problems } : null,
    restartRequired: app.restartRequired(),
    configPath: app.configStore.path,
  };
}

function approvalView(a: ApprovalView) {
  return { id: a.id, runId: a.runId, conversationId: a.conversationId, tool: a.tool, title: a.title, body: a.body, cwd: a.cwd, reasons: a.reasons, details: a.details, expiresAt: a.expiresAt };
}

function modelsView(app: App) {
  const config = app.config();
  return {
    routing: config.routing,
    models: config.models.map(m => ({
      id: m.id, label: m.label ?? m.id, provider: m.provider, model: m.model,
      providerKind: config.providers.find(p => p.id === m.provider)?.kind,
      contextLength: m.contextLength, minContext: m.minContext, maxOutputTokens: m.maxOutputTokens,
      inChat: config.routing.chat.includes(m.id),
      probe: app.status.get(m.id) ?? null,
      cooldown: app.status.coolingDown(m.id) ?? null,
      recentFailures: app.health.failures(m.id),
    })),
  };
}

export function createWebServer(app: App): WebServer {
  const config = app.config();
  let auth = new WebAuth(defaultOrigins(config.server.port, config.server.origins), config.server.tailscaleLogins);
  const streams = new LiveStreams(app.bus);
  const router = new Router();

  router.add('GET', '/api/health', ({ res }) => sendJson(res, 200, {
    ok: true, bootId: app.bus.bootId, now: Date.now(), activeRuns: app.engine.activeRuns().length,
    configError: Boolean(app.configStore.lastError), restartRequired: app.restartRequired(),
  }));

  router.add('GET', '/api/events', ({ req, res, url }) => streams.open(req, res, url));

  // ── 会話 ──
  router.add('GET', '/api/conversations', ({ res }) => sendJson(res, 200, { conversations: app.conversations.list() }));
  router.add('POST', '/api/conversations', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    const title = requireString(body, 'title', { optional: true, max: 200 });
    sendJson(res, 201, { conversation: app.conversations.create(title ? { title } : {}) });
  });
  router.add('PATCH', '/api/conversations/:id', async ({ req, res, params }) => {
    const id = params[0]!;
    if (!app.conversations.get(id)) throw new HttpProblem(404, { error: 'not_found', message: '会話がありません' });
    const body = requireObject(await readJson(req));
    const title = requireString(body, 'title', { optional: true, max: 200 });
    if (title) app.conversations.rename(id, title);
    if (body.archived === true) app.conversations.archive(id);
    sendJson(res, 200, { conversation: app.conversations.get(id) });
  });
  router.add('GET', '/api/conversations/:id/messages', ({ res, params }) => {
    const id = params[0]!;
    const conversation = app.conversations.get(id);
    if (!conversation) throw new HttpProblem(404, { error: 'not_found', message: '会話がありません' });
    const { snapshot: _snapshot, ...meta } = conversation;
    const active = app.engine.activeRuns().find(r => r.conversationId === id);
    sendJson(res, 200, {
      conversation: meta,
      messages: app.conversations.messages(id).map(m => ({
        id: m.id, role: m.role, runId: m.run_id, createdAt: m.created_at,
        text: m.message.role === 'user' ? stripAttachments(m.message.content) : m.message.content,
        ...(m.message.role === 'user' && m.message.attachments?.length ? { attachments: m.message.attachments } : {}),
        ...(m.message.role === 'assistant' && m.message.toolCalls?.length
          ? { toolCalls: m.message.toolCalls.map(c => ({ id: c.id, name: c.name, input: JSON.stringify(c.arguments ?? c.raw ?? null).slice(0, 2000) })) } : {}),
        ...(m.message.role === 'tool' ? { toolName: m.message.name, toolCallId: m.message.toolCallId, isError: Boolean(m.message.isError) } : {}),
      })),
      activeRun: active ? { runId: active.runId, draft: app.bus.drafts().find(d => d.runId === active.runId)?.text ?? '' } : null,
      approvals: app.approvals.pending().filter(a => a.conversationId === id).map(approvalView),
    });
  });
  router.add('POST', '/api/conversations/:id/messages', async ({ req, res, params }) => {
    const id = params[0]!;
    const body = requireObject(await readJson(req));
    const ids = body.attachments === undefined ? [] : body.attachments;
    if (!Array.isArray(ids) || !ids.every(a => typeof a === 'string') || ids.length > MAX_ATTACHMENTS) {
      throw new HttpProblem(400, { error: 'invalid_field', field: 'attachments', message: `attachments は添付ファイルの ID の配列にしてください（${MAX_ATTACHMENTS} 件まで）` });
    }
    const text = ids.length && (body.text === undefined || body.text === '') ? '' : requireString(body, 'text', { max: MAX_MESSAGE_CHARS })!;
    const uploads = ids.map(uid => {
      const upload = app.uploads.get(uid);
      if (!upload) throw new HttpProblem(400, { error: 'invalid_field', field: 'attachments', message: '添付ファイルが見つかりません（もう一度添付してください）' });
      return upload;
    });
    const images: ImageRef[] = [];
    const blocks: string[] = [];
    for (const upload of uploads) {
      if (upload.kind === 'image') images.push(app.uploads.image(upload)); else blocks.push(attachmentBlock(upload));
    }
    if (images.length) {
      const config = app.config();
      const vision = config.routing.chat.some(mid => config.models.find(m => m.id === mid)?.vision && app.status.usable(mid));
      if (!vision) throw new HttpProblem(409, { error: 'no_vision', message: '画像を読めるモデルがチャットの列にありません（models[].vision が true のモデルを routing.chat に入れてください）' });
    }
    const attachments: AttachmentMeta[] = uploads.map(u => ({ id: u.id, name: u.name, kind: u.kind }));
    const content = [text || (images.length ? '（画像を添付しました）' : '（ファイルを添付しました）'), ...blocks].join('\n\n');
    if (!app.conversations.get(id)) app.conversations.create({ id });
    const outcome = app.engine.send(id, content, images, attachments);
    if (!outcome.ok) { const { ok: _ok, httpStatus, ...error } = outcome; sendJson(res, httpStatus, { error: error.errorKind, ...error }); return; }
    sendJson(res, 202, { runId: outcome.runId, messageId: outcome.messageId });
  });
  router.add('POST', '/api/conversations/:id/retry', ({ res, params }) => {
    const outcome = app.engine.retry(params[0]!);
    if (!outcome.ok) { const { ok: _ok, httpStatus, ...error } = outcome; sendJson(res, httpStatus, { error: error.errorKind, ...error }); return; }
    sendJson(res, 202, { runId: outcome.runId });
  });

  // ── 添付ファイル ──
  router.add('POST', '/api/uploads', async ({ req, res, url }) => {
    const name = (url.searchParams.get('name') ?? 'file').slice(0, 200);
    const body = await readBody(req, MAX_UPLOAD_BYTES);
    try { sendJson(res, 201, { upload: app.uploads.save({ name, mime: String(req.headers['content-type'] ?? ''), body }) }); }
    catch (error) {
      if (error instanceof UploadError) throw new HttpProblem(error.status, { error: 'upload', message: error.message });
      throw error;
    }
  });

  // ── 実行 ──
  router.add('POST', '/api/runs/:id/stop', ({ res, params }) => sendJson(res, 200, { stopped: app.engine.stop(params[0]!) }));
  router.add('GET', '/api/runs/active', ({ res }) => sendJson(res, 200, { drafts: app.bus.drafts() }));
  router.add('GET', '/api/runs', ({ res, url }) => {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), 500);
    sendJson(res, 200, { runs: app.runs.recent(limit).map(r => ({ ...r, flags: JSON.parse(r.flags) as string[] })) });
  });

  // ── 承認とツールの記録 ──
  router.add('GET', '/api/approvals', ({ res }) => sendJson(res, 200, { approvals: app.approvals.pending().map(approvalView) }));
  router.add('POST', '/api/approvals/:id', async ({ req, res, params }) => {
    const body = requireObject(await readJson(req));
    const decision = body.decision;
    if (decision !== 'once' && decision !== 'conversation' && decision !== 'deny') {
      throw new HttpProblem(400, { error: 'invalid_field', field: 'decision', message: 'decision は once / conversation / deny のどれかにしてください' });
    }
    const ok = app.approvals.decide(params[0]!, decision);
    if (!ok) throw new HttpProblem(404, { error: 'not_found', message: 'この承認は既に終わっています（時間切れか、中止された可能性があります）' });
    sendJson(res, 200, { ok: true });
  });
  router.add('GET', '/api/tool-calls', ({ res, url }) => {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), 500);
    sendJson(res, 200, { toolCalls: app.db.prepare('SELECT * FROM tool_calls ORDER BY created_at DESC LIMIT ?').all(limit) });
  });

  // ── 記憶と履歴 ──
  const memoryProblem = (error: unknown) => {
    if (error instanceof MemoryError) throw new HttpProblem(400, { error: 'memory', message: error.message });
    throw error;
  };
  const memoryId = (raw: string) => {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id < 1) throw new HttpProblem(400, { error: 'invalid_id', message: 'ID が正しくありません' });
    return id;
  };
  router.add('GET', '/api/memories', ({ res }) => {
    const usage = app.memory.usage();
    const items = app.memory.list();
    sendJson(res, 200, { books: {
      user: { ...usage.user, items: items.filter(m => m.book === 'user') },
      notes: { ...usage.notes, items: items.filter(m => m.book === 'notes') },
    } });
  });
  router.add('POST', '/api/memories', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    const book = body.book;
    if (book !== 'user' && book !== 'notes') throw new HttpProblem(400, { error: 'invalid_field', field: 'book', message: 'book は user か notes にしてください' });
    const content = requireString(body, 'content', { max: 600 })!;
    try { sendJson(res, 201, app.memory.save({ book, content, actor: 'user', origin: 'user' })); } catch (error) { memoryProblem(error); }
  });
  router.add('PATCH', '/api/memories/:id', async ({ req, res, params }) => {
    const content = requireString(requireObject(await readJson(req)), 'content', { max: 600 })!;
    try { sendJson(res, 200, app.memory.update(memoryId(params[0]!), content, 'user')); } catch (error) { memoryProblem(error); }
  });
  router.add('DELETE', '/api/memories/:id', ({ res, params }) => {
    try { sendJson(res, 200, app.memory.forget(memoryId(params[0]!), 'user', '画面から削除')); } catch (error) { memoryProblem(error); }
  });
  router.add('GET', '/api/memories/:id/events', ({ res, params }) => sendJson(res, 200, { events: app.memory.events(memoryId(params[0]!)) }));
  router.add('GET', '/api/memory-events', ({ res }) => sendJson(res, 200, { events: app.memory.events(undefined, 100) }));
  router.add('POST', '/api/memory-events/:id/undo', ({ res, params }) => {
    try { sendJson(res, 200, { memory: app.memory.undo(memoryId(params[0]!)) }); } catch (error) { memoryProblem(error); }
  });
  router.add('GET', '/api/history', ({ res, url }) => {
    const q = (url.searchParams.get('q') ?? '').slice(0, 200);
    const days = Number(url.searchParams.get('days') ?? '') || undefined;
    sendJson(res, 200, { hits: searchHistory(app.db, q, { days, limit: 50 }) });
  });

  // ── タスク・ワーカー・通知・プロフィール ──
  registerTaskRoutes(router, app);
  // ── スキル・レビュー・好奇心・振り返り ──
  registerReviewRoutes(router, app);

  // ── 設定とモデル ──
  router.add('GET', '/api/settings', ({ res }) => sendJson(res, 200, settingsView(app)));
  router.add('GET', '/api/settings/schema', ({ res }) => sendJson(res, 200, AppConfig));
  router.add('PUT', '/api/settings', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    let next;
    try { next = parseConfig(Value.Clone(body.config)); }
    catch (error) {
      if (error instanceof ConfigError) throw new HttpProblem(400, { error: 'invalid_config', message: error.message.split('\n')[0], problems: error.problems });
      throw error;
    }
    await app.applyConfig(next);
    sendJson(res, 200, { ...settingsView(app), ...modelsView(app) });
  });
  router.add('GET', '/api/models', ({ res }) => sendJson(res, 200, modelsView(app)));
  router.add('POST', '/api/models/probe', async ({ res }) => {
    await app.status.probeAll(app.config());
    sendJson(res, 200, modelsView(app));
  });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const verdict = auth.check(req);
    if (!verdict.ok) { sendJson(res, 403, { error: 'forbidden', reason: verdict.reason }); return; }
    if (!url.pathname.startsWith('/api/')) {
      if (!serveStatic(app.paths.webDist, req, res)) sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const match = router.match(req.method ?? 'GET', url.pathname);
    if (!match) { sendJson(res, 404, { error: 'not_found' }); return; }
    if (match === 'method_not_allowed') { sendJson(res, 405, { error: 'method_not_allowed' }); return; }
    try { await match.handler({ req, res, params: match.params, url }); }
    catch (error) {
      if (error instanceof HttpProblem) { sendJson(res, error.status, error.body); return; }
      app.log(`[ERROR] ${req.method} ${url.pathname}: ${(error as Error).stack ?? error}`);
      sendJson(res, 500, { error: 'internal', message: '内部エラーが発生しました（ログを確認してください）' });
    }
  };

  const server = createServer((req, res) => { void handle(req, res); });
  server.on('close', () => streams.close());
  const setOrigins = (origins: readonly string[]) => { auth = new WebAuth(origins, config.server.tailscaleLogins); };
  return { server, streams, handle, setOrigins };
}
