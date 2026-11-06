// 作業の一覧（checklist）の保存と、system に入れる文を作る。
// キーは `checklist:<会話ID>` なので、会話の削除（src/db/erase.ts）に自動で乗る。

import type { KV } from '../../db/kv.ts';
import type { Language } from '../../config/schema.ts';
import { plainLine } from '../../shared/plain-text.ts';
import { toolText } from '../../shared/messages/tools.ts';

export type ChecklistStatus = 'pending' | 'in_progress' | 'done';
export interface ChecklistItem { text: string; status: ChecklistStatus }
export interface Checklist { items: ChecklistItem[]; tainted: boolean; updatedAt: number }
export const CHECKLIST_MAX_ITEMS = 30;
export const CHECKLIST_MAX_TEXT = 200;

export function checklistKey(conversationId: string): string {
  return `checklist:${conversationId}`;
}

const STATUSES: readonly ChecklistStatus[] = ['pending', 'in_progress', 'done'];

function isValid(value: unknown): value is Checklist {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.items) || v.items.length > CHECKLIST_MAX_ITEMS) return false;
  if (typeof v.tainted !== 'boolean' || typeof v.updatedAt !== 'number') return false;
  return v.items.every((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const it = item as Record<string, unknown>;
    return typeof it.text === 'string'
      && Array.from(it.text).length <= CHECKLIST_MAX_TEXT
      && STATUSES.includes(it.status as ChecklistStatus);
  });
}

export function readChecklist(kv: KV, conversationId: string): Checklist | undefined {
  const value = kv.getJson<unknown>(checklistKey(conversationId));
  return isValid(value) ? value : undefined;
}

export function writeChecklist(
  kv: KV,
  conversationId: string,
  items: readonly ChecklistItem[],
  tainted: boolean,
  now: number,
): Checklist | undefined {
  const cleaned: ChecklistItem[] = [];
  for (const item of items) {
    const text = plainLine(item.text, CHECKLIST_MAX_TEXT);
    if (text !== '') cleaned.push({ text, status: item.status });
    if (cleaned.length === CHECKLIST_MAX_ITEMS) break;
  }
  const key = checklistKey(conversationId);
  if (cleaned.length === 0) {
    kv.delete(key);
    return undefined;
  }
  const list: Checklist = { items: cleaned, tainted, updatedAt: now };
  kv.setJson(key, list);
  return list;
}

export function checklistSection(list: Checklist | undefined, language: Language): string {
  if (list === undefined) return '';
  const open = list.items.filter(item => item.status !== 'done');
  if (open.length === 0) return '';
  const lines = [toolText(language, 'checklist.section')];
  if (list.tainted) lines.push(toolText(language, 'checklist.section_tainted'));
  for (const item of open) {
    lines.push(item.status === 'in_progress' ? `- [>] ${item.text}` : `- [ ] ${item.text}`);
  }
  return lines.join('\n');
}
