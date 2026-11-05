// PowerShell のパイプで流れてくるファイルのパス（security-self-api.md の審査: パイプで渡るパス）。読むコマンドだけ。
// Get-ChildItem・Get-Item が流すファイルのオブジェクトは PSPath を持ち、Select-String・Get-Content などは、パスの引数が無いとそれを束縛して読む。
// 引数にパスが書かれていなくても、前のコマンドが流したファイルを読むので、パスの引数が無くパイプで受ける読むコマンドは、前のコマンドが何を流すかで決める:
// 流れるのが文字だけなら許し、ファイルの一覧（パスが分かる Get-ChildItem など）なら、その一覧を読むものとして調べ（秘密のパスが含まれれば止める）、分からなければ今回だけ。
// 書くコマンドは、ここでは決めない: 書き込み先の結び付き（パイプから名前で渡る -Destination など）は真似きれないので、allowlist-ps.ts でパイプの有無によらず毎回確かめる（§11.13）。

import { Acc, type ListSpec, type MatchCtx } from './allowlist-core.ts';
import { first, parsePs, pathWords, psCmdlet, type PsCmd, type PsParsed } from './allowlist-ps.ts';
import type { Statement, Word } from './shell-lex.ts';

const PATH_KEYS = ['path', 'literalpath'] as const;
// 流れてきた文字列が、そのままパスとして束縛されるもの（本物の PowerShell 5.1 で確かめた。Get-Content・Get-FileHash・Select-String は文字列をパスにしない）
const BY_VALUE = new Set(['get-childitem', 'get-item', 'test-path', 'resolve-path', 'import-csv']);
// 出力が文字や、パスを持たないもの
const TEXT = new Set(['get-content', 'out-string', 'convertto-json', 'convertto-csv', 'measure-object', 'get-date', 'write-host', 'format-table', 'format-list', 'out-null', 'get-member', 'join-path', 'split-path', 'start-sleep']);
// ファイルの一覧を流すもの
const LISTERS = new Set(['get-childitem', 'get-item', 'resolve-path']);
// 流れてきたものを選ぶ・並べるだけで、中身は変えないもの
const PASS = new Set(['where-object', 'sort-object', 'select-object']);

export type Flow =
  | { kind: 'text' }
  | { kind: 'files'; lists: Array<{ word: Word; list: ListSpec }>; names: boolean }
  | { kind: 'unknown' };
const TEXT_FLOW: Flow = { kind: 'text' };
const UNKNOWN: Flow = { kind: 'unknown' };

// -Include / -Exclude の名前の絞り込み。* と ? だけの指定は、PowerShell と同じに名前に当てられる。[ ]・エスケープのバッククォートなどを含む指定・変数は真似ない（undefined）
const SIMPLE_PATTERN = /^[\w.*?-]+$/u;
function patterns(words: readonly Word[]): string[] | undefined {
  if (words.some(w => w.dynamic || w.kind !== 'plain')) return undefined;
  const list = words.flatMap(w => w.text.split(',').map(t => t.trim()).filter(Boolean));
  return list.every(t => SIMPLE_PATTERN.test(t)) ? list : undefined;
}

// 文 u が流すもの
export function flowOf(u: Statement | undefined, ctx: MatchCtx, external: (name: string) => boolean): Flow {
  if (!u || u.kind !== 'command' || u.words.length === 0 || u.shapes.length > 0) return UNKNOWN;
  const head = u.words[0]!;
  if (head.kind !== 'plain' || head.dynamic || head.quoted) return UNKNOWN;
  const key = head.text.toLowerCase();
  const spec = psCmdlet(key);
  if (!spec) return external(key.replace(/\.exe$/u, '')) ? TEXT_FLOW : UNKNOWN;
  const id = spec.names[0]!;
  if (TEXT.has(id)) return TEXT_FLOW;
  if (id === 'write-output') return u.words.slice(1).every(w => w.kind === 'plain' && !w.dynamic) ? TEXT_FLOW : UNKNOWN;
  const p = parsePs(spec, u.words, new Acc(), ctx);
  if (PASS.has(id)) {
    // 計算した列やプロパティを取り出すと、流れるものが元のファイルでなくなる
    if (id === 'select-object' && (p.all.has('expandproperty') || u.words.some(w => w.kind === 'hash' || w.kind === 'block'))) return UNKNOWN;
    return u.pipedIn ? flowOf(u.upstream, ctx, external) : TEXT_FLOW;
  }
  if (LISTERS.has(id)) {
    const given = pathWords(p);
    if (given.length === 0 && u.pipedIn) return UNKNOWN;
    const roots: Word[] = given.length ? given : [{ text: '.', dynamic: false, glob: false, quoted: false, home: false, kind: 'plain' }];
    if (roots.some(w => w.dynamic || w.kind !== 'plain')) return UNKNOWN;
    // -Filter は Windows のファイル検索の決まり（末尾の ? が何にも当たらない・*. が拡張子のない名前に当たる・短い 8.3 の名前）で名前を選ぶので、真似ない
    if (p.all.has('filter')) return UNKNOWN;
    const deep = id === 'get-childitem' && p.all.has('recurse');
    const include = patterns(first(p, 'include'));
    // 分からない -Include は何が返るか分からない。分からない -Exclude は、引かずに多めに調べる
    if (include === undefined) return UNKNOWN;
    const list: ListSpec = { deep, items: id !== 'get-childitem', include: deep ? include : [], exclude: deep ? patterns(first(p, 'exclude')) ?? [] : [] };
    return { kind: 'files', lists: roots.map(word => ({ word, list })), names: p.all.has('name') };
  }
  return UNKNOWN;
}

// パスの引数が無く、パイプで受ける文の判定
export function pipeBound(spec: PsCmd, p: PsParsed, st: Statement, acc: Acc, ctx: MatchCtx, external: (name: string) => boolean): void {
  if (!st.pipedIn) return;
  const id = spec.names[0]!;
  if (id === 'set-location' || spec.writes) return;
  const keys = PATH_KEYS.filter(k => spec.params.has(k));
  if (keys.length === 0 || keys.some(k => p.all.has(k))) return;
  const byValue = BY_VALUE.has(id);
  const flow = flowOf(st.upstream, ctx, external);
  if (flow.kind === 'text' && !byValue) return;
  if (flow.kind === 'files' && !(byValue && flow.names)) {
    for (const { word, list } of flow.lists) acc.readList(word, list);
    return;
  }
  acc.add('once', 'list.pipe_read', {}, false);
}
