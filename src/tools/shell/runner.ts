import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, statSync, type WriteStream } from 'node:fs';
import { delimiter, join } from 'node:path';
import { isSensitiveName } from '../../shared/redaction.ts';

const WINDOWS = process.platform === 'win32';

const BASE_ENV = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'SystemDrive', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'PSModulePath', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
  'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'XDG_RUNTIME_DIR',
];

export function scrubEnv(extraAllow: readonly string[] = [], source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allow = new Set([...BASE_ENV, ...extraAllow].map(k => (WINDOWS ? k.toUpperCase() : k)));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!allow.has(WINDOWS ? key.toUpperCase() : key)) continue;
    if (isSensitiveName(key) || /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/iu.test(key)) continue;
    out[key] = value;
  }
  return out;
}

const whichCache = new Map<string, string | undefined>();
export function which(name: string): string | undefined {
  if (whichCache.has(name)) return whichCache.get(name);
  const exts = WINDOWS ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map(e => e.toLowerCase()) : [''];
  let found: string | undefined;
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, WINDOWS && !name.toLowerCase().endsWith(ext) ? `${name}${ext}` : name);
      if (existsSync(candidate)) { found = candidate; break; }
    }
    if (found) break;
  }
  whichCache.set(name, found);
  return found;
}

// 子プロセスの PATH で、名前から実際に起動されるファイルを探す（キャッシュしない）。PATH の空の項目と . は作業フォルダを指す
export function findExecutable(name: string, env: Record<string, string>, cwd: string, opts: { windows?: boolean; powershell?: boolean } = {}): string | undefined {
  const windows = opts.windows ?? WINDOWS;
  const lookup = (key: string): string | undefined => env[key] ?? Object.entries(env).find(([k]) => k.toUpperCase() === key)?.[1];
  const exts = windows ? [...(lookup('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase()), ...(opts.powershell ? ['.ps1'] : [])] : [''];
  const named = windows && /\.[A-Za-z0-9]+$/u.test(name);
  const names = windows ? [...(named ? [name] : []), ...exts.map(e => `${name}${e}`)] : [name];
  for (const raw of (lookup('PATH') ?? '').split(windows ? ';' : delimiter)) {
    const dir = raw === '' || raw === '.' ? cwd : raw;
    for (const candidate of names) {
      const file = join(dir, candidate);
      try { if (statSync(file).isFile()) return file; } catch { /* 無い */ }
    }
  }
  return undefined;
}

export type ShellChoice = 'auto' | 'pwsh' | 'powershell' | 'bash' | 'sh';
export interface ShellSpec { name: string; file: string; args: (command: string) => string[] }

const PS_UTF8 = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;';
// 文字コードの設定のあと、制限モードにする。.NET の直接呼び出し（[IO.File]::...）・New-Object・Add-Type が止まり、元のモードへ戻すのも止まる
const PS_CONSTRAINED = "$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage';";

export function resolveShell(choice: ShellChoice): ShellSpec {
  const ps = (file: string, name: string): ShellSpec => ({ name, file, args: c => ['-NoProfile', '-NonInteractive', '-Command', `${PS_UTF8}${PS_CONSTRAINED}${c}`] });
  const posix = (file: string, name: string): ShellSpec => ({ name, file, args: c => (name === 'bash' ? ['--noprofile', '--norc', '-c', c] : ['-c', c]) });
  if (choice === 'pwsh' || (choice === 'auto' && WINDOWS && which('pwsh'))) return ps(which('pwsh') ?? 'pwsh', 'pwsh');
  if (choice === 'powershell' || (choice === 'auto' && WINDOWS)) return ps(which('powershell') ?? 'powershell.exe', 'powershell');
  if (choice === 'bash' || (choice === 'auto' && which('bash'))) return posix(which('bash') ?? 'bash', 'bash');
  return posix(which('sh') ?? '/bin/sh', 'sh');
}

export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (WINDOWS) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { } }
  }
}

export interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  maxBytes: number;
  fullOutputDir?: string;
  outputId?: string;
  input?: string;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  totalBytes: number;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  fullOutputPath?: string;
  spawnError?: string;
}

export function runProcess(file: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd, env: opts.env, windowsHide: true, detached: !WINDOWS, shell: false,
        stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ exitCode: null, stdout: '', stderr: '', truncated: false, totalBytes: 0, timedOut: false, aborted: false, durationMs: 0, spawnError: (error as Error).message });
      return;
    }
    let stdout = ''; let stderr = ''; let kept = 0; let total = 0; let truncated = false;
    let full: WriteStream | undefined; let fullPath: string | undefined;
    const backlog: Array<[string, Buffer]> = [];
    const onData = (stream: 'out' | 'err') => (chunk: Buffer) => {
      total += chunk.length;
      if (kept < opts.maxBytes) {
        const part = chunk.subarray(0, opts.maxBytes - kept);
        kept += part.length;
        if (stream === 'out') stdout += part.toString('utf8'); else stderr += part.toString('utf8');
        if (part.length < chunk.length) truncated = true;
      } else truncated = true;
      if (opts.fullOutputDir && opts.outputId) {
        if (!full && truncated) {
          mkdirSync(opts.fullOutputDir, { recursive: true });
          fullPath = join(opts.fullOutputDir, `${opts.outputId}.log`);
          full = createWriteStream(fullPath);
          for (const [s, b] of backlog) full.write(s === 'err' ? Buffer.concat([Buffer.from('[stderr] '), b]) : b);
          backlog.length = 0;
        }
        if (full) full.write(stream === 'err' ? Buffer.concat([Buffer.from('[stderr] '), chunk]) : chunk);
        else backlog.push([stream, chunk]);
      }
    };
    child.stdout?.on('data', onData('out'));
    child.stderr?.on('data', onData('err'));
    if (opts.input !== undefined) child.stdin?.end(opts.input);

    let timedOut = false; let aborted = false; let spawnError: string | undefined;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, opts.timeoutMs);
    const onAbort = () => { aborted = true; killTree(child); };
    opts.signal.addEventListener('abort', onAbort, { once: true });
    if (opts.signal.aborted) onAbort();
    child.on('error', error => { spawnError = error.message; });
    child.on('close', code => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      full?.end();
      resolve({
        exitCode: code, stdout, stderr, truncated, totalBytes: total, timedOut, aborted, durationMs: Date.now() - started,
        ...(fullPath ? { fullOutputPath: fullPath } : {}), ...(spawnError ? { spawnError } : {}),
      });
    });
  });
}
