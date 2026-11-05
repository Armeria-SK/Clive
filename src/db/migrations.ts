import type { Migration } from './database.ts';

export const MIGRATIONS: readonly Migration[] = [
  // 1: 会話・発言・実行記録・KV
  `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'task')),
    title TEXT,
    -- 会話の開始時に作る凍結スナップショット（system の不変部分）。会話中は変えない
    snapshot TEXT,
    snapshot_hash TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_message_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_conversations_recent ON conversations (archived, last_message_at DESC);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    run_id TEXT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    -- 検索と表示に使う平文
    text TEXT NOT NULL DEFAULT '',
    -- モデルに渡す構造（ツール呼び出しなど）の JSON
    parts TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_messages_conversation ON messages (conversation_id, id);

  CREATE VIRTUAL TABLE messages_fts USING fts5 (text, content = 'messages', content_rowid = 'id', tokenize = 'trigram');
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
  END;

  CREATE TABLE engine_runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    conversation_id TEXT,
    model_id TEXT,
    provider_id TEXT,
    model TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    duration_ms INTEGER,
    ok INTEGER,
    error_kind TEXT,
    error_message TEXT,
    stop TEXT,
    iterations INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    est_prompt_tokens INTEGER,
    flags TEXT NOT NULL DEFAULT '[]'
  ) STRICT;
  CREATE INDEX ix_engine_runs_started ON engine_runs (started_at DESC);
  CREATE INDEX ix_engine_runs_model ON engine_runs (model_id, started_at DESC);

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  `,
  // 2: ツールの実行記録と承認
  `
  CREATE TABLE tool_calls (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    conversation_id TEXT,
    tool TEXT NOT NULL,
    -- 伏せ字にした入力
    input TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('allow', 'ask', 'deny')),
    decided_by TEXT NOT NULL,
    approval_id TEXT,
    ok INTEGER,
    duration_ms INTEGER,
    output_preview TEXT,
    full_ref TEXT,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_tool_calls_run ON tool_calls (run_id, created_at);
  CREATE INDEX ix_tool_calls_created ON tool_calls (created_at DESC);

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    input TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    reasons TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
    scope TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_at INTEGER
  ) STRICT;
  CREATE INDEX ix_approvals_status ON approvals (status, created_at DESC);
  `,
  // 3: 記憶。会話中にその場で保存し、一覧で見て直せる。出典と変更履歴を残す
  `
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY,
    book TEXT NOT NULL CHECK (book IN ('user', 'notes')),
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'forgotten')),
    origin TEXT NOT NULL CHECK (origin IN ('chat', 'review', 'user')),
    source_conversation_id TEXT,
    source_message_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_memories_book ON memories (book, status, updated_at DESC);

  CREATE VIRTUAL TABLE memories_fts USING fts5 (content, content = 'memories', content_rowid = 'id', tokenize = 'trigram');
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts (rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;
  CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO memories_fts (rowid, content) VALUES (new.id, new.content);
  END;

  -- 記憶の変更履歴（取り消しの元データ）
  CREATE TABLE memory_events (
    id INTEGER PRIMARY KEY,
    memory_id INTEGER NOT NULL REFERENCES memories (id),
    action TEXT NOT NULL CHECK (action IN ('create', 'update', 'forget', 'restore')),
    before TEXT,
    after TEXT,
    actor TEXT NOT NULL CHECK (actor IN ('clive', 'user', 'review')),
    run_id TEXT,
    reason TEXT,
    undone_at INTEGER,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_memory_events_memory ON memory_events (memory_id, created_at DESC);

  -- SOUL.md と USER.md の版（会話の開始時に中身が変わっていたら残す）
  CREATE TABLE file_versions (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_file_versions_name ON file_versions (name, id DESC);

  -- 会話の古い部分の要約（コンテキストに入りきらなくなったときに作る）
  ALTER TABLE conversations ADD COLUMN summary TEXT;
  ALTER TABLE conversations ADD COLUMN summary_upto INTEGER;
  `,
  // 4: タスク（自分で書いて自分で動くメモ帳）と通知
  `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    next_action TEXT,
    done_criteria TEXT,
    status TEXT NOT NULL CHECK (status IN ('inbox', 'ready', 'running', 'waiting', 'scheduled', 'done', 'failed', 'cancelled')),
    origin TEXT NOT NULL CHECK (origin IN ('user', 'self', 'curiosity', 'schedule')),
    priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
    -- 繰り返し（status = 'scheduled' のひな形だけが持つ）
    cron TEXT,
    timezone TEXT,
    -- これより前には実行しない（予定・休止・再試行の待ち）
    run_at INTEGER,
    parent_id TEXT REFERENCES tasks (id),
    -- タスク専用の会話（実行の記録が積み上がる）
    conversation_id TEXT,
    waiting_kind TEXT CHECK (waiting_kind IN ('question', 'approval')),
    waiting_text TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_until INTEGER,
    result_summary TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  ) STRICT;
  CREATE INDEX ix_tasks_actionable ON tasks (status, run_at, priority);
  CREATE INDEX ix_tasks_parent ON tasks (parent_id);

  CREATE TABLE task_events (
    id INTEGER PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks (id),
    kind TEXT NOT NULL,
    actor TEXT NOT NULL,
    content TEXT,
    run_id TEXT,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_task_events_task ON task_events (task_id, id);

  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    link TEXT,
    dedup_key TEXT,
    read_at INTEGER,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_notifications_recent ON notifications (created_at DESC);
  CREATE INDEX ix_notifications_dedup ON notifications (dedup_key, created_at DESC);
  `,
  // 5: 好奇心リスト・スキルの下書きと使用回数・記憶の振り返りのジョブ
  `
  CREATE TABLE curiosity_items (
    id INTEGER PRIMARY KEY,
    topic TEXT NOT NULL,
    why TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'researching', 'done', 'dropped')),
    result TEXT,
    task_id TEXT,
    source TEXT NOT NULL DEFAULT 'clive',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_curiosity_open ON curiosity_items (status, created_at);
  ALTER TABLE tasks ADD COLUMN curiosity_id INTEGER;

  CREATE TABLE skill_drafts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    body TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    conversation_id TEXT,
    run_id TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  ) STRICT;
  CREATE INDEX ix_skill_drafts_pending ON skill_drafts (status, created_at);

  CREATE TABLE skill_usage (
    name TEXT PRIMARY KEY,
    uses INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER
  ) STRICT;

  CREATE TABLE memory_jobs (
    id INTEGER PRIMARY KEY,
    trigger TEXT NOT NULL CHECK (trigger IN ('task', 'idle', 'heavy_run', 'book_full', 'manual')),
    dedup_key TEXT NOT NULL UNIQUE,
    conversation_id TEXT,
    task_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
    run_id TEXT,
    review_conversation_id TEXT,
    note TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  ) STRICT;
  CREATE INDEX ix_memory_jobs_pending ON memory_jobs (status, created_at);
  `,
  // 6: 添付ファイル
  `
  CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'pdf', 'image')),
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    text TEXT,
    pages INTEGER,
    created_at INTEGER NOT NULL
  ) STRICT;
  `,
  // 7: 取り消しを元に戻すため、取り消す直前の状態を覚える（前に取り消したものは NULL = 戻せない）
  `
  ALTER TABLE tasks ADD COLUMN cancelled_from TEXT CHECK (cancelled_from IN ('inbox', 'ready', 'running', 'waiting', 'scheduled'));
  `,
];
