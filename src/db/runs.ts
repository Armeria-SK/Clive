import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LANGUAGE } from '../config/schema.ts';
import { engineText } from '../shared/messages/engine.ts';
import type { EngineErrorKind, StopReason, Usage } from '../engine/types.ts';

export interface RunRow {
  id: string;
  kind: string;
  conversation_id: string | null;
  model_id: string | null;
  provider_id: string | null;
  model: string | null;
  attempts: number;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  ok: number | null;
  error_kind: string | null;
  error_message: string | null;
  stop: string | null;
  iterations: number;
  tool_calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  est_prompt_tokens: number | null;
  flags: string;
  // 1 = この実行は、外から読んだ内容（Web・添付、前の実行から引き継いだ分を含む）を読んだ。終わったかどうかに関わらず、読んだ時点で書く
  tainted: number;
}

export interface RunFinish {
  ok: boolean;
  modelId?: string;
  providerId?: string;
  model?: string;
  attempts: number;
  errorKind?: EngineErrorKind;
  errorMessage?: string;
  stop?: StopReason;
  iterations?: number;
  toolCalls?: number;
  usage?: Usage;
  estPromptTokens?: number;
  flags?: string[];
}

export class Runs {
  readonly db: DatabaseSync;
  readonly now: () => number;
  constructor(db: DatabaseSync, now: () => number = Date.now) { this.db = db; this.now = now; }

  start(id: string, kind: string, conversationId?: string): void {
    this.db.prepare('INSERT INTO engine_runs (id, kind, conversation_id, started_at) VALUES (?, ?, ?, ?)')
      .run(id, kind, conversationId ?? null, this.now());
  }

  finish(id: string, f: RunFinish): void {
    const ended = this.now();
    const row = this.db.prepare('SELECT started_at FROM engine_runs WHERE id = ?').get(id) as { started_at: number } | undefined;
    this.db.prepare(`
      UPDATE engine_runs SET ended_at = ?, duration_ms = ?, ok = ?, model_id = ?, provider_id = ?, model = ?, attempts = ?,
        error_kind = ?, error_message = ?, stop = ?, iterations = ?, tool_calls = ?, input_tokens = ?, output_tokens = ?,
        cache_read_tokens = ?, cache_write_tokens = ?, est_prompt_tokens = ?, flags = ?
      WHERE id = ?
    `).run(
      ended, row ? ended - row.started_at : null, f.ok ? 1 : 0, f.modelId ?? null, f.providerId ?? null, f.model ?? null, f.attempts,
      f.errorKind ?? null, f.errorMessage ?? null, f.stop ?? null, f.iterations ?? 0, f.toolCalls ?? 0,
      f.usage?.inputTokens ?? null, f.usage?.outputTokens ?? null, f.usage?.cacheReadTokens ?? null, f.usage?.cacheWriteTokens ?? null,
      f.estPromptTokens ?? null, JSON.stringify(f.flags ?? []), id,
    );
  }

  // 「外から読んだ」印を付ける（一度付いたら外れない）。実行が終わる前に書くので、落ちて途中で終わった実行にも残る
  markTainted(id: string): void {
    this.db.prepare('UPDATE engine_runs SET tainted = 1 WHERE id = ?').run(id);
  }

  get(id: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM engine_runs WHERE id = ?').get(id) as RunRow | undefined;
  }

  // その会話の、いちばん新しいチャットの実行（やり直し・次の発言が、前の実行の印と終わり方を見るため）
  latestChat(conversationId: string): RunRow | undefined {
    return this.db.prepare("SELECT * FROM engine_runs WHERE conversation_id = ? AND kind = 'chat' ORDER BY started_at DESC, rowid DESC LIMIT 1").get(conversationId) as RunRow | undefined;
  }

  recent(limit = 100): RunRow[] {
    return this.db.prepare('SELECT * FROM engine_runs ORDER BY started_at DESC LIMIT ?').all(limit) as unknown as RunRow[];
  }

  closeDangling(message: string = engineText(DEFAULT_LANGUAGE, 'run.restart_interrupted')): number {
    const now = this.now();
    const result = this.db.prepare(`
      UPDATE engine_runs SET ended_at = ?, ok = 0, error_kind = 'cancelled', error_message = ?
      WHERE ended_at IS NULL
    `).run(now, message);
    return Number(result.changes);
  }
}
