import { homedir } from 'node:os';
import { parse as parsePath } from 'node:path';
import { DEFAULT_LANGUAGE, type Language } from '../../config/schema.ts';
import { guardText, type GuardMessageKey } from '../../shared/messages/guard.ts';
import { codeFindings, readOnlyInvocation } from './code-guard.ts';
import { segments, splitCommand, type Segment } from './parse-cmd.ts';
import { expandPath, isInside, needsWriteApproval, placePath, type Placement, type ScopePolicy } from './scope.ts';

export type Decision = 'allow' | 'ask' | 'deny';
const RANK: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };
export const worst = (a: Decision, b: Decision): Decision => (RANK[a] >= RANK[b] ? a : b);

export interface ShellGuardOptions {
  policy: ScopePolicy;
  outsideRoots: 'ask' | 'deny';
  allow?: readonly string[];
  ask?: readonly string[];
  deny?: readonly string[];
  windows?: boolean;
  language?: Language;
  // server.origins の host。Tailscale の URL なども Clive 自身に届くので、ループバックと同じに確かめる
  selfHosts?: readonly string[];
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

const DELETE_CMDS = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'ri', 'shred', 'unlink', 'trash']);
const WRITE_CMDS = new Set([
  ...DELETE_CMDS, 'mv', 'move', 'move-item', 'mi', 'cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'robocopy', 'mkdir', 'md', 'new-item', 'ni',
  'touch', 'tee', 'tee-object', 'set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content', 'clc', 'rename-item', 'ren', 'rename',
  'ln', 'chmod', 'chown', 'chgrp', 'truncate', 'dd', 'unzip', 'expand-archive', 'compress-archive', 'patch',
  // git・tar などは引数だけでは読み書きを判別できないので入れない（読み取り専用のフォルダでの git 操作は見逃しうる）
]);
const CWD_CMDS = new Set(['cd', 'pushd', 'set-location', 'sl', 'chdir']);
const INTERPRETERS: Array<[RegExp, RegExp]> = [
  [/^(?:node|nodejs|bun|deno)$/u, /^(?:-e|--eval|-p|--print|eval)$/u],
  [/^(?:python|python3|py|pypy)(?:\d(?:\.\d+)?)?$/u, /^-c$/u],
  [/^(?:perl|ruby)$/u, /^-[eE]$/u],
  [/^php$/u, /^-r$/u],
  [/^(?:pwsh|powershell)$/u, /^-(?:e|ec|enc|encodedcommand)$/iu],
];
const NETWORK_FETCH = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm']);
const SHELL_SINKS = new Set(['sh', 'bash', 'zsh', 'pwsh', 'powershell', 'iex', 'invoke-expression', 'cmd', 'python', 'python3', 'node', 'perl', 'ruby']);
const NULL_SINKS = /^(?:\/dev\/null|\$null|nul|NUL)$/u;
const URLISH = /^[a-z][a-z0-9+.-]*:\/\//iu;

const SEND_METHOD = /^(?:post|put|patch|delete)$/iu;
// curl の値を取る短いフラグ（-sSXPUT のようにくっつけた形でも、値の手前までを読む）
const CURL_VALUE_SHORT = new Set('AbcCdDeEFHKmoPQrtTuUwxXyYz');

function curlSends(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const [name = '', value] = arg.split(/=(.*)/su);
      if (/^--(?:data(?:-[a-z]+)?|form(?:-string)?|upload-file|json)$/u.test(name)) return true;
      if (name === '--request' && SEND_METHOD.test(value ?? args[i + 1] ?? '')) return true;
      continue;
    }
    if (!/^-[A-Za-z]/u.test(arg)) continue;
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j]!;
      if (!CURL_VALUE_SHORT.has(flag)) continue;
      if (flag === 'd' || flag === 'F' || flag === 'T') return true;
      if (flag === 'X' && SEND_METHOD.test(arg.slice(j + 1) || args[i + 1] || '')) return true;
      break;
    }
  }
  return false;
}

// PowerShell の引数は、他と重ならない先頭の何文字かに省いて書ける（-Meth、-Bo）。-Name:値 の書き方もある
function psParam(arg: string, name: string, min: number): { value?: string } | undefined {
  const m = /^-([a-z]+)(?::(.*))?$/u.exec(arg.toLowerCase());
  if (!m || m[1]!.length < min || !name.startsWith(m[1]!)) return undefined;
  return m[2] === undefined ? {} : { value: m[2] };
}

function powershellSends(args: readonly string[]): boolean {
  return args.some((arg, i) => {
    const method = psParam(arg, 'method', 2);
    if (method) return SEND_METHOD.test(method.value ?? args[i + 1] ?? '');
    return Boolean(psParam(arg, 'body', 1) ?? psParam(arg, 'infile', 2));
  });
}

