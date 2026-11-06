// PowerShell の許可の一覧（security-self-api.md §11.3.2・11.3.4）。コマンドレットと別名は表の名前だけ。引数は省略しない正式な名前（大文字小文字は問わない）。

import { Acc, checkValue, flagMap, isFlagLike, literal, type FlagDef, type MatchCtx, type ValueType } from './allowlist-core.ts';
import type { Statement, Word } from './shell-lex.ts';

// writes: ファイルを書く・作る・移す・消すコマンドレット（毎回確かめる。パイプで受けるファイルの読みの判定 allowlist-pipe.ts は、読むコマンドだけを見る）
export interface PsCmd { names: readonly string[]; params: Map<string, FlagDef>; pos: readonly string[]; extra?: (p: PsParsed, acc: Acc, ctx: MatchCtx, st: Statement) => void; writes?: boolean }
export interface PsParsed { named: Map<string, Word[]>; positional: Word[]; all: Map<string, Word[]> }

const ENC = 'ASCII|BigEndianUnicode|BigEndianUTF32|Byte|Default|OEM|String|Unicode|Unknown|UTF7|UTF8|UTF8BOM|UTF8NoBOM|UTF32';
const ACTION = 'SilentlyContinue|Stop|Continue|Ignore';
const COMMON = flagMap(`erroraction:${ACTION} ea:${ACTION} warningaction:${ACTION} wa:${ACTION} verbose outvariable:var errorvariable:var`, true);
const COLORS = 'Black|DarkBlue|DarkGreen|DarkCyan|DarkRed|DarkMagenta|DarkYellow|Gray|DarkGray|Blue|Green|Cyan|Red|Magenta|Yellow|White';
const COMPARE = ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'like', 'notlike', 'match', 'notmatch', 'contains', 'notcontains', 'in', 'notin'].flatMap(o => [`${o}:s`, `c${o}:s`]).join(' ');

const CMDS = new Map<string, PsCmd>();
function cmd(names: string, params: string, pos: string, extra?: PsCmd['extra'], writes = false): void {
  const list = names.split(/\s+/u).filter(Boolean).map(n => n.toLowerCase());
  const spec: PsCmd = { names: list, params: new Map([...COMMON, ...flagMap(params, true)]), pos: pos.split(/\s+/u).filter(Boolean).map(p => p.toLowerCase()), ...(extra ? { extra } : {}), ...(writes ? { writes } : {}) };
  for (const n of list) CMDS.set(n, spec);
}
export const psCmdlet = (name: string): PsCmd | undefined => CMDS.get(name);
export const psCmdletNames = (): string[] => [...CMDS.keys()];

// プロバイダ付きのパス（env: function: HKLM: など。ドライブ文字 1 つの C: は除く）
const PROVIDER = /^[A-Za-z][A-Za-z0-9_]+:(?![\\/]{2})/u;

