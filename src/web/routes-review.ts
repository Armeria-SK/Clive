import type { App } from '../app.ts';
import { CuriosityError, type CuriosityStatus } from '../curiosity/store.ts';
import { curiosityText } from '../curiosity/text.ts';
import { languageOf } from '../shared/language.ts';
import { TRIGGER_LABEL } from '../memory/review.ts';
import { SkillError } from '../tools/skills/store.ts';
import { taskView } from '../tasks/store.ts';
import { HttpProblem, readJson, requireObject, requireString, sendJson, type Router } from './http.ts';

const STATUSES: readonly CuriosityStatus[] = ['open', 'researching', 'done', 'dropped'];

function problem(error: unknown): never {
  if (error instanceof SkillError || error instanceof CuriosityError) throw new HttpProblem(400, { error: 'invalid', message: error.message });
  throw error;
}

function idOf(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpProblem(400, { error: 'invalid_id', message: 'ID が正しくありません' });
  return id;
}

export function registerReviewRoutes(router: Router, app: App): void {
  // ── スキル ──
  router.add('GET', '/api/skills', ({ res }) => sendJson(res, 200, {
    skills: app.skills.list().map(({ body: _body, ...s }) => s),
    dir: app.skills.dir,
  }));
  router.add('GET', '/api/skills/:name', ({ res, params }) => {
    const skill = app.skills.get(params[0]!);
    if (!skill) throw new HttpProblem(404, { error: 'not_found', message: 'スキルがありません' });
    sendJson(res, 200, { skill });
  });
  router.add('PUT', '/api/skills/:name', async ({ req, res, params }) => {
    const body = requireObject(await readJson(req));
    const description = requireString(body, 'description', { max: 300 })!;
    const text = requireString(body, 'body', { max: 20_000 })!;
    try { sendJson(res, 200, { skill: app.skills.write({ name: params[0]!, description, body: text }) }); } catch (error) { problem(error); }
  });
  router.add('DELETE', '/api/skills/:name', ({ res, params }) => {
    try { app.skills.remove(params[0]!); sendJson(res, 200, { ok: true }); } catch (error) { problem(error); }
  });

  // ── レビュー（承認が要るものをまとめて扱う） ──
  router.add('GET', '/api/review', ({ res }) => {
    const drafts = app.skills.drafts('pending').map(d => {
      const current = app.skills.get(d.name);
      return { ...d, current: current ? { description: current.description, body: current.body } : null };
    });
    sendJson(res, 200, {
      skillDrafts: drafts,
      taskProposals: app.tasks.list({ statuses: ['inbox'] }).map(taskView),
    });
  });
  router.add('POST', '/api/skill-drafts/:id/approve', ({ res, params }) => {
    try { sendJson(res, 200, { skill: app.skills.approve(idOf(params[0]!)) }); } catch (error) { problem(error); }
  });
  router.add('POST', '/api/skill-drafts/:id/reject', ({ res, params }) => {
    try { app.skills.reject(idOf(params[0]!)); sendJson(res, 200, { ok: true }); } catch (error) { problem(error); }
  });

  // ── 好奇心リスト ──
  router.add('GET', '/api/curiosity', ({ res, url }) => sendJson(res, 200, {
    items: app.curiosity.list({ includeClosed: url.searchParams.get('all') === '1' }),
  }));
  router.add('POST', '/api/curiosity', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    const topic = requireString(body, 'topic', { max: 200 })!;
    const why = requireString(body, 'why', { optional: true, max: 500 });
    try { sendJson(res, 201, { item: app.curiosity.add({ topic, why, source: 'user' }) }); } catch (error) { problem(error); }
  });
  router.add('PATCH', '/api/curiosity/:id', async ({ req, res, params }) => {
    const body = requireObject(await readJson(req));
    if (body.status !== undefined && !(STATUSES as readonly unknown[]).includes(body.status)) {
      throw new HttpProblem(400, { error: 'invalid_field', field: 'status', message: `status は ${STATUSES.join(' / ')} のどれかにしてください` });
    }
    const topic = requireString(body, 'topic', { optional: true, max: 200 });
    const why = requireString(body, 'why', { optional: true, max: 500 });
    const result = requireString(body, 'result', { optional: true, max: 4000 });
    try {
      sendJson(res, 200, { item: app.curiosity.update(idOf(params[0]!), {
        ...(topic !== undefined ? { topic } : {}), ...(why !== undefined ? { why } : {}), ...(result !== undefined ? { result } : {}),
        ...(body.status !== undefined ? { status: body.status as CuriosityStatus } : {}),
      }) });
    } catch (error) { problem(error); }
  });
  router.add('POST', '/api/curiosity/:id/task', ({ res, params }) => {
    const item = app.curiosity.get(idOf(params[0]!));
    if (!item) throw new HttpProblem(404, { error: 'not_found', message: '項目がありません' });
    if (item.status === 'researching') throw new HttpProblem(409, { error: 'busy', message: '既に調べています' });
    const text = curiosityText(languageOf(app.config()));
    const task = app.tasks.create({
      title: text.title(item.topic).slice(0, 200), body: item.why ? text.why(item.why) : '',
      doneCriteria: text.doneCriteria, origin: 'curiosity', curiosityId: item.id, actor: 'user',
    });
    app.curiosity.update(item.id, { status: 'researching', taskId: task.id });
    app.worker.requestRun(task.id);
    sendJson(res, 201, { task: taskView(task) });
  });

  // ── 振り返りの記録 ──
  router.add('GET', '/api/reviews', ({ res }) => {
    const jobs = app.reviews.list(50).map(job => ({
      ...job, triggerLabel: TRIGGER_LABEL[job.trigger],
      changes: job.run_id ? app.db.prepare('SELECT * FROM memory_events WHERE run_id = ? ORDER BY id').all(job.run_id) : [],
    }));
    sendJson(res, 200, { jobs, pending: app.reviews.pendingCount() });
  });
  router.add('POST', '/api/reviews', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    const conversationId = requireString(body, 'conversationId', { max: 100 })!;
    if (!app.conversations.get(conversationId)) throw new HttpProblem(404, { error: 'not_found', message: '会話がありません' });
    const last = app.conversations.messages(conversationId, 1).at(-1);
    const job = app.reviews.enqueue('manual', `manual:${conversationId}:${last?.id ?? 0}`, { conversationId });
    app.worker.poke();
    sendJson(res, job ? 202 : 200, { queued: Boolean(job) });
  });
}
