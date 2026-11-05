import { homedir } from 'node:os';
import { extname, parse as parsePath, sep } from 'node:path';
import { DEFAULT_LANGUAGE, type Language } from '../../config/schema.ts';
import { guardText, type GuardMessageKey } from '../../shared/messages/guard.ts';
import { entryMatches, parseAllowEntry } from './allow-entry.ts';
import { classifyStatements, type MatchCtx, type PathRef, type Reason, type RepoInfo } from './allowlist.ts';
import { codeFindings } from './code-guard.ts';
import { inspectRepo } from './git-repo.ts';
import { segments, splitCommand } from './parse-cmd.ts';
import { expandPath, isInside, placePath, realish, writeApprovalKind, type Expanded, type Placement, type ProtectedKind, type ScopePolicy } from './scope.ts';
import type { LexFail, ShellKind, Word } from './shell-lex.ts';

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
}

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
  let limits = false;
  const add = (d: Decision, reason: string) => { decision = worst(decision, d); if (!reasons.includes(reason)) reasons.push(reason); };
  const addCode = (reason: string) => {
    add('ask', reason);
    if (!askKinds.includes('code')) askKinds.push('code');
  };
  const done = (): ShellVerdict => {
    const onceOnly = askKinds.includes('code') && decision !== 'deny';
    if (onceOnly) explainWithCodeGuard();
    return { decision, reasons, paths, onceOnly: askKinds.includes('code'), scripts, askKinds, limits: limits || scripts.length > 0 };
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
  const repoFor = (dashC: string | undefined): RepoInfo => {
    if (!cwdKnown) return { found: true, configOk: false, badKey: 'cwd', unreadable: false, hooksPath: false, hooksFiles: false };
    if (dashC === undefined) return inspectRepo(cwd);
    const target = resolveWord({ text: dashC, dynamic: false, glob: false, quoted: false, home: dashC === '~' || dashC.startsWith('~/'), kind: 'plain' }, cwd, windows, language);
    return 'path' in target ? inspectRepo(target.path) : { found: true, configOk: false, badKey: '-C', unreadable: false, hooksPath: false, hooksFiles: false };
  };
  const ctx: MatchCtx = { shell, windows, repo: repoFor, external, selfHosts };
  const classified = classifyStatements(command, ctx);
  if (classified.lex) {
    add('deny', text('lex.denied', { detail: lexDetail(language, classified.lex) }));
    return done();
  }
  if (!classified.statements.length) add('deny', text('guard.no_command'));

  const reasonText = (r: Reason): string => (r.key.startsWith('ask.') ? text('guard.needs_approval', { reason: text(r.key) }) : text(r.key, r.params));
  const allowEntries = (opts.allow ?? []).map(parseAllowEntry).filter((e): e is string[] => e !== null);
  let fetched = false;

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
        if (write) addCode(text('list.write_dynamic', { input })); else add('ask', text('list.read_dynamic', { input }));
        continue;
      }
      const placement = placePath(expanded.path, opts.policy);
      if (primary) paths.push({ input, path: expanded.path, placement, write });
      if (placement.kind === 'deny') { add('deny', placement.reason); continue; }
      if (deletes && isCriticalTarget(expanded.path, opts.policy)) { add('deny', text('guard.irreversible', { path: expanded.path })); continue; }
      if (placement.kind === 'outside') { add(opts.outsideRoots, text('guard.touches_outside', { path: expanded.path })); continue; }
      if (write && placement.mode === 'read') { add('deny', text('guard.write_readonly', { path: expanded.path })); continue; }
      if (!write) continue;
      const kind = writeApprovalKind(expanded.path, opts.policy);
      if (kind) addCode(text(WRITE_KEYS[kind], { path: expanded.path }));
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
    if (result.level === 'once' || result.level === 'deny') {
      for (const token of suspectPaths(st.words)) {
        const resolved = resolveWord({ text: token, dynamic: st.words.some(w => w.text === token && w.dynamic), glob: false, quoted: false, home: token === '~' || token.startsWith('~/'), kind: 'plain' }, cwd, windows, language);
        if ('unresolved' in resolved) continue;
        const placement = placePath(resolved.path, opts.policy);
        if (placement.kind === 'deny') add('deny', placement.reason);
      }
    }

    if (result.cwd) {
      if (!result.cwd.word) cwdKnown = false;
      else {
        const e = resolveWord(result.cwd.word, cwd, windows, language);
        if ('unresolved' in e) cwdKnown = false;
        else { cwd = e.path; cwds.push(e.path); }
      }
    }
  }
  return done();
}
