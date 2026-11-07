// 許可の一覧の表（security-self-api.md §11.3.1・11.3.4・11.3.5・11.7）: bash のコマンドと、PowerShell からも呼ぶ外部の道具（rg・tar・curl・言語の道具）。
// 表にある綴り以外のフラグ・形は、すべて「今回だけ」（exempt: 持ち主の tools.shell.allow で外せる）。

import { Acc, checkUrl, checkValue, envAssignOk, flagMap, isFlagLike, literal, parseGnu, walkAll, type CopyUse, type GnuSpec, type MatchCtx } from './allowlist-core.ts';
import type { Word } from './shell-lex.ts';

export type Run = (words: Word[], acc: Acc, ctx: MatchCtx) => void;
export interface Tool { builtin: boolean; run: Run }

const TOOLS = new Map<string, Tool>();
const register = (names: readonly string[], run: Run, builtin = false): void => { for (const n of names) TOOLS.set(n, { builtin, run }); };
const gnu = (spec: GnuSpec, builtin = false, after?: (p: ReturnType<typeof parseGnu>, acc: Acc, ctx: MatchCtx, words: Word[]) => void): void =>
  register(spec.names, (words, acc, ctx) => { const p = parseGnu(spec, words, acc, ctx); after?.(p, acc, ctx, words); }, builtin);

const formOnce = (acc: Acc, cmd: string, detail: string, exempt = true): void => acc.add('once', 'list.form', { cmd, detail }, exempt);
// C5: 値の分からない引数・ワイルドカードは、◎ でないコマンドでは「--」のあとにだけ許す
function dynamicOnce(words: readonly Word[], acc: Acc, cmd: string): void {
  for (const w of words.slice(1)) {
    if (!w.dynamic && !w.glob) continue;
    acc.add('once', 'list.dynamic', { cmd, detail: w.text }, true);
    return;
  }
}

