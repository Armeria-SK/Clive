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
  put('SOUL.md'); put('USER.md'); put('src/a.ts'); put('f.txt'); put('x'); put('.env', 'SECRET=1');
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [join(ws, 'SOUL.md'), join(ws, 'USER.md'), join(ws, 'skills')], skillsDir: join(ws, 'skills') };
  const run = (command: string, shell: 'bash' | 'powershell', extra: Partial<ShellGuardOptions> = {}) =>
    checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell', ...extra });
  return { ws, policy, bash: (c: string) => run(c, 'bash'), ps: (c: string) => run(c, 'powershell') };
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

// ── PowerShell ──

const PS_SHELLS = ['powershell', 'pwsh'] as const;
const commandLines = (statements: Statement[]): string[] => statements.filter(s => s.kind === 'command').map(s => s.words.map(w => w.text).join(' '));

test('PowerShell: "…" の中の $( … ) は中の文を $( … ) と同じに読み、文字列全体は値の分からない語（引用符つき）になる', () => {
  for (const shell of PS_SHELLS) {
    const statements = read('Write-Output "a $($x.Name) b"', shell);
    assert.deepEqual(statements.map(s => s.kind), ['expr', 'command']);
    const word = statements[1]!.words[1]!;
    assert.deepEqual([word.text, word.dynamic, word.quoted, word.kind, word.glob], ['a $($x.Name) b', true, true, 'plain', false]);
    assert.deepEqual(commandLines(read('Write-Output "$(Get-Date -Format yyyy)"', shell)), ['Get-Date -Format yyyy', 'Write-Output $(Get-Date -Format yyyy)']);
    // 入れ子の引用符・入れ子の $( )・複数
    assert.deepEqual(commandLines(read('Write-Output "$("x $(Get-Date -Format yyyy)")"', shell)), ['Get-Date -Format yyyy', 'Write-Output $("x $(Get-Date -Format yyyy)")']);
    assert.deepEqual(commandLines(read('Write-Output "$(Get-Date)-$(Get-Location)"', shell)), ['Get-Date', 'Get-Location', 'Write-Output $(Get-Date)-$(Get-Location)']);
    assert.deepEqual(commandLines(read('Write-Output "$(Get-Date -Format "yyyy")"', shell)), ['Get-Date -Format yyyy', 'Write-Output $(Get-Date -Format "yyyy")']);
    assert.deepEqual(commandLines(read("Write-Output \"$(Write-Output '(a)')\"", shell)), ['Write-Output (a)', "Write-Output $(Write-Output '(a)')"]);
    assert.deepEqual(commandLines(read("Write-Output \"$(Write-Output '\"')\"", shell)), ['Write-Output "', "Write-Output $(Write-Output '\"')"]);
    assert.deepEqual(commandLines(read('Write-Output "$(Write-Output $(Get-Date))"', shell)), ['Get-Date', 'Write-Output $(…)', 'Write-Output $(Write-Output $(Get-Date))']);
    assert.deepEqual(commandLines(read('Write-Output "$(Write-Output (Get-Date))"', shell)), ['Get-Date', 'Write-Output $(…)', 'Write-Output $(Write-Output (Get-Date))']);
    // 空の $( ) と、複数行の中身
    assert.deepEqual(commandLines(read('Write-Output "a$()b"', shell)), ['Write-Output a$()b']);
    assert.deepEqual(commandLines(read('Write-Output "$(\nGet-Date\nGet-Location\n)"', shell)), ['Get-Date', 'Get-Location', 'Write-Output $(\nGet-Date\nGet-Location\n)']);
    // $( がシングルクォートの中なら文字
    assert.deepEqual(read("Write-Output '$(Get-Date)'", shell).map(s => s.words[1]!.dynamic), [false]);
    assert.equal(read('"$($x.Name) $($x.Length)"', shell).length, 3);
  }
});