// PowerShell は、引用符で囲んだ -Path・-FilePath・位置のパスのワイルドカード（* ? [ ]）も解決する（-LiteralPath だけが文字どおり。本物の PowerShell 5.1 で確かめた）。
// ワイルドカードを含むパスは、引用符つきでも「当たるものすべて」を調べる対象（glob）にする。バッククォート（ワイルドカードのエスケープ）を含むパスは、判定できないものとして扱う
const WILDCARD = /[*?[]/u;
export function withWildcard(w: Word): Word {
  if (w.kind !== 'plain' || w.dynamic) return w;
  if (w.text.includes('`')) return { ...w, dynamic: true, unescaped: w.text.replace(/`(.?)/gsu, '$1') };
  return WILDCARD.test(w.text) ? { ...w, glob: true } : w;
}
// New-Item・mkdir の -Path は、作るパスとして文字どおりに扱われる（* ? はパスに使えない文字のエラー。[ ] は名前になる。本物の PowerShell 5.1 で確かめた）
const LITERAL_CREATE = new Set(['new-item', 'mkdir']);
const wildcardParam = (spec: PsCmd, def: FlagDef, key: string): boolean =>
  (def.type === 'path-r' || def.type === 'path-n' || def.type === 'path-w') && key !== 'literalpath' && !spec.names.some(n => LITERAL_CREATE.has(n));

function bind(def: FlagDef, w: Word, acc: Acc, name: string, ctx: MatchCtx): void {
  const t = def.type as string;
  if (t === 'bool') return;
  if (t === 'blk' || t === 'blks' || t === 'blkh') {
    if (w.kind === 'block') return;
    if (w.kind === 'hash') { if (t !== 'blkh' || !(w.hashKeys ?? []).every(k => HASH_KEYS.has(k))) acc.add('once', 'list.form', { cmd: name, detail: '@{…}' }, true); return; }
    if (t === 'blk') acc.add('once', 'list.form', { cmd: name, detail: w.text }, true);
    return;
  }
  if (w.kind === 'block') { acc.add('once', 'shape.script_block', {}, true); return; }
  if (w.kind === 'hash' || w.kind === 'splat') { acc.add('once', 'list.form', { cmd: name, detail: w.text }, true); return; }
  if (t === 'path-r' || t === 'path-n' || t === 'path-w') {
    const mode = t === 'path-w' ? 'write' : 'read';
    for (const part of splitList(w)) {
      if (!part.dynamic && PROVIDER.test(part.text)) {
        if (!(mode === 'read' && /^env:/iu.test(part.text))) acc.add('once', 'list.form', { cmd: name, detail: part.text }, true);
        continue;
      }
      if (t === 'path-n') acc.readNames(part); else if (mode === 'read') acc.read(part); else acc.write(part);
    }
    return;
  }
  checkValue(def.type as ValueType, w, acc, name, '', ctx);
}
const HASH_KEYS = new Set(['name', 'expression', 'n', 'e', 'label', 'l', 'width', 'alignment', 'formatstring', 'descending', 'ascending']);
function splitList(w: Word): Word[] {
  if (w.dynamic || !w.text.includes(',')) return [w];
  return [w, ...w.text.split(',').map(t => ({ ...w, text: t.trim(), glob: w.glob && /[*?[{]/u.test(t) }))];
}

const isParam = (w: Word): boolean => w.kind === 'plain' && !w.dynamic && !w.quoted && /^-[A-Za-z]/u.test(w.text) && !w.attached;

export function parsePs(spec: PsCmd, words: readonly Word[], acc: Acc, ctx: MatchCtx): PsParsed {
  const name = words[0]!.text;
  const named = new Map<string, Word[]>();
  const all = new Map<string, Word[]>();
  const positional: Word[] = [];
  const args = words.slice(1);
  const take = (key: string, w: Word): void => { named.set(key, [...(named.get(key) ?? []), w]); };
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (!isParam(w)) { positional.push(w); continue; }
    const key = w.text.slice(1).toLowerCase();
    const def = spec.params.get(key);
    if (!def) { acc.add('once', 'list.flag', { cmd: name, flag: w.text }, true); continue; }
    if (def.type === 'bool') {
      if (args[i + 1]?.attached) i++;
      all.set(key, [...(all.get(key) ?? []), w]);
      continue;
    }
    const raw = args[++i];
    if (!raw || (isParam(raw) && !raw.attached)) { acc.add('once', 'list.form', { cmd: name, detail: `${w.text} の値` }, true); if (raw) i--; continue; }
    const value = wildcardParam(spec, def, key) ? withWildcard(raw) : raw;
    take(key, value);
    all.set(key, [...(all.get(key) ?? []), value]);
    bind(def, value, acc, name, ctx);
  }
  const rest = [...spec.pos];
  positional.forEach((w, i) => {
    const last = spec.pos.at(-1)?.endsWith('…') ?? false;
    const slot = rest[Math.min(i, rest.length - 1)];
    if (slot === undefined || (i >= rest.length && !last)) { acc.add('once', 'list.form', { cmd: name, detail: w.text }, true); return; }
    const key = slot.replace('…', '');
    const def = spec.params.get(key);
    if (!def) return;
    const value = wildcardParam(spec, def, key) ? withWildcard(w) : w;
    take(key, value);
    all.set(key, [...(all.get(key) ?? []), value]);
    bind(def, value, acc, name, ctx);
  });
  return { named, positional, all };
}

export const first = (p: PsParsed, ...keys: string[]): Word[] => keys.flatMap(k => p.named.get(k) ?? []);
export const pathWords = (p: PsParsed): Word[] => first(p, 'path', 'literalpath').flatMap(splitList);

// ── 読む ──
cmd('get-childitem gci ls dir', 'Path:path-n LiteralPath:path-n Filter:s Include:s Exclude:s Recurse Depth:n File Directory Hidden Force Name', 'path');
cmd('get-item gi', 'Path:path-r LiteralPath:path-r Force', 'path');
cmd('test-path', 'Path:path-r LiteralPath:path-r Force PathType:Any|Container|Leaf', 'path');
cmd('resolve-path rvpa', 'Path:path-r LiteralPath:path-r Force Relative', 'path');
cmd('get-filehash', 'Path:path-r LiteralPath:path-r Force Algorithm:SHA1|SHA256|SHA384|SHA512|MD5', 'path');
cmd('get-content gc cat type', `Path:path-r LiteralPath:path-r TotalCount:n Head:n First:n Tail:n Last:n Raw Encoding:${ENC} ReadCount:n`, 'path');
cmd('select-string sls', `Pattern:s Path:path-r LiteralPath:path-r SimpleMatch CaseSensitive NotMatch AllMatches List Quiet Context:s Encoding:${ENC} Include:s Exclude:s Raw`, 'pattern path');
cmd('split-path', 'Path:s Parent Leaf Extension LeafBase Qualifier NoQualifier', 'path');
cmd('join-path', 'Path:s ChildPath:s AdditionalChildPath:s', 'path childpath additionalchildpath…');
cmd('get-location gl pwd', '', '');
cmd('measure-object measure', 'Line Word Character IgnoreWhiteSpace Property:s Sum Average Maximum Minimum', 'property');
cmd('select-object select', 'First:n Last:n Skip:n SkipLast:n Index:s Unique ExpandProperty:s Property:blkh', 'property…');
cmd('where-object where ?', `FilterScript:blks Property:s Value:s ${COMPARE}`, 'filterscript');
cmd('foreach-object foreach %', 'Process:blk Begin:blk End:blk', 'process');
cmd('sort-object sort', 'Property:blkh Descending Unique CaseSensitive Top:n Bottom:n', 'property…');
cmd('group-object group', 'Property:blkh NoElement', 'property…');
cmd('format-table ft', 'Property:blkh AutoSize Wrap', 'property…');
cmd('format-list fl', 'Property:blkh', 'property…');
cmd('out-string', 'Width:n Stream', '');
cmd('out-null out-host', '', '');
cmd('convertto-json', 'Depth:n Compress', 'inputobject');
cmd('convertfrom-json', 'AsHashtable', 'inputobject');
cmd('convertto-csv', 'NoTypeInformation Delimiter:s', 'inputobject');
cmd('convertfrom-csv', 'Delimiter:s', 'inputobject');
cmd('import-csv', `Path:path-r LiteralPath:path-r Delimiter:s Encoding:${ENC}`, 'path');
cmd('get-date', 'Format:s UFormat:s Date:s', 'date');
cmd('get-command gcm', 'Name:s CommandType:Alias|Application|Cmdlet|Function|All|ExternalScript|Filter|Script', 'name…');
cmd('get-member gm', 'MemberType:All|Method|Methods|Property|Properties|NoteProperty|AliasProperty|ScriptProperty', '');
cmd('get-process gps ps', 'Name:s Id:n', 'name…');
cmd('get-service gsv', 'Name:s', 'name…');
cmd('write-output echo write', '', 'inputobject…');
cmd('write-host', `NoNewline ForegroundColor:${COLORS}`, 'object…');
cmd('start-sleep sleep', 'Seconds:n Milliseconds:n', 'seconds', (p, acc) => {
  const s = first(p, 'seconds')[0];
  if (s && !s.dynamic && Number(s.text) > 600) acc.add('once', 'list.form', { cmd: 'Start-Sleep', detail: s.text }, true);
});
cmd('set-location sl cd chdir push-location pushd', 'Path:path-r LiteralPath:path-r', 'path', (p, acc) => {
  const w = pathWords(p)[0];
  acc.cwd = { word: w && !(w.text === '-' || w.text === '+') ? w : null };
});
cmd('pop-location popd', '', '', (_p, acc) => { acc.cwd = { word: null }; });

// ── 書く: 毎回確かめる（security-self-api.md §11.13）──
// PowerShell のパラメータの結び付き（パイプで流れてくる値の名前から -Destination や -Path が決まる、など）はガードが真似しきれず、審査のたびに確かめなしの書き込みが見つかった。
// ファイルを書く・作る・移す・消すコマンドレットは、書き込み先が決まっていても確かめなしにはしない（確かめなしで書くなら file_write の道具）。
// 引数の読みとパスの調べは残す: 禁止の一覧・秘密のパスは止め、守る場所・許可フォルダの外は、持ち主が tools.shell.allow に書いても外せない。パイプを受けるものは外せない
function writer(names: string, params: string, pos: string, extra?: PsCmd['extra']): void {
  cmd(names, params, pos, (p, acc, ctx, st) => {
    extra?.(p, acc, ctx, st);
    pipedInput(acc, st);
    acc.add('once', 'list.ps_write', { cmd: st.words[0]!.text }, true);
  }, true);
}
// パイプを受ける文は、流れてくる値が引数（書き込み先・宛先）に名前で結び付くことがあるので、持ち主の許可でも外せない
function pipedInput(acc: Acc, st: Statement): void {
  if (st.pipedIn) acc.add('once', 'list.ps_pipe', { cmd: st.words[0]!.text }, false);
}
const joinName: PsCmd['extra'] = (p, acc) => {
  const name = first(p, 'name')[0];
  if (name) acc.copies.push({ kind: 'join', sources: [], dest: first(p, 'path')[0] ?? null, name, recursive: false, dirFlag: false, noTargetDir: false });
};
writer('new-item ni', 'Path:path-w Name:s ItemType:File|Directory Value:s Force', 'path', joinName);
// 計画の表に無い追加: Windows PowerShell 5.1 の mkdir・md は New-Item -ItemType Directory を包んだ関数
writer('mkdir md', 'Path:path-w Name:s Force', 'path', joinName);
writer('set-content add-content ac', `Path:path-w LiteralPath:path-w Value:s Encoding:${ENC} NoNewline Force`, 'path value…');
writer('clear-content clc', 'Path:path-w LiteralPath:path-w Force', 'path');
writer('out-file', `FilePath:path-w LiteralPath:path-w Encoding:${ENC} Append NoNewline Width:n InputObject:s`, 'filepath');
writer('tee-object tee', 'FilePath:path-w LiteralPath:path-w Append Variable:var', 'filepath');
writer('copy-item copy cp cpi', 'Path:path-r LiteralPath:path-r Destination:path-w Recurse Force Container Filter:s Include:s Exclude:s', 'path destination', (p, acc) => {
  const sources = pathWords(p);
  if (sources.length > 0) acc.copies.push({ kind: 'copy', sources, dest: first(p, 'destination')[0] ?? null, name: null, recursive: p.all.has('recurse'), dirFlag: false, noTargetDir: false });
  if (p.all.has('recurse')) for (const w of sources) acc.walk(w);
});
writer('move-item move mv mi', 'Path:path-w LiteralPath:path-w Destination:path-w Force', 'path destination', (p, acc) => {
  const sources = pathWords(p);
  if (sources.length > 0) acc.copies.push({ kind: 'copy', sources, dest: first(p, 'destination')[0] ?? null, name: null, recursive: true, dirFlag: false, noTargetDir: false });
  for (const w of sources) acc.walk(w);
});
writer('rename-item ren rni', 'Path:path-w LiteralPath:path-w NewName:s Force', 'path newname', (p, acc) => {
  const sources = pathWords(p);
  if (sources.length > 0) acc.copies.push({ kind: 'rename', sources, dest: null, name: first(p, 'newname')[0] ?? null, recursive: false, dirFlag: false, noTargetDir: false });
});
writer('remove-item rm del erase rd rmdir ri', 'Path:path-w LiteralPath:path-w Recurse Include:s Exclude:s Filter:s Force', 'path', (p, acc) => {
  acc.deletes = true;
  if (p.all.has('recurse')) for (const ref of acc.paths) ref.recursive = true;
});
// 元のフォルダの下の秘密のパスは、アーカイブにそのまま入る（tar -c・zip と同じに、歩いて調べる）
writer('compress-archive', 'Path:path-r LiteralPath:path-r DestinationPath:path-w CompressionLevel:Optimal|NoCompression|Fastest Force Update', 'path destinationpath', (p, acc) => { for (const w of pathWords(p)) acc.walk(w); });
cmd('expand-archive', 'Path:s LiteralPath:s DestinationPath:s Force', 'path destinationpath', (_p, acc) => { acc.add('once', 'list.expand', { cmd: 'Expand-Archive' }, false); });

// ── ネットワーク（11.3.4）──
const WEB = 'Uri:url UseBasicParsing Method:s TimeoutSec:n MaximumRedirection:n UserAgent:s OutFile:path-w Body:s InFile:path-r ContentType:s';
export const WEB_NAMES = ['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm'];
const webExtra: PsCmd['extra'] = (p, acc, _ctx, st) => {
  acc.fetch = true;
  pipedInput(acc, st);
  if (p.all.has('outfile')) acc.add('once', 'list.ps_write', { cmd: `${st.words[0]!.text} -OutFile` }, true);
  const method = first(p, 'method')[0];
  let sends = false;
  if (method) {
    if (/^(?:post|put|patch|delete)$/iu.test(method.text) && !method.dynamic) sends = true;
    else if (method.dynamic || !/^(?:get|head)$/iu.test(method.text)) acc.add('once', 'list.form', { cmd: 'Invoke-WebRequest', detail: `-Method ${method.text}` }, true);
  }
  if (p.all.has('body') || p.all.has('infile') || p.all.has('contenttype')) sends = true;
  // Invoke-WebRequest・Invoke-RestMethod は転送を既定で（5 回まで）追う。-MaximumRedirection 0 のときだけ許す
  const redirects = first(p, 'maximumredirection')[0];
  if (!redirects || redirects.dynamic || redirects.text !== '0') acc.add('once', 'list.redirect', { cmd: 'Invoke-WebRequest' }, true);
  if (sends) acc.add('ask', 'ask.powershell');
};
cmd('invoke-webrequest iwr invoke-restmethod irm', WEB, 'uri', webExtra);

// ── 外部のプログラム（Windows）に渡す引数（C7）──
const WIDE = new Set(['git', 'rg', 'node', 'nodejs', 'python', 'python3', 'py']);
// Windows PowerShell 5.1 が外部のプログラムに渡す引数は、ガードが読んだ語の並びと違うことがある。本物の 5.1 で測った表は tests/shell-ps-argv.test.ts（§11.13 の続き）:
// 空の引数（'' や ""）は黙って消える（git grep -e '' -- -O./x.sh は、git に grep -e -- -O./x.sh として渡り、-O のフラグが動いた）・カンマの並びに空白か空の要素があると別々の引数になる・-名前:値 は 1 つの引数 -名前:値 のまま渡る。
// ガードの読みと受け取る並びが違う引数は、止める
export function winArgs(name: string, words: readonly Word[], ext: string, acc: Acc): void {
  const cmdFile = ext === '.cmd' || ext === '.bat';
  for (const w of words.slice(1)) {
    const mangled = w.split ? `${w.text}:` : w.loose ? w.text : !w.dynamic && w.kind === 'plain' && w.text === '' ? "''" : '';
    if (mangled) { acc.add('deny', 'list.winargs_ps', { detail: `${name}: ${mangled}` }, false); return; }
    if (w.dynamic) continue;
    const t = w.text;
    let detail = '';
    if (t.includes('"')) detail = '"';
    else if (/\s/u.test(t) && t.endsWith('\\')) detail = '\\';
    else if (cmdFile && /[&|<>^%!()\s]/u.test(t)) detail = t;
    else if (/[^\u0000-\u007f]/u.test(t) && !WIDE.has(name.toLowerCase())) detail = t;
    if (detail) { acc.add('deny', 'list.winargs', { detail: `${name}: ${detail}` }, false); return; }
  }
}

// ── PowerShell だけの外部: findstr・where.exe・tree.com・whoami・hostname・ipconfig ──
export function runFindstr(words: Word[], acc: Acc, ctx: MatchCtx): void {
  const flags = flagMap('/s /i /n /r /l /m /v /x /b /e /o /c:s /f:path-r /g:path-r /d:s', true);
  const pos: Word[] = [];
  const dirs: Word[] = [];
  let pattern = false;
  let recursive = false;
  for (const w of words.slice(1)) {
    if (w.dynamic) acc.add('once', 'list.dynamic', { cmd: 'findstr', detail: w.text }, true);
    // findstr も、引用符を外した引数のスイッチを読む（'/f:list.txt' や "/s" もスイッチ）
    if (!(literal(w) && /^\/[A-Za-z]/u.test(w.text))) { pos.push(w); continue; }
    const colon = w.text.indexOf(':');
    const key = (colon > 0 ? w.text.slice(0, colon) : w.text).toLowerCase();
    const def = flags.get(key);
    if (!def || (colon > 0) !== (def.type !== 'bool')) { acc.add('once', 'list.flag', { cmd: 'findstr', flag: w.text }, true); continue; }
    if (key === '/c' || key === '/g') pattern = true;
    // /f:（読むファイルの一覧）と /g:（検索する文字の一覧）は、読むファイルが別のファイルの中身（/f:/ と /g:/ は標準入力）で決まる。常に今回だけ
    if (key === '/f' || key === '/g') acc.add('once', 'list.file_list', { cmd: 'findstr', flag: w.text.slice(0, 2) }, false);
    if (key === '/s') recursive = true;
    if (key === '/d') for (const d of w.text.slice(colon + 1).split(';')) if (d) dirs.push({ ...w, text: d });
    if (colon > 0) checkValue(def.type as ValueType, { ...w, text: w.text.slice(colon + 1) }, acc, 'findstr', key, ctx);
  }
  const operands = pattern ? pos : pos.slice(1);
  for (const w of operands) acc.read(w);
  // findstr は、ファイル名のワイルドカード（* ?）を自分で展開し（PowerShell は展開しない）、/s では下の階層まで探し、/d のフォルダの一覧も探す。
  // 名前で絞る Windows のファイル検索の決まりは真似ず、そのフォルダの名前を全部調べる（秘密のパスがあれば止める）
  for (const d of dirs) acc.walk(d);
  for (const w of operands) {
    if (w.dynamic) continue;
    const wild = /[*?]/u.test(w.text);
    if (!recursive && !wild) continue;
    const dir = w.text.slice(0, Math.max(w.text.lastIndexOf('\\'), w.text.lastIndexOf('/')) + 1);
    const wildDir = /[*?]/u.test(dir);
    acc.walk({ ...w, text: dir === '' || wildDir ? '.' : dir, glob: false }, recursive || wildDir);
  }
}
export function runPsSimple(name: string, words: Word[], acc: Acc, ctx: MatchCtx): boolean {
  const args = words.slice(1);
  const bad = (): void => { acc.add('once', 'list.form', { cmd: name, detail: args.map(w => w.text).join(' ') }, true); };
  if (name === 'whoami' || name === 'hostname') { if (args.length) bad(); return true; }
  if (name === 'ipconfig') { if (!(args.length === 0 || (args.length === 1 && /^\/all$/iu.test(args[0]!.text)))) bad(); return true; }
  if (name === 'tree.com' || name === 'tree') {
    for (const w of args) {
      if (/^\/[FA]$/iu.test(w.text) && literal(w)) continue;
      checkValue('path-n', w, acc, 'tree', '', ctx);
    }
    return true;
  }
  if (name === 'where.exe') {
    for (let i = 0; i < args.length; i++) {
      const w = args[i]!;
      if (literal(w) && /^\/Q$/iu.test(w.text)) continue;
      if (literal(w) && /^\/R$/iu.test(w.text)) { const v = args[++i]; if (v) acc.read(v, true); else bad(); continue; }
      if (isFlagLike(w) || w.text.startsWith('/')) { acc.add('once', 'list.flag', { cmd: 'where.exe', flag: w.text }, true); continue; }
      if (w.dynamic || w.glob) acc.add('once', 'list.dynamic', { cmd: 'where.exe', detail: w.text }, true);
    }
    return true;
  }
  return false;
}
