import { homedir } from 'node:os';
import { basename, dirname, extname, join, parse as parsePath, resolve, sep } from 'node:path';
import { DEFAULT_LANGUAGE, type Language } from '../../config/schema.ts';
import { guardText, type GuardMessageKey } from '../../shared/messages/guard.ts';
import { entryMatches, parseAllowEntry } from './allow-entry.ts';
import { classifyStatements, type CopyUse, type MatchCtx, type PathRef, type Reason, type RepoInfo } from './allowlist.ts';
import { codeFindings } from './code-guard.ts';
import { inspectRepo } from './git-repo.ts';
import { segments, splitCommand } from './parse-cmd.ts';
import { containsDotGit, exists, expandGlob, isDirectory, listTree, protectedInside, wildcardMatches } from './path-expand.ts';
import { containsToolConfig, curlConfigFile, isToolConfigPath, wgetConfigFile, type Env } from './tool-config.ts';
import { expandPath, isInside, placePath, realish, writeApprovalKind, type Expanded, type Placement, type ProtectedKind, type ScopePolicy } from './scope.ts';
import { isPowerShell, type LexFail, type ShellKind, type Word } from './shell-lex.ts';

export type Decision = 'allow' | 'ask' | 'deny';
const RANK: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };
export const worst = (a: Decision, b: Decision): Decision => (RANK[a] >= RANK[b] ? a : b);

export interface ShellGuardOptions {
  policy: ScopePolicy;
  outsideRoots: 'ask' | 'deny';
  allow?: readonly string[];
  ask?: readonly string[];
  deny?: readonly string[];
  // OS（既定は動いている OS）。shell の既定: Windows は powershell、それ以外は bash
  windows?: boolean;
  shell?: ShellKind;
  language?: Language;
  // server.origins の host。Tailscale の URL なども Clive 自身に届くので、ループバックと同じに確かめる
  selfHosts?: readonly string[];
  // C2: 子プロセスの PATH で、名前から実際に起動されるファイル。許可フォルダ・データのフォルダの中なら、その名前の一覧はすべて今回だけ
  which?: (name: string) => string | undefined;
  dataDir?: string;
  // 子プロセスの環境変数（ツールの設定ファイルの場所に使う。既定は動いているプロセスのもの）
  env?: Env;
  // git をホーム・システムの設定の洗い出しつきで動かせるか（既定は true。shell.ts は実際の git の版から渡す）
  gitIsolated?: boolean;
}

// cwd: いま（直前の cd の先）。cwds: これまでにいられたすべてのフォルダ。known: cd の先をすべて決められたか
interface CwdTrack { cwd: string; cwds: string[]; known: boolean }

export interface CheckedPath { input: string; path?: string; placement: Placement | { kind: 'unresolved'; reason: string }; write: boolean }

export interface ShellVerdict {
  decision: Decision;
  reasons: string[];
  paths: CheckedPath[];
  // コードを動かす確かめ（種類 'code'）を含む。会話の許可を越えず、毎回確かめる
  onceOnly: boolean;
  // 確かめで中身を見せるファイルの絶対パス（3 つまで）
  scripts: string[];
  askKinds: Array<'code'>;
  // 見せたファイルのほかに、読み込まれるファイルや入れた部品のコードも動く（札に限界の文を添える）
  limits: boolean;
  // コマンドの git がすべて、設定に core.hooksPath の無い 1 つのリポジトリのもので、そのリポジトリ自身のフックの置き場所（.git/hooks）。そうでなければ null
  ownHooksDir: string | null;
}

