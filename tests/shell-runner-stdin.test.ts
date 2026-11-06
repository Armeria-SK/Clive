import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { lexShell } from '../src/tools/hooks/shell-lex.ts';
import { resolveShell, runProcess, scrubEnv, which } from '../src/tools/shell/runner.ts';
import { tempDir } from './helpers.ts';

// ガードの読みと、bash が実行するものが同じであること（security-self-api.md §11.15）。
// Windows の Git Bash は、bash -c の引数の中の連続する \\ を 1 つに減らす（msys が引数を読み直す）ので、スクリプトは引数でなく標準入力で渡す。
// ここで走らせるのは、Clive のシェルの道具が実際に使う resolveShell と runProcess

const bashPath = which('bash');
const bashAvailable = bashPath !== undefined && spawnSync(bashPath, ['--noprofile', '--norc', '-c', 'echo ok'], { encoding: 'utf8' }).stdout.trim() === 'ok';
const skip = !bashAvailable && 'bash が無い';

type Result = Awaited<ReturnType<typeof runProcess>>;
function runnerIn(cwd: string, timeoutMs = 30_000) {
  const spec = resolveShell('bash');
  return (script: string): Promise<Result> => runProcess(spec.file, spec.args(script), {
    cwd, env: scrubEnv(), timeoutMs, signal: new AbortController().signal, maxBytes: 200_000, ...(spec.stdin ? { input: spec.stdin(script) } : {}),
  });
}

test('bash の起動: スクリプトは引数に入れず、標準入力で渡す（Windows の引数の読み直しで変わらない）。sh も同じ', () => {
  const script = 'echo "\\\\\\$(touch made)" && cat';
  for (const choice of ['bash', 'sh'] as const) {
    const spec = resolveShell(choice);
    assert.ok(spec.args(script).every(arg => !arg.includes('touch') && !arg.includes('echo')), `${choice}: スクリプトが引数に入っている: ${JSON.stringify(spec.args(script))}`);
    assert.equal(spec.stdin?.(script), script, `${choice}: 標準入力にそのまま入れる`);
  }
  assert.deepEqual(resolveShell('bash').args('ls').slice(0, 3), ['--noprofile', '--norc', '-c']);
  assert.equal(resolveShell('powershell').stdin, undefined, 'PowerShell は今までどおり引数で渡す');
});

test('bash の起動: 標準入力を読むコマンド（引数なしの cat）は止まらず、スクリプトの続きを食べない', { skip }, async t => {
  const run = runnerIn(tempDir(t), 30_000);
  const result = await run('cat\necho after\n');
  assert.equal(result.timedOut, false, 'cat が標準入力を待って止まった');
  assert.equal(result.stdout, 'after\n', 'cat がスクリプトの続き（echo after）を食べた');
  const reading = await run('read -n 3 x; echo "x=[$x]"\nXXXecho notresumed\n');
  assert.equal(reading.stdout, 'x=[]\n', 'read がスクリプトの続きを食べた');
  assert.doesNotMatch(reading.stdout + reading.stderr, /notresumed/u, '食べた残りの途中から、続きが実行された');
  assert.equal(reading.exitCode, 127, '行の途中から再開せず、次の行は別のコマンドとして（見つからず）失敗する');
  const piped = await run('echo hi | cat; cat < /dev/null; echo done');
  assert.equal(piped.stdout, 'hi\ndone\n');
});

test('bash の起動: 終了コード・標準出力・日本語・長いスクリプト・構文エラー・見つからないコマンドは、素の -c と同じ結果になる。タイムアウトは孫プロセスまで止める', { skip }, async t => {
  const dir = tempDir(t);
  const run = runnerIn(dir);
  const scripts = [
    'exit 7', 'echo out; echo err >&2; false', 'echo 日本語の出力 "あ い"', `echo ${'x'.repeat(7900)}`, 'echo before\n)', 'echo before; )', 'echo a; echo "unclosed', 'definitely-not-a-command-xyz', 'read x; echo "[$x]"', 'cat; echo after',
    'echo $0 $LINENO', 'for i in 1 2 3; do echo $i; done | sort -r', 'x=$(echo hi); echo "$x"', 'cd /; pwd; cd - >/dev/null', 'echo a > out.txt; cat out.txt', 'cat <<EOF\nline1\nline2\nEOF',
  ];
  for (const script of scripts) {
    const raw = spawnSync(bashPath!, ['--noprofile', '--norc', '-c', script], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: scrubEnv() });
    const real = await run(script);
    assert.deepEqual([real.exitCode, real.stdout], [raw.status, raw.stdout], JSON.stringify(script.slice(0, 60)));
  }
  assert.equal((await run('echo out; echo err >&2')).stderr.includes('err'), true, '標準エラーは別に取れる');
  const slow = await runnerIn(dir, 800)('node -e "setTimeout(() => {}, 30000)"; echo late');
  assert.equal(slow.timedOut, true);
  assert.ok(slow.durationMs < 20_000, `止めるまで ${slow.durationMs}ms`);
  const ctl = new AbortController();
  const spec = resolveShell('bash');
  const script = 'exec sleep 30';
  const pending = runProcess(spec.file, spec.args(script), { cwd: dir, env: scrubEnv(), timeoutMs: 30_000, signal: ctl.signal, maxBytes: 1000, ...(spec.stdin ? { input: spec.stdin(script) } : {}) });
  setTimeout(() => ctl.abort(), 300);
  const aborted = await pending;
  assert.equal(aborted.aborted, true);
  assert.ok(aborted.durationMs < 20_000, `取り消してから止めるまで ${aborted.durationMs}ms`);
});