// ── 読むだけのコマンド ──
gnu({ names: ['ls'], ro: true, flags: '-a -A -l -h -R -1 -t -r -S -d -F -i -s --color=never', pos: ['path-n…'] });
gnu({ names: ['cat'], ro: true, flags: '-n -b -s -A -E -T -v', pos: ['path-r…'] });
gnu({ names: ['head'], ro: true, numeric: true, flags: '-n:n -c:n -q -v', pos: ['path-r…'] });
gnu({ names: ['tail'], ro: true, numeric: true, flags: '-n:n -c:n -q -v', pos: ['path-r…'] });
gnu({ names: ['wc'], ro: true, flags: '-l -w -c -m -L', pos: ['path-r…'] });
gnu({ names: ['sort'], flags: '-n -r -u -f -h -V -b -s -z -k:s -t:s', pos: ['path-r…'] });
gnu({ names: ['uniq'], flags: '-c -d -u -i -f:n -s:n -w:n', pos: ['path-r'] });
gnu({ names: ['cut'], ro: true, flags: '-d:s -f:s -c:s -b:s -s --complement', pos: ['path-r…'] });
gnu({ names: ['tr'], ro: true, flags: '-d -s -c -C', pos: ['s', 's'] });
gnu({ names: ['nl', 'tac', 'rev'], ro: true, flags: '', pos: ['path-r…'] });
gnu({ names: ['column'], ro: true, flags: '-t -s:s', pos: ['path-r…'] });
gnu({ names: ['diff'], ro: true, flags: '-u -U:n -r -N -q -w -b -B -i -y --brief --color=never --label:s', pos: ['path-r', 'path-r'] }, false, (p, acc) => { if (p.seen.has('-r')) for (const w of p.pos) acc.walk(w); });
gnu({ names: ['cmp'], ro: true, flags: '-l -s', pos: ['path-r', 'path-r'] });
gnu({ names: ['comm'], ro: true, flags: '-1 -2 -3', pos: ['path-r', 'path-r'] });
const GREP_FLAGS = '-r -R -n -i -l -L -c -v -w -x -o -E -F -P -h -H -s -q -I -a -z -Z --null -A:n -B:n -C:n -m:n -e:pat -f:path-r --include:pat --exclude:pat --exclude-dir:pat --color=never';
// -r / -R は、パスのフォルダの下を歩く（パスが無ければ今のフォルダ）。--include などの絞り込みは真似ない（全部を調べる）
gnu({ names: ['grep', 'egrep', 'fgrep'], ro: true, numeric: true, flags: GREP_FLAGS, pos: ['pat', 'path-r…'], patFlags: ['-e', '-f'] }, false, (p, acc) => {
  if (p.seen.has('-r') || p.seen.has('-R')) walkAll(acc, p.seen.has('-e') || p.seen.has('-f') ? p.pos : p.pos.slice(1));
});
gnu({
  names: ['rg'], numeric: false, patFlags: ['-e', '--files', '--type-list'], pos: ['pat', 'path-r…'],
  flags: '-n -N -i -S -s -w -v -l -c -o -F -x -u -uu -uuu -L -e:pat -g:pat -t:s -T:s -A:n -B:n -C:n -m:n -M:n -d:n --hidden --no-ignore --files --json --no-heading --heading --vimgrep --color=never --max-depth:n --sort=path --type-list --count-matches --files-with-matches --files-without-match',
}, false, (p, acc) => {
  // rg は、パスのフォルダの下を歩く（パスが無ければ今のフォルダ）。名前だけを出す --files と --type-list は読まない。
  // 既定では「.」で始まる名前を読まないが、-u -uu -uuu --hidden と -g（グロブは隠しも読む。本物の rg 14 で確かめた）があれば読む。無視の一覧（.gitignore）は真似ない
  if (p.seen.has('--files') || p.seen.has('--type-list')) return;
  walkAll(acc, p.seen.has('-e') ? p.pos : p.pos.slice(1), !['-u', '-uu', '-uuu', '--hidden', '-g'].some(f => p.seen.has(f)));
});
gnu({ names: ['fd', 'fdfind'], flags: '-e:s -t:f|d|l -H -I -d:n --max-depth:n -g -a -l -0 -E:pat -s -i -F -L --color=never', pos: ['pat', 'path-r…'] });
gnu({ names: ['file'], flags: '-b -i -L --mime-type --mime-encoding', pos: ['path-r…'] });
gnu({ names: ['stat'], ro: true, flags: '-c:s --format:s -L -t', pos: ['path-r…'] });
gnu({ names: ['du'], ro: true, flags: '-s -h -a -c -k -m -d:n --max-depth:n', pos: ['path-r…'] });
gnu({ names: ['df'], ro: true, flags: '-h -T -k', pos: ['path-r…'] });
gnu({ names: ['tree'], flags: '-L:n -a -d -f -i -n -I:pat -P:pat --noreport', pos: ['path-n…'] });
gnu({ names: ['basename', 'dirname'], ro: true, flags: '', pos: ['s…'] });
gnu({ names: ['realpath'], ro: true, flags: '-e -m -s --relative-to:path-r', pos: ['path-r…'] });
gnu({ names: ['readlink'], ro: true, flags: '-f -e -m -n', pos: ['path-r…'] });
gnu({ names: ['pwd'], ro: true, flags: '-P -L', pos: [] }, true);
gnu({ names: ['date'], flags: '-u -I -R -d:s', pos: ['s'] });
gnu({ names: ['whoami', 'id', 'nproc', 'uptime'], ro: true, flags: '', pos: [] });
gnu({ names: ['uname'], ro: true, flags: '-a -s -r -m -o', pos: [] });
gnu({ names: ['hostname'], ro: true, flags: '-f -s -I', pos: [] });
gnu({ names: ['printenv'], flags: '', pos: ['s…'] });
gnu({ names: ['which'], ro: true, flags: '-a', pos: ['s…'] });
gnu({ names: ['type'], ro: true, flags: '-a -t -p', pos: ['s…'] }, true);
// -c は、チェックサムの一覧のファイルに書かれたファイルを読んで照合する（どのファイルを読むかが、ファイルの中身で決まる）。一覧のファイルを読む形は常に今回だけ
gnu({ names: ['md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'b2sum', 'cksum'], ro: true, flags: '-c', pos: ['path-r…'] }, false, (p, acc, _ctx, words) => {
  if (p.seen.has('-c')) acc.add('once', 'list.file_list', { cmd: words[0]!.text, flag: '-c' }, false);
});
gnu({ names: ['xxd'], flags: '-l:n -s:n -c:n -g:n -u -p', pos: ['path-r'] });
gnu({ names: ['od'], ro: true, flags: '-A:s -t:s -N:n -j:n -v -c -x', pos: ['path-r…'] });
gnu({ names: ['hexdump'], ro: true, flags: '-C -n:n -s:n -v', pos: ['path-r…'] });
gnu({ names: ['strings'], ro: true, flags: '-n:n -a -t:s', pos: ['path-r…'] });
gnu({ names: ['mkdir'], flags: '-p -v -m:s', pos: ['path-w…'] });
gnu({ names: ['rmdir'], flags: '-v', pos: ['path-w…'] }, false, (_p, acc) => { acc.deletes = true; });
gnu({ names: ['touch'], flags: '-a -m -c -d:s -t:s -r:path-r', pos: ['path-w…'] });
gnu({ names: ['tee'], flags: '-a', pos: ['path-w…'] });
const MODE = /^(?:[ugoa]*[-+=][rwxXst]+|[0-7]{3,4})$/u;
gnu({ names: ['chmod'], flags: '-R -v -c', pos: ['s', 'path-w…'] }, false, (p, acc) => {
  const mode = p.pos[0];
  if (mode && (mode.dynamic || !MODE.test(mode.text))) formOnce(acc, 'chmod', mode.text);
});

// ── 数・待つ ──
register(['seq'], (words, acc, ctx) => { for (const w of words.slice(1)) checkValue('n', w, acc, 'seq', '', ctx); });
register(['sleep'], (words, acc) => {
  const args = words.slice(1);
  if (args.length === 0) { formOnce(acc, 'sleep', ''); return; }
  for (const w of args) {
    const m = /^([0-9]+(?:\.[0-9]+)?)([smhd]?)$/u.exec(w.text);
    const seconds = m ? Number(m[1]) * ({ '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]!] ?? 1) : Number.NaN;
    if (w.dynamic || !(seconds <= 600)) formOnce(acc, 'sleep', w.text);
  }
});

// ── シェルの組み込み ──
register(['echo'], () => undefined, true);
register(['true', 'false', ':'], () => undefined, true);
register(['printf'], (words, acc, ctx) => {
  if (words[1] && literal(words[1]) && words[1].text === '-v') {
    if (words[2]) checkValue('var', words[2], acc, 'printf', '-v', ctx);
    else formOnce(acc, 'printf', '-v');
  }
}, true);
const FILE_TESTS = new Set(['-e', '-f', '-d', '-r', '-w', '-x', '-s', '-L', '-h', '-p', '-S', '-b', '-c', '-O', '-G', '-N', '-k', '-u', '-g', '-t']);
// 値を式や配列の添字として評価する形は、値が整数の定数だけでなければ今回だけ（持ち主の許可でも外せない）。値に a[$(コマンド)] が入っていると、そのコマンドが動くため
const INT_LITERAL = /^[+-]?[0-9]+$/u;
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const NUM_OPS = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge']);
const arithOnce = (acc: Acc, cmd: string, detail: string): void => acc.add('once', 'list.arith', { cmd, detail: detail.slice(0, 60) }, false);
register(['test', '[', '[['], (words, acc) => {
  const cmd = words[0]!.text;
  const args = words.slice(1);
  args.forEach((w, i) => {
    if (literal(w) && FILE_TESTS.has(w.text) && args[i + 1]) acc.read(args[i + 1]!);
    if (!literal(w)) return;
    // [[ は -eq などの両側を式として評価する。[ と test は整数でなければ失敗するだけ（本物の bash 5.3 で確かめた）。-v -R は、どれも名前の添字を評価する
    if (cmd === '[[' && NUM_OPS.has(w.text)) {
      const bad = [args[i - 1], args[i + 1]].find(x => x !== undefined && !(literal(x) && INT_LITERAL.test(x.text)));
      if (bad) arithOnce(acc, cmd, `${w.text} ${bad.text}`);
    }
    if ((w.text === '-v' || w.text === '-R') && args[i + 1] && !(literal(args[i + 1]!) && PLAIN_NAME.test(args[i + 1]!.text))) arithOnce(acc, cmd, `${w.text} ${args[i + 1]!.text}`);
  });
}, true);
// let は引数を式として、declare・typeset・local は -i の値と NAME[…] の添字を評価する。普通の名前と、-i でなければ決まった文字の値、-i なら整数の値だけを安全とする（それ以外は評価されうる）
register(['let', 'declare', 'typeset', 'local'], (words, acc) => {
  const cmd = words[0]!.text;
  const args = words.slice(1);
  const integer = cmd !== 'let' && args.some(w => literal(w) && /^-[A-Za-z]*i[A-Za-z]*$/u.test(w.text));
  const safe = args.every(w => {
    if (!literal(w)) return false;
    if (cmd === 'let') return /^[\s0-9+\-*/%()]+$/u.test(w.text);
    if (/^-[A-Za-z]+$/u.test(w.text)) return true;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:=([\s\S]*))?$/u.exec(w.text);
    return m !== null && (m[2] === undefined || (integer ? INT_LITERAL.test(m[2]) : /^[A-Za-z0-9_./:-]*$/u.test(m[2])));
  });
  if (safe) acc.add('once', 'list.command', { cmd }, true); else arithOnce(acc, cmd, args.map(w => w.text).join(' '));
}, true);
register(['env'], (words, acc) => { if (words.length > 1) formOnce(acc, 'env', words.slice(1).map(w => w.text).join(' ')); });
register(['command'], (words, acc) => {
  if (words[1] && literal(words[1]) && words[1].text === '-v' && words.length > 2) return;
  formOnce(acc, 'command', words.slice(1).map(w => w.text).join(' '));
}, true);
register(['export'], (words, acc) => {
  for (const w of words.slice(1)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:=([\s\S]*))?$/u.exec(w.text);
    if (!m || w.kind !== 'plain' || w.glob) { acc.add('once', 'list.env', { name: w.text }, false); continue; }
    if (m[2] === undefined) continue;
    if (!envAssignOk(m[1]!, { ...w, text: m[2] })) acc.add('once', 'list.env', { name: m[1]! }, false);
  }
}, true);
register(['cd', 'pushd', 'chdir'], (words, acc) => {
  const args = words.slice(1).filter(w => !(literal(w) && /^-[PL]$/u.test(w.text)));
  if (args.length > 1) { formOnce(acc, words[0]!.text, args.map(w => w.text).join(' ')); acc.cwd = { word: null }; return; }
  const target = args[0];
  if (!target || (literal(target) && target.text === '-')) { acc.cwd = { word: null }; return; }
  acc.read(target);
  acc.cwd = { word: target };
}, true);
register(['popd'], (_words, acc) => { acc.cwd = { word: null }; }, true);

// ── jq ──
const JQ_BOOL = new Set(['-r', '-j', '-c', '-S', '-e', '-n', '-s', '-a', '-M', '-R', '-C', '--tab', '--raw-output', '--join-output', '--compact-output', '--sort-keys', '--exit-status', '--null-input', '--slurp', '--ascii-output', '--monochrome-output', '--raw-input', '--color-output', '--seq']);
// import・include は、探索の道（-L・~/.jq・プログラムのフォルダ）の .json・.jq を読み込む。読むパスの調べは、プログラムの文の中の名前までは見ない。
// プログラムにこの語があれば今回だけ（文字列や名前の中の語も止める側に倒す）。-f のプログラムは、分類の時点では中身を確かめられない（同じコマンドの前の文で書かれることもある）ので常に今回だけ
const JQ_MODULE = /\b(?:import|include)\b/iu;
register(['jq'], (words, acc, ctx) => {
  const args = words.slice(1);
  const pos: Word[] = [];
  let fromFile = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (!w.dynamic && !w.quoted && w.text === '--') { pos.push(...args.slice(i + 1)); break; }
    if (!isFlagLike(w)) { pos.push(w); continue; }
    const t = w.text;
    if (JQ_BOOL.has(t)) continue;
    if (/^-[rjcSenasMRC]+$/u.test(t)) continue;
    if (t === '--indent') { const v = args[++i]; if (v) checkValue('n', v, acc, 'jq', t, ctx); else formOnce(acc, 'jq', t); continue; }
    if (t === '--arg' || t === '--argjson') { if (!args[i + 1] || !args[i + 2]) formOnce(acc, 'jq', t); i += 2; continue; }
    if (t === '--slurpfile' || t === '--rawfile') { const f = args[i + 2]; if (!args[i + 1] || !f) formOnce(acc, 'jq', t); else acc.read(f); i += 2; continue; }
    if (t === '-f' || t === '--from-file') {
      const f = args[++i];
      if (f) { acc.read(f); fromFile = true; acc.add('once', 'list.form', { cmd: 'jq', detail: `${t} ${f.text}` }, false); } else formOnce(acc, 'jq', t);
      continue;
    }
    if (t === '--library-path' || t.startsWith('--library-path=') || /^-[^-]*L/u.test(t)) {
      acc.add('once', 'list.form', { cmd: 'jq', detail: t }, false);
      const v = t.startsWith('--') ? (t.includes('=') ? undefined : args[++i]) : t.endsWith('L') ? args[++i] : undefined;
      if (v) acc.read(v);
      continue;
    }
    acc.add('once', 'list.flag', { cmd: 'jq', flag: t }, true);
  }
  const program = fromFile ? undefined : pos[0];
  if (program && (program.dynamic || JQ_MODULE.test(program.text))) acc.add('once', 'list.form', { cmd: 'jq', detail: program.dynamic ? program.text : 'import / include' }, false);
  for (const w of fromFile ? pos : pos.slice(1)) acc.read(w);
});

