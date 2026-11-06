import { rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './database.ts';

export interface EraseDeps {
  db: DatabaseSync;
  uploadsDir: string;
  // 長いシェル出力の全文を置くフォルダ（道具の記録の full_ref はこの下のものだけ消す）
  toolOutputsDir: string;
}

export interface EraseResult {
  messages: number;
  uploads: number;
  files: { removed: number; failed: string[] };
}

const inside = (dir: string, path: string): boolean => { const base = resolve(dir) + sep; return resolve(path).startsWith(base); };

// 会話を消す（元に戻せない）。消すもの: 会話・発言（検索の索引も）・要約と固定の system（会話の行にある）・承認の記録・
// 会話ごとの kv（`<名前>:<会話ID>` の形のもの全部）・待っている振り返り・その会話だけが使う添付（行とファイル）と長い出力の全文ファイル。
// 数字だけ残すもの: 実行の記録（会話との結び付きと本文を消す）と道具の記録（種類・結果・時間は残し、入力と出力の本文・結び付きを消す）。
// 残すもの: 記憶・スキルの下書き・その会話から作ったタスク（結び付きだけ外す）。呼ぶ側が、走っている会話・チャット以外の会話を断る
export function eraseConversation(deps: EraseDeps, id: string): EraseResult {
  const { db } = deps;
  const files: string[] = [];
  const result = transaction(db, (): Omit<EraseResult, 'files'> => {
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
  });
  // ファイルは、記録を消したあとで消す。消せなかったものは数えて返す（記録はもう無いので、残った分は孤児のファイル）
  const failed: string[] = [];
  let removed = 0;
  for (const file of files) {
    try { rmSync(file, { force: true }); removed++; } catch { failed.push(file); }
  }
  return { ...result, files: { removed, failed } };
}
