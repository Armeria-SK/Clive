import type { IconName } from './icon-paths.ts';
import type { NotificationItem, SkillDraft, SkillSummary } from './api.ts';
import type { PlainKey } from './i18n/index.ts';

export type ToolEffect = 'read' | 'write' | 'exec' | 'network' | 'meta';

export interface ToolEntry { name: string; icon: IconName; effect: ToolEffect; desc: PlainKey }

// 組み込みの道具 24 個。サーバーに道具の一覧の API が無い（gaps A3）ので、画面に固定で持つ。
// 名前と効果の食い違いは tests/skills-logs.test.ts が、サーバーの builtinTools() と突き合わせて落とす。
export const TOOL_CATALOG: readonly ToolEntry[] = [
  { name: 'file_read', icon: 'file', effect: 'read', desc: 'tool.file_read' },
  { name: 'file_write', icon: 'filePen', effect: 'write', desc: 'tool.file_write' },
  { name: 'file_edit', icon: 'pencil', effect: 'write', desc: 'tool.file_edit' },
  { name: 'file_list', icon: 'folder', effect: 'read', desc: 'tool.file_list' },
  { name: 'shell_run', icon: 'terminal', effect: 'exec', desc: 'tool.shell_run' },
  { name: 'web_fetch', icon: 'globe', effect: 'network', desc: 'tool.web_fetch' },
  { name: 'web_search', icon: 'search', effect: 'network', desc: 'tool.web_search' },
  { name: 'memory_save', icon: 'bookmark', effect: 'meta', desc: 'tool.memory_save' },
  { name: 'memory_update', icon: 'bookmark', effect: 'meta', desc: 'tool.memory_update' },
  { name: 'memory_forget', icon: 'bookmark', effect: 'meta', desc: 'tool.memory_forget' },
  { name: 'memory_search', icon: 'bookmark', effect: 'read', desc: 'tool.memory_search' },
  { name: 'history_search', icon: 'search', effect: 'read', desc: 'tool.history_search' },
  { name: 'history_read', icon: 'msg', effect: 'read', desc: 'tool.history_read' },
  { name: 'task_create', icon: 'tasks', effect: 'meta', desc: 'tool.task_create' },
  { name: 'task_list', icon: 'tasks', effect: 'read', desc: 'tool.task_list' },
  { name: 'task_update', icon: 'tasks', effect: 'meta', desc: 'tool.task_update' },
  { name: 'task_checkpoint', icon: 'clock', effect: 'meta', desc: 'tool.task_checkpoint' },
  { name: 'task_complete', icon: 'circleCheck', effect: 'meta', desc: 'tool.task_complete' },
  { name: 'ask_user', icon: 'help', effect: 'meta', desc: 'tool.ask_user' },
  { name: 'skill_view', icon: 'book', effect: 'read', desc: 'tool.skill_view' },
  { name: 'skill_draft', icon: 'book', effect: 'meta', desc: 'tool.skill_draft' },
  { name: 'curiosity_add', icon: 'sparkles', effect: 'meta', desc: 'tool.curiosity_add' },
  { name: 'curiosity_list', icon: 'sparkles', effect: 'read', desc: 'tool.curiosity_list' },
  { name: 'curiosity_update', icon: 'sparkles', effect: 'meta', desc: 'tool.curiosity_update' },
];

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

export const cloneFolders = (value: FolderDraft): FolderDraft => ({ roots: value.roots.map(r => ({ ...r })), deny: [...value.deny] });

export function foldersFromConfig(config: Record<string, any>): FolderDraft {
  const tools = (config.tools ?? {}) as { roots?: unknown; deny?: unknown };
  const roots = Array.isArray(tools.roots)
    ? tools.roots.flatMap((r): Root[] => (r && typeof r.path === 'string' && (r.mode === 'read' || r.mode === 'write') ? [{ path: r.path, mode: r.mode }] : []))
    : [];
  const deny = Array.isArray(tools.deny) ? tools.deny.filter((p): p is string => typeof p === 'string') : [];
  return { roots, deny };
}

// 設定の tools.roots / tools.deny だけを差し替える。ほかの項目は、渡された設定のまま残す。
export function applyFolders(config: Record<string, any>, folders: FolderDraft): Record<string, any> {
  return { ...config, tools: { ...(config.tools ?? {}), roots: folders.roots.map(r => ({ path: r.path, mode: r.mode })), deny: [...folders.deny] } };
}

export const foldersEqual = (a: FolderDraft, b: FolderDraft): boolean =>
  a.deny.length === b.deny.length && a.deny.every((p, i) => p === b.deny[i])
  && a.roots.length === b.roots.length && a.roots.every((r, i) => r.path === b.roots[i]!.path && r.mode === b.roots[i]!.mode);

export function addRoot(folders: FolderDraft, path: string, mode: RootMode): FolderDraft {
  const clean = path.trim();
  if (!clean || folders.roots.some(r => r.path === clean)) return folders;
  return { ...folders, roots: [...folders.roots, { path: clean, mode }] };
}

export const removeRoot = (folders: FolderDraft, path: string): FolderDraft => ({ ...folders, roots: folders.roots.filter(r => r.path !== path) });

export const setRootMode = (folders: FolderDraft, path: string, mode: RootMode): FolderDraft =>
  ({ ...folders, roots: folders.roots.map(r => (r.path === path ? { ...r, mode } : r)) });

export function addDeny(folders: FolderDraft, path: string): FolderDraft {
  const clean = path.trim();
  if (!clean || folders.deny.includes(clean)) return folders;
  return { ...folders, deny: [...folders.deny, clean] };
}

export const removeDeny = (folders: FolderDraft, path: string): FolderDraft => ({ ...folders, deny: folders.deny.filter(p => p !== path) });