// ── 本物の bash と、ガードの読みの突き合わせ（\ の連続 0〜6 個 × 後ろの 23 通りの文字 × 2 つの後ろの形）──

const BACKSLASH_RUNS = [0, 1, 2, 3, 4, 5, 6];
const TRAILING = ['$', '`', '"', '\\', '\n', 'n', '.', '|', '(', ')', '[', ']', '*', '?', '-', '/', "'", ' ', '!', '#', 'a', '0', '{'];
const TAILS = ['X', '(echo QQ)X'];

test('ガードの読み（"…" の中の \\ の連続 0〜6 個 × 後ろの 23 通り）が、Clive のシェルが動かす bash の結果と同じ', { skip }, async t => {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'cwd'));
  const run = runnerIn(join(dir, 'cwd'));
  const rows: Array<{ script: string; tail: string }> = [];
  for (const n of BACKSLASH_RUNS) for (const c of TRAILING) for (const tail of TAILS) rows.push({ script: `printf '<%s>\\n' "${'\\'.repeat(n)}${c}${tail}"`, tail });
  assert.equal(rows.length, 7 * 23 * 2);
  const checked: Array<{ script: string; tail: string; word: { text: string; dynamic: boolean }; substituted: boolean }> = [];
  let rejected = 0;
  for (const { script, tail } of rows) {
    const lexed = lexShell(script, 'bash');
    if (!lexed.ok) { rejected++; continue; }
    const printf = lexed.statements.find(s => s.words[0]?.text === 'printf');
    assert.ok(printf && printf.words.length === 3, `${JSON.stringify(script)}: printf の語が 3 つでない`);
    checked.push({ script, tail, word: printf.words[2]!, substituted: lexed.statements.some(s => s.words[0]?.text === 'echo' && s.words[1]?.text === 'QQ') });
  }
  assert.ok(checked.length > 200 && rejected >= 10, `読めた ${checked.length} 行・止めた ${rejected} 行（突き合わせが偏っている）`);
  const wrong: string[] = [];
  const POOL = 12;
  for (let i = 0; i < checked.length; i += POOL) {
    await Promise.all(checked.slice(i, i + POOL).map(async row => {
      const real = await run(row.script);
      const label = JSON.stringify(row.script);
      if (real.exitCode !== 0) { wrong.push(`${label}: 本物の bash が失敗 (${real.exitCode}) ${real.stderr.trim()}`); return; }
      const out = real.stdout;
      if (row.tail !== 'X') {
        const realSubstituted = out.includes('QQ') && !out.includes('echo QQ');
        if (realSubstituted !== row.substituted) wrong.push(`${label}: 置換 ガード=${row.substituted} 本物=${realSubstituted} 出力=${JSON.stringify(out)}`);
        if (row.substituted) return;
      }
      const expected = `<${row.word.dynamic ? row.word.text.replace(/\$X/gu, '') : row.word.text}>\n`;
      if (out !== expected) wrong.push(`${label}: ガードの読み ${JSON.stringify(expected)} / 本物 ${JSON.stringify(out)}`);
    }));
  }
  assert.deepEqual(wrong, []);
});

test('bash: echo "\\\\\\$(touch made) は、Clive のシェルで置換にならず、文字を出すだけで何も作らない。素の -c は Windows では置換にしてしまう', { skip }, async t => {
  const dir = tempDir(t);
  const script = 'echo "\\\\\\$(touch made)"';
  const result = await runnerIn(dir)(script);
  assert.equal(result.stdout, '\\$(touch made)\n');
  assert.equal(existsSync(join(dir, 'made')), false, '置換の touch が動いた');
  const lexed = lexShell(script, 'bash');
  assert.ok(lexed.ok && lexed.statements.length === 1 && lexed.statements[0]!.words[1]!.text === '\\$(touch made)' && !lexed.statements[0]!.words[1]!.dynamic, 'ガードも、置換のない 1 つの文として読む');
  if (process.platform === 'win32') {
    const raw = spawnSync(bashPath!, ['--noprofile', '--norc', '-c', script], { cwd: dir, encoding: 'utf8' });
    assert.equal(raw.stdout, '\\\n', '前提: 素の bash -c では \\\\ が減って、$( が置換になる');
    assert.equal(existsSync(join(dir, 'made')), true, '前提: 素の bash -c では置換の touch が動く');
  }
});