function askReason(seg: Segment): GuardMessageKey | undefined {
  const a = seg.args.map(x => x.toLowerCase());
  const sub = a[0];
  switch (seg.cmd) {
    case 'npm': case 'pnpm': case 'yarn': case 'bun':
      if (sub && ['install', 'i', 'add', 'ci', 'uninstall', 'remove', 'rm', 'update', 'up', 'upgrade', 'publish', 'link', 'exec', 'x', 'dlx'].includes(sub)) return 'ask.package';
      return undefined;
    case 'npx': case 'pnpx': case 'bunx': return 'ask.npx';
    case 'pip': case 'pip3': case 'pipx': case 'uv': case 'poetry': case 'conda': case 'gem': case 'cargo': case 'go': case 'composer':
      if (a.some(x => ['install', 'add', 'uninstall', 'remove', 'publish', 'get', 'sync'].includes(x))) return 'ask.package';
      return undefined;
    case 'apt': case 'apt-get': case 'dnf': case 'yum': case 'pacman': case 'zypper': case 'apk': case 'brew': case 'winget': case 'choco': case 'scoop': case 'snap': case 'flatpak':
    case 'install-module': case 'install-package': case 'install-script':
      return 'ask.system_package';
    case 'curl':
      return curlSends(seg.args) ? 'ask.curl' : undefined;
    case 'wget':
      if (a.some(x => x.startsWith('--post') || x === '--method')) return 'ask.wget';
      return undefined;
    case 'invoke-webrequest': case 'iwr': case 'invoke-restmethod': case 'irm':
      return powershellSends(a) ? 'ask.powershell' : undefined;
    case 'scp': case 'sftp': case 'ssh': case 'rsync': case 'ftp': case 'nc': case 'ncat': case 'netcat': case 'telnet': case 'socat':
      return 'ask.remote';
    case 'git':
      if (sub && ['push', 'send-email', 'request-pull'].includes(sub)) return 'ask.git_push';
      if (sub === 'remote' && ['add', 'set-url'].includes(a[1] ?? '')) return 'ask.git_remote';
      return undefined;
    case 'gh': case 'glab': return 'ask.gh';
    case 'docker': case 'podman': case 'kubectl': return 'ask.container';
    case 'systemctl': case 'service': case 'launchctl': case 'start-service': case 'stop-service': case 'set-service': return 'ask.service';
    default: return undefined;
  }
}

function matchesPrefix(seg: Segment, prefixes: readonly string[] | undefined): string | undefined {
  if (!prefixes?.length) return undefined;
  const normalized = [seg.cmd, ...seg.args].join(' ').toLowerCase();
  return prefixes.find(p => normalized === p.toLowerCase() || normalized.startsWith(`${p.toLowerCase()} `));
}

// 出力先を指すフラグ（curl -o、wget -O、iwr -OutFile）。値がくっついた形も読む
const OUTPUT_FLAGS: Record<string, { exact: RegExp; attached: RegExp }> = {
  curl: { exact: /^(?:-[A-Za-z]*o|--output|--output-dir)$/u, attached: /^(?:--output=|--output-dir=|-o)(.+)$/u },
  wget: { exact: /^(?:-O|-o|-a|-P|--output-document|--output-file|--append-output|--directory-prefix)$/u, attached: /^(?:--output-document=|--output-file=|--append-output=|--directory-prefix=|-O|-o|-a|-P)(.+)$/u },
};
const PS_OUTFILE = { exact: /^-outf(?:i|il|ile)?$/iu, attached: /^-outf(?:i|il|ile)?:(.+)$/iu };
for (const cmd of ['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm']) OUTPUT_FLAGS[cmd] = PS_OUTFILE;

function urlFileName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
  } catch { return ''; }
}

// -O（curl）や -O なしの wget は、URL の最後の名前で作業場所に書く
function remoteNameWrites(seg: Segment): string[] {
  const urls = seg.args.filter(a => URLISH.test(a));
  const valueOf = (exact: RegExp, attached: RegExp): string => {
    for (const [i, a] of seg.args.entries()) {
      const m = attached.exec(a);
      if (m) return m[1]!;
      if (exact.test(a)) return seg.args[i + 1] ?? '';
    }
    return '';
  };
  const under = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
  if (seg.cmd === 'curl') {
    if (!seg.args.some(a => /^--remote-name(?:-all)?$/u.test(a) || /^-[A-Za-z]*O[A-Za-z]*$/u.test(a))) return [];
    const dir = valueOf(/^--output-dir$/u, /^--output-dir=(.+)$/u);
    return urls.flatMap(u => urlFileName(u) || []).map(name => under(dir, name));
  }
  if (seg.cmd === 'wget') {
    if (seg.args.some(a => /^(?:-O|--output-document)/u.test(a))) return [];
    const dir = valueOf(/^(?:-P|--directory-prefix)$/u, /^(?:--directory-prefix=|-P)(.+)$/u);
    return urls.map(u => under(dir, urlFileName(u) || 'index.html'));
  }
  return [];
}

