import type { IconName } from './icon-paths.ts';
import type { NotificationItem, SkillDraft, SkillSummary } from './api.ts';
import type { PlainKey } from './i18n/index.ts';
import type { ToolPolicy } from '../../src/tools/tool-policy.ts';

export type ToolEffect = 'read' | 'write' | 'exec' | 'network' | 'meta';

// 組み込みの道具 27 個の絵と説明の辞書キー。名前・効果・使える場面・今の方針は、サーバー（GET /api/tools）から読む。
// 名前の食い違いは tests/skills.test.ts が、サーバーの一覧と突き合わせて落とす。知らない道具（あとから増えたもの）は、絵だけ汎用で説明は出さない。
export interface ToolLook { icon: IconName; desc: PlainKey | null }
export const TOOL_LOOKS: Readonly<Record<string, ToolLook>> = {
  file_read: { icon: 'file', desc: 'tool.file_read' },
  file_write: { icon: 'filePen', desc: 'tool.file_write' },
  file_edit: { icon: 'pencil', desc: 'tool.file_edit' },
  file_list: { icon: 'folder', desc: 'tool.file_list' },
  file_search: { icon: 'search', desc: 'tool.file_search' },
  shell_run: { icon: 'terminal', desc: 'tool.shell_run' },
  web_fetch: { icon: 'globe', desc: 'tool.web_fetch' },
  web_search: { icon: 'search', desc: 'tool.web_search' },
  memory_save: { icon: 'bookmark', desc: 'tool.memory_save' },
  memory_update: { icon: 'bookmark', desc: 'tool.memory_update' },
  memory_forget: { icon: 'bookmark', desc: 'tool.memory_forget' },
  memory_search: { icon: 'bookmark', desc: 'tool.memory_search' },
  history_search: { icon: 'search', desc: 'tool.history_search' },
  history_read: { icon: 'msg', desc: 'tool.history_read' },
  task_create: { icon: 'tasks', desc: 'tool.task_create' },
  task_list: { icon: 'tasks', desc: 'tool.task_list' },
  task_update: { icon: 'tasks', desc: 'tool.task_update' },
  task_checkpoint: { icon: 'clock', desc: 'tool.task_checkpoint' },
  task_complete: { icon: 'circleCheck', desc: 'tool.task_complete' },
  ask_user: { icon: 'help', desc: 'tool.ask_user' },
  skill_view: { icon: 'book', desc: 'tool.skill_view' },
  skill_draft: { icon: 'book', desc: 'tool.skill_draft' },
  curiosity_add: { icon: 'sparkles', desc: 'tool.curiosity_add' },
  curiosity_list: { icon: 'sparkles', desc: 'tool.curiosity_list' },
  curiosity_update: { icon: 'sparkles', desc: 'tool.curiosity_update' },
  calculate: { icon: 'sliders', desc: 'tool.calculate' },
  date_calc: { icon: 'clock', desc: 'tool.date_calc' },
};

// 道具の並び: 画面の辞書の順（ファイル・シェル・Web・記憶・タスク・スキル・好奇心）。辞書に無い道具は、そのあとに名前順
const LOOK_ORDER: readonly string[] = Object.keys(TOOL_LOOKS);
export function orderTools<T extends { name: string }>(tools: readonly T[]): T[] {
  const rank = (name: string): number => { const i = LOOK_ORDER.indexOf(name); return i < 0 ? LOOK_ORDER.length : i; };
  return [...tools].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

export const toolLook = (name: string): ToolLook => (Object.hasOwn(TOOL_LOOKS, name) ? TOOL_LOOKS[name]! : { icon: 'wrench', desc: null });

// 道具ごとの方針の名前（デザインの「承認なし / 承認を求める / 止める」）
export const POLICY_LABEL: Record<ToolPolicy, PlainKey> = { allow: 'tools.policy.allow', ask: 'tools.policy.ask', block: 'tools.policy.block' };

export const EFFECT_LABEL: Record<ToolEffect, PlainKey> = {
  read: 'tools.effect.read', write: 'tools.effect.write', exec: 'tools.effect.exec', network: 'tools.effect.network', meta: 'tools.effect.meta',
};

// 一覧の行。レビュー待ちの下書きを先頭に、そのあとにスキルを名前順で並べる。
export type SkillRow =
  | { kind: 'draft'; name: string; description: string; at: number; revises: boolean }
  | { kind: 'skill'; name: string; description: string; uses: number; lastUsedAt: number | null };

export function skillRows(drafts: readonly SkillDraft[], skills: readonly SkillSummary[]): SkillRow[] {
  const pending = drafts
    .filter(d => d.status === 'pending')
    .sort((a, b) => b.created_at - a.created_at)
    .map((d): SkillRow => ({ kind: 'draft', name: d.name, description: d.description, at: d.created_at, revises: d.current !== null }));
  const known = [...skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s): SkillRow => ({ kind: 'skill', name: s.name, description: s.description, uses: s.uses, lastUsedAt: s.lastUsedAt }));
  return [...pending, ...known];
}

// 同じ名前のレビュー待ちが複数あるときは、いちばん新しいものを開く。
export function findDraft(drafts: readonly SkillDraft[], name: string): SkillDraft | undefined {
  return drafts.filter(d => d.name === name && d.status === 'pending').sort((a, b) => b.created_at - a.created_at)[0];
}

