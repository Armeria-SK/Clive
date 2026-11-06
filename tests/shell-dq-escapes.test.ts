import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand, type ShellGuardOptions } from '../src/tools/hooks/shell-guard.ts';
import { lexShell, type LexCode, type ShellKind, type Statement } from '../src/tools/hooks/shell-lex.ts';
import { tempDir } from './helpers.ts';

// 二重引用符の中の書き方を、本物のシェルと同じに読む（security-self-api.md §11.15）。
// bash: "…" の中の \ は $ ` " \ 改行の前でだけ特別で、ほかは文字のまま。PowerShell: "…" の中の $( … ) は、中の文を $( … ) と同じに調べる。

function fixture(t: { after: (fn: () => void) => void }) {
  const ws = realish(join(tempDir(t), 'workspace'));
  const put = (rel: string, body = 'x') => { mkdirSync(join(ws, rel, '..'), { recursive: true }); writeFileSync(join(ws, rel), body); };
  put('SOUL.md'); put('USER.md'); put('src/a.ts'); put('f.txt'); put('x');
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [join(ws, 'SOUL.md'), join(ws, 'USER.md'), join(ws, 'skills')], skillsDir: join(ws, 'skills') };
  const run = (command: string, shell: 'bash' | 'powershell', extra: Partial<ShellGuardOptions> = {}) =>
    checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell', ...extra });
  return { ws, bash: (c: string) => run(c, 'bash'), ps: (c: string) => run(c, 'powershell') };
}

const failure = (command: string, shell: ShellKind, windows = false): LexCode | null => { const r = lexShell(command, shell, { windows }); return r.ok ? null : r.fail.code; };
const read = (command: string, shell: ShellKind, windows = false): Statement[] => {
  const r = lexShell(command, shell, { windows });
  assert.ok(r.ok, `${shell}: ${JSON.stringify(command)} が読めない: ${r.ok ? '' : `${r.fail.code} ${r.fail.detail}`}`);
  return r.statements;
};
const stopped = (v: { decision: string; onceOnly: boolean }): boolean => v.decision === 'deny' || (v.decision === 'ask' && v.onceOnly);

// ── bash ──

test('bash: "…" の中の \\ は、$ ` " \\ 改行の前でだけ特別。ほかの \\ は文字のまま（grep の正規表現・echo の \\n）', () => {
  const second = (command: string) => read(command, 'bash')[0]!.words[1]!;
  const rows: Array<[string, string, boolean]> = [
    [String.raw`grep "\.ts$" src`, String.raw`\.ts$`, false],
    [String.raw`echo "a\nb"`, String.raw`a\nb`, false],
    [String.raw`grep "a\|b" f`, String.raw`a\|b`, false],
    [String.raw`echo "\$HOME"`, '$HOME', false],
    ['echo "\\`x\\`"', '`x`', false],
    [String.raw`echo "say \"hi\""`, 'say "hi"', false],
    [String.raw`echo "a\\b"`, String.raw`a\b`, false],
    [String.raw`echo "a\\"`, 'a\\', false],
    ['echo "a\\\nb"', 'ab', false],
    [String.raw`echo "\$(rm x)"`, '$(rm x)', false],
    [String.raw`echo "\\$x"`, String.raw`\$x`, true],
    [String.raw`echo "\d \w \s \( \) \[ \] \* \? \. \- \/ \'"`, String.raw`\d \w \s \( \) \[ \] \* \? \. \- \/ \'`, false],
  ];
  for (const [command, text, dynamic] of rows) {
    const w = second(command);
    assert.equal(w.text, text, command);
    assert.equal(w.dynamic, dynamic, command);
    assert.equal(w.quoted, true, command);
  }
});

test('bash: \\$ のあとの ( は置換ではない。内側の文は作られず、変数でもない', () => {
  const statements = read(String.raw`echo "\$(rm x)" "\${y}" "\$z"`, 'bash');
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0]!.words.map(w => [w.text, w.dynamic]), [['echo', false], ['$(rm x)', false], ['${y}', false], ['$z', false]]);
  // \\ のあとの $( は本物の置換（\\ は \ 1 つになるだけ）
  const real = read(String.raw`echo "\\$(ls)"`, 'bash');
  assert.deepEqual(real.map(s => s.words.map(w => w.text)), [['ls'], ['echo', String.raw`\$(ls)`]]);
  // \" のあとの $( も本物の置換
  assert.deepEqual(read(String.raw`echo "a\"$(ls)"`, 'bash').map(s => s.words[0]!.text), ['ls', 'echo']);
});

test('bash: 読みきれない \\ は、これまでどおり止める（"…" の外・閉じない引用符・CRLF の行の継続）', () => {
  const cases: Array<[string, LexCode]> = [
    [String.raw`echo a\.b`, 'backslash'], [String.raw`echo \$x`, 'backslash'], [String.raw`n\ode x`, 'backslash'], [String.raw`echo 'a'\.b`, 'backslash'], ['ls \\\n -la', 'backslash'],
    [String.raw`echo "a"\.b`, 'backslash'],
    ['echo "a\\', 'unclosed'], ['echo "a\\"', 'unclosed'], ['echo "a\\\\\\', 'unclosed'],
    ['echo "a\\\r\nb"', 'backslash'],
  ];
  for (const shell of ['bash', 'sh'] as const) for (const [command, code] of cases) assert.equal(failure(command, shell), code, `${shell}: ${JSON.stringify(command)}`);
  // 引用符の中のバッククォートは、\ で打ち消さないかぎり、これまでどおり止める
  assert.equal(failure('echo "a`date`"', 'bash'), 'backtick');
  assert.equal(failure('echo "a\\\\`date`"', 'bash'), 'backtick');
  assert.equal(failure('echo "a\\`date\\`"', 'bash'), null);
});