function pathArgs(seg: Segment, windows: boolean): Array<{ input: string; write: boolean }> {
  const out: Array<{ input: string; write: boolean }> = [];
  const writer = WRITE_CMDS.has(seg.cmd) || (seg.cmd === 'sed' && seg.args.some(a => a.startsWith('-i')));
  const outputFlag = OUTPUT_FLAGS[seg.cmd];
  out.push(...remoteNameWrites(seg).map(input => ({ input, write: true })));
  for (let i = 0; i < seg.args.length; i++) {
    let token = seg.args[i]!;
    const raw = seg.rawArgs[i] ?? token;
    // リダイレクト（> file、>> file、2> file、>file）
    const redirect = /^(?:\d?>>?|&>>?|>\|)(.*)$/u.exec(raw);
    if (redirect) {
      const target = redirect[1] || seg.args[++i];
      if (target && !target.startsWith('&') && !NULL_SINKS.test(target)) out.push({ input: target, write: true });
      continue;
    }
    if (/^<\s*/u.test(raw)) { const target = raw.slice(1) || seg.args[++i]; if (target) out.push({ input: target, write: false }); continue; }
    if (outputFlag) {
      const attached = outputFlag.attached.exec(token);
      if (attached) { out.push({ input: attached[1]!, write: true }); continue; }
      if (outputFlag.exact.test(token)) {
        const target = seg.args[++i];
        if (target && target !== '-' && !NULL_SINKS.test(target)) out.push({ input: target, write: true });
        continue;
      }
    }
    if (seg.cmd === 'dd' && /^of=./u.test(token)) { out.push({ input: token.slice(3), write: true }); continue; }
    if (token.startsWith('-')) {
      // -Path:C:\x のような PowerShell の書き方
      const colon = /^-[A-Za-z]+:(.+)$/u.exec(token);
      if (colon) out.push({ input: colon[1]!, write: writer });
      continue;
    }
    if (windows && /^\/[a-z?]{1,3}$/iu.test(token)) continue; // del /s /q などのフラグ
    if (URLISH.test(token) || NULL_SINKS.test(token)) continue;
    if (/^[\w.-]+@[\w.-]+:/u.test(token)) continue; // user@host:path（scp・git のリモート）
    const eq = /^[A-Za-z_][\w-]*=(.+)$/u.exec(token);
    if (eq) {
      if (/^(?:[~./\\]|[A-Za-z]:)/u.test(eq[1]!)) token = eq[1]!;
      else continue; // key=value の値がパスでなければ見ない
    }
    if (token === '' || token === '{}' || token === ';' || token === '+') continue;
    if (/^-?\d+(?:\.\d+)?[kKmMgG]?$/u.test(token)) continue; // 数値（-TotalCount 3、head -n 20 など）はパスとして見ない
    out.push({ input: token, write: writer });
  }
  return out;
}

function isCriticalTarget(abs: string, policy: ScopePolicy): boolean {
  const root = parsePath(abs).root;
  if (root && (abs === root || abs.replace(/[\\/]+$/u, '') === root.replace(/[\\/]+$/u, ''))) return true;
  if (isInside(abs, homedir())) return true;
  return policy.roots.some(r => isInside(abs, r.path));
}