// ── sed ──
function sedRegexEnd(src: string, start: number, delim: string): number {
  for (let i = start; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === delim) return i;
    if (src[i] === '\n') return -1;
  }
  return -1;
}
export function sedScriptOk(script: string): boolean {
  let i = 0;
  const n = script.length;
  const skipBlank = (): void => { while (i < n && /[ \t]/u.test(script[i]!)) i++; };
  for (;;) {
    while (i < n && /[\s;]/u.test(script[i]!)) i++;
    if (i >= n) return true;
    // 番地
    for (let part = 0; part < 2; part++) {
      if (script[i] === '$') i++;
      else if (/[0-9]/u.test(script[i] ?? '')) { while (/[0-9]/u.test(script[i] ?? '')) i++; } else if (script[i] === '/') {
        const e = sedRegexEnd(script, i + 1, '/');
        if (e < 0) return false;
        i = e + 1;
        while (script[i] === 'I' || script[i] === 'M') i++;
      } else if (part === 0) break;
      else return false;
      if (part === 0 && script[i] === ',') { i++; continue; }
      break;
    }
    skipBlank();
    if (script[i] === '!') { i++; skipBlank(); }
    const c = script[i++];
    if (c === undefined) return false;
    if ('pdqQ=nNPDhHgGxlFz'.includes(c)) {
      if ((c === 'q' || c === 'Q' || c === 'l') && /[0-9]/u.test(script[i] ?? '')) while (/[0-9]/u.test(script[i] ?? '')) i++;
    } else if (c === 's') {
      const delim = script[i++];
      if (!delim || /[\s\\]/u.test(delim)) return false;
      const e1 = sedRegexEnd(script, i, delim);
      if (e1 < 0) return false;
      const e2 = sedRegexEnd(script, e1 + 1, delim);
      if (e2 < 0) return false;
      i = e2 + 1;
      while (i < n && /[giIpmM0-9]/u.test(script[i]!)) i++;
    } else if (c === 'y') {
      const delim = script[i++];
      if (!delim || /[\s\\]/u.test(delim)) return false;
      const e1 = sedRegexEnd(script, i, delim);
      if (e1 < 0) return false;
      const e2 = sedRegexEnd(script, e1 + 1, delim);
      if (e2 < 0) return false;
      i = e2 + 1;
    } else return false;
    skipBlank();
    if (i < n && script[i] !== ';' && script[i] !== '\n') return false;
  }
}
register(['sed'], (words, acc, ctx) => {
  const args = words.slice(1);
  const scripts: Word[] = [];
  const pos: Word[] = [];
  let inPlace = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (!w.dynamic && !w.quoted && w.text === '--') { pos.push(...args.slice(i + 1)); break; }
    if (w.dynamic || w.glob) acc.add('once', 'list.dynamic', { cmd: 'sed', detail: w.text }, true);
    if (!isFlagLike(w)) { pos.push(w); continue; }
    const t = w.text;
    if (t === '--posix') continue;
    if (t.startsWith('--') || !/^-[nErszie]+$/u.test(t)) { acc.add('once', 'list.flag', { cmd: 'sed', flag: t }, true); continue; }
    for (let j = 1; j < t.length; j++) {
      const ch = t[j]!;
      if (ch === 'e') {
        const rest = t.slice(j + 1);
        const v = rest !== '' ? { ...w, text: rest } : args[++i];
        if (v) scripts.push(v); else formOnce(acc, 'sed', '-e');
        break;
      }
      if (ch === 'i') {
        if (j === t.length - 1) inPlace = true; else acc.add('once', 'list.flag', { cmd: 'sed', flag: t }, true);
        continue;
      }
    }
  }
  if (scripts.length === 0 && pos.length > 0) scripts.push(pos.shift()!);
  if (scripts.length === 0) formOnce(acc, 'sed', '');
  for (const s of scripts) if (s.dynamic || !sedScriptOk(s.text)) formOnce(acc, 'sed', s.text.length > 40 ? `${s.text.slice(0, 40)}…` : s.text);
  for (const w of pos) checkValue(inPlace ? 'path-w' : 'path-r', w, acc, 'sed', '', ctx);
});