test('bash: シングルクォートの中の \\ は文字のまま。PowerShell の "…" の中の \\ は、これまでどおり文字（エスケープではない）', () => {
  assert.equal(read(String.raw`echo 'a\nb'`, 'bash')[0]!.words[1]!.text, String.raw`a\nb`);
  assert.equal(read(String.raw`Write-Output "a\nb"`, 'powershell')[0]!.words[1]!.text, String.raw`a\nb`);
});

test('bash: \\" で引用符を閉じたと取り違えて、引用符の外の全角を見逃さない（"a\\"" ＡＢ は外に全角がある）', () => {
  for (const shell of ['bash', 'sh'] as const) {
    assert.equal(failure('echo "a\\"" ＡＢ', shell), 'fullwidth', `${shell}: 引用符の外の全角は止める`);
    assert.equal(failure('echo "a\\" ＡＢ"', shell), null, `${shell}: \\" は引用符を閉じない。全角は引用符の中`);
    assert.equal(failure('echo "ＡＢ \\" ＣＤ"', shell), null, shell);
    assert.equal(failure('echo "a\\\\" ＡＢ', shell), 'fullwidth', `${shell}: \\\\ のあとの " は閉じる`);
  }
});

test('bash: 守るコマンドの判定。grep "\\.ts$" src と rg "a\\|b" . は確かめなしに動く。echo "\\$(rm x)" は文字のままで、何も動かさない', t => {
  const f = fixture(t);
  const allow = [
    String.raw`grep "\.ts$" src`, String.raw`rg "a\|b" .`, String.raw`echo "a\nb"`, String.raw`grep "a\|b" f.txt`, String.raw`grep -rn "foo\.bar" src`, String.raw`echo "\$(rm x)"`, String.raw`echo "\$HOME"`,
    String.raw`find . -name "*\.ts" -type f`, String.raw`grep -E "[0-9]+\.[0-9]+" f.txt`, 'cat f.txt | grep "a\\|b"', String.raw`echo "say \"hi\"" > out.txt`,
  ];
  const wrong = allow.flatMap(c => { const v = f.bash(c); return v.decision === 'allow' ? [] : [`${c} → ${v.decision}${v.onceOnly ? '/once' : ''} ${v.reasons.join(' / ')}`]; });
  assert.deepEqual(wrong, []);
  // 内側の文は作られない（rm x は文として判定されず、動かない）
  assert.deepEqual(read(String.raw`echo "\$(rm x)"`, 'bash').map(s => s.words[0]!.text), ['echo']);
});

test('bash: "…" の中の \\ が読めるようになっても、引用符の外の \\・本物の置換・守る場所への書き込みは、これまでどおり', t => {
  const f = fixture(t);
  for (const command of [String.raw`echo \$x`, String.raw`n\ode --eval=1`, String.raw`ls \.`]) assert.equal(f.bash(command).decision, 'deny', command);
  // \\ のあとの $( は本物の置換: 中の文は判定される
  assert.equal(f.bash(String.raw`echo "\\$(ls)"`).decision, 'allow');
  const hit = f.bash(String.raw`echo "\\$(touch SOUL.md)"`);
  assert.ok(stopped(hit), `${hit.decision}: 置換の中の書き込みは確かめ`);
  assert.ok(stopped(f.bash(String.raw`echo "a\"$(node -e 1)"`)));
  assert.ok(stopped(f.bash(String.raw`echo "x" > "SOUL.md"`)));
});

test('bash（Windows）: Git Bash に -c で渡すと連続する \\ が 1 つに減るので、"…" の中の \\\\ は止める。\\ が 1 つの形はそのまま読む。何も渡さないときも止める側', t => {
  const denied = [String.raw`echo "a\\b"`, String.raw`echo "\\$(ls)"`, String.raw`echo "\\\$(touch made)"`, String.raw`echo "a\\"`, String.raw`echo "\\\\"`, 'echo "x\\\\\\\n"', String.raw`grep "a\\.b" f`];
  for (const shell of ['bash', 'sh'] as const) {
    for (const command of denied) {
      assert.equal(failure(command, shell, true), 'win_backslash', `${shell}: ${command}`);
      assert.equal(failure(command, shell, false), null, `${shell}: ${command}（Linux などでは読める）`);
    }
    for (const command of [String.raw`grep "\.ts$" src`, String.raw`echo "a\nb"`, String.raw`echo "\$(rm x)"`, String.raw`echo "say \"hi\""`, String.raw`rg "a\|b" .`, 'echo "a\\\nb"']) assert.equal(failure(command, shell, true), null, `${shell}: ${command}`);
  }
  assert.equal(lexShell(denied[2]!, 'bash').ok, false, 'windows を渡さないときは、止める側（Windows と同じ）');
  const f = fixture(t);
  const verdict = checkShellCommand(denied[2]!, f.ws, { policy: { roots: [{ path: f.ws, mode: 'write' }], deny: [], askOnWrite: [], skillsDir: join(f.ws, 'skills') }, outsideRoots: 'ask', shell: 'bash', windows: true });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reasons.join(), /Git Bash/u);
  assert.equal(f.bash(denied[2]!).decision, 'allow', 'Linux などの判定（windows: false）では、\\\\\\$ は文字');
});
