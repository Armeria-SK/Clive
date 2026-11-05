import type { App } from '../app.ts';
import { AVATAR_SHAPES } from '../config/schema.ts';
import { ConfigError } from '../config/store.ts';
import { parseCron } from '../tasks/schedule.ts';
import { TaskError, taskView, type Task } from '../tasks/store.ts';
import { languageOf } from '../shared/language.ts';
import { taskText } from '../shared/messages/tasks.ts';
import { domainProblem, HttpProblem, readJson, requireObject, requireString, sendJson, type Router } from './http.ts';

const MOTIONS = ['auto', 'none', 'float', 'sway', 'pulse'] as const;

function taskProblem(error: unknown): never {
  if (error instanceof TaskError) throw domainProblem(409, 'task', error);
  throw error;
}

function priorityOf(body: Record<string, unknown>): number | undefined {
  if (body.priority === undefined) return undefined;
  if (body.priority !== 1 && body.priority !== 2 && body.priority !== 3) {
    throw new HttpProblem(400, { error: 'invalid_field', field: 'priority', message: 'priority は 1（高）・2・3（低）のどれかにしてください' });
  }
  return body.priority;
}

function whenOf(body: Record<string, unknown>): number | null | undefined {
  if (body.when === undefined) return undefined;
  if (body.when === null || body.when === '') return null;
  const ms = typeof body.when === 'string' ? Date.parse(body.when) : Number.NaN;
  if (!Number.isFinite(ms)) throw new HttpProblem(400, { error: 'invalid_field', field: 'when', message: 'when は日時（例: 2026-11-06T09:00:00+09:00）にしてください' });
  return ms;
}

function cronOf(body: Record<string, unknown>): string | undefined {
  if (body.repeat === undefined || body.repeat === null) return undefined;
  const repeat = requireObject(body.repeat);
  const freq = typeof repeat.freq === 'string' ? repeat.freq : '';
  const values = repeat.values && typeof repeat.values === 'object' ? Object.fromEntries(Object.entries(repeat.values).map(([k, v]) => [k, String(v)])) : {};
  const cron = parseCron(freq, values);
  if (!cron) throw new HttpProblem(400, { error: 'invalid_field', field: 'repeat', message: '繰り返しの指定が正しくありません（freq は daily / weekday / weekly / hourly / interval。時刻は HH:MM）' });
  return cron;
}