// ── find ──
const FIND_BOOL = new Set(['-empty', '-readable', '-writable', '-executable', '-prune', '-print', '-print0', '-depth', '!', '-not', '-a', '-and', '-o', '-or', '(', ')']);
const FIND_VALUE = flagMap('-name:s -iname:s -path:s -ipath:s -wholename:s -regex:s -iregex:s -type:f|d|l -maxdepth:n -mindepth:n -mtime:s -mmin:s -size:s -links:n -perm:s -user:s -group:s -newer:path-r -samefile:path-r -printf:s');
register(['find'], (words, acc, ctx) => {
  dynamicOnce(words, acc, 'find');
  const args = words.slice(1);
  let i = 0;
  while (i < args.length && literal(args[i]) && ['-L', '-H', '-P'].includes(args[i]!.text)) i++;
  const startsExpr = (w: Word): boolean => w.kind === 'plain' && !w.dynamic && (w.text.startsWith('-') || w.text === '!' || w.text === '(');
  while (i < args.length && !startsExpr(args[i]!)) acc.readNames(args[i++]!, true);
  while (i < args.length) {
    const w = args[i++]!;
    if (!literal(w) && !w.glob) { formOnce(acc, 'find', w.text); continue; }
    if (FIND_BOOL.has(w.text)) continue;
    const def = FIND_VALUE.get(w.text);
    if (!def) { acc.add('once', 'list.flag', { cmd: 'find', flag: w.text }, true); continue; }
    const v = args[i++];
    if (!v) { formOnce(acc, 'find', `${w.text} の値`); continue; }
    checkValue(def.type === 'bool' ? 'x' : def.type, v, acc, 'find', w.text, ctx);
  }
});

// ── cp・mv・rm ──
const copyUse = (acc: Acc, p: ReturnType<typeof parseGnu>, kind: 'cp' | 'mv', recursive: boolean): void => {
  const target = p.values.get('-t')?.[0] ?? null;
  const sources = target ? p.pos : p.pos.slice(0, -1);
  const dest = target ?? p.pos.at(-1) ?? null;
  const use: CopyUse = { kind: 'copy', sources, dest, name: null, recursive, dirFlag: target !== null, noTargetDir: p.seen.has('-T') };
  acc.copies.push(use);
  // 元のフォルダを丸ごと動かす・写す形は、フォルダの下の秘密のパスをそのまま持っていくので、tar -c・zip と同じに歩いて調べる
  for (const s of sources) { if (kind === 'cp') acc.read(s, recursive); else acc.write(s, recursive); if (recursive) acc.walk(s); }
  if (dest) acc.write(dest);
};
gnu({ names: ['cp'], flags: '-r -R -a -f -n -v -p -u -T -t:x --preserve:s', pos: ['x…'] }, false, (p, acc) => {
  if (p.pos.length < (p.values.has('-t') ? 1 : 2)) formOnce(acc, 'cp', p.pos.map(w => w.text).join(' '));
  else copyUse(acc, p, 'cp', p.seen.has('-r') || p.seen.has('-R') || p.seen.has('-a'));
});
gnu({ names: ['mv'], flags: '-f -n -v -u -T -t:x', pos: ['x…'] }, false, (p, acc) => {
  if (p.pos.length < (p.values.has('-t') ? 1 : 2)) formOnce(acc, 'mv', p.pos.map(w => w.text).join(' '));
  else copyUse(acc, p, 'mv', true);
});
gnu({ names: ['rm'], flags: '-r -R -f -v -d', pos: ['path-w…'] }, false, (p, acc) => {
  acc.deletes = true;
  if (p.seen.has('-r') || p.seen.has('-R')) for (const ref of acc.paths) ref.recursive = true;
});

