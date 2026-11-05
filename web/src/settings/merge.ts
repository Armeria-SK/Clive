import { hasIds, isPlain, type Config } from './model.ts';

// 設定の保存で、ほかの場所（右のパネルの自発行動、別のタブ、スキルの画面、プロフィール）が先に変えた値を巻き戻さないための部分。
// 画面を開いたときの設定（saved）から、いまの編集（draft）への差を「編集の一覧」にして、保存の直前に読み直した最新の設定へ
// その編集だけを当てる。ユーザーが触った場所を、ほかの場所も先に変えていたら、書き込まずに衝突として返す。

type Path = readonly string[];

export type Edit =
  | { type: 'set'; path: Path; before: unknown; after: unknown }
  | { type: 'addItem'; path: Path; id: string; item: Record<string, unknown> }
  | { type: 'removeItem'; path: Path; id: string; before: Record<string, unknown> };

export interface Conflict { path: string; edit: Edit }
export interface MergeResult { config: Config; conflicts: Conflict[] }

// undefined のキーは「無い」ものとして比べる（JSON にしたときと同じ）。キーの順番は見ない。
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const defined = (o: Record<string, unknown>) => Object.keys(o).filter(k => o[k] !== undefined);
  const keys = defined(left);
  return keys.length === defined(right).length && keys.every(k => deepEqual(left[k], right[k]));
}

// id を持つ一覧（models / providers）は id で突き合わせ、追加・削除・項目の中の編集に分ける。
// それ以外の一覧（タグ・順番・フック・フォルダ）は 1 つの値として扱う。
export function diffConfig(saved: Config, draft: Config): Edit[] {
  const edits: Edit[] = [];
  walk(saved, draft, [], edits);
  return edits;
}

function walk(before: unknown, after: unknown, path: Path, edits: Edit[]): void {
  if (deepEqual(before, after)) return;
  if (isPlain(before) && isPlain(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) walk(before[key], after[key], [...path, key], edits);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after) && hasIds(before) && hasIds(after)) {
    const old = new Map(before.map(item => [item.id, item]));
    for (const item of after) {
      const existing = old.get(item.id);
      if (existing) walk(existing, item, [...path, item.id], edits);
      else edits.push({ type: 'addItem', path, id: item.id, item });
    }
    for (const item of before) if (!after.some(other => other.id === item.id)) edits.push({ type: 'removeItem', path, id: item.id, before: item });
    return;
  }
  edits.push({ type: 'set', path, before, after });
}

// 編集が、名前・色・形・動きの値を変えるものだけなら、触った項目だけを返す（保存で、ほかの項目をいまの値で上書きしないため）。
// ほかの設定が 1 つでも混ざる・プロフィールごと消す、などのときは null。
export function profilePatch(edits: readonly Edit[]): Record<string, unknown> | null {
  const sets = edits.filter((e): e is Extract<Edit, { type: 'set' }> => e.type === 'set' && e.path.length === 2 && e.path[0] === 'profile');
  if (!sets.length || sets.length !== edits.length) return null;
  return Object.fromEntries(sets.map(e => [e.path[1]!, e.after]));
}

export const editPath = (edit: Edit): string => (edit.type === 'set' ? edit.path : [...edit.path, edit.id]).join('.');

export function applyEdits(latest: Config, edits: readonly Edit[]): MergeResult {
  const config = structuredClone(latest) as Config;
  const conflicts: Conflict[] = [];
  for (const edit of edits) if (!applyOne(config, edit)) conflicts.push({ path: editPath(edit), edit });
  return { config, conflicts };
}

// 途中の道を辿る。オブジェクトは名前で、id を持つ一覧は id で。道が無ければ、create のときだけオブジェクトを作る。
function locate(root: Config, path: Path, create: boolean): Record<string, any> | unknown[] | null {
  let current: any = root;
  for (const key of path) {
    if (Array.isArray(current)) {
      const item = current.find(x => isPlain(x) && x.id === key);
      if (!item) return null;
      current = item;
    } else if (isPlain(current)) {
      if (current[key] === undefined || current[key] === null) {
        if (!create) return null;
        current[key] = {};
      }
      current = current[key];
    } else return null;
  }
  return Array.isArray(current) || isPlain(current) ? current : null;
}

// 当てられたら true。最新の側がすでに同じ値なら、何もせず true。ユーザーが見ていた値（before）と最新が違えば false（衝突）。
function applyOne(config: Config, edit: Edit): boolean {
  if (edit.type === 'set') {
    const parent = locate(config, edit.path.slice(0, -1), edit.before === undefined);
    if (!parent || Array.isArray(parent)) return false;
    const key = edit.path.at(-1)!;
    const now = parent[key];
    if (deepEqual(now, edit.after)) return true;
    if (!deepEqual(now, edit.before)) return false;
    if (edit.after === undefined) delete parent[key]; else parent[key] = structuredClone(edit.after);
    return true;
  }
  const list = locate(config, edit.path, false);
  if (!Array.isArray(list)) return false;
  const at = list.findIndex(x => isPlain(x) && x.id === edit.id);
  if (edit.type === 'addItem') {
    if (at >= 0) return deepEqual(list[at], edit.item);
    list.push(structuredClone(edit.item));
    return true;
  }
  if (at < 0) return true;
  if (!deepEqual(list[at], edit.before)) return false;
  list.splice(at, 1);
  return true;
}