test('PowerShell: 極端に深く入れ子にした "$(" でも、例外を投げず「入れ子が深い」で止める', () => {
  const deep = `Write-Output ${'"$('.repeat(50000)}1${')"'.repeat(50000)}`;
  for (const shell of PS_SHELLS) assert.equal(failure(deep, shell), 'depth', shell);
  const deepFullwidth = `Write-Output ${'"$('.repeat(50000)}1${')"'.repeat(50000)} ＡＢ`;
  for (const shell of PS_SHELLS) assert.notEqual(failure(deepFullwidth, shell), null, shell);
});

test('PowerShell: ブロックの中の "$( … )" の中の文も、ブロックの中の文（strict）として読む', () => {
  const statements = read('Get-ChildItem | ForEach-Object { "$(Get-Date) $($_.Name)" }', 'powershell');
  const inner = statements.filter(s => s.words[0]?.text === 'Get-Date');
  assert.equal(inner.length, 1);
  assert.equal(inner[0]!.inBlock, true);
  assert.deepEqual(statements.at(-1)!.words[1]!.kind, 'block');
});

test('PowerShell: 読みきれない "…" の中の $( は、これまでどおり止める（${・バッククォート・$$(・閉じない・コメント・@" "@・入れ子が深い）', () => {
  const cases: Array<[string, LexCode]> = [
    ['Write-Output "${env:PATH}"', 'ps_expand'], ['Write-Output "a${x}"', 'ps_expand'], ['Write-Output "$(Get-Date) ${x}"', 'ps_expand'], ['Write-Output "$("${x}")"', 'ps_expand'],
    ['Write-Output "a`$(Get-Date)"', 'backtick'], ['Write-Output "$(Get-Date `n)"', 'backtick'], ['Write-Output "$("a`nb")"', 'backtick'],
    ['Write-Output "$$(Get-Date)"', 'ps_expand'], ['Write-Output "$$$(Get-Date)"', 'ps_expand'],
    ['Write-Output "$(Get-Date"', 'unclosed'], ['Write-Output "$(Get-Date', 'unclosed'], ['Write-Output "$(Get-Date)', 'unclosed'], ['Write-Output "$("', 'unclosed'], ['Write-Output "$(Write-Output (1)"', 'unclosed'], ['Write-Output "$({ 1 )"', 'unclosed'],
    ['Write-Output "$(1 # )\n)"', 'unexpected'], ['Write-Output "a$(Get-Date # c\n)"', 'unexpected'],
    ["Write-Output \"$(Write-Output ')')\"", 'ps_expand'], ["Write-Output \"$(Write-Output '(')\"", 'ps_expand'], ['Write-Output "$(Write-Output ")")"', 'ps_expand'], ['Write-Output "$(Write-Output "(")"', 'ps_expand'],
    ["Write-Output \"a$(@'\nx)\n'@)b\"", 'ps_expand'], ['Write-Output "$(Get-Date # )\n)"', 'unexpected'], ["Write-Output \"$(Write-Output '(a')\"", 'ps_expand'],
    ['Write-Output "$(@"\nx\n"@)"', 'here_string'], ['Write-Output "$(<# c #> 1)"', 'block_comment'], ['Write-Output "$(Get-Date --% x)"', 'parse_token'],
    ['Write-Output "$($a[0)"', 'unclosed'], ['Write-Output "$(} 1)"', 'unexpected'], ['Write-Output "$(1 ＢＣ)" x', 'fullwidth'],
    ['Write-Output "$("$("$("$("$(1)")")")")"', 'depth'],
    ['Write-Output "$(Get-Date)" ＡＢ', 'fullwidth'], ["Write-Output \"a$('\"')b\" ＡＢ", 'fullwidth'], ["Write-Output \"$(Write-Output '\"')\" ＡＢ", 'fullwidth'],
    ['$a["${x}"] = 1', 'ps_expand'], ['$a["$$(Get-Date)"] = 1', 'ps_expand'], ['$a.b["x$(Get-Date"] = 1', 'unclosed'],
  ];
  for (const shell of PS_SHELLS) for (const [command, code] of cases) assert.equal(failure(command, shell), code, `${shell}: ${JSON.stringify(command)}`);
  for (const shell of PS_SHELLS) {
    assert.equal(failure('Write-Output "$("$("$("$(1)")")")"', shell), null, `${shell}: 入れ子 4 段までは読める`);
    assert.equal(failure('Write-Output "$(Get-Date) ＡＢ"', shell), null, `${shell}: 引用符の中の全角は可`);
    assert.equal(failure("Write-Output \"a$('\"')b ＡＢ\"", shell), null, `${shell}: 入れ子の引用符のあとも、文字列の中の全角は可`);
    assert.equal(failure('$a[0] = "$(Get-Date)"', shell), null, `${shell}: 代入の右辺の "$( )" は読める`);
    // 代入の左辺の添字の中の "$( )" も読める（以前は先読みで飛ばす作りで、止めていた）。中の文の判定は tests/shell-ps-index.test.ts
    for (const command of ['$a["$(Get-Date)"] = 1', '$a[0]["$(Get-Date)"] = 1', '$a.b["x$(Get-Date)"] = 1']) assert.equal(failure(command, shell), null, `${shell}: ${command}`);
  }
});

