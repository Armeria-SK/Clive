// プロバイダの「名前（ID）」とモデルの ID の欄: 打った文字を ID の決まり（src/config/schema.ts の id の pattern）に直す。画面を使わない部分。
// プロバイダ: 英小文字・数字・_ -（40 文字まで）。モデル: 英小文字・数字・_ . -（64 文字まで）。どちらも、先頭は英小文字か数字

export type IdKind = 'provider' | 'model';

export const ID_RULES: Record<IdKind, { max: number; unusable: RegExp }> = {
  provider: { max: 40, unusable: /[^a-z0-9_-]/gu },
  model: { max: 64, unusable: /[^a-z0-9_.-]/gu },
};

// 全角の英数字は半角に、大文字は小文字に、空白は - に直し、使えない文字は外す。先頭の英小文字・数字より前の記号と、後ろの区切りも外す。
// 日本語だけのように何も残らなければ空（決められない）
export function slugId(text: string, kind: IdKind): string {
  const rule = ID_RULES[kind];
  return text.normalize('NFKC').trim().toLowerCase()
    .replace(/\s+/gu, '-')
    .replace(rule.unusable, '')
    .replace(/-{2,}/gu, '-')
    .replace(/^[^a-z0-9]+/u, '')
    .slice(0, rule.max)
    .replace(/[-_.]+$/u, '');
}

// ほかと重なるときは -2 -3 …を足す。上限の長さを超えないよう、名前のほうを切る
export function uniqueSlug(base: string, taken: readonly string[], kind: IdKind): string {
  const { max } = ID_RULES[kind];
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, max - suffix.length).replace(/[-_.]+$/u, '')}${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

// ⌘/Ctrl+S で保存するとき、打ちかけの ID の欄（確定は欄を離れたとき）にいたら、その欄を確定させる（blur）。確定したら true。
// ID の欄は、打っている間は設定の値を変えない（確定のときに直した ID を入れる）ので、先に確定しないと、打ちかけの ID が保存に入らない
export function commitPendingId(doc: { activeElement: Element | null }): boolean {
  const active = doc.activeElement as (Element & { blur?: () => void }) | null;
  if (typeof active?.closest !== 'function' || !active.closest('.set-idfield')) return false;
  active.blur?.();
  return true;
}

// 打った文字から決まる ID。id が null のときは、使える文字が 1 つも無いので決められない。changed は、今の ID から変わるか。
// taken は今ある ID（current を含んでよい。自分自身とは重ならない）
export function idFromInput(text: string, kind: IdKind, taken: readonly string[], current: string): { id: string | null; changed: boolean } {
  const slug = slugId(text, kind);
  if (slug === '') return { id: null, changed: false };
  if (slug === current) return { id: slug, changed: false };
  const id = uniqueSlug(slug, taken.filter(x => x !== current), kind);
  return { id, changed: id !== current };
}
