import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Value } from '@sinclair/typebox/value';
import type { App } from '../app.ts';
import { AppConfig, LANGUAGES, type Language } from '../config/schema.ts';
import { ConfigError, parseConfig } from '../config/store.ts';
import { candidateModelIds, type SendChoice } from '../engine/chat.ts';
import { modelEfforts } from '../engine/efforts.ts';
import { defaultTexts } from '../engine/workspace.ts';
import { languageOf } from '../shared/language.ts';
import { engineText } from '../shared/messages/engine.ts';
import { approvalWire } from '../tools/approvals.ts';
import { eraseConversation } from '../db/erase.ts';
import { searchHistory } from '../memory/history.ts';
import { join } from 'node:path';
import { MemoryError, planBooks } from '../memory/store.ts';
import { defaultOrigins, WebAuth } from './auth.ts';
import { httpText } from '../shared/messages/http.ts';
import { configProblem, domainProblem, HttpProblem, problem, readBody, readJson, requireObject, requireString, Router, sendJson } from './http.ts';
import { attachmentBlock, MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, stripAttachments, UploadError } from '../uploads/store.ts';
import type { AttachmentMeta, ImageRef } from '../engine/types.ts';
import { registerOnboardingRoutes } from './routes-onboarding.ts';
import { registerReviewRoutes } from './routes-review.ts';
import { registerTaskRoutes } from './routes-tasks.ts';
import { LiveStreams } from './sse.ts';
import { serveStatic } from './static.ts';

const MAX_MESSAGE_CHARS = 100_000;
// 会話を消すとき、動いている振り返りを止めて待つのを繰り返す回数の上限（超えたら 409 で消さない）
const MAX_REVIEW_STOP_ROUNDS = 10;
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

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
    configError: app.configStore.lastError ? { message: app.configStore.lastError.message, problems: app.configStore.lastError.problems, issues: app.configStore.lastError.issues } : null,
    restartRequired: app.restartRequired(),
    configPath: app.configStore.path,
  };
}

function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
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
      efforts: modelEfforts(config, m, app.status.get(m.id)),
      probe: app.status.get(m.id) ?? null,
      cooldown: app.status.coolingDown(m.id) ?? null,
      recentFailures: app.health.failures(m.id),
    })),
  };
}