// ── tar・zip・unzip・gzip ──
function archiveFile(value: Word, acc: Acc, write: boolean, ctx: MatchCtx): void {
  if (value.dynamic) { acc.add('once', 'list.dynamic', { cmd: 'tar', detail: value.text }, true); return; }
  if (value.text.includes(':') && !(ctx.windows && /^[A-Za-z]:[\\/]/u.test(value.text))) { formOnce(acc, 'tar', `-f ${value.text}`, false); return; }
  checkValue(write ? 'path-w' : 'path-r', value, acc, 'tar', '-f', ctx);
}
const ABSOLUTE = /^(?:[A-Za-z]:)?[\\/]/u;
const TAR_BUNDLE = /^[ctxvzjJ]*[fC]$/u;
// 持ち主の許可が外せるのは、オプションが全部この集まり（短い c t x v z j J f C p と、長い綴りの完全一致）に入る tar だけ。集まりの外のオプションが 1 つでもあれば外せない list.form にする（省略形も外。版で別の綴りに展開される）
const TAR_LONG_MODE = new Map([['--create', 'c'], ['--list', 't']]);
const TAR_LONG_VALUE = new Map<string, 'f' | 'C'>([['--file', 'f'], ['--directory', 'C']]);
const TAR_LONG_PLAIN = new Set(['--gzip', '--bzip2', '--xz', '--verbose', '--preserve-permissions']);
const joinPath = (dir: string, name: string): string => `${dir.replace(/[\\/]+$/u, '')}/${name}`;
const nested = (base: Word | undefined, v: Word): Word => (base && !v.dynamic && !base.dynamic && !ABSOLUTE.test(v.text) ? { ...v, text: joinPath(base.text, v.text) } : v);
register(['tar'], (words, acc, ctx) => {
  const args = words.slice(1);
  const modes = new Set<string>();
  let file: Word | undefined;
  let expand = false;
  const pos: Word[] = [];
  const dirs: Word[] = [];
  // -C は、そのあとに書かれた元の名前の基準になる（順序に敏感。相対の -C を重ねると、重なっていく）
  const baseOf = new Map<Word, Word | undefined>();
  let cdir: Word | undefined;
  const want = (rest: Word[]): void => { for (const w of rest) if (w.dynamic || w.glob) acc.add('once', 'list.dynamic', { cmd: 'tar', detail: w.text }, true); };
  const flag = (name: string): void => acc.add('once', 'list.flag', { cmd: 'tar', flag: name }, true);
  const unsafe = (detail: string): void => formOnce(acc, 'tar', detail, false);
  want(args);
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    let text = w.text;
    const bundle = i === 0 && literal(w) && !text.startsWith('-') && /^[A-Za-z]+$/u.test(text);
    if (bundle) {
      if (!TAR_BUNDLE.test(text)) formOnce(acc, 'tar', text, false);
      text = `-${text}`;
    }
    if (!bundle && (!literal(w) || !text.startsWith('-') || text === '-')) { pos.push(w); baseOf.set(w, cdir); continue; }
    if (text.startsWith('--')) {
      if (/^--exclude=/u.test(text)) continue;
      const eq = text.indexOf('=');
      const name = eq < 0 ? text : text.slice(0, eq);
      flag(name);
      const kind = TAR_LONG_VALUE.get(name);
      if (kind) {
        const v = eq < 0 ? args[++i] : { ...w, text: text.slice(eq + 1) };
        if (!v || v.text === '') unsafe(`${name} の値`);
        else if (kind === 'f') file = v;
        else { dirs.push(v); cdir = nested(cdir, v); }
        continue;
      }
      if (eq >= 0) { unsafe(text); continue; }
      const mode = TAR_LONG_MODE.get(name);
      if (mode) modes.add(mode);
      else if (name === '--extract' || name === '--get') { acc.add('once', 'list.expand', { cmd: 'tar' }, false); expand = true; } else if (!TAR_LONG_PLAIN.has(name)) unsafe(text);
      continue;
    }
    for (let j = 1; j < text.length; j++) {
      const ch = text[j]!;
      if (ch === 'c' || ch === 't') modes.add(ch);
      else if ('vzjJ'.includes(ch)) continue;
      else if (ch === 'p') flag('-p');
      else if (ch === 'f' || ch === 'C') {
        const rest = text.slice(j + 1);
        const v = rest !== '' ? { ...w, text: rest } : args[++i];
        if (!v) { formOnce(acc, 'tar', `-${ch} の値`); break; }
        if (ch === 'f') file = v;
        else { dirs.push(v); cdir = nested(cdir, v); }
        break;
      } else if (ch === 'x') { acc.add('once', 'list.expand', { cmd: 'tar' }, false); expand = true; break; } else {
        flag(`-${ch}`);
        unsafe(text);
        break;
      }
    }
  }
  if (expand) return;
  if (modes.size !== 1) { formOnce(acc, 'tar', args.map(w => w.text).join(' '), !file && dirs.length === 0); return; }
  const create = modes.has('c');
  if (file) archiveFile(file, acc, create, ctx);
  for (const d of dirs) checkValue('path-r', d, acc, 'tar', '-C', ctx);
  if (create) {
    // 元のフォルダの下の秘密のパスは、アーカイブにそのまま入る（out.tar という名前は秘密のパスではない）ので、歩いて調べる。-C のあとの名前は、その -C のフォルダの下
    for (const w of pos) {
      const base = baseOf.get(w);
      // bsdtar（tar.exe）は @ で始まる名前を「そのアーカイブを読んで、中の項目を写す」と読む。-C のあとなら、その -C のフォルダが基準。外せない確かめにして、@ を除いた名前を読み取りとして調べる（GNU tar ではただの名前だが、安全な側に倒す）
      if (w.text.startsWith('@')) {
        formOnce(acc, 'tar', w.text, false);
        const name = { ...w, text: w.text.slice(1) };
        if (name.text !== '') acc.read(nested(base, name));
        continue;
      }
      acc.read(w, true);
      acc.walk(nested(base, w));
    }
  }
});
register(['zip'], (words, acc, ctx) => {
  const args = words.slice(1);
  const flags = flagMap('-r -q -j -v -0 -1 -2 -3 -4 -5 -6 -7 -8 -9');
  const pos: Word[] = [];
  dynamicOnce(words, acc, 'zip');
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (!isFlagLike(w)) { pos.push(w); continue; }
    if (w.text === '-x') { while (args[i + 1] && !isFlagLike(args[i + 1]!)) i++; continue; }
    if (flags.has(w.text) || /^-[rqjv0-9]+$/u.test(w.text)) continue;
    acc.add('once', 'list.flag', { cmd: 'zip', flag: w.text }, true);
  }
  void ctx;
  if (pos.length < 1) { formOnce(acc, 'zip', ''); return; }
  acc.write(pos[0]!);
  // 元のフォルダの下の秘密のパスは、zip にそのまま入る
  for (const w of pos.slice(1)) { acc.read(w, true); acc.walk(w); }
});
gnu({ names: ['unzip'], flags: '-l -v -Z', pos: ['path-r', 's…'] }, false, (p, acc) => {
  if (!p.seen.has('-l') && !p.seen.has('-Z') && !p.seen.has('-v')) acc.add('once', 'list.expand', { cmd: 'unzip' }, false);
});
register(['gzip'], (words, acc, ctx) => {
  const args = words.slice(1);
  const mode = args.find(isFlagLike);
  if (!mode || !['-l', '-c'].includes(mode.text) || args.filter(isFlagLike).length !== 1) { acc.add('once', 'list.flag', { cmd: 'gzip', flag: mode?.text ?? '' }, true); return; }
  dynamicOnce(words, acc, 'gzip');
  for (const w of args.filter(a => !isFlagLike(a))) checkValue('path-r', w, acc, 'gzip', '', ctx);
});
register(['gunzip'], (words, acc, ctx) => {
  const args = words.slice(1);
  if (args.filter(isFlagLike).length !== 1 || args.find(isFlagLike)!.text !== '-c') { acc.add('once', 'list.flag', { cmd: 'gunzip', flag: args.find(isFlagLike)?.text ?? '' }, true); return; }
  dynamicOnce(words, acc, 'gunzip');
  for (const w of args.filter(a => !isFlagLike(a))) checkValue('path-r', w, acc, 'gunzip', '', ctx);
});
gnu({ names: ['zcat'], flags: '', pos: ['path-r…'] });