test('PowerShell: 守るコマンドの判定。読むだけ・文字を整えるだけの "$( )" は確かめなしに動く', t => {
  const f = fixture(t);
  const allow = [
    'Get-ChildItem | ForEach-Object { "$($_.Name) $($_.Length)" }', 'Write-Output "名前は $($x.Name)"', 'Write-Output "$($f.Length) bytes"', 'Write-Host "$(Get-Date -Format yyyy)"', 'Write-Output "$(Get-Date)"',
    'Write-Output "a$($b)c"', 'Write-Output "$("x $($y)")"', '"$(Get-Date)"', 'Write-Output "$(Get-Location)/sub"', 'foreach ($f in Get-ChildItem) { Write-Host "$($f.Name)" }',
    'Get-ChildItem | ForEach-Object { Write-Output "$($_.Name): $($_.Length)" }', 'Get-ChildItem | Format-Table Name, @{Name="size"; Expression={ "$($_.Length) bytes" }}', '$s = "$(Get-Date)"; Write-Output $s',
    'Write-Output "x" "$(Get-Date)"', 'Write-Output "$(Write-Output $(Get-Date))"', 'Get-Content f.txt | ForEach-Object { "$($_.Length) $_" }', 'Write-Output "$((Get-Date).Year)"', 'Write-Output "$(1)$(2)"', 'Write-Output "$(Get-Date -Format "yyyy-MM")"',
  ];
  const wrong = allow.flatMap(c => PS_SHELLS.flatMap(shell => { const v = checkShellCommand(c, f.ws, { policy: f.policy, outsideRoots: 'ask', shell, windows: true }); return v.decision === 'allow' ? [] : [`${shell}: ${c} → ${v.decision}${v.onceOnly ? '/once' : ''} ${v.reasons.join(' / ')}`]; }));
  assert.deepEqual(wrong, []);
});