const HARD_DENY_CMDS = new Map<string, GuardMessageKey>([
  ['mkfs', 'hard.fs_create'], ['format', 'hard.disk_format'], ['diskpart', 'hard.disk_ops'], ['fdisk', 'hard.disk_ops'],
  ['parted', 'hard.disk_ops'], ['shutdown', 'hard.os_stop'], ['reboot', 'hard.os_restart'], ['halt', 'hard.os_stop'], ['poweroff', 'hard.os_stop'],
  ['stop-computer', 'hard.os_stop'], ['restart-computer', 'hard.os_restart'], ['bcdedit', 'hard.boot'], ['vssadmin', 'hard.shadow'],
  ['set-executionpolicy', 'hard.exec_policy'], ['reg', 'hard.registry'], ['regedit', 'hard.registry'], ['takeown', 'hard.ownership'],
  ['passwd', 'hard.password'], ['useradd', 'hard.user_add'], ['userdel', 'hard.user_del'], ['net', 'hard.net'],
  ['crontab', 'hard.schedule'], ['schtasks', 'hard.schedule'], ['register-scheduledtask', 'hard.schedule'],
]);
const ELEVATE = /^\s*\(?\s*(?:sudo|doas|su|runas|pkexec)(?:\.exe)?\b/iu;
const FORK_BOMB = /:\s*\(\s*\)\s*\{/u;
const SHELL_SINKS = new Set(['sh', 'bash', 'zsh', 'pwsh', 'powershell', 'iex', 'invoke-expression', 'cmd', 'python', 'python3', 'node', 'perl', 'ruby']);
const WRITE_KEYS: Record<ProtectedKind, GuardMessageKey> = { persona: 'guard.write_persona', skill: 'guard.write_skill', git: 'guard.write_git' };
const CWD_CMDS = new Set(['cd', 'pushd', 'set-location', 'sl', 'chdir']);

function isCriticalTarget(abs: string, policy: ScopePolicy): boolean {
  const root = parsePath(abs).root;
  if (root && (abs === root || abs.replace(/[\\/]+$/u, '') === root.replace(/[\\/]+$/u, ''))) return true;
  if (isInside(abs, homedir())) return true;
  return policy.roots.some(r => isInside(abs, r.path));
}

// 持ち主が書いた tools.shell.deny / ask は、語の並びの頭が一致するかで見る（大文字小文字は問わない）
function matchesPrefix(words: readonly string[], prefixes: readonly string[] | undefined): string | undefined {
  if (!prefixes?.length) return undefined;
  const normalized = words.join(' ').toLowerCase();
  return prefixes.find(p => normalized === p.toLowerCase() || normalized.startsWith(`${p.toLowerCase()} `));
}

// 書き込み先に Windows が無視する末尾の . と空白を落とす（SOUL.md. は SOUL.md を指す）
function windowsNames(p: string): string {
  return p.split(sep).map(seg => (seg === '.' || seg === '..' ? seg : seg.replace(/[. ]+$/u, '') || seg)).join(sep);
}

// 語が指すパス。リテラルは $ や % を展開しない（シェルも展開しない）。変数を含むものは既知の変数だけ展開する
export function resolveWord(word: Word, base: string, windows: boolean, language: Language): Expanded {
  const text = word.dynamic ? word.text : word.text.replace(/[$%`]/gu, '_');
  const expanded = expandPath(text, base, process.env, language);
  if ('unresolved' in expanded) return expanded;
  return { path: windows ? windowsNames(expanded.path) : expanded.path };
}

// ワイルドカードを含む語の、絶対パスのパターン
function patternOf(word: Word, base: string, windows: boolean): string {
  const text = word.text.replace(/[$%`]/gu, '_');
  const abs = text === '~' || text.startsWith('~/') || text.startsWith('~\\') ? join(homedir(), text.slice(2)) : resolve(base, text);
  return windows ? windowsNames(abs) : abs;
}

const URLISH = /^[a-z][a-z0-9+.-]*:\/\//iu;
const NULL_SINKS = /^(?:\/dev\/null|\$null|nul)$/iu;
const PATH_START = /^(?:[~./\\]|[A-Za-z]:)/u;

// 一覧の表で引数の意味が分からないコマンド（今回だけ）でも、禁止の一覧・秘密のパスに当たる引数は止める（11.1 の 4）
function suspectPaths(words: readonly Word[]): string[] {
  const out: string[] = [];
  for (const [i, w] of words.entries()) {
    if (i === 0 || w.kind !== 'plain') continue;
    let token = w.text;
    if (token.startsWith('-')) {
      const m = /^-[A-Za-z]+:(.+)$/u.exec(token) ?? /^--?[A-Za-z][\w-]*=(.+)$/u.exec(token);
      if (!m || !PATH_START.test(m[1]!)) continue;
      token = m[1]!;
    } else {
      const eq = /^[A-Za-z_][\w-]*=(.+)$/u.exec(token);
      if (eq) { if (!PATH_START.test(eq[1]!)) continue; token = eq[1]!; }
    }
    if (!token || token === '-' || token === '{}' || URLISH.test(token) || NULL_SINKS.test(token) || /^-?\d+(?:\.\d+)?[kKmMgG]?$/u.test(token)) continue;
    if (/\s/u.test(token) && !PATH_START.test(token)) continue;
    // 名前:ストリーム の形（ADS）は、名前のところで調べる。fix:thing のような語は名前だけを見る
    const colon = token.indexOf(':');
    out.push(colon > 1 && !/^[A-Za-z]:[\\/]/u.test(token) ? token.slice(0, colon) : token);
  }
  return out;
}

const lexDetail = (language: Language, fail: LexFail): string => guardText(language, `lex.${fail.code}`, { detail: fail.detail });

export function checkShellCommand(command: string, initialCwd: string, opts: ShellGuardOptions): ShellVerdict {
  const windows = opts.windows ?? process.platform === 'win32';
  const shell: ShellKind = opts.shell ?? (windows ? 'powershell' : 'bash');
  const language = opts.language ?? DEFAULT_LANGUAGE;
  const text = (key: GuardMessageKey, params?: Record<string, string | number>) => guardText(language, key, params);
  let decision: Decision = 'allow';
  const reasons: string[] = [];
  const paths: CheckedPath[] = [];
  const scripts: string[] = [];
  const askKinds: Array<'code'> = [];
  const selfHosts = opts.selfHosts ?? [];
  const env: Env = opts.env ?? process.env;
  let limits = false;
  const add = (d: Decision, reason: string) => { decision = worst(decision, d); if (!reasons.includes(reason)) reasons.push(reason); };
  const addCode = (reason: string) => {
    add('ask', reason);
    if (!askKinds.includes('code')) askKinds.push('code');
  };
  // コマンドの git が調べたリポジトリ。持ち主が許したときに、そのリポジトリ自身のフックだけを動かせるかを決める
  const repoLog: { repos: RepoInfo[]; unsafe: boolean } = { repos: [], unsafe: false };
  const ownHooksDir = (): string | null => {
    const found = repoLog.repos.filter(r => r.found);
    if (repoLog.unsafe || found.length === 0 || found.some(r => r.unreadable || !r.configOk || r.hooksPath || !r.hooksDir)) return null;
    const dirs = new Set(found.map(r => r.hooksDir));
    return dirs.size === 1 ? [...dirs][0]! : null;
  };
  const done = (): ShellVerdict => {
    const onceOnly = askKinds.includes('code') && decision !== 'deny';
    if (onceOnly) explainWithCodeGuard();
    return { decision, reasons, paths, onceOnly: askKinds.includes('code'), scripts, askKinds, limits: limits || scripts.length > 0, ownHooksDir: ownHooksDir() };
  };

  // 今回だけにした理由を、より分かる文（ファイルのコードを動かします など）と、中身を見せるファイルで補う（判定は変えない）
  function explainWithCodeGuard(): void {
    let cwd = initialCwd;
    const segs = segments(command, { backticks: !windows });
    for (const [i, seg] of segs.entries()) {
      for (const found of codeFindings(seg, { cwd, language, selfHosts, prev: seg.stdin === 'pipe' ? segs[i - 1] : undefined })) {
        if (!reasons.includes(found.reason)) reasons.push(found.reason);
        for (const file of found.scripts) if (!scripts.includes(file) && scripts.length < 3) scripts.push(file);
      }
      if (CWD_CMDS.has(seg.cmd)) {
        const target = seg.args.find(a => !a.startsWith('-'));
        const e = target ? expandPath(target, cwd, process.env, language) : undefined;
        if (e && 'path' in e) cwd = e.path;
      }
    }
  }

  if (!command.trim()) { add('deny', text('guard.empty')); return done(); }
  if (FORK_BOMB.test(command)) add('deny', text('guard.fork_bomb'));
  if (splitCommand(command).some(part => ELEVATE.test(part))) add('deny', text('guard.elevate'));

  const cwds: string[] = [initialCwd];
  let cwd = initialCwd;
  let cwdKnown = true;
  const external: MatchCtx['external'] = opts.which ? (name: string) => {
    const found = opts.which!(name);
    if (!found) return { ok: true, ext: '.exe', detail: '' };
    const real = realish(found);
    const roots = [...opts.policy.roots.map(r => r.path), ...(opts.dataDir ? [opts.dataDir] : [])];
    const ext = extname(found).toLowerCase();
    const inside = roots.find(p => isInside(p, real) || isInside(p, found));
    if (inside) return { ok: false, ext, detail: found };
    if (windows && !['.exe', '.com'].includes(ext) && !(['.cmd', '.bat'].includes(ext) && /^(?:npm|pnpm|yarn)$/u.test(name))) return { ok: false, ext, detail: found };
    return { ok: true, ext, detail: '' };
  } : undefined;
  // 許可の一覧の判定は文の順に進む。リポジトリの設定・curl の設定ファイルは、そのとき cd でいられるすべてのフォルダ（最初と、cd で動いた先すべて）で調べる。
  // cd の先が分からなければ（変数・ワイルドカード・cd -・popd など）、調べられないので今回だけ
  const seen: CwdTrack = { cwd: initialCwd, cwds: [initialCwd], known: true };
  const followCd = (track: CwdTrack, cd: { word: Word | null }): void => {
    if (!cd.word || cd.word.dynamic || cd.word.glob) { track.known = false; return; }
    const e = resolveWord(cd.word, track.cwd, windows, language);
    if ('unresolved' in e) { track.known = false; return; }
    track.cwd = e.path;
    track.cwds.push(e.path);
  };
  const unresolvedRepo = (badKey: string): RepoInfo => { repoLog.unsafe = true; return { found: true, configOk: false, badKey, unreadable: false, hooksPath: false, hooksFiles: false, hooksDir: '', remotes: [] }; };
  const inspect = (path: string): RepoInfo => { const info = inspectRepo(path); repoLog.repos.push(info); return info; };
  const mergeRepos = (infos: readonly RepoInfo[]): RepoInfo => infos.find(i => i.unreadable) ?? infos.find(i => !i.configOk) ?? {
    found: infos.some(i => i.found), configOk: true, badKey: '', unreadable: false, hooksPath: infos.some(i => i.hooksPath), hooksFiles: infos.some(i => i.hooksFiles), hooksDir: infos.find(i => i.found)?.hooksDir ?? '',
    // 宛先の名前は、見つかったすべてのリポジトリにあるものだけ（どれか 1 つでも無ければ、そこでは git がフォルダとして扱う）
    remotes: infos.filter(i => i.found).reduce<readonly string[] | null>((common, i) => (common === null ? i.remotes : common.filter(n => i.remotes.includes(n))), null) ?? [],
  };
  const repoFor = (dashC: string | undefined): RepoInfo => {
    if (!seen.known) return unresolvedRepo('cwd');
    if (dashC === undefined) return mergeRepos([...new Set(seen.cwds)].map(inspect));
    const targets = new Set<string>();
    for (const base of seen.cwds) {
      const target = resolveWord({ text: dashC, dynamic: false, glob: false, quoted: false, home: dashC === '~' || dashC.startsWith('~/'), kind: 'plain' }, base, windows, language);
      if (!('path' in target)) return unresolvedRepo('-C');
      targets.add(target.path);
    }
    return mergeRepos([...targets].map(inspect));
  };
  const toolConfig: MatchCtx['toolConfig'] = tool => {
    if (!seen.known) return { unknownCwd: true };
    const file = tool === 'curl' ? seen.cwds.map(c => curlConfigFile(env, c)).find(Boolean) : wgetConfigFile(env);
    return file ? { file } : undefined;
  };
  const afterStatement: MatchCtx['afterStatement'] = result => { if (result.cwd) followCd(seen, result.cwd); };
  const ctx: MatchCtx = { shell, windows, repo: repoFor, external, selfHosts, gitIsolated: opts.gitIsolated ?? true, toolConfig, afterStatement };
  const classified = classifyStatements(command, ctx);
  if (classified.lex) {
    add('deny', text('lex.denied', { detail: lexDetail(language, classified.lex) }));
    return done();
  }
  if (!classified.statements.length) add('deny', text('guard.no_command'));

  const reasonText = (r: Reason): string => (r.key.startsWith('ask.') ? text('guard.needs_approval', { reason: text(r.key) }) : text(r.key, r.params));
  const allowEntries = (opts.allow ?? []).map(parseAllowEntry).filter((e): e is string[] => e !== null);
  let fetched = false;

  // 1 つの絶対パスを、書く・読む・消すものとして調べる
  const evalAbs = (abs: string, input: string, write: boolean, deletes: boolean, primary: boolean): void => {
    const placement = placePath(abs, opts.policy);
    if (primary) paths.push({ input, path: abs, placement, write });
    if (placement.kind === 'deny') { add('deny', placement.reason); return; }
    if (deletes && isCriticalTarget(abs, opts.policy)) { add('deny', text('guard.irreversible', { path: abs })); return; }
    // ツールの設定ファイルは、許可フォルダの外（ホームが許可フォルダの外なのが既定）でも、ふつうの確かめではなく今回だけ。外の確かめで戻る前に調べる
    if (write && isToolConfigPath(abs, env)) addCode(text('list.tool_config', { path: abs }));
    if (placement.kind === 'outside') { add(opts.outsideRoots, text('guard.touches_outside', { path: abs })); return; }
    if (write && placement.mode === 'read') { add('deny', text('guard.write_readonly', { path: abs })); return; }
    if (!write) return;
    const kind = writeApprovalKind(abs, opts.policy);
    if (kind) addCode(text(WRITE_KEYS[kind], { path: abs }));
  };
  // フォルダごと書く・消すとき、その中に守る場所（人格・スキル・.git）まで届くなら今回だけ
  const rangeCheck = (dir: string): void => {
    if (protectedInside(dir, opts.policy) || containsToolConfig(dir, env)) addCode(text('list.write_ancestor', { path: dir }));
  };
  const dotfiles = isPowerShell(shell);

  const checkPath = (ref: PathRef, deletes: boolean): void => {
    const write = ref.mode === 'write';
    const input = ref.word.text;
    const relative = !ref.word.dynamic && !ref.word.home && !/^(?:[~/\\$%]|[A-Za-z]:)/u.test(input);
    if (relative && !cwdKnown) {
      if (write) addCode(text('list.cwd_unknown', { input })); else add('ask', text('list.cwd_unknown', { input }));
      return;
    }
    for (const base of relative ? cwds : [cwd]) {
      const primary = base === cwd;
      const expanded = resolveWord(ref.word, base, windows, language);
      if ('unresolved' in expanded) {
        if (primary) paths.push({ input, placement: { kind: 'unresolved', reason: expanded.unresolved }, write });
        if (write) addCode(text('list.write_dynamic', { input }));
        else if (ref.strict) addCode(text('list.read_dynamic', { input }));
        else add('ask', text('list.read_dynamic', { input }));
        continue;
      }
      const globbing = ref.word.glob && !ref.word.dynamic;
      // ワイルドカードの手前のフォルダは、書く・消す対象ではない（当たるものだけが対象）。外・禁止のパスかどうかだけ見る
      evalAbs(expanded.path, input, globbing ? false : write, globbing ? false : deletes, primary);
      if (globbing) {
        // ワイルドカード: 今あるもののうち当たるものを全部調べる。列挙しきれないときは、手前のフォルダを調べて確かめる
        const globbed = expandGlob(patternOf(ref.word, base, windows), dotfiles);
        if (globbed.complete) {
          for (const match of globbed.matches) {
            evalAbs(match, match, write, deletes, false);
            if (write && (ref.recursive || deletes) && isDirectory(match)) rangeCheck(match);
          }
        } else if (write) rangeCheck(globbed.prefix);
        else add('ask', text('list.wild_many', { input }));
      } else if (write && ref.recursive && isDirectory(expanded.path)) rangeCheck(expanded.path);
      if (ref.list) listCheck(ref, base, expanded.path, globbing);
    }
  };

  // パイプで次のコマンドに流れるファイル（Get-ChildItem の出力など）は、次のコマンドが読む。フォルダなら中のファイルを、読むものとして調べる
  const listCheck = (ref: PathRef, base: string, root: string, globbing: boolean): void => {
    const list = ref.list!;
    const heads = globbing ? expandGlob(patternOf(ref.word, base, windows), dotfiles) : { matches: [root], complete: true };
    let complete = heads.complete;
    const wanted = (name: string): boolean => (list.filter.length === 0 || list.filter.some(p => wildcardMatches(name, p)))
      && (list.include.length === 0 || list.include.some(p => wildcardMatches(name, p))) && !list.exclude.some(p => wildcardMatches(name, p));
    for (const head of heads.matches) {
      if (list.items || !isDirectory(head)) { evalAbs(head, head, false, false, false); continue; }
      const tree = listTree(head, list.deep);
      complete = complete && tree.complete;
      for (const entry of tree.entries) if (wanted(basename(entry)) || isDirectory(entry)) evalAbs(entry, entry, false, false, false);
    }
    if (!complete) add('ask', text('list.wild_many', { input: ref.word.text }));
  };

  // cp・mv・Copy-Item・Move-Item・Rename-Item・New-Item: 実際に書かれるパスを組み立てて調べる
  const checkCopy = (use: CopyUse): void => {
    for (const base of cwds) {
      const unresolvedWord = (w: Word | null): boolean => w !== null && 'unresolved' in resolveWord(w, base, windows, language);
      const dyn = (w: Word | null): void => { if (w) addCode(text('list.write_dynamic', { input: w.text })); };
      if (use.kind === 'join') {
        if (!use.name || use.name.dynamic || unresolvedWord(use.dest)) { dyn(use.name?.dynamic ? use.name : use.dest ?? use.name); continue; }
        const dir = use.dest ? (resolveWord(use.dest, base, windows, language) as { path: string }).path : base;
        evalAbs(windows ? windowsNames(resolve(dir, use.name.text)) : resolve(dir, use.name.text), use.name.text, true, false, false);
        continue;
      }
      if (use.kind === 'rename') {
        if (!use.name || use.name.dynamic) { dyn(use.name); continue; }
        for (const source of use.sources) {
          const r = resolveWord(source, base, windows, language);
          if ('unresolved' in r) { dyn(source); continue; }
          evalAbs(windows ? windowsNames(resolve(dirname(r.path), use.name.text)) : resolve(dirname(r.path), use.name.text), use.name.text, true, false, false);
        }
        continue;
      }
      // copy
      if (use.dest !== null && unresolvedWord(use.dest)) { dyn(use.dest); continue; }
      // -Destination を付けない Copy-Item・Move-Item は、作業フォルダに入れる（同じ名前なら上書きする。本物の PowerShell 5.1 で確かめた）
      const dest = use.dest === null ? base : (resolveWord(use.dest, base, windows, language) as { path: string }).path;
      const destIsDir = use.dest === null || (!use.noTargetDir && (use.dirFlag || use.sources.length > 1 || /[\\/]$/u.test(use.dest.text) || isDirectory(dest)));
      let unknownNames = false;
      const names: string[] = [];
      for (const source of use.sources) {
        const r = resolveWord(source, base, windows, language);
        if ('unresolved' in r || source.dynamic) { unknownNames = true; continue; }
        if (/(?:^|[\\/])\.\.?$/u.test(source.text) || source.text === '~') {
          unknownNames = true;
          if (use.recursive && containsDotGit(r.path)) addCode(text('list.write_ancestor', { path: r.path }));
          continue;
        }
        if (source.glob) {
          const globbed = expandGlob(patternOf(source, base, windows), dotfiles);
          if (!globbed.complete) { unknownNames = true; continue; }
          names.push(...globbed.matches.map(m => basename(m)));
          if (use.recursive) for (const m of globbed.matches) if (isDirectory(m) && containsDotGit(m)) addCode(text('list.write_ancestor', { path: m }));
          continue;
        }
        names.push(basename(r.path));
        if (use.recursive && isDirectory(r.path) && containsDotGit(r.path)) addCode(text('list.write_ancestor', { path: r.path }));
      }
      if (destIsDir) {
        for (const name of names) {
          const target = join(dest, name);
          evalAbs(target, target, true, false, false);
        }
        if (unknownNames || (use.recursive && names.length === 0)) rangeCheck(dest);
      } else {
        evalAbs(dest, dest, true, false, false);
        if (use.recursive && isDirectory(dest)) rangeCheck(dest);
      }
    }
  };

  // curl -O・wget の既定の名前: URL の最後の名前で、作業場所（または指定のフォルダ）に書く
  const checkRemoteName = (url: Word, dir: Word | null): void => {
    if (url.dynamic) return;
    let name = '';
    try { name = decodeURIComponent(new URL(url.text).pathname.split('/').filter(Boolean).pop() ?? ''); } catch { /* URL でなければ別の理由で止まっている */ }
    name ||= 'index.html';
    for (const base of cwds) {
      const d = dir ? resolveWord(dir, base, windows, language) : { path: base };
      if ('unresolved' in d) { addCode(text('list.write_dynamic', { input: dir?.text ?? '' })); continue; }
      const target = windows ? windowsNames(resolve(d.path, name)) : resolve(d.path, name);
      evalAbs(target, name, true, false, false);
    }
  };

  for (const [index, st] of classified.statements.entries()) {
    const result = classified.results[index]!;
    const words = st.words.map(w => w.text);
    const first = st.words[0];
    const name = first && !first.dynamic ? (first.text.split(/[\\/]/u).pop() ?? '').toLowerCase().replace(/\.exe$/u, '') : '';
    const hard = name ? HARD_DENY_CMDS.get(name) ?? (name.startsWith('mkfs') ? 'hard.fs_create' : undefined) : undefined;
    if (hard) add('deny', text('guard.hard_denied', { label: text(hard), cmd: name }));
    if (name === 'dd' && words.some(a => /^of=\/dev\//u.test(a))) add('deny', text('guard.device_write'));
    const denied = matchesPrefix(words, opts.deny);
    if (denied) add('deny', text('guard.config_denied', { prefix: denied }));
    if (result.fetch) fetched = true;
    else if (fetched && name && SHELL_SINKS.has(name)) add('deny', text('guard.download_exec'));

    const allowedByConfig = allowEntries.some(entry => entryMatches(entry, st.words, windows));
    for (const reason of result.reasons) {
      if (hard || denied) break;
      if (reason.exempt && allowedByConfig) continue;
      if (reason.key === 'list.install' || reason.key === 'list.expand') limits = limits || reason.key === 'list.install';
      if (reason.level === 'deny') add('deny', reasonText(reason));
      else if (reason.level === 'once') addCode(reasonText(reason));
      else add('ask', reasonText(reason));
    }
    const asked = matchesPrefix(words, opts.ask);
    if (asked && !allowedByConfig) add('ask', text('guard.needs_approval', { reason: asked }));

    for (const ref of result.paths) checkPath(ref, result.deletes);
    for (const use of result.copies) checkCopy(use);
    for (const remote of result.remoteNames) checkRemoteName(remote.url, remote.dir);
    if (result.level === 'once' || result.level === 'deny') {
      for (const token of suspectPaths(st.words)) {
        const resolved = resolveWord({ text: token, dynamic: st.words.some(w => w.text === token && w.dynamic), glob: false, quoted: false, home: token === '~' || token.startsWith('~/'), kind: 'plain' }, cwd, windows, language);
        if ('unresolved' in resolved) continue;
        const placement = placePath(resolved.path, opts.policy);
        if (placement.kind === 'deny') add('deny', placement.reason);
      }
    }

    if (result.cwd) {
      const track: CwdTrack = { cwd, cwds, known: cwdKnown };
      followCd(track, result.cwd);
      cwd = track.cwd;
      cwdKnown = track.known;
    }
  }
  return done();
}