export function registerTaskRoutes(router: Router, app: App): void {
  const view = (task: Task) => taskView(task, languageOf(app.config()));
  const getTask = (id: string): Task => {
    const task = app.tasks.get(id);
    if (!task) throw new HttpProblem(404, { error: 'not_found', message: 'タスクがありません' });
    return task;
  };

  router.add('GET', '/api/tasks', ({ res }) => sendJson(res, 200, {
    active: app.tasks.list().map(view),
    finished: app.tasks.recentlyFinished().map(view),
  }));

  router.add('POST', '/api/tasks', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    const title = requireString(body, 'title', { max: 200 })!;
    const text = requireString(body, 'body', { optional: true, max: 20_000 });
    const priority = priorityOf(body);
    const when = whenOf(body);
    const cron = cronOf(body);
    try {
      const task = app.tasks.create({
        title, body: text, priority, origin: 'user', actor: 'user',
        ...(when ? { runAt: when } : {}), ...(cron ? { cron, timezone: app.config().timezone } : {}),
      });
      // 「今すぐ」頼まれたものは、すぐに実行する（1時間の上限より先に）
      if (!when && !cron) app.worker.requestRun(task.id);
      sendJson(res, 201, { task: view(task) });
    } catch (error) { taskProblem(error); }
  });

  router.add('GET', '/api/tasks/:id', ({ res, params }) => {
    const task = getTask(params[0]!);
    const approvals = task.conversation_id ? app.approvals.pending().filter(a => a.conversationId === task.conversation_id).map(a => ({
      id: a.id, runId: a.runId, conversationId: a.conversationId, tool: a.tool, title: a.title, body: a.body, cwd: a.cwd, reasons: a.reasons, details: a.details, expiresAt: a.expiresAt,
    })) : [];
    const children = task.status === 'scheduled'
      ? app.db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at DESC LIMIT 20').all(task.id) as unknown as Task[]
      : [];
    sendJson(res, 200, { task: view(task), events: app.tasks.events(task.id), approvals, runs: children.map(view) });
  });

  router.add('PATCH', '/api/tasks/:id', async ({ req, res, params }) => {
    const task = getTask(params[0]!);
    const body = requireObject(await readJson(req));
    const title = requireString(body, 'title', { optional: true, max: 200 });
    const text = requireString(body, 'body', { optional: true, max: 20_000 });
    const nextAction = body.nextAction === null ? null : requireString(body, 'nextAction', { optional: true, max: 2000 });
    const priority = priorityOf(body);
    const when = whenOf(body);
    try {
      const updated = app.tasks.update(task.id, {
        ...(title !== undefined ? { title } : {}), ...(text !== undefined ? { body: text } : {}),
        ...(nextAction !== undefined ? { nextAction } : {}), ...(priority !== undefined ? { priority } : {}),
        ...(when !== undefined ? { runAt: when } : {}),
      }, 'user');
      app.tasks.event(task.id, 'edited', 'user');
      sendJson(res, 200, { task: view(updated) });
    } catch (error) { taskProblem(error); }
  });

  router.add('POST', '/api/tasks/:id/answer', async ({ req, res, params }) => {
    const task = getTask(params[0]!);
    const text = requireString(requireObject(await readJson(req)), 'text', { max: 20_000 })!;
    if (task.status !== 'waiting') throw new HttpProblem(409, { error: 'task', message: '返事を待っているタスクではありません' });
    app.tasks.event(task.id, 'answer', 'user', taskText(languageOf(app.config()), 'event.answer', { question: task.waiting_text ?? '', text }));
    const updated = app.tasks.setReady(task.id, { actor: 'user' });
    app.worker.requestRun(task.id);
    sendJson(res, 200, { task: view(updated) });
  });

  router.add('POST', '/api/tasks/:id/run-now', ({ res, params }) => {
    let task = getTask(params[0]!);
    try {
      if (task.status === 'running') throw new TaskError('error.running');
      if (task.status === 'waiting') throw new TaskError('error.waiting_answer');
      if (task.status === 'scheduled') {
        const child = app.tasks.spawnNow(task.id);
        if (!child) throw new TaskError('error.previous_unfinished');
        task = child;
      } else if (task.status === 'inbox') {
        task = app.tasks.approve(task.id);
      } else if (task.status !== 'ready' || task.attempts >= task.max_attempts) {
        task = app.tasks.reopen(task.id, 'user', taskText(languageOf(app.config()), 'event.run_now'));
      } else {
        task = app.tasks.update(task.id, { runAt: null }, 'user');
      }
      app.worker.requestRun(task.id);
      sendJson(res, 202, { task: view(task) });
    } catch (error) { taskProblem(error); }
  });

  router.add('POST', '/api/tasks/:id/approve', ({ res, params }) => {
    try { sendJson(res, 200, { task: view(app.tasks.approve(getTask(params[0]!).id)) }); } catch (error) { taskProblem(error); }
  });

  const close = (status: 'cancelled' | 'done') => ({ res, params }: { res: Parameters<typeof sendJson>[0]; params: string[] }) => {
    const task = getTask(params[0]!);
    if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
      throw new HttpProblem(409, { error: 'task', message: 'このタスクは既に終わっています' });
    }
    const updated = app.tasks.finish(task.id, status, taskText(languageOf(app.config()), status === 'done' ? 'summary.done_from_ui' : 'summary.cancelled_from_ui'), 'user');
    app.worker.stopTask(task.id);
    sendJson(res, 200, { task: view(updated) });
  };
  router.add('POST', '/api/tasks/:id/cancel', close('cancelled'));
  router.add('POST', '/api/tasks/:id/done', close('done'));

  // ── ワーカー ──
  router.add('GET', '/api/worker', ({ res }) => sendJson(res, 200, app.worker.status()));
  router.add('POST', '/api/worker', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    if (body.paused !== undefined) {
      if (typeof body.paused !== 'boolean') throw new HttpProblem(400, { error: 'invalid_field', field: 'paused', message: 'paused は true / false にしてください' });
      app.worker.setPaused(body.paused);
    }
    if (body.autonomy !== undefined) {
      if (typeof body.autonomy !== 'boolean') throw new HttpProblem(400, { error: 'invalid_field', field: 'autonomy', message: 'autonomy は true / false にしてください' });
      const config = app.config();
      if (config.worker.autonomy !== body.autonomy) await app.applyConfig({ ...config, worker: { ...config.worker, autonomy: body.autonomy } });
    }
    sendJson(res, 200, app.worker.status());
  });

  // ── 通知 ──
  router.add('GET', '/api/notifications', ({ res }) => sendJson(res, 200, { notifications: app.notifications.list(), unread: app.notifications.unread() }));
  router.add('POST', '/api/notifications/read', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    let ids: number[] | undefined;
    if (body.ids !== undefined) {
      if (!Array.isArray(body.ids) || !body.ids.every(id => Number.isSafeInteger(id))) {
        throw new HttpProblem(400, { error: 'invalid_field', field: 'ids', message: 'ids は通知 ID の配列にしてください' });
      }
      ids = body.ids as number[];
    }
    app.notifications.markRead(ids);
    sendJson(res, 200, { unread: app.notifications.unread() });
  });

  // ── プロフィール（名前と姿） ──
  router.add('GET', '/api/profile', ({ res }) => sendJson(res, 200, { ...app.config().profile, shapes: AVATAR_SHAPES, motions: MOTIONS }));
  router.add('PATCH', '/api/profile', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    const config = app.config();
    const profile = { ...config.profile };
    const name = requireString(body, 'name', { optional: true, max: 40 });
    if (name !== undefined) {
      if (!name.trim()) throw new HttpProblem(400, { error: 'invalid_field', field: 'name', message: '名前が空です' });
      profile.name = name.trim();
    }
    if (body.shape !== undefined) {
      if (!(AVATAR_SHAPES as readonly unknown[]).includes(body.shape)) throw new HttpProblem(400, { error: 'invalid_field', field: 'shape', message: `shape は ${AVATAR_SHAPES.join(' / ')} のどれかにしてください` });
      profile.shape = body.shape as typeof profile.shape;
    }
    if (body.color !== undefined) {
      if (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/u.test(body.color)) throw new HttpProblem(400, { error: 'invalid_field', field: 'color', message: 'color は #RRGGBB の形にしてください' });
      profile.color = body.color;
    }
    if (body.motion !== undefined) {
      if (!(MOTIONS as readonly unknown[]).includes(body.motion)) throw new HttpProblem(400, { error: 'invalid_field', field: 'motion', message: `motion は ${MOTIONS.join(' / ')} のどれかにしてください` });
      profile.motion = body.motion as typeof profile.motion;
    }
    try {
      const saved = await app.applyConfig({ ...config, profile });
      sendJson(res, 200, { ...saved.profile, shapes: AVATAR_SHAPES, motions: MOTIONS });
    } catch (error) {
      if (error instanceof ConfigError) throw new HttpProblem(400, { error: 'invalid_config', message: error.message.split('\n')[0], problems: error.problems });
      throw error;
    }
  });
}