// モデルと考える深さの選び方（PATCH と送信で共通）。設定にあるモデルだけ、そのモデルで選べる値だけを受ける。
// モデルだけを替えて、今の考える深さが新しいモデルに無いときは、null に戻して effortReset で知らせる。何も書く前に検査を終える
function readChoice(app: App, body: Record<string, unknown>, current: { model_id: string | null; effort: string | null } | undefined): { choice: SendChoice; effortReset: boolean } {
  const choice: SendChoice = {};
  const text = (field: 'modelId' | 'effort'): string | null | undefined => {
    const value = body[field];
    if (value === undefined || value === null) return value;
    if (typeof value !== 'string' || !value.trim()) throw problem(400, 'invalid_field', 'required', { field, params: { field } });
    return value;
  };
  const modelId = text('modelId');
  const effort = text('effort');
  if (modelId !== undefined) {
    if (modelId !== null && !app.config().models.some(m => m.id === modelId)) throw problem(400, 'invalid_field', 'unknown_model', { field: 'modelId', params: { id: modelId } });
    choice.modelId = modelId;
  }
  if (effort !== undefined) choice.effort = effort;
  const { efforts } = app.engine.effortChoices(modelId !== undefined ? modelId : current?.model_id ?? null);
  if (effort) {
    if (!efforts.includes(effort)) throw problem(400, 'invalid_field', 'bad_effort', { field: 'effort', params: { effort, values: efforts.join(' / ') || '-' } });
    return { choice, effortReset: false };
  }
  const kept = effort === undefined ? current?.effort ?? null : null;
  if (modelId !== undefined && kept !== null && !efforts.includes(kept)) { choice.effort = null; return { choice, effortReset: true }; }
  return { choice, effortReset: false };
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
  // ?archived=1 でアーカイブした会話（q は題の部分一致）
  router.add('GET', '/api/conversations', ({ res, url }) => {
    const archived = ['1', 'true'].includes(url.searchParams.get('archived') ?? '');
    const query = (url.searchParams.get('q') ?? '').slice(0, 100);
    sendJson(res, 200, { conversations: app.conversations.list(archived ? 200 : 100, { archived, ...(query.trim() ? { query } : {}) }) });
  });
  router.add('POST', '/api/conversations', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    const title = requireString(body, 'title', { optional: true, max: 200 });
    sendJson(res, 201, { conversation: app.conversations.create(title ? { title } : {}) });
  });
  router.add('PATCH', '/api/conversations/:id', async ({ req, res, params }) => {
    const id = params[0]!;
    const current = app.conversations.get(id);
    if (!current) throw problem(404, 'not_found', 'conversation_missing');
    const body = requireObject(await readJson(req));
    const title = requireString(body, 'title', { optional: true, max: 200 });
    if (body.archived !== undefined && typeof body.archived !== 'boolean') {
      throw problem(400, 'invalid_field', 'bad_bool', { field: 'archived', params: { field: 'archived' } });
    }
    const { choice, effortReset } = readChoice(app, body, current);
    const changed = (change: 'renamed' | 'archived' | 'unarchived') => app.bus.publish({ type: 'conversation.changed', conversationId: id, change });
    if (title) { app.conversations.rename(id, title); changed('renamed'); }
    app.conversations.setChoice(id, choice);
    if (body.archived === true) { app.conversations.archive(id); changed('archived'); }
    if (body.archived === false) { app.conversations.unarchive(id); changed('unarchived'); }
    sendJson(res, 200, { conversation: app.conversations.get(id), ...(effortReset ? { effortReset: true } : {}) });
  });
  // 要約（読むだけ）。要約が無い会話は summary が null
  router.add('GET', '/api/conversations/:id/summary', ({ res, params }) => {
    const id = params[0]!;
    if (!app.conversations.get(id)) throw problem(404, 'not_found', 'conversation_missing');
    sendJson(res, 200, app.conversations.summaryOf(id));
  });
  // 会話を消す（元に戻せない。画面は消えるものと残るものを見せて確かめてから呼ぶ）。返事を作っている最中の会話と、チャット以外の会話（タスク・振り返り）は断る。
  // この会話を材料にした振り返りが動いていれば、止めて終わるのを待ってから消す（その会話から作った振り返りの会話も、いっしょに消える）。
  // モデルの道具からは呼べない（道具を足していない）
  router.add('DELETE', '/api/conversations/:id', async ({ res, params }) => {
    const id = params[0]!;
    const conversation = app.conversations.get(id);
    if (!conversation) throw problem(404, 'not_found', 'conversation_missing');
    if (conversation.kind !== 'chat') throw problem(409, 'conflict', 'conversation_not_deletable');
    const running = () => app.engine.activeRuns().some(r => r.conversationId === id);
    if (running()) throw problem(409, 'conflict', 'conversation_running');
    // 振り返りを止めて待つあいだに、次の振り返りが始まらないよう、毎回、待っている振り返りを先に外してから、動いているものを止める。動いているものが無くなるまで繰り返す。
    // 最後の確かめと消すところのあいだには await が無いので、そのあいだに振り返りは始まらない
    for (let round = 0; ; round++) {
      app.reviews.dropPendingFor(id);
      const reviewConversations = new Set(app.reviews.runningFor(id).map(j => j.review_conversation_id));
      const reviewRuns = app.engine.activeRuns().filter(r => r.kind === 'review' && reviewConversations.has(r.conversationId));
      if (!reviewRuns.length) break;
      if (round >= MAX_REVIEW_STOP_ROUNDS) throw problem(409, 'conflict', 'conversation_running');
      for (const run of reviewRuns) app.engine.stop(run.runId);
      await Promise.all(reviewRuns.map(run => app.engine.wait(run.runId)));
    }
    if (!app.conversations.get(id)) throw problem(404, 'not_found', 'conversation_missing');
    if (running()) throw problem(409, 'conflict', 'conversation_running');
    const erased = eraseConversation({ db: app.db, uploadsDir: app.paths.uploads, toolOutputsDir: join(app.paths.data, 'tool_outputs'), markDeleted: ids => app.conversations.markDeleted(ids) }, id);
    app.approvals.forgetConversation(id);
    if (erased.files.failed.length) app.log(`[WARN] 会話を消したあと、消せなかったファイルがあります: ${erased.files.failed.join(', ')}`);
    app.bus.publish({ type: 'conversation.changed', conversationId: id, change: 'deleted' });
    sendJson(res, 200, { deleted: true, ...erased });
  });
  router.add('GET', '/api/conversations/:id/messages', ({ res, params }) => {
    const id = params[0]!;
    const conversation = app.conversations.get(id);
    if (!conversation) throw problem(404, 'not_found', 'conversation_missing');
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
      pending: app.engine.pending(id),
      activeRun: active ? { runId: active.runId, draft: app.bus.drafts().find(d => d.runId === active.runId)?.text ?? '' } : null,
      approvals: app.approvals.pending().filter(a => a.conversationId === id).map(approvalWire),
    });
  });
  // 次に送るときの量。何も書かない（まだ無い会話を作らず、system も固定しない）
  router.add('GET', '/api/conversations/:id/context', ({ res, params, url }) => {
    const id = params[0]!;
    const existing = app.conversations.get(id);
    if (existing && existing.kind !== 'chat') throw problem(409, 'conflict', 'not_chat_conversation');
    const outcome = app.engine.contextUsage(id, url.searchParams.get('modelId') || undefined);
    if (!outcome.ok) { const { ok: _ok, httpStatus, ...error } = outcome; sendJson(res, httpStatus, { error: error.errorKind, ...error }); return; }
    const { ok: _ok, ...usage } = outcome;
    sendJson(res, 200, usage);
  });
  router.add('POST', '/api/conversations/:id/messages', async ({ req, res, params }) => {
    const id = params[0]!;
    const body = requireObject(await readJson(req));
    const ids = body.attachments === undefined ? [] : body.attachments;
    if (!Array.isArray(ids) || !ids.every(a => typeof a === 'string') || ids.length > MAX_ATTACHMENTS) {
      throw problem(400, 'invalid_field', 'bad_attachments', { field: 'attachments', params: { max: MAX_ATTACHMENTS } });
    }
    const text = ids.length && (body.text === undefined || body.text === '') ? '' : requireString(body, 'text', { max: MAX_MESSAGE_CHARS })!;
    const uploads = ids.map(uid => {
      const upload = app.uploads.get(uid);
      if (!upload) throw problem(400, 'invalid_field', 'attachment_missing', { field: 'attachments' });
      return upload;
    });
    if (body.interrupt !== undefined && typeof body.interrupt !== 'boolean') throw problem(400, 'invalid_field', 'bad_bool', { field: 'interrupt', params: { field: 'interrupt' } });
    const interrupt = body.interrupt === true;
    const existing = app.conversations.get(id);
    const { choice, effortReset } = readChoice(app, body, existing);
    const images: ImageRef[] = [];
    const blocks: string[] = [];
    for (const upload of uploads) {
      if (upload.kind === 'image') images.push(app.uploads.image(upload)); else blocks.push(attachmentBlock(upload, languageOf(app.config())));
    }
    if (images.length) {
      const config = app.config();
      // 会話でモデルを選んでいれば、画像を読めるかはそのモデルで決める
      const pinned = choice.modelId !== undefined ? choice.modelId : existing?.model_id ?? null;
      const candidates = pinned ? [pinned] : candidateModelIds(config, 'chat');
      // 候補が 1 つも無い（モデルが 0 個）ときは画像の話の前に、エンジンの「使えるモデルがない」案内に任せる
      const vision = candidates.some(mid => config.models.find(m => m.id === mid)?.vision && app.status.usable(mid));
      if (candidates.length && !vision) throw problem(409, 'no_vision', 'no_vision');
    }
    const attachments: AttachmentMeta[] = uploads.map(u => ({ id: u.id, name: u.name, kind: u.kind }));
    const content = [text || engineText(languageOf(app.config()), images.length ? 'attachment.image' : 'attachment.file'), ...blocks].join('\n\n');
    // 画面が決めた id へ最初の発言を送ると、受け付けたときに会話ができる。作られる id は UUID の形だけ。タスク・振り返りの会話には、ここから送らせない
    if (existing && existing.kind !== 'chat') throw problem(409, 'conflict', 'not_chat_conversation');
    if (!existing && !CONVERSATION_ID.test(id)) throw problem(400, 'invalid_id', 'invalid_id');
    const outcome = app.engine.send(id, content, images, attachments, choice, { interrupt });
    if (!outcome.ok) { const { ok: _ok, httpStatus, ...error } = outcome; sendJson(res, httpStatus, { error: error.errorKind, ...error }); return; }
    // 実行中だったときは待たせた（queued）。今の実行が次の区切りで読む。取り消すときは pendingId
    // 考える深さを新しいモデルに無いので戻したときは、effortReset で知らせる（PATCH と同じ）
    const reset = effortReset ? { effortReset: true } : {};
    sendJson(res, 202, outcome.queued ? { runId: outcome.runId, queued: true, pendingId: outcome.pendingId, ...reset } : { runId: outcome.runId, messageId: outcome.messageId, ...reset });
  });
  // 待っている発言を、差し込まれる前に取り消す
  router.add('DELETE', '/api/conversations/:id/pending/:pid', ({ res, params }) => {
    if (!app.engine.cancelPending(params[0]!, params[1]!)) throw problem(404, 'not_found', 'pending_gone');
    sendJson(res, 200, { cancelled: true });
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
      if (error instanceof UploadError) throw domainProblem(error.status, 'upload', error);
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
  router.add('GET', '/api/approvals', ({ res }) => sendJson(res, 200, { approvals: app.approvals.pending().map(approvalWire) }));
  router.add('POST', '/api/approvals/:id', async ({ req, res, params }) => {
    const body = requireObject(await readJson(req));
    const decision = body.decision;
    if (decision !== 'once' && decision !== 'conversation' && decision !== 'deny') {
      throw problem(400, 'invalid_field', 'bad_enum', { field: 'decision', params: { field: 'decision', values: 'once / conversation / deny' } });
    }
    const ok = app.approvals.decide(params[0]!, decision);
    if (!ok) throw problem(404, 'not_found', 'approval_gone');
    sendJson(res, 200, { ok: true });
  });
  router.add('GET', '/api/tool-calls', ({ res, url }) => {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), 500);
    sendJson(res, 200, { toolCalls: app.db.prepare('SELECT * FROM tool_calls ORDER BY created_at DESC LIMIT ?').all(limit) });
  });

  // ── 記憶と履歴 ──
  const memoryProblem = (error: unknown) => {
    if (error instanceof MemoryError) throw domainProblem(400, 'memory', error);
    throw error;
  };
  const memoryId = (raw: string) => {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id < 1) throw problem(400, 'invalid_id', 'invalid_id');
    return id;
  };
  router.add('GET', '/api/memories', ({ res }) => {
    const items = app.memory.list();
    const budget = app.engine.memoryBudget();
    const plan = planBooks(items, languageOf(app.config()), budget);
    sendJson(res, 200, {
      books: {
        user: { used: app.memory.used('user'), items: items.filter(m => m.book === 'user') },
        notes: { used: app.memory.used('notes'), items: items.filter(m => m.book === 'notes') },
      },
      context: { tokens: plan.tokens, budget: budget ?? null, omitted: plan.omitted.length },
    });
  });
  router.add('POST', '/api/memories', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    const book = body.book;
    if (book !== 'user' && book !== 'notes') throw problem(400, 'invalid_field', 'bad_book', { field: 'book' });
    const content = requireString(body, 'content', { max: 600 })!;
    try { sendJson(res, 201, app.memory.save({ book, content, actor: 'user', origin: 'user' })); } catch (error) { memoryProblem(error); }
  });
  router.add('PATCH', '/api/memories/:id', async ({ req, res, params }) => {
    const content = requireString(requireObject(await readJson(req)), 'content', { max: 600 })!;
    try { sendJson(res, 200, app.memory.update(memoryId(params[0]!), content, 'user')); } catch (error) { memoryProblem(error); }
  });
  router.add('DELETE', '/api/memories/:id', ({ res, params }) => {
    try { sendJson(res, 200, app.memory.forget(memoryId(params[0]!), 'user', httpText(languageOf(app.config()), 'memory_deleted_note'))); } catch (error) { memoryProblem(error); }
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
  // ── はじめの設定・名前と話し方（SOUL.md / USER.md）・.env の読み直し ──
  registerOnboardingRoutes(router, app);

  // ── 設定とモデル ──
  router.add('GET', '/api/settings', ({ res }) => sendJson(res, 200, settingsView(app)));
  router.add('GET', '/api/settings/schema', ({ res }) => sendJson(res, 200, AppConfig));
  router.add('PUT', '/api/settings', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    let next;
    try { next = parseConfig(Value.Clone(body.config)); }
    catch (error) {
      if (error instanceof ConfigError) throw configProblem(error);
      throw error;
    }
    await app.applyConfig(next);
    sendJson(res, 200, { ...settingsView(app), ...modelsView(app) });
  });
  router.add('GET', '/api/templates/:language', ({ res, params }) => {
    const language = params[0]!;
    if (!isLanguage(language)) throw problem(404, 'not_found', 'unknown_language', { params: { language, values: LANGUAGES.join(' / ') } });
    sendJson(res, 200, { language, ...defaultTexts(app.paths, language) });
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
      if (error instanceof HttpProblem) { sendJson(res, error.status, error.render(languageOf(app.config()))); return; }
      app.log(`[ERROR] ${req.method} ${url.pathname}: ${(error as Error).stack ?? error}`);
      sendJson(res, 500, { error: 'internal', message: httpText(languageOf(app.config()), 'internal'), code: 'http.internal' });
    }
  };

  const server = createServer((req, res) => { void handle(req, res); });
  server.on('close', () => streams.close());
  const setOrigins = (origins: readonly string[]) => { auth = new WebAuth(origins, config.server.tailscaleLogins); };
  return { server, streams, handle, setOrigins };
}