// ── ネットワーク（11.3.4）──
const SEND_METHODS = /^(?:post|put|patch|delete)$/iu;
// 宛先を偽るのに使える（サーバーは Host・Origin・Sec-Fetch-*・Tailscale のヘッダで自分宛てか見分ける）ヘッダ。@ファイルは中身が分からない
const SPOOF_HEADERS = /^(?:host|origin|sec-fetch-[a-z-]+|x-forwarded-[a-z-]+|forwarded|tailscale-[a-z-]+|x-real-ip|x-original-url|x-rewrite-url)$/iu;
const CURL_FLAGS = flagMap('-q -s -S -L -I -i -f --fail -v -m:n --max-time:n --connect-timeout:n --retry:n -A:s --user-agent:s -H:s --header:s --compressed --http1.1 --http2 -X:s --request:s -o:path-w --output:path-w -O --remote-name --output-dir:path-w --create-dirs -g --globoff -d:s --data:s --data-raw:s --data-binary:s --data-urlencode:s -F:s --form:s --form-string:s -T:path-r --upload-file:path-r --json:s');
// 標準出力・捨て場に書く -o は、ファイルに保存しない
const SINK = /^(?:-|\/dev\/null|nul)$/iu;
const CURL_SEND = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '-F', '--form', '--form-string', '-T', '--upload-file', '--json']);
register(['curl'], (words, acc, ctx) => {
  const args = words.slice(1);
  const urls: Word[] = [];
  // 設定ファイルを読ませないのは、最初の引数が -q のときだけ（それ以外の -q は、curl は効かせない）
  const config = ctx.toolConfig?.('curl');
  if (config && !(args[0] && literal(args[0]) && args[0].text === '-q')) acc.add('once', 'file' in config ? 'list.tool_rc' : 'list.tool_rc_cwd', { cmd: 'curl', path: 'file' in config ? config.file : '', flag: '-q' }, false);
  let dir: Word | null = null;
  let remoteName = false;
  let sends = false;
  let saves = false;
  let globoff = false;
  const uploads: Word[] = [];
  acc.fetch = true;
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (w.dynamic || w.glob) acc.add('once', 'list.dynamic', { cmd: 'curl', detail: w.text }, true);
    if (!isFlagLike(w)) { urls.push(w); continue; }
    const text = w.text;
    const eq = text.startsWith('--') ? text.indexOf('=') : -1;
    const names = text.startsWith('--') ? [eq > 0 ? text.slice(0, eq) : text] : [...text.slice(1)].map(ch => `-${ch}`);
    for (const [k, name] of names.entries()) {
      const def = CURL_FLAGS.get(name);
      if (!def) { acc.add('once', 'list.flag', { cmd: 'curl', flag: name }, true); break; }
      if (name === '-O' || name === '--remote-name') { remoteName = true; saves = true; }
      if (name === '--create-dirs') saves = true;
      if (name === '-g' || name === '--globoff') globoff = true;
      if (name === '-L') acc.add('once', 'list.redirect', { cmd: 'curl' }, true);
      if (def.type === 'bool') { if (eq > 0) acc.add('once', 'list.flag', { cmd: 'curl', flag: text }, true); continue; }
      const attached = text.startsWith('--') ? (eq > 0 ? text.slice(eq + 1) : '') : text.slice(k + 2);
      const value = attached !== '' ? { ...w, text: attached, dynamic: false, glob: false } : args[++i];
      if (!value) { formOnce(acc, 'curl', `${name} の値`); break; }
      if (value.dynamic || value.glob) acc.add('once', 'list.dynamic', { cmd: 'curl', detail: value.text }, true);
      if (name === '-H' || name === '--header') {
        const header = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*[:;]/u.exec(value.text)?.[1];
        if (value.text.startsWith('@') || (header && SPOOF_HEADERS.test(header))) acc.add('once', 'list.header', { cmd: 'curl', header: header ?? value.text }, false);
        break;
      }
      if (name === '-X' || name === '--request') {
        if (SEND_METHODS.test(value.text)) sends = true;
        else if (!/^(?:get|head)$/iu.test(value.text)) acc.add('once', 'list.form', { cmd: 'curl', detail: `${name} ${value.text}` }, true);
        break;
      }
      if (CURL_SEND.has(name)) {
        sends = true;
        if (name === '-T' || name === '--upload-file') { acc.read(value); uploads.push(value); }
        else if (value.text.startsWith('@')) acc.read({ ...value, text: value.text.slice(1) });
        else if (name === '--data-urlencode' && !value.text.includes('=') && value.text.includes('@')) acc.read({ ...value, text: value.text.slice(value.text.indexOf('@') + 1) });
        else if (/^(?:-F|--form)$/u.test(name) && /=[@<]/u.test(value.text)) {
          const file = value.text.replace(/^[^=]*=[@<]/u, '').replace(/[;].*$/u, '');
          acc.read({ ...value, text: file });
          if (file.includes(',')) for (const part of file.split(',')) acc.read({ ...value, text: part.trim() });
        }
        break;
      }
      if (name === '--output-dir') { dir = value; saves = true; }
      if ((name === '-o' || name === '--output') && !SINK.test(value.text)) saves = true;
      checkValue(def.type, value, acc, 'curl', name, ctx);
      break;
    }
  }
  if (urls.length === 0) formOnce(acc, 'curl', '');
  for (const u of urls) {
    checkUrl(u, acc, ctx, 'curl');
    if (remoteName) acc.remoteNames.push({ url: u, dir });
  }
  // ファイルに保存する形は、保存先が決まっていても常に今回だけ（URL の { } [ ] と -o の #1 で、書き込み先が変わる）。持ち主が書いた項目では外せる
  if (saves) acc.add('once', 'list.download', { cmd: 'curl' }, true);
  // curl は URL（と -T の元）の { } [ ] を展開する。-g が無ければ宛先も書き込み先も読めないので、持ち主の許可でも外せない今回だけ。-g があれば文字どおり（URL は書かれたとおりに調べる）
  if (!globoff) for (const u of [...urls, ...uploads]) if (!u.dynamic && /[{}[\]]/u.test(u.text)) { acc.add('once', 'list.url_glob', { detail: u.text }, false); break; }
  if (sends) acc.add('ask', 'ask.curl');
});
const WGET_FLAGS = flagMap('-q -S --no-config --spider --max-redirect:n -T:n --timeout:n -t:n --tries:n -U:s -O:path-w --output-document:path-w -P:path-w --directory-prefix:path-w --post-data:s --post-file:path-r --method:s --body-data:s --body-file:path-r');
register(['wget'], (words, acc, ctx) => {
  const args = words.slice(1);
  const urls: Word[] = [];
  const config = ctx.toolConfig?.('wget');
  if (config && !(args[0] && literal(args[0]) && args[0].text === '--no-config')) acc.add('once', 'file' in config ? 'list.tool_rc' : 'list.tool_rc_cwd', { cmd: 'wget', path: 'file' in config ? config.file : '', flag: '--no-config' }, false);
  let dir: Word | null = null;
  let output = false;
  let toStdout = false;
  let spider = false;
  let sends = false;
  let redirects: string | undefined;
  acc.fetch = true;
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (w.dynamic || w.glob) acc.add('once', 'list.dynamic', { cmd: 'wget', detail: w.text }, true);
    if (!isFlagLike(w)) { urls.push(w); continue; }
    const text = w.text;
    const eq = text.startsWith('--') ? text.indexOf('=') : -1;
    const names = text.startsWith('--') ? [eq > 0 ? text.slice(0, eq) : text] : [...text.slice(1)].map(ch => `-${ch}`);
    for (const [k, name] of names.entries()) {
      const def = WGET_FLAGS.get(name);
      if (!def) { acc.add('once', 'list.flag', { cmd: 'wget', flag: name }, true); break; }
      if (name === '--spider') spider = true;
      if (def.type === 'bool') { if (eq > 0) acc.add('once', 'list.flag', { cmd: 'wget', flag: text }, true); continue; }
      const attached = text.startsWith('--') ? (eq > 0 ? text.slice(eq + 1) : '') : text.slice(k + 2);
      const value = attached !== '' ? { ...w, text: attached, dynamic: false, glob: false } : args[++i];
      if (!value) { formOnce(acc, 'wget', `${name} の値`); break; }
      if (value.dynamic || value.glob) acc.add('once', 'list.dynamic', { cmd: 'wget', detail: value.text }, true);
      if (name === '--max-redirect') redirects = value.text;
      if (name === '-O' || name === '--output-document') { output = true; toStdout = value.text === '-'; }
      if (name === '-P' || name === '--directory-prefix') dir = value;
      if (/^--(?:post-data|post-file|method|body-data|body-file)$/u.test(name)) {
        sends = true;
        if (name === '--post-file' || name === '--body-file') acc.read(value);
        break;
      }
      checkValue(def.type, value, acc, 'wget', name, ctx);
      break;
    }
  }
  // wget は転送を既定で（20 回まで）追う。0 にしたときだけ許す
  if (redirects !== '0') acc.add('once', 'list.redirect', { cmd: 'wget' }, true);
  if (urls.length === 0) formOnce(acc, 'wget', '');
  for (const u of urls) {
    checkUrl(u, acc, ctx, 'wget');
    if (!output) acc.remoteNames.push({ url: u, dir });
  }
  // -O - （標準出力）と --spider（保存しない）のほかは、ファイルに保存するので、保存先が決まっていても常に今回だけ。持ち主が書いた項目では外せる
  if ((output && !toStdout) || (!output && !spider)) acc.add('once', 'list.download', { cmd: 'wget' }, true);
  if (sends) acc.add('ask', 'ask.wget');
});

