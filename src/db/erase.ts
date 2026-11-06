import { rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './database.ts';

export interface EraseDeps {
  db: DatabaseSync;
  uploadsDir: string;
  // 長いシェル出力の全文を置くフォルダ（道具の記録の full_ref はこの下のものだけ消す）
  toolOutputsDir: string;
  // 消した会話（と、いっしょに消した振り返りの会話）の id を渡す。動いていた実行の遅れた書き込みが、消した会話を作り直さないようにするための覚え
  markDeleted?: ((ids: string[]) => void) | undefined;
}

export interface EraseResult {
  messages: number;
  uploads: number;
  // いっしょに消した、この会話を材料にした振り返り（記憶の振り返りの会話）の数
  reviews: number;
  files: { removed: number; failed: string[] };
}

const inside = (dir: string, path: string): boolean => { const base = resolve(dir) + sep; return resolve(path).startsWith(base); };

// 会話を消す（元に戻せない）。消すもの: 会話・発言（検索の索引も）・要約と固定の system（会話の行にある）・承認の記録・
// 会話ごとの kv（`<名前>:<会話ID>` の形のもの全部）・待っている振り返り・その会話だけが使う添付（行とファイル）と長い出力の全文ファイル・
// この会話で notify_owner が出した通知（題と本文に会話の内容を写していることがあるため。タスクの実行が出した通知は、残すタスクのものとして残す）。
// 数字だけ残すもの: 実行の記録（会話との結び付きと本文を消す）と道具の記録（種類・結果・時間は残し、入力と出力の本文・結び付きを消す）。
// 残すもの: 記憶・スキルの下書き・その会話から作ったタスク（結び付きだけ外す）。
// この会話を材料にした振り返り（memory_jobs の conversation_id がこの会話の、振り返りの会話）も、同じやり方で消す（発言に、この会話の文が写っているため）。
// 振り返りの記録（memory_jobs）は、会話の ID と返事のメモを消して残す。呼ぶ側が、走っている会話・チャット以外の会話を断り、動いている振り返りを止めておく
export function eraseConversation(deps: EraseDeps, id: string): EraseResult {
  const { db } = deps;
  const files: string[] = [];
  let reviewIds: string[] = [];
  const result = transaction(db, (): Omit<EraseResult, 'files'> => {
    // 振り返りの記録から辿れるものと、振り返りの会話自身が材料として覚えているもの（記録から辿れなくなったものも消す）
    reviewIds = (db.prepare(`SELECT j.review_conversation_id AS id FROM memory_jobs j JOIN conversations c ON c.id = j.review_conversation_id
      WHERE j.conversation_id = ? AND c.kind = 'task'
      UNION SELECT id FROM conversations WHERE source_conversation_id = ? AND kind = 'task'`).all(id, id) as Array<{ id: string }>).map(r => r.id);
    for (const reviewId of reviewIds) eraseOne(deps, reviewId, files);
    db.prepare('UPDATE memory_jobs SET review_conversation_id = NULL, note = NULL WHERE conversation_id = ?').run(id);
    return { ...eraseOne(deps, id, files), reviews: reviewIds.length };
  });
  deps.markDeleted?.([id, ...reviewIds]);
  // ファイルは、記録を消したあとで消す。消せなかったものは数えて返す（記録はもう無いので、残った分は孤児のファイル）
  const failed: string[] = [];
  let removed = 0;
  for (const file of files) {
    try { rmSync(file, { force: true }); removed++; } catch { failed.push(file); }
  }
  return { ...result, files: { removed, failed } };
}

// 会話 1 つ分を消す（トランザクションの中で呼ぶ。消すファイルは files に足すだけで、ここでは消さない）
function eraseOne(deps: EraseDeps, id: string, files: string[]): { messages: number; uploads: number } {
  const { db } = deps;
  // この会話の発言に付いていた添付の ID
  const attachmentIds = new Set<string>();
  const rows = db.prepare("SELECT parts FROM messages WHERE conversation_id = ? AND role = 'user'").all(id) as Array<{ parts: string }>;
  for (const row of rows) {
    try {
      const parts = JSON.parse(row.parts) as { attachments?: Array<{ id?: unknown }> };
      for (const a of parts.attachments ?? []) if (typeof a.id === 'string') attachmentIds.add(a.id);
    } catch { }
  }
  const refs = db.prepare('SELECT full_ref FROM tool_calls WHERE conversation_id = ? AND full_ref IS NOT NULL').all(id) as Array<{ full_ref: string }>;
  for (const ref of refs) if (inside(deps.toolOutputsDir, ref.full_ref)) files.push(ref.full_ref);

  const messages = Number(db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id).changes);
  db.prepare('DELETE FROM approvals WHERE conversation_id = ?').run(id);
  db.prepare("UPDATE tool_calls SET conversation_id = NULL, input = '', output_preview = NULL, full_ref = NULL, approval_id = NULL WHERE conversation_id = ?").run(id);
  db.prepare('UPDATE engine_runs SET conversation_id = NULL, error_message = NULL WHERE conversation_id = ?').run(id);
  db.prepare("DELETE FROM kv WHERE length(key) > length(?) AND substr(key, -(length(?) + 1)) = ':' || ?").run(id, id, id);
  db.prepare('UPDATE memories SET source_conversation_id = NULL, source_message_id = NULL WHERE source_conversation_id = ?').run(id);
  db.prepare('UPDATE skill_drafts SET conversation_id = NULL WHERE conversation_id = ?').run(id);
  db.prepare('UPDATE tasks SET created_in_conversation = NULL WHERE created_in_conversation = ?').run(id);
  db.prepare("UPDATE task_events SET content = REPLACE(content, ?, '-') WHERE content IS NOT NULL AND instr(content, ?) > 0").run(id, id);
  db.prepare("DELETE FROM memory_jobs WHERE conversation_id = ? AND status = 'pending'").run(id);
  db.prepare("UPDATE memory_jobs SET conversation_id = NULL, dedup_key = 'deleted:' || id WHERE conversation_id = ?").run(id);
  db.prepare("DELETE FROM notifications WHERE substr(dedup_key, 1, 6) = 'owner:' AND link IN (?, ?)").run(`#/c/${id}`, `#/c/${encodeURIComponent(id)}`);
  db.prepare('UPDATE notifications SET link = NULL WHERE link IS NOT NULL AND instr(link, ?) > 0').run(id);

  // 添付は、ほかの会話の発言が使っていなければ消す
  let uploads = 0;
  for (const uploadId of attachmentIds) {
    const used = db.prepare("SELECT 1 FROM messages WHERE role = 'user' AND instr(parts, ?) > 0 LIMIT 1").get(`"id":"${uploadId}"`);
    if (used) continue;
    if (Number(db.prepare('DELETE FROM uploads WHERE id = ?').run(uploadId).changes)) { uploads++; files.push(join(deps.uploadsDir, uploadId)); }
  }
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  return { messages, uploads };
}
