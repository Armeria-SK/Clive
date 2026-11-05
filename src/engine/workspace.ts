import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LANGUAGE, type Language } from '../config/schema.ts';
import type { AppPaths } from '../paths.ts';

export const WORKSPACE_FILES = ['SOUL.md', 'USER.md', 'CURIOSITY.md'] as const;
export type WorkspaceFile = (typeof WORKSPACE_FILES)[number];
export type TemplateName = 'rules' | WorkspaceFile;

export function templatePath(paths: AppPaths, name: TemplateName, language: Language): string | undefined {
  const japanese = join(paths.templates, name === 'rules' ? 'rules.ja.md' : name);
  const candidates = language === 'ja' ? [japanese] : [join(paths.templates, language, name === 'rules' ? 'rules.md' : name), japanese];
  return candidates.find(path => existsSync(path));
}

export function ensureWorkspace(paths: AppPaths, language: Language = DEFAULT_LANGUAGE): void {
  mkdirSync(paths.workspace, { recursive: true });
  for (const name of WORKSPACE_FILES) {
    const target = join(paths.workspace, name);
    const source = templatePath(paths, name, language);
    if (!source) continue;
    try { copyFileSync(source, target, constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}

function readIfExists(path: string | undefined): string {
  if (!path) return '';
  try { return existsSync(path) ? readFileSync(path, 'utf8').trim() : ''; } catch { return ''; }
}

export function readTemplate(paths: AppPaths, name: TemplateName, language: Language): string {
  return readIfExists(templatePath(paths, name, language));
}

export function defaultTexts(paths: AppPaths, language: Language): { rules: string; files: Array<{ name: WorkspaceFile; content: string }> } {
  return {
    rules: readTemplate(paths, 'rules', language),
    files: WORKSPACE_FILES.map(name => ({ name, content: readTemplate(paths, name, language) })),
  };
}

export interface Snapshot {
  text: string;
  hash: string;
}

const SNAPSHOT_HEADINGS: Record<Language, { soul: string; user: string }> = {
  ja: { soul: '# あなた自身（SOUL.md）', user: '# ユーザーについて（USER.md）' },
  en: { soul: '# Who you are (SOUL.md)', user: '# About the user (USER.md)' },
};

export function buildSnapshot(paths: AppPaths, extra: { memories?: string; skills?: string } = {}, language: Language = DEFAULT_LANGUAGE): Snapshot {
  const rules = readTemplate(paths, 'rules', language);
  const soul = readIfExists(join(paths.workspace, 'SOUL.md'));
  const user = readIfExists(join(paths.workspace, 'USER.md'));
  const headings = SNAPSHOT_HEADINGS[language];
  const sections = [
    rules,
    soul && `${headings.soul}\n\n${soul}`,
    user && `${headings.user}\n\n${user}`,
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

const DYNAMIC: Record<Language, { locale: string; format: Intl.DateTimeFormatOptions; time: (formatted: string, timezone: string) => string; reply: string }> = {
  ja: {
    locale: 'ja-JP',
    format: { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit' },
    time: (formatted, timezone) => `現在時刻: ${formatted}（${timezone}）`,
    reply: '返事は日本語で書く（ユーザーが別の言語で話しかけたら、その言語で返す）',
  },
  en: {
    locale: 'en-US',
    format: { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    time: (formatted, timezone) => `Current time: ${formatted} (${timezone})`,
    reply: 'Write your replies in English (if the user speaks to you in another language, reply in that language).',
  },
};

export function buildDynamic(timezone: string, language: Language = DEFAULT_LANGUAGE, now = new Date()): string {
  const text = DYNAMIC[language];
  const formatted = new Intl.DateTimeFormat(text.locale, { ...text.format, timeZone: timezone }).format(now);
  return [text.time(formatted, timezone), text.reply].join('\n');
}