test('PowerShell: "$( )" の中の文は、トップレベルの文と同じ判定になる。書く・消す・コードを動かすものは確かめ（今回だけ）で、許可にはならない', t => {
  const f = fixture(t);
  const sameAsTop: Array<[string, string]> = [
    ['Write-Output "$(Set-Content SOUL.md x)"', 'Set-Content SOUL.md x'], ['Write-Output "$(Remove-Item x)"', 'Remove-Item x'], ['Write-Output "$(Set-Content out.txt x)"', 'Set-Content out.txt x'],
    ['Write-Output "$(New-Item -ItemType Directory made)"', 'New-Item -ItemType Directory made'], ['Write-Output "$(Copy-Item f.txt g.txt)"', 'Copy-Item f.txt g.txt'],
    ["Write-Output \"$(iex 'x')\"", "iex 'x'"], ['Write-Output "$(Invoke-Expression "Get-Date")"', 'Invoke-Expression "Get-Date"'], ['Write-Output "$(node -e 1)"', 'node -e 1'], ['Write-Output "$(Start-Process notepad)"', 'Start-Process notepad'],
    ['Write-Output "$(Get-Process | Stop-Process)"', 'Get-Process | Stop-Process'], ['Write-Output "$(Invoke-WebRequest -Uri https://example.com -OutFile x)"', 'Invoke-WebRequest -Uri https://example.com -OutFile x'],
    ['Write-Output "$("x $(Set-Content SOUL.md y)")"', 'Set-Content SOUL.md y'], ['Write-Output "$(Get-Date) $(Remove-Item x)"', 'Remove-Item x'], ['Write-Output "$(Get-Date;Remove-Item x)"', 'Remove-Item x'],
    ['Write-Output "$(Get-Content .env)"', 'Get-Content .env'], ['Write-Output "$(Get-Content ../outside.txt)"', 'Get-Content ../outside.txt'], ['Write-Output "$(Get-ChildItem | Remove-Item)"', 'Get-ChildItem | Remove-Item'],
    ['Write-Output "$([Math]::Round(1.5))"', '[Math]::Round(1.5)'], ['Write-Output "$(& $x)"', '& $x'], ['Write-Output "$(function f { 1 })"', 'function f { 1 }'],
    ['Get-ChildItem | ForEach-Object { "$(Remove-Item $_)" }', 'Get-ChildItem | ForEach-Object { Remove-Item $_ }'], ['Get-ChildItem | ForEach-Object { "$(Get-Content $_.FullName)" }', 'Get-ChildItem | ForEach-Object { Get-Content $_.FullName }'],
  ];
  const wrong: string[] = [];
  for (const [wrapped, bare] of sameAsTop) {
    const inner = f.ps(bare);
    const outer = f.ps(wrapped);
    if (outer.decision === 'allow') { wrong.push(`許可になった: ${wrapped}`); continue; }
    if (outer.decision !== inner.decision || outer.onceOnly !== inner.onceOnly) wrong.push(`${wrapped} → ${outer.decision}/${outer.onceOnly}、中の文だけだと ${inner.decision}/${inner.onceOnly}（${bare}）`);
  }
  assert.deepEqual(wrong, []);
  // 具体的に: 人格への書き込みは今回だけ、秘密は止める、iex は止めるか今回だけ
  const soul = f.ps('Write-Output "$(Set-Content SOUL.md x)"');
  assert.deepEqual([soul.decision, soul.onceOnly], ['ask', true]);
  assert.match(soul.reasons.join('\n'), /SOUL\.md|人格/u);
  const remove = f.ps('Write-Output "$(Remove-Item x)"');
  assert.deepEqual([remove.decision, remove.onceOnly], ['ask', true]);
  assert.equal(f.ps('Write-Output "$(Get-Content .env)"').decision, 'deny');
  assert.ok(stopped(f.ps("Write-Output \"$(iex 'x')\"")));
});

