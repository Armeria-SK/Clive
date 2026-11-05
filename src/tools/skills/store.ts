import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LANGUAGE, type Language } from '../../config/schema.ts';
import { atomicWriteFile } from '../../config/store.ts';

const INDEX_TEXT: Record<Language, { heading: string; instruction: string }> = {
  ja: { heading: '# スキル（手順書）', instruction: '次の作業をするときは、先に skill_view で手順を読んでから従う。' },
  en: { heading: '# Skills (procedures)', instruction: 'Before doing any of the work below, first read the procedure with skill_view and then follow it.' },
};

export interface Skill { name: string; description: string; body: string; uses: number; lastUsedAt: number | null; updatedAt: number }
export interface SkillDraft {
  id: number; name: string; description: string; body: string; reason: string | null;
  status: 'pending' | 'approved' | 'rejected'; conversation_id: string | null; run_id: string | null; created_at: number; decided_at: number | null;
}

export class SkillError extends Error {}

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const MAX_BODY = 20_000;
const MAX_DESCRIPTION = 300;

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try { return String(JSON.parse(value)); } catch { return value.slice(1, -1); }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/gu, "'");
  return value;
}

export function parseSkillFile(text: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(text);
  if (!m) return { body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/u)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/u.exec(line);
    if (kv) meta[kv[1]!] = unquote(kv[2]!.trim());
  }
  return { ...(meta.name ? { name: meta.name } : {}), ...(meta.description ? { description: meta.description } : {}), body: m[2]!.trim() };
}

export function renderSkillFile(skill: { name: string; description: string; body: string }): string {
  const description = skill.description.replace(/\r?\n/gu, ' ').trim();
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(description)}\n---\n\n${skill.body.trim()}\n`;
}

function validate(input: { name: string; description: string; body: string }): void {
  if (!SKILL_NAME.test(input.name)) throw new SkillError('名前は英小文字・数字・ハイフンで、63 文字以内にしてください（例: weekly-report）');
  if (!input.description.trim()) throw new SkillError('説明が空です（いつ使う手順かを 1 文で）');
  if (input.description.length > MAX_DESCRIPTION) throw new SkillError(`説明は ${MAX_DESCRIPTION} 文字以内にしてください`);
  if (!input.body.trim()) throw new SkillError('本文が空です');
  if (input.body.length > MAX_BODY) throw new SkillError(`本文は ${MAX_BODY} 文字以内にしてください`);
}

export class SkillStore {
  readonly #db: DatabaseSync;
  readonly #dir: string;
  readonly #now: () => number;
  onDraft: ((draft: SkillDraft) => void) | undefined;

  constructor(db: DatabaseSync, dir: string, now: () => number = Date.now) { this.#db = db; this.#dir = dir; this.#now = now; }

  get dir(): string { return this.#dir; }

  list(): Skill[] {
    if (!existsSync(this.#dir)) return [];
    const skills: Skill[] = [];
    for (const entry of readdirSync(this.#dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SKILL_NAME.test(entry.name)) continue;
      const skill = this.get(entry.name);
      if (skill) skills.push(skill);
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Skill | undefined {
    if (!SKILL_NAME.test(name)) return undefined;
    const path = join(this.#dir, name, 'SKILL.md');
    if (!existsSync(path)) return undefined;
    const parsed = parseSkillFile(readFileSync(path, 'utf8'));
    const usage = this.#db.prepare('SELECT uses, last_used_at FROM skill_usage WHERE name = ?').get(name) as { uses: number; last_used_at: number | null } | undefined;
    return {
      name, description: parsed.description ?? '（説明がありません）', body: parsed.body,
      uses: usage?.uses ?? 0, lastUsedAt: usage?.last_used_at ?? null, updatedAt: statSync(path).mtimeMs,
    };
  }

  index(language: Language = DEFAULT_LANGUAGE): string {
    const skills = this.list();
    if (!skills.length) return '';
    const text = INDEX_TEXT[language];
    return [
      text.heading,
      text.instruction,
      ...skills.map(s => `- ${s.name}: ${s.description}`),
    ].join('\n');
  }

  recordUse(name: string): void {
    this.#db.prepare(`INSERT INTO skill_usage (name, uses, last_used_at) VALUES (?, 1, ?)
      ON CONFLICT (name) DO UPDATE SET uses = uses + 1, last_used_at = excluded.last_used_at`).run(name, this.#now());
  }

  write(input: { name: string; description: string; body: string }): Skill {
    validate(input);
    const dir = join(this.#dir, input.name);
    mkdirSync(dir, { recursive: true });
    atomicWriteFile(join(dir, 'SKILL.md'), renderSkillFile(input));
    return this.get(input.name)!;
  }

  remove(name: string): void {
    if (!this.get(name)) throw new SkillError(`スキル ${name} がありません`);
    rmSync(join(this.#dir, name), { recursive: true, force: true });
  }

  draft(input: { name: string; description: string; body: string; reason?: string | undefined; conversationId?: string; runId?: string }): SkillDraft {
    validate(input);
    const pending = this.#db.prepare("SELECT COUNT(*) AS n FROM skill_drafts WHERE status = 'pending'").get() as { n: number };
    if (pending.n >= 20) throw new SkillError('承認待ちの下書きが 20 件あります。ユーザーが確かめるまで、新しい下書きは作れません');
    // 同じ名前の承認待ちは、新しいもので置き換える（古い方は却下扱い）
    const now = this.#now();
    this.#db.prepare("UPDATE skill_drafts SET status = 'rejected', decided_at = ? WHERE name = ? AND status = 'pending'").run(now, input.name);
    const result = this.#db.prepare('INSERT INTO skill_drafts (name, description, body, reason, conversation_id, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.name, input.description.trim(), input.body.trim(), input.reason?.trim() || null, input.conversationId ?? null, input.runId ?? null, now);
    const draft = this.getDraft(Number(result.lastInsertRowid))!;
    this.onDraft?.(draft);
    return draft;
  }

  getDraft(id: number): SkillDraft | undefined {
    return this.#db.prepare('SELECT * FROM skill_drafts WHERE id = ?').get(id) as SkillDraft | undefined;
  }

  drafts(status: SkillDraft['status'] | 'all' = 'pending', limit = 50): SkillDraft[] {
    return (status === 'all'
      ? this.#db.prepare('SELECT * FROM skill_drafts ORDER BY id DESC LIMIT ?').all(limit)
      : this.#db.prepare('SELECT * FROM skill_drafts WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)) as unknown as SkillDraft[];
  }

  approve(id: number): Skill {
    const draft = this.getDraft(id);
    if (!draft || draft.status !== 'pending') throw new SkillError('承認待ちの下書きではありません');
    const skill = this.write(draft);
    this.#db.prepare("UPDATE skill_drafts SET status = 'approved', decided_at = ? WHERE id = ?").run(this.#now(), id);
    return skill;
  }

  reject(id: number): void {
    const draft = this.getDraft(id);
    if (!draft || draft.status !== 'pending') throw new SkillError('承認待ちの下書きではありません');
    this.#db.prepare("UPDATE skill_drafts SET status = 'rejected', decided_at = ? WHERE id = ?").run(this.#now(), id);
  }
}