export function checkShellCommand(command: string, initialCwd: string, opts: ShellGuardOptions): ShellVerdict {
  const windows = opts.windows ?? process.platform === 'win32';
  const language = opts.language ?? DEFAULT_LANGUAGE;
  const text = (key: GuardMessageKey, params?: Record<string, string | number>) => guardText(language, key, params);
  let decision: Decision = 'allow';
  const reasons: string[] = [];
  const paths: CheckedPath[] = [];
  const scripts: string[] = [];
  const askKinds: Array<'code'> = [];
  const selfHosts = opts.selfHosts ?? [];
  const add = (d: Decision, reason: string) => { decision = worst(decision, d); if (!reasons.includes(reason)) reasons.push(reason); };
  const addCode = (reason: string, files: readonly string[] = []) => {
    add('ask', reason);
    if (!askKinds.includes('code')) askKinds.push('code');
    for (const file of files) if (!scripts.includes(file) && scripts.length < 3) scripts.push(file);
  };
  const done = (): ShellVerdict => ({ decision, reasons, paths, onceOnly: askKinds.includes('code'), scripts, askKinds });

  if (!command.trim()) { add('deny', text('guard.empty')); return done(); }
  if (FORK_BOMB.test(command)) add('deny', text('guard.fork_bomb'));
  if (splitCommand(command).some(part => ELEVATE.test(part))) add('deny', text('guard.elevate'));
  if (/\$\(|<\(|>\(/u.test(command) || (!windows && /`/u.test(command))) add('ask', text('guard.substitution'));

  const segs = segments(command, { backticks: !windows });
  if (!segs.length) add('deny', text('guard.no_command'));
  let cwd = initialCwd;
  let cwdKnown = true;
  let fetched = false;

  for (const [segIndex, seg] of segs.entries()) {
    const hard = HARD_DENY_CMDS.get(seg.cmd) ?? (seg.cmd.startsWith('mkfs') ? 'hard.fs_create' : undefined);
    if (hard) add('deny', text('guard.hard_denied', { label: text(hard), cmd: seg.cmd }));
    if (seg.cmd === 'dd' && seg.args.some(a => /^of=\/dev\//u.test(a))) add('deny', text('guard.device_write'));
    const denied = matchesPrefix(seg, opts.deny);
    if (denied) add('deny', text('guard.config_denied', { prefix: denied }));

    if (NETWORK_FETCH.has(seg.cmd)) fetched = true;
    else if (fetched && SHELL_SINKS.has(seg.cmd)) add('deny', text('guard.download_exec'));

    for (const [cmdRe, flagRe] of INTERPRETERS) {
      // その場のコードが別のファイルを読み込むこともあるので、このコードも毎回確かめる
      if (cmdRe.test(seg.cmd) && seg.args.some(a => flagRe.test(a))) addCode(text('guard.interpreter', { cmd: seg.cmd }));
    }
    const allowedByConfig = Boolean(matchesPrefix(seg, opts.allow));
    for (const found of codeFindings(seg, { cwd, language, selfHosts, prev: seg.stdin === 'pipe' ? segs[segIndex - 1] : undefined })) {
      if (found.exemptable && allowedByConfig) continue;
      addCode(found.reason, found.scripts);
    }
    const askedKey = askReason(seg);
    const asked = matchesPrefix(seg, opts.ask) ?? (askedKey ? text(askedKey) : undefined);
    if (asked && !allowedByConfig) add('ask', text('guard.needs_approval', { reason: asked }));

    if (CWD_CMDS.has(seg.cmd)) {
      const target = seg.args.find(a => !a.startsWith('-'));
      if (!target || target === '-') { cwdKnown = false; continue; }
      const expanded = expandPath(target, cwd, process.env, language);
      if ('unresolved' in expanded) { add('ask', text('guard.cd_unresolved', { detail: expanded.unresolved })); cwdKnown = false; continue; }
      const placement = placePath(expanded.path, opts.policy);
      paths.push({ input: target, path: expanded.path, placement, write: false });
      if (placement.kind === 'deny') add('deny', placement.reason);
      else if (placement.kind === 'outside') add(opts.outsideRoots, text('guard.cd_outside', { path: expanded.path }));
      cwd = expanded.path;
      continue;
    }
    if (seg.cmd === 'popd') { cwdKnown = false; continue; }

    for (const { input, write } of pathArgs(seg, windows)) {
      const relative = !/^(?:[~/\\$%]|[A-Za-z]:)/u.test(input);
      if (relative && !cwdKnown) { add('ask', text('guard.relative_unknown', { input })); continue; }
      const expanded = expandPath(input, cwd, process.env, language);
      if ('unresolved' in expanded) {
        paths.push({ input, placement: { kind: 'unresolved', reason: expanded.unresolved }, write });
        add('ask', text('guard.path_unresolved', { input, detail: expanded.unresolved }));
        continue;
      }
      const placement = placePath(expanded.path, opts.policy);
      paths.push({ input, path: expanded.path, placement, write });
      if (placement.kind === 'deny') { add('deny', placement.reason); continue; }
      if (DELETE_CMDS.has(seg.cmd) && isCriticalTarget(expanded.path, opts.policy)) { add('deny', text('guard.irreversible', { path: expanded.path })); continue; }
      if (placement.kind === 'outside') add(opts.outsideRoots, text('guard.touches_outside', { path: expanded.path }));
      else if (write && placement.mode === 'read') add('deny', text('guard.write_readonly', { path: expanded.path }));
      else if (write && needsWriteApproval(expanded.path, opts.policy)) add('ask', text('guard.write_persona', { path: expanded.path }));
      else if (!write && !readOnlyInvocation(seg) && needsWriteApproval(expanded.path, opts.policy)) add('ask', text('guard.touch_persona', { path: expanded.path }));
    }
  }
  return done();
}