// SKILL.md の中身（サーバーの renderSkillFile と同じ形）。
export function skillFileText(skill: { name: string; description: string; body: string }): string {
  const description = skill.description.replace(/\r?\n/gu, ' ').trim();
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(description)}\n---\n\n${skill.body.trim()}\n`;
}

// スキルの下書きの通知（題は「…: <名前>」、リンクは #/review）から、開く先を決める。
// 名前を読み取れなければ、スキル・ツールの一覧へ。#/review 以外のリンクは触らない。
const SKILL_NAME_AT_END = /:\s*([a-z0-9][a-z0-9-]{0,62})\s*$/u;
export function skillDraftLink(notification: Pick<NotificationItem, 'link' | 'title'>): string | null {
  if (notification.link !== '#/review') return null;
  const name = SKILL_NAME_AT_END.exec(notification.title)?.[1];
  return name ? `#/skills/draft/${encodeURIComponent(name)}` : '#/skills';
}

export type RootMode = 'read' | 'write';
export interface Root { path: string; mode: RootMode }
export interface FolderDraft { roots: Root[]; deny: string[] }

export function foldersFromConfig(config: Record<string, any>): FolderDraft {
  const tools = (config.tools ?? {}) as { roots?: unknown; deny?: unknown };
  const roots = Array.isArray(tools.roots)
    ? tools.roots.flatMap((r): Root[] => (r && typeof r.path === 'string' && (r.mode === 'read' || r.mode === 'write') ? [{ path: r.path, mode: r.mode }] : []))
    : [];
  const deny = Array.isArray(tools.deny) ? tools.deny.filter((p): p is string => typeof p === 'string') : [];
  return { roots, deny };
}

export function addRoot(folders: FolderDraft, path: string, mode: RootMode): FolderDraft {
  const clean = path.trim();
  if (!clean || folders.roots.some(r => r.path === clean)) return folders;
  return { ...folders, roots: [...folders.roots, { path: clean, mode }] };
}

export const removeRoot = (folders: FolderDraft, path: string): FolderDraft => ({ ...folders, roots: folders.roots.filter(r => r.path !== path) });

export const setRootMode = (folders: FolderDraft, path: string, mode: RootMode): FolderDraft =>
  ({ ...folders, roots: folders.roots.map(r => (r.path === path ? { ...r, mode } : r)) });

// サーバーの既定の「触れないパス」（src/config/schema.ts の tools.deny の既定値。tests/skills.test.ts が突き合わせる）。
export const DEFAULT_DENY: readonly string[] = ['~/.ssh', '~/.aws', '~/.gnupg'];

export type BroadKind = 'filesystem' | 'home';

// ディスク全体（/ やドライブの直下）とホームフォルダの全体は、範囲として広すぎる。ホームの実際の場所は画面からは分からないので、~ と、/home/<名前>・/Users/<名前>（ドライブ付きも）の形で見分ける。
// . と .. は先に畳む（/home/alice/. はホーム、/tmp/.. はディスク全体、~/.. はホームの外）。相対の名前（workspace など）は、置き場所が分からないので見分けない。
export function broadKind(path: string): BroadKind | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/[\\/]+/u);
  const absolute = /^[\\/]/u.test(trimmed);
  const drive = /^[A-Za-z]:$/u.test(parts[0] ?? '');
  if (drive) parts.shift();
  const home = !absolute && !drive && parts[0] === '~';
  if (home) parts.shift();
  const stack: string[] = [];
  let above = false;
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part !== '..') stack.push(part);
    else if (stack.length) stack.pop();
    else above = true;
  }
  if (home) return above ? 'filesystem' : stack.length === 0 ? 'home' : null;
  if (!absolute && !drive) return null;
  if (stack.length === 0) return 'filesystem';
  // /home と /Users（C:\Users）そのものは、全員のホームフォルダをまとめて含むので、ホームの全体と同じに扱う
  return stack.length <= 2 && /^(?:home|users)$/iu.test(stack[0]!) ? 'home' : null;
}

export type Widening =
  | { kind: 'deny-removed'; path: string; builtin: boolean }
  | { kind: 'root-added'; path: string; mode: RootMode; broad: BroadKind | null }
  | { kind: 'root-write'; path: string; broad: BroadKind | null };

// 保存で、Clive が触れられる範囲が広がるもの（触れないパスを外す・フォルダを足す・読むだけを読み書きにする）を、そのまま並べる。狭くなる変更は含めない。
export function wideningChanges(before: FolderDraft, after: FolderDraft): Widening[] {
  const out: Widening[] = [];
  for (const path of before.deny) if (!after.deny.includes(path)) out.push({ kind: 'deny-removed', path, builtin: DEFAULT_DENY.includes(path) });
  for (const root of after.roots) {
    const old = before.roots.find(r => r.path === root.path);
    if (!old) out.push({ kind: 'root-added', path: root.path, mode: root.mode, broad: broadKind(root.path) });
    else if (old.mode === 'read' && root.mode === 'write') out.push({ kind: 'root-write', path: root.path, broad: broadKind(root.path) });
  }
  return out;
}
