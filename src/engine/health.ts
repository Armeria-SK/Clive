import { DEFAULT_LANGUAGE, type Language } from '../config/schema.ts';
import type { Runs } from '../db/runs.ts';
import type { Notifications } from '../notify/notifications.ts';
import { taskText } from '../shared/messages/tasks.ts';
import type { ModelStatus } from './status.ts';
import type { RunEvent } from './types.ts';

export const FAILURE_THRESHOLD = 3;
export const COOLDOWN_MS = 5 * 60_000;

export class HealthMonitor {
  readonly #status: ModelStatus;
  readonly #runs: Runs;
  readonly #notifications: Notifications;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  readonly #language: () => Language;
  #failures = new Map<string, { count: number; reason: string }>();

  constructor(deps: { status: ModelStatus; runs: Runs; notifications: Notifications; now?: () => number; log?: (line: string) => void; language?: () => Language }) {
    this.#status = deps.status;
    this.#runs = deps.runs;
    this.#notifications = deps.notifications;
    this.#now = deps.now ?? Date.now;
    this.#log = deps.log ?? (() => undefined);
    this.#language = deps.language ?? (() => DEFAULT_LANGUAGE);
  }

  failures(modelId: string): number { return this.#failures.get(modelId)?.count ?? 0; }

  observe(event: RunEvent): void {
    if (event.type === 'model.switch') { this.#fail(event.from, event.reason, false); return; }
    if (event.type !== 'run.end') return;
    const modelId = this.#runs.get(event.runId)?.model_id;
    if (!modelId) return;
    if (event.ok) { this.#succeed(modelId); return; }
    // 中止・コンテキスト不足は、モデルやサーバーの不調ではない（コンテキストは送る前の確認で知らせている）
    if (event.errorKind === 'cancelled' || event.errorKind === 'context_overflow') return;
    this.#fail(modelId, event.errorMessage ?? event.errorKind ?? taskText(this.#language(), 'health.default_reason'), event.errorKind === 'auth');
  }

  #succeed(modelId: string): void {
    if (this.#failures.delete(modelId) && this.#status.coolingDown(modelId)) {
      this.#status.endCooldown(modelId);
      this.#log(`[INFO] model ${modelId}: 回復しました`);
    }
  }

  #fail(modelId: string, reason: string, immediate: boolean): void {
    const current = this.#failures.get(modelId);
    const count = (current?.count ?? 0) + 1;
    this.#failures.set(modelId, { count, reason });
    if (!immediate && count < FAILURE_THRESHOLD) return;
    this.#status.cooldown(modelId, this.#now() + COOLDOWN_MS, reason);
    this.#log(`[WARN] model ${modelId}: ${count} 回続けて失敗したため、${COOLDOWN_MS / 60_000} 分間は予備のモデルを先に使います（${reason.split('\n')[0]}）`);
    const language = this.#language();
    this.#notifications.notify({
      kind: 'health_alert',
      title: immediate ? taskText(language, 'health.auth_title', { model: modelId }) : taskText(language, 'health.failing_title', { model: modelId, count }),
      body: `${reason.split('\n')[0]}\n${immediate ? taskText(language, 'health.auth_tail') : taskText(language, 'health.failing_tail', { minutes: COOLDOWN_MS / 60_000 })}`,
      link: '#/settings',
      dedupKey: `health:${modelId}:${immediate ? 'auth' : 'failing'}`,
    });
  }
}
