import { api, ApiError, type Task } from './api.ts';
import { t } from './i18n/index.ts';
import { ROW_ACTION_API } from './task-meta.ts';
import { toast } from './toast.tsx';

export type TaskAction = keyof typeof ROW_ACTION_API | 'stop';

export interface ActionContext {
  // いまワーカーが動かしている実行の id（止めるのはこれだけ）と、別のタスクが動いているか
  runId?: string | undefined;
  busyWithOther?: boolean;
}

export function reportTaskError(error: unknown): void {
  toast({ icon: 'alert', title: t('toast.actionFailed'), body: error instanceof ApiError ? error.message : undefined });
}

// 行とシートで共通の操作。成功したら通知（トースト）を出して true を返す。失敗したら理由を出して false を返す。
// 取り消しのトーストに「元に戻す」は付けない（サーバーの取り消しは戻せない）。
export async function performTaskAction(action: TaskAction, task: Pick<Task, 'id' | 'title'>, context: ActionContext = {}): Promise<boolean> {
  try {
    if (action === 'stop') {
      if (!context.runId) return false;
      await api.stop(context.runId);
      toast({ icon: 'square', title: t('tasks.toast.stopped'), body: t('tasks.toast.stoppedBody') });
      return true;
    }
    await api.taskAction(task.id, ROW_ACTION_API[action]);
    switch (action) {
      case 'run':
      case 'runNow':
      case 'retry':
        toast({ icon: 'play', title: t(context.busyWithOther ? 'tasks.toast.runNext' : 'tasks.toast.runStarted'), body: task.title });
        break;
      case 'done': toast({ kind: 'done', icon: 'check', title: t('tasks.toast.done'), body: task.title }); break;
      case 'cancel': toast({ icon: 'circleSlash', title: t('tasks.toast.cancelled'), body: task.title }); break;
      case 'approve': toast({ kind: 'done', icon: 'check', title: t('tasks.toast.approved'), body: task.title }); break;
      case 'skip': toast({ icon: 'circleSlash', title: t('tasks.toast.skipped'), body: task.title }); break;
    }
    return true;
  } catch (error) {
    reportTaskError(error);
    return false;
  }
}

export async function answerTask(task: Pick<Task, 'id'>, text: string): Promise<boolean> {
  try {
    await api.answerTask(task.id, text);
    toast({ kind: 'done', icon: 'msg', title: t('tasks.toast.answered'), body: t('tasks.toast.answeredBody') });
    return true;
  } catch (error) {
    reportTaskError(error);
    return false;
  }
}