// ── 言語の道具（11.3.5）と、入れるもの（11.7）──
// 作業フォルダの設定を起動のときに読む道具は入れない: yarn（.yarnrc の yarn-path・corepack の packageManager）・pnpm（packageManager）・cargo と rustc（rustup の rust-toolchain）・go（go.mod の toolchain 行で別の Go を取ってくる）
const INFO_FORMS: Array<[RegExp, string[][]]> = [
  [/^(?:node|nodejs)$/u, [['--version'], ['-v']]],
  [/^(?:python\d*(?:\.\d+)?|py)$/u, [['--version'], ['-V']]],
  [/^(?:deno|bun|tsc)$/u, [['--version']]],
];
const INSTALL_SUBS = new Set(['install', 'i', 'add', 'ci', 'update', 'upgrade', 'up', 'dedupe', 'rebuild', 'link', 'sync', 'get', 'develop']);
const PACKAGE_TOOLS = ['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'pipx', 'uv', 'poetry', 'conda', 'cargo', 'go', 'gem', 'composer', 'pdm', 'hatch'];
const NPM_NAME = /^[@a-z0-9._/-]+$/u;
const exactForm = (words: readonly Word[], forms: readonly string[][]): boolean =>
  words.slice(1).every(literal) && forms.some(f => f.length === words.length - 1 && f.every((t, i) => words[i + 1]!.text === t));

function langInfo(name: string, words: Word[], acc: Acc): void {
  const args = words.slice(1);
  const rest = args.map(w => w.text).join(' ');
  const installing = /^(?:npm|pnpm|yarn|bun)$/u.test(name)
    ? literal(args[0]) && INSTALL_SUBS.has(args[0]!.text)
    : args.some(w => literal(w) && INSTALL_SUBS.has(w.text));
  if (PACKAGE_TOOLS.includes(name) && installing) { acc.add('once', 'list.install', { cmd: name }, false); return; }
  // npm と pip は、ls・list・freeze・--version のようにローカルしか見ない形でも、外へ送りうるものに数える（sends だけ。fetch は立てないので、動かしたあとの印は付かず、シェルで動かす形を止めることもない）。
  // レジストリ・インデックスの宛先は作業フォルダの設定（.npmrc・pip.conf・pip.ini など）から読まれ、だまされた判定役がモデルにそれを書かせていたら、どの形でもその宛先へ問い合わせが出うる。形からは設定の中身が分からないので、形では分けない
  if ((name === 'npm' || /^pip3?$/u.test(name)) && args.length > 0) acc.sends = true;
  const info = INFO_FORMS.find(([re]) => re.test(name));
  if (info && exactForm(words, info[1])) return;
  if (name === 'npm' && exactForm(words, [['--version'], ['-v']])) return;
  if (name === 'npm' && args.length > 0) { npmForms(words, acc); return; }
  if (/^pip3?$/u.test(name) && args.length > 0) { pipForms(words, acc); return; }
  formOnce(acc, name, rest);
}
// レジストリに問い合わせて、相手の書いた文字（説明・版・作者の文）を読む形。形が一覧の外でも、札で許して動かせば同じなので、検査より先に印を付ける
const NPM_REGISTRY_READS = new Set(['view', 'info', 'show', 'v', 'outdated', 'search', 's', 'audit']);
const PIP_REGISTRY_READS = new Set(['download', 'index', 'search']);
function npmForms(words: Word[], acc: Acc): void {
  const args = words.slice(1);
  const sub = args[0];
  const rest = args.slice(1);
  const bad = (): void => formOnce(acc, 'npm', args.map(w => w.text).join(' '));
  if (sub && literal(sub) && NPM_REGISTRY_READS.has(sub.text)) acc.fetch = true;
  if (!sub || !literal(sub) || !rest.every(literal)) { bad(); return; }
  const flags = (allowed: RegExp): boolean => rest.filter(isFlagLike).every(w => allowed.test(w.text));
  if (/^(?:ls|list)$/u.test(sub.text)) { if (!(flags(/^(?:--depth=[0-9]+|--all|--json|--prod|--omit=dev)$/u) && rest.every(isFlagLike))) bad(); return; }
  if (sub.text === 'outdated') { if (!rest.every(w => w.text === '--json')) bad(); return; }
  if (sub.text === 'view') {
    const names = rest.filter(w => !isFlagLike(w));
    if (!names.length || !names.every(w => NPM_NAME.test(w.text)) || !rest.filter(isFlagLike).every(w => w.text === '--json')) bad();
    return;
  }
  bad();
}
function pipForms(words: Word[], acc: Acc): void {
  const args = words.slice(1);
  const sub = args[0];
  const rest = args.slice(1);
  const bad = (): void => formOnce(acc, words[0]!.text, args.map(w => w.text).join(' '));
  if (sub && literal(sub) && (PIP_REGISTRY_READS.has(sub.text) || (sub.text === 'list' && rest.some(w => literal(w) && w.text === '--outdated')))) acc.fetch = true;
  if (!sub || !literal(sub) || !rest.every(literal)) { bad(); return; }
  if (sub.text === '--version' && rest.length === 0) return;
  if (sub.text === 'list') { if (!rest.every(w => w.text === '--outdated' || w.text === '--format=json')) bad(); return; }
  if (sub.text === 'freeze') { if (rest.length) bad(); return; }
  if (sub.text === 'show') { if (!(rest.length >= 1 && rest.every(w => NPM_NAME.test(w.text) && !w.text.startsWith('-')))) bad(); return; }
  bad();
}
for (const name of ['node', 'nodejs', 'python', 'python3', 'py', 'deno', 'bun', 'go', 'cargo', 'rustc', 'npm', 'pnpm', 'yarn', 'pip', 'pip3', 'pipx', 'uv', 'poetry', 'conda', 'gem', 'composer', 'pdm', 'hatch']) {
  register([name], (words, acc) => langInfo(name, words, acc));
}
for (const v of ['python3.8', 'python3.9', 'python3.10', 'python3.11', 'python3.12', 'python3.13']) register([v], (words, acc) => langInfo('python', words, acc));
register(['tsc'], (words, acc, ctx) => {
  const args = words.slice(1);
  if (exactForm(words, [['--version']])) return;
  if (!args.every(w => literal(w) || w.quoted)) { formOnce(acc, 'tsc', args.map(w => w.text).join(' ')); return; }
  let noEmit = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.text;
    if (t === '--noEmit') noEmit = true;
    else if (t === '-p' || t === '--project') { const v = args[++i]; if (v) checkValue('path-r', v, acc, 'tsc', t, ctx); else formOnce(acc, 'tsc', t); } else if (t === '--pretty') { if (args[++i]?.text !== 'false') formOnce(acc, 'tsc', '--pretty'); } else { formOnce(acc, 'tsc', args.map(w => w.text).join(' ')); return; }
  }
  if (!noEmit) formOnce(acc, 'tsc', args.map(w => w.text).join(' '));
});

export const toolFor = (name: string): Tool | undefined => TOOLS.get(name);
export const toolNames = (): string[] => [...TOOLS.keys()];
