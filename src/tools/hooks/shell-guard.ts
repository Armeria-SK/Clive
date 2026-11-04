import { homedir } from 'node:os';
import { parse as parsePath } from 'node:path';
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
}

export interface CheckedPath { input: string; path?: string; placement: Placement | { kind: 'unresolved'; reason: string }; write: boolean }

export interface ShellVerdict {
  decision: Decision;
  reasons: string[];
  paths: CheckedPath[];
}

const HARD_DENY_CMDS = new Map<string, string>([
  ['mkfs', 'ファイルシステムの作成'], ['format', 'ディスクのフォーマット'], ['diskpart', 'ディスクの操作'], ['fdisk', 'ディスクの操作'],
  ['parted', 'ディスクの操作'], ['shutdown', 'OS の停止'], ['reboot', 'OS の再起動'], ['halt', 'OS の停止'], ['poweroff', 'OS の停止'],
  ['stop-computer', 'OS の停止'], ['restart-computer', 'OS の再起動'], ['bcdedit', '起動設定の変更'], ['vssadmin', 'シャドウコピーの操作'],
  ['set-executionpolicy', '実行ポリシーの変更'], ['reg', 'レジストリの操作'], ['regedit', 'レジストリの操作'], ['takeown', '所有権の変更'],
  ['passwd', 'パスワードの変更'], ['useradd', 'ユーザーの追加'], ['userdel', 'ユーザーの削除'], ['net', 'ユーザー・共有・サービスの操作'],
  ['crontab', '定期実行の登録'], ['schtasks', '定期実行の登録'], ['register-scheduledtask', '定期実行の登録'],
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

function askReason(seg: Segment): string | undefined {
  const a = seg.args.map(x => x.toLowerCase());
  const sub = a[0];
  switch (seg.cmd) {
    case 'npm': case 'pnpm': case 'yarn': case 'bun':
      if (sub && ['install', 'i', 'add', 'ci', 'uninstall', 'remove', 'rm', 'update', 'up', 'upgrade', 'publish', 'link', 'exec', 'x', 'dlx'].includes(sub)) return 'パッケージの導入・公開';
      return undefined;
    case 'npx': case 'pnpx': case 'bunx': return 'パッケージを取ってきて実行します';
    case 'pip': case 'pip3': case 'pipx': case 'uv': case 'poetry': case 'conda': case 'gem': case 'cargo': case 'go': case 'composer':
      if (a.some(x => ['install', 'add', 'uninstall', 'remove', 'publish', 'get', 'sync'].includes(x))) return 'パッケージの導入・公開';
      return undefined;
    case 'apt': case 'apt-get': case 'dnf': case 'yum': case 'pacman': case 'zypper': case 'apk': case 'brew': case 'winget': case 'choco': case 'scoop': case 'snap': case 'flatpak':
    case 'install-module': case 'install-package': case 'install-script':
      return 'システムへのパッケージの導入';
    case 'curl':
      if (a.some(x => /^(?:-d|--data.*|-f|--form.*|-t|--upload-file|--json)$/u.test(x)) || a.some((x, i) => (x === '-x' || x === '--request') && /^(?:post|put|patch|delete)$/u.test(a[i + 1] ?? ''))) return '外への送信（curl）';
      return undefined;
    case 'wget':
      if (a.some(x => x.startsWith('--post') || x === '--method')) return '外への送信（wget）';
      return undefined;
    case 'invoke-webrequest': case 'iwr': case 'invoke-restmethod': case 'irm':
      if (a.some((x, i) => (x === '-method' && /^(?:post|put|patch|delete)$/u.test(a[i + 1] ?? '')) || x === '-body' || x === '-infile')) return '外への送信（PowerShell）';
      return undefined;
    case 'scp': case 'sftp': case 'ssh': case 'rsync': case 'ftp': case 'nc': case 'ncat': case 'netcat': case 'telnet': case 'socat':
      return 'リモートへの接続・送信';
    case 'git':
      if (sub && ['push', 'send-email', 'request-pull'].includes(sub)) return 'リモートへの送信（git）';
      if (sub === 'remote' && ['add', 'set-url'].includes(a[1] ?? '')) return 'リモートの変更（git）';
      return undefined;
    case 'gh': case 'glab': return 'GitHub / GitLab の操作';
    case 'docker': case 'podman': case 'kubectl': return 'コンテナ・クラスタの操作';
    case 'systemctl': case 'service': case 'launchctl': case 'start-service': case 'stop-service': case 'set-service': return 'サービスの操作';
    default: return undefined;
  }
}

function matchesPrefix(seg: Segment, prefixes: readonly string[] | undefined): string | undefined {
  if (!prefixes?.length) return undefined;
  const normalized = [seg.cmd, ...seg.args].join(' ').toLowerCase();
  return prefixes.find(p => normalized === p.toLowerCase() || normalized.startsWith(`${p.toLowerCase()} `));
}

function pathArgs(seg: Segment, windows: boolean): Array<{ input: string; write: boolean }> {
  const out: Array<{ input: string; write: boolean }> = [];
  const writer = WRITE_CMDS.has(seg.cmd) || (seg.cmd === 'sed' && seg.args.some(a => a.startsWith('-i')));
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
  let decision: Decision = 'allow';
  const reasons: string[] = [];
  const paths: CheckedPath[] = [];
  const add = (d: Decision, reason: string) => { decision = worst(decision, d); if (!reasons.includes(reason)) reasons.push(reason); };

  if (!command.trim()) return { decision: 'deny', reasons: ['空のコマンドです'], paths };
  if (FORK_BOMB.test(command)) add('deny', 'フォーク爆弾です');
  if (splitCommand(command).some(part => ELEVATE.test(part))) add('deny', '管理者権限での実行（sudo など）はできません');
  if (/\$\(|<\(|>\(/u.test(command) || (!windows && /`/u.test(command))) add('ask', 'コマンド置換を含んでいて、実際に何が実行されるか判定できません');

  const segs = segments(command);
  if (!segs.length) add('deny', '実行するコマンドがありません');
  let cwd = initialCwd;
  let cwdKnown = true;
  let fetched = false;

  for (const seg of segs) {
    const hard = HARD_DENY_CMDS.get(seg.cmd) ?? (seg.cmd.startsWith('mkfs') ? 'ファイルシステムの作成' : undefined);
    if (hard) add('deny', `${hard}は許可されていません（${seg.cmd}）`);
    if (seg.cmd === 'dd' && seg.args.some(a => /^of=\/dev\//u.test(a))) add('deny', 'デバイスへの直接書き込みは許可されていません');
    const denied = matchesPrefix(seg, opts.deny);
    if (denied) add('deny', `設定で拒否しているコマンドです（${denied}）`);

    if (NETWORK_FETCH.has(seg.cmd)) fetched = true;
    else if (fetched && SHELL_SINKS.has(seg.cmd)) add('deny', 'ダウンロードした内容をそのまま実行しようとしています');

    for (const [cmdRe, flagRe] of INTERPRETERS) {
      if (cmdRe.test(seg.cmd) && seg.args.some(a => flagRe.test(a))) add('ask', `インタプリタに直接コードを渡していて、何をするか判定できません（${seg.cmd}）`);
    }
    const asked = matchesPrefix(seg, opts.ask) ?? askReason(seg);
    if (asked && !matchesPrefix(seg, opts.allow)) add('ask', `承認が必要な操作です: ${asked}`);

    if (CWD_CMDS.has(seg.cmd)) {
      const target = seg.args.find(a => !a.startsWith('-'));
      if (!target || target === '-') { cwdKnown = false; continue; }
      const expanded = expandPath(target, cwd);
      if ('unresolved' in expanded) { add('ask', `移動先が判定できません: ${expanded.unresolved}`); cwdKnown = false; continue; }
      const placement = placePath(expanded.path, opts.policy);
      paths.push({ input: target, path: expanded.path, placement, write: false });
      if (placement.kind === 'deny') add('deny', placement.reason);
      else if (placement.kind === 'outside') add(opts.outsideRoots, `許可フォルダの外に移動します（${expanded.path}）`);
      cwd = expanded.path;
      continue;
    }
    if (seg.cmd === 'popd') { cwdKnown = false; continue; }

    for (const { input, write } of pathArgs(seg, windows)) {
      const relative = !/^(?:[~/\\$%]|[A-Za-z]:)/u.test(input);
      if (relative && !cwdKnown) { add('ask', `移動のあとの相対パスで、場所が判定できません（${input}）`); continue; }
      const expanded = expandPath(input, cwd);
      if ('unresolved' in expanded) {
        paths.push({ input, placement: { kind: 'unresolved', reason: expanded.unresolved }, write });
        add('ask', `パスが判定できません（${input}）: ${expanded.unresolved}`);
        continue;
      }
      const placement = placePath(expanded.path, opts.policy);
      paths.push({ input, path: expanded.path, placement, write });
      if (placement.kind === 'deny') { add('deny', placement.reason); continue; }
      if (DELETE_CMDS.has(seg.cmd) && isCriticalTarget(expanded.path, opts.policy)) { add('deny', `消すと戻せない場所です（${expanded.path}）`); continue; }
      if (placement.kind === 'outside') add(opts.outsideRoots, `許可フォルダの外に触れます（${expanded.path}）`);
      else if (write && placement.mode === 'read') add('deny', `読み取り専用のフォルダに書き込もうとしています（${expanded.path}）`);
      else if (write && needsWriteApproval(expanded.path, opts.policy)) add('ask', `人格・プロフィールのファイルを書き換えます（${expanded.path}）`);
    }
  }
  return { decision, reasons, paths };
}
