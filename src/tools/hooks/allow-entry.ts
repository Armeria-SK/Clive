// tools.shell.allow の項目（security-self-api.md §11.6）。持ち主が選んだ「決まったコマンド」だけを書ける。
// 書ける形: 字句の決まりで読んだとき、ちょうど 1 つの文で、どの語も引用符・変数・ワイルドカード・置換・リダイレクト・区切りを含まない。

import { lexShell, type ShellKind, type Word } from './shell-lex.ts';

const FORBIDDEN = /[;|&<>$`(){}[\]*?'"\\\r\n]/u;

function plainWords(entry: string, shell: ShellKind): string[] | null {
  const lexed = lexShell(entry, shell);
  if (!lexed.ok || lexed.statements.length !== 1) return null;
  const st = lexed.statements[0]!;
  const plain = (w: Word): boolean => w.kind === 'plain' && !w.dynamic && !w.glob && !w.quoted && !w.home;
  if (st.kind !== 'command' || st.words.length === 0 || st.redirects.length || st.assigns.length || st.shapes.length || st.pipedIn || st.pipedOut || st.background) return null;
  return st.words.every(plain) ? st.words.map(w => w.text) : null;
}

// 語の並び。書けない形なら null（設定を読むときに ConfigError で断る）
export function parseAllowEntry(entry: string): string[] | null {
  if (!entry.trim() || FORBIDDEN.test(entry)) return null;
  const bash = plainWords(entry, 'bash');
  const ps = plainWords(entry, 'powershell');
  if (!bash || !ps || bash.join('\0') !== ps.join('\0')) return null;
  return bash;
}

// 文の語の並びの頭が、項目の語の並びとちょうど同じとき。コマンドの名前は Windows では大文字小文字を問わず、引数は問う
export function entryMatches(entry: readonly string[], words: readonly Word[], windows: boolean): boolean {
  if (entry.length === 0 || words.length < entry.length) return false;
  return entry.every((e, i) => {
    const w = words[i]!;
    if (w.kind !== 'plain' || w.dynamic || w.glob || w.home) return false;
    return i === 0 && windows ? w.text.toLowerCase() === e.toLowerCase() : w.text === e;
  });
}
