import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AppPaths } from '../paths.ts';

export const WORKSPACE_FILES = ['SOUL.md', 'USER.md', 'CURIOSITY.md'] as const;

export function ensureWorkspace(paths: AppPaths): void {
  mkdirSync(paths.workspace, { recursive: true });
  for (const name of WORKSPACE_FILES) {
    const target = join(paths.workspace, name);
    const source = join(paths.templates, name);
    if (!existsSync(target) && existsSync(source)) copyFileSync(source, target);
  }
}

function readIfExists(path: string): string {
  try { return existsSync(path) ? readFileSync(path, 'utf8').trim() : ''; } catch { return ''; }
}

export interface Snapshot {
  text: string;
  hash: string;
}

export function buildSnapshot(paths: AppPaths, extra: { memories?: string; skills?: string } = {}): Snapshot {
  const rules = readIfExists(join(paths.templates, 'rules.ja.md'));
  const soul = readIfExists(join(paths.workspace, 'SOUL.md'));
  const user = readIfExists(join(paths.workspace, 'USER.md'));
  const sections = [
    rules,
    soul && `# あなた自身（SOUL.md）\n\n${soul}`,
    user && `# ユーザーについて（USER.md）\n\n${user}`,
    extra.memories,
    extra.skills,
  ].filter(Boolean);
  const text = sections.join('\n\n---\n\n');
  return { text, hash: createHash('sha256').update(text).digest('hex') };
}

export function recordFileVersions(db: DatabaseSync, paths: AppPaths, now = Date.now()): void {
  for (const name of ['SOUL.md', 'USER.md']) {
    const content = readIfExists(join(paths.workspace, name));
    if (!content) continue;
    const hash = createHash('sha256').update(content).digest('hex');
    const last = db.prepare('SELECT content_hash FROM file_versions WHERE name = ? ORDER BY id DESC LIMIT 1').get(name) as { content_hash: string } | undefined;
    if (last?.content_hash === hash) continue;
    db.prepare('INSERT INTO file_versions (name, content, content_hash, created_at) VALUES (?, ?, ?, ?)').run(name, content, hash, now);
  }
}

export function buildDynamic(timezone: string, now = new Date()): string {
  const formatted = new Intl.DateTimeFormat('ja-JP', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).format(now);
  return `現在時刻: ${formatted}（${timezone}）`;
}