test('PowerShell: "$( )" を含む文字列は値の分からない語。パスや引数で文字どおりが要るところでは、変数と同じ決まりになる', t => {
  const f = fixture(t);
  const same: Array<[string, string]> = [
    ['Get-Content "$($x.Name)"', 'Get-Content "$x"'], ['Get-Content "a$(Get-Date).txt"', 'Get-Content "a$x.txt"'], ['Get-ChildItem -Path "$(Get-Location)/src"', 'Get-ChildItem -Path "$x/src"'],
    ['Set-Content "$(Get-Date).txt" x', 'Set-Content "$x.txt" x'], ['Set-Location "$(Get-Location)"', 'Set-Location "$x"'], ['Select-String -Path "$($d)/*.txt" -Pattern x', 'Select-String -Path "$d/*.txt" -Pattern x'],
    ['git log "$(Get-Date)"', 'git log "$x"'], ['git -C "$(Get-Location)" status', 'git -C "$x" status'], ['rg "$(Get-Date)" src', 'rg "$x" src'], ['node "$(Get-Date)"', 'node "$x"'], ['Invoke-WebRequest -Uri "$(Get-Date)"', 'Invoke-WebRequest -Uri "$x"'],
    ['Get-ChildItem | ForEach-Object { Get-Content "$($_.Name)" }', 'Get-ChildItem | ForEach-Object { Get-Content "$_.Name" }'], ['Remove-Item "$(Get-Date)"', 'Remove-Item "$x"'],
  ];
  const level = (v: { decision: string; onceOnly: boolean }): string => (v.decision === 'allow' ? 'allow' : v.onceOnly ? 'once' : v.decision);
  const wrong: string[] = [];
  for (const [wrapped, withVar] of same) {
    const a = level(f.ps(wrapped));
    const b = level(f.ps(withVar));
    if (a !== b) wrong.push(`${wrapped} → ${a}、変数の形 ${withVar} → ${b}`);
  }
  assert.deepEqual(wrong, []);
  // 具体的に: 値の分からない読むパスは、変数のときと同じふつうの確かめ（今回だけではない）
  const reading = f.ps('Get-Content "$($x.Name)"');
  assert.equal(reading.decision, 'ask');
  assert.equal(reading.onceOnly, false);
  assert.equal(f.ps('Set-Content "$(Get-Date).txt" x').onceOnly, true);
});

test('PowerShell: try/catch などの中の "$( )" も読み、中の文の判定（秘密のパスなど）が効く。ハッシュのキー・-Name:値 の値の中も同じ', t => {
  const f = fixture(t);
  assert.equal(f.ps('try { Write-Output "$(Get-Date)" } catch { }').onceOnly, true);
  assert.equal(f.ps('try { Write-Output "$(Get-Content .env)" } catch { }').decision, 'deny');
  assert.equal(f.ps('while ($true) { "$(Get-Content .env)" }').decision, 'deny');
  assert.equal(f.ps('function f { "$(Get-Content .env)" }').decision, 'deny');
  assert.ok(stopped(f.ps('$h = @{"$(Remove-Item x)"=1}')));
  assert.ok(stopped(f.ps('Get-Content -Path:"$(Remove-Item x)"')));
  assert.ok(stopped(f.ps('Write-Output "a" -InputObject:"$(Remove-Item x)"')));
  assert.equal(f.ps('Write-Output "$(Get-Content .env)" | Out-Null').decision, 'deny');
  assert.equal(f.ps('Write-Output "$(Get-Content .env)" > $null').decision, 'deny');
  assert.ok(stopped(f.ps('$x = "$(Remove-Item x)"')));
  assert.ok(stopped(f.ps('if ("$(Remove-Item x)") { 1 }')));
  assert.ok(stopped(f.ps('foreach ($i in "$(Remove-Item x)") { 1 }')));
  assert.ok(stopped(f.ps('Get-ChildItem | Where-Object { $_.Name -eq "$(Remove-Item x)" }')));
  assert.ok(stopped(f.ps('"$(Remove-Item x)".Length')));
  assert.ok(stopped(f.ps('Write-Output ("$(Remove-Item x)")')));
  assert.ok(stopped(f.ps('Write-Output "a" , "$(Remove-Item x)"')));
});

test('PowerShell: シングルクォートの中・ヒア文字列の中の $( は文字のまま、何も判定しない', t => {
  const f = fixture(t);
  assert.equal(f.ps("Write-Output '$(Remove-Item x)'").decision, 'allow');
  assert.equal(f.ps("Write-Output @'\n$(Remove-Item x)\n'@").decision, 'allow');
  assert.deepEqual(read("Write-Output '$(Remove-Item x)'", 'powershell').map(s => s.words[0]!.text), ['Write-Output']);
});
