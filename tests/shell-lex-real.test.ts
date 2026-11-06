import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { lexShell, type ShellKind } from '../src/tools/hooks/shell-lex.ts';
import { resolveShell, runProcess, scrubEnv, which } from '../src/tools/shell/runner.ts';
import { tempDir } from './helpers.ts';

// security-self-api.md §11.10: 字句の読み取りが、本物のシェルの読み方と同じこと。
// PowerShell は [Parser]::ParseInput の結果（コマンドの名前と引数の並び）、bash は同じ語を printf '<%s>\n' に渡した結果と比べる。

const BASH_ROWS = [
  'ls -la', 'ls', 'cat README.md', 'head -n 50 x', 'tail -n 20 log', 'grep -rn "TODO" src', 'grep -rn \'TODO\' src', 'rg -n foo', 'rg -e "x y" f', 'find . -name "*.md" -type f', 'wc -l *.md', 'sort data.txt',
  "jq '.items[]' a.json", 'git log --oneline -20', 'git commit -m "x y"', 'git commit -m \'it is "ok"\'', 'echo "a  b" \'c  d\' e', 'echo "it\'s" \'say "hi"\'', 'echo a=b --flag=value -- x', "printf '%s\\n' hi",
  "sed -n '1,20p' f", 'sed -i "s/a/b/g" f', 'curl -sS "https://example.com/a?b=c&d=e"', 'curl -o page.html https://example.com/x', 'mkdir -p out', 'cp a.txt b.txt', 'mv a b', 'rm -rf build', 'tar -czf out.tgz dir',
  'echo "a;b|c&d"', "echo 'a;b|c&d'", 'echo "#notacomment"', 'echo x#y', 'echo "tab\there"', 'echo ""', "echo ''", 'echo a"b"c\'d\'e', 'ls -- *.md', 'echo [abc] ?x', 'echo "*" \'?\'', 'node --version', 'npm view left-pad version --json',
  'echo "日本語 の 引用"', 'grep -r 日本語 .', 'echo 100%', 'echo @home ^x', 'echo a,b', 'echo =x', 'echo a:b', 'cat < in.txt', 'echo hi > out.txt', 'echo hi >> out.txt 2>&1',
];

// "…" の中の \ は、$ ` " \ 改行の前でだけ特別。ほかは文字のまま（§11.15）
const BASH_DQ_ROWS = [
  'grep "\\.ts$" src', 'echo "a\\nb"', 'grep "a\\|b" f', 'echo "\\$HOME"', 'echo "\\`x\\`"', 'echo "say \\"hi\\""', 'echo "a\\\\b"', 'echo "a\\\\"', 'echo "a\\\nb"', 'echo "\\$(rm x)"', 'echo "\\\\\\$HOME"',
  'echo "\\d\\w\\s"', 'echo "\\(\\)\\[\\]\\*\\?\\.\\-\\/"', "echo \"a\\'b\"", 'ls "C:\\Users\\x"', 'echo "a\\tb"', 'echo "\\\\"', 'echo "\\$"', 'echo "\\`"', 'echo "\\""', 'rg "a\\|b\\.c" .', 'echo "a\\\n\\\nb"',
  'echo "a\\\\\\"b"', 'echo "\\\\\\\\"', 'echo "\\\\$"', 'printf "%s\\n" "x"', 'echo "\\\\\\\n"',
];

const PS_ROWS = [
  'Get-ChildItem -Recurse -Filter *.md', 'dir', 'ls', 'Get-Content x -TotalCount 20', 'Get-Content -Path:a.txt -Raw', "Select-String -Path *.ts -Pattern 'foo bar'", 'Set-Content -Path a.txt -Value "x"',
  'New-Item -ItemType Directory out', 'Invoke-WebRequest -Uri https://example.com -UseBasicParsing', 'git log --oneline -20', "git commit -m 'it''s'", 'rg -n foo', 'node --version', 'Write-Output hi', 'Set-Location sub',
  'Remove-Item -Recurse -Force build', 'cat a.txt', 'Start-Sleep 5', 'Get-Date -Format yyyy-MM-dd', "Write-Host 'a  b' -ForegroundColor Green", 'ls | Sort-Object Length -Descending | Select-Object -First 5', 'Copy-Item a b',
  'curl.exe -sS https://example.com', 'git -C sub status', 'Write-Output "a b"', "Write-Output 'say \"hi\"'", 'Join-Path a b', 'echo a;echo b', 'rg "a b" f', 'tar.exe -tf a.tar', 'Get-Content a.txt | Select-String foo',
  'Test-Path -LiteralPath a.txt', 'git config --get user.name', 'rg --max-depth=2 foo', 'Write-Output a=b', 'Write-Output "#x"', 'Write-Output x#y', 'Write-Output "日本語 の 引用"', "Write-Output ''", 'Write-Output ""',
  'Write-Output 100%', 'Write-Output a:b', 'Write-Output --flag', 'Write-Output -- x', 'Get-ChildItem -Path:src -Recurse', '& git status', 'git log --since="2 weeks ago"', 'Write-Output a"b"', "Write-Output 'a'b",
  "Write-Output 'a'$x", 'Write-Output "a"b', 'Write-Output "a"\'b\'', "Write-Output a'b'c'd'", "Write-Output 'x'-y", "rg 'x'--pre=./p.sh f", 'Write-Output (1)b', 'Write-Output $(1)b', 'Write-Output @(1)b', 'Write-Output {1}b',
  'Write-Output $x\y', 'Write-Output $x"b"', 'Write-Output $x,"b"', 'Write-Output "a"-x', "Write-Output 'a'.Length", "Set-Content 'x'.Replace('x','SOUL.md') hi", 'Write-Output 5', 'Write-Output 1.5kb',
];

function realBash(): string | undefined {
  const found = which('bash');
  if (!found) return undefined;
  const probe = spawnSync(found, ['--noprofile', '--norc', '-c', 'echo ok'], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout.trim() === 'ok' ? found : undefined;
}

const bashPath = realBash();

test('bash: 字句の読み取りが読んだ語は、本物の bash が printf に渡す語と同じ', { skip: !bashPath && 'bash が無い' }, t => {
  const dir = tempDir(t);
  const wrong: string[] = [];
  for (const row of BASH_ROWS) {
    const lexed = lexShell(row, 'bash');
    if (!lexed.ok) { wrong.push(`${row}: 読めない (${lexed.fail.code})`); continue; }
    const st = lexed.statements[0]!;
    const name = st.words[0]!.text;
    const rest = row.slice(row.indexOf(name) + name.length).replace(/\s*(?:>>?|<)\s*\S+(?:\s+2>&1)?\s*$/u, '');
    const script = `printf '<%s>\\n'${rest}`;
    const real = spawnSync(bashPath!, ['--noprofile', '--norc', '-c', script], { cwd: dir, encoding: 'utf8' });
    if (real.status !== 0) { wrong.push(`${row}: 本物の bash が失敗 ${real.stderr.trim()}`); continue; }
    const realWords = real.stdout.replace(/\n$/u, '').split('\n').map(line => line.replace(/^<|>$/gu, ''));
    const mine = st.words.slice(1).map(w => w.text);
    const same = mine.length === 0 ? realWords.length === 1 && realWords[0] === '' : JSON.stringify(mine) === JSON.stringify(realWords);
    if (!same) wrong.push(`${row}: 字句 ${JSON.stringify(mine)} / 本物 ${JSON.stringify(realWords)}`);
  }
  assert.deepEqual(wrong, []);
});

test('bash: 本物の bash が展開で語を増やす・変える書き方は、字句の読み取りが「展開」の印を付ける', { skip: !bashPath && 'bash が無い' }, t => {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'd'));
  writeFileSync(join(dir, 'a.md'), '');
  writeFileSync(join(dir, 'd', 'x'), '');
  writeFileSync(join(dir, 'b.md'), '');
  const rows = ['echo *.md', 'echo {x,y}', 'echo ~', 'echo $HOME', 'echo $(echo q)', 'echo ?.md', 'echo [ab].md', 'echo d/*'];
  for (const row of rows) {
    const lexed = lexShell(row, 'bash');
    assert.equal(lexed.ok, true, row);
    const word = lexed.ok ? lexed.statements.at(-1)!.words[1]! : undefined;
    assert.ok(word && (word.glob || word.dynamic || word.home), `${row}: 展開される語に印が付いていない`);
    const real = spawnSync(bashPath!, ['--noprofile', '--norc', '-c', `printf '<%s>\\n'${row.slice(4)}`], { cwd: dir, encoding: 'utf8' });
    assert.notDeepEqual(real.stdout.replace(/\n$/u, '').split('\n').map(l => l.replace(/^<|>$/gu, '')), [word!.text], `${row}: 本物は展開しない（印が不要）`);
  }
});

// Windows の Git Bash に -c で渡すと、連続する \\ が 1 つに減る（msys が引数を読み直す。\ 1 つは減らない）ので、本物の bash の読み方はスクリプトのファイルで渡して見る。
// 実際の実行（bash -c）で何が起きるかは、下の「Windows」の試験で別に確かめる
function viaFile(dir: string, script: string): { stdout: string; status: number | null; stderr: string } {
  const file = join(dir, 'script.sh');
  writeFileSync(file, script);
  return spawnSync(bashPath!, ['--noprofile', '--norc', file], { cwd: join(dir, 'cwd'), encoding: 'utf8' });
}
const scratch = (t: { after: (fn: () => void) => void }): string => { const dir = tempDir(t); mkdirSync(join(dir, 'cwd')); return dir; };

test('bash: "…" の中の \\ の読み方（\\. \\n \\| \\$ \\` \\" \\\\ 改行の前・行末）が、本物の bash が printf に渡す語と同じ', { skip: !bashPath && 'bash が無い' }, t => {
  const dir = scratch(t);
  const wrong: string[] = [];
  for (const row of BASH_DQ_ROWS) {
    const lexed = lexShell(row, 'bash');
    if (!lexed.ok) { wrong.push(`${row}: 読めない (${lexed.fail.code})`); continue; }
    const st = lexed.statements[0]!;
    const name = st.words[0]!.text;
    const real = viaFile(dir, `printf '<%s>\\n'${row.slice(row.indexOf(name) + name.length)}`);
    if (real.status !== 0) { wrong.push(`${row}: 本物の bash が失敗 ${real.stderr.trim()}`); continue; }
    const realWords = real.stdout.replace(/\n$/u, '').split('\n').map(line => line.replace(/^<|>$/gu, ''));
    const mine = st.words.slice(1).map(w => w.text);
    if (JSON.stringify(mine) !== JSON.stringify(realWords)) wrong.push(`${row}: 字句 ${JSON.stringify(mine)} / 本物 ${JSON.stringify(realWords)}`);
  }
  assert.deepEqual(wrong, []);
  assert.equal(lexShell('echo "a\\', 'bash').ok, false, '行末の \\ は引用符が閉じず、読めない');
});

test('bash: echo "\\$(rm x)" は本物の bash でも文字を出すだけで何も動かさない。\\\\ のあとの $( は本物の置換として動く（字句の読み取りの読み方と同じ）', { skip: !bashPath && 'bash が無い' }, t => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'cwd', 'x'), '');
  const literal = viaFile(dir, 'echo "\\$(rm x)"');
  assert.equal(literal.stdout, '$(rm x)\n');
  assert.equal(existsSync(join(dir, 'cwd', 'x')), true, '\\$ は置換にならず、x は消えない');
  const lexed = lexShell('echo "\\$(rm x)"', 'bash');
  assert.ok(lexed.ok && lexed.statements.length === 1 && lexed.statements[0]!.words[1]!.text === '$(rm x)' && !lexed.statements[0]!.words[1]!.dynamic, '字句の読み取りも、置換のない 1 つの文として読む');
  const real = viaFile(dir, 'echo "\\\\$(touch made)"');
  assert.equal(real.stdout, '\\\n', '\\\\ は \\ 1 つになり、そのあとの $( は本物の置換（touch の出力は空）');
  assert.equal(existsSync(join(dir, 'cwd', 'made')), true, '本物の置換は動く');
  const lexedReal = lexShell('echo "\\\\$(touch made)"', 'bash');
  assert.ok(lexedReal.ok && lexedReal.statements.map(s => s.words[0]!.text).join() === 'touch,echo', '字句の読み取りも、置換の中の touch を文として読む');
});

// Windows の Git Bash に bash -c で渡すと、"…" の中の連続する \\ は 1 つに減る。Clive のシェルは、スクリプトを標準入力で渡す（runner.ts）ので減らず、ファイルで渡した結果と同じになる
test('bash（Windows）: 素の bash -c は連続する \\\\ を 1 つに減らす。Clive のシェルの渡し方（標準入力）は、ファイルで渡した結果と同じで、ガードの読みどおりに動く', { skip: (process.platform !== 'win32' || !bashPath) && 'Windows の Git Bash が無い' }, async t => {
  const dir = scratch(t);
  const spec = resolveShell('bash');
  const viaC = (script: string) => spawnSync(bashPath!, ['--noprofile', '--norc', '-c', script], { cwd: join(dir, 'cwd'), encoding: 'utf8' });
  const viaClive = (script: string) => runProcess(spec.file, spec.args(script), { cwd: join(dir, 'cwd'), env: scrubEnv(), timeoutMs: 30_000, signal: new AbortController().signal, maxBytes: 100_000, ...(spec.stdin ? { input: spec.stdin(script) } : {}) });
  const dangerous = 'echo "\\\\\\$(touch made3)"';
  assert.equal(viaFile(dir, dangerous).stdout, '\\$(touch made3)\n', '前提: ファイルで渡せば、置換にならず文字を出すだけ');
  assert.equal(existsSync(join(dir, 'cwd', 'made3')), false);
  assert.equal(viaC(dangerous).stdout, '\\\n', '前提: -c で渡すと \\\\ が減って、$( が本物の置換になる');
  assert.equal(existsSync(join(dir, 'cwd', 'made3')), true, '前提: -c では置換の touch が動く');
  rmSync(join(dir, 'cwd', 'made3'));
  assert.equal((await viaClive(dangerous)).stdout, '\\$(touch made3)\n', 'Clive のシェルの渡し方では、置換にならず文字を出すだけ');
  assert.equal(existsSync(join(dir, 'cwd', 'made3')), false, 'Clive のシェルで置換の touch が動いた');
  const differ: string[] = [];
  for (const row of BASH_DQ_ROWS) {
    const script = `printf '<%s>\\n'${row.slice(row.indexOf(' '))}`;
    const c = viaC(script);
    const f = viaFile(dir, script);
    const clive = await viaClive(script);
    assert.equal(clive.stdout, f.stdout, `${row}: Clive のシェルの結果が、ファイルで渡した結果と違う`);
    if (c.stdout !== f.stdout) differ.push(row);
    const lexed = lexShell(row, 'bash');
    assert.ok(lexed.ok, `${row}: 読めない`);
    if (lexed.ok) assert.deepEqual(clive.stdout.replace(/\n$/u, '').split('\n').map(l => l.replace(/^<|>$/gu, '')), lexed.statements[0]!.words.slice(1).map(w => w.text), `${row}: ガードの読みどおりに動く`);
  }
  assert.ok(differ.length > 0, '前提: \\\\ を含む行は -c で結果が変わる');
  assert.ok(differ.every(row => row.includes('\\\\')), `\\\\ を含まない行が -c で変わった: ${differ.filter(row => !row.includes('\\\\')).join(' / ')}`);
});

function psHost(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'echo ok'], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout.trim() === 'ok' ? 'powershell.exe' : undefined;
}

const SEP = '\u001f';
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$lines = [System.IO.File]::ReadAllLines($env:CLIVE_LEX_IN, [System.Text.Encoding]::UTF8)
for ($i = 0; $i -lt $lines.Count; $i++) {
  $errors = $null; $tokens = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($lines[$i], [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) { Write-Output ("ERR|" + $i); continue }
  $cmds = $ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.CommandAst] }, $true)
  foreach ($cmd in $cmds) {
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($e in $cmd.CommandElements) {
      if ($e -is [System.Management.Automation.Language.CommandParameterAst]) {
        $parts.Add('-' + $e.ParameterName)
        if ($e.Argument -ne $null) { if ($e.Argument -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $parts.Add($e.Argument.Value) } else { $parts.Add($e.Argument.Extent.Text) } }
      } elseif ($e -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $parts.Add($e.Value) }
      elseif ($e -is [System.Management.Automation.Language.ConstantExpressionAst]) { $parts.Add($e.Extent.Text) }
      else { $parts.Add('<<dyn>>') }
    }
    Write-Output ("CMD|" + $i + "|" + ($parts -join [string][char]31))
  }
}
`;

const host = psHost();

test('PowerShell 5.1: 字句の読み取りが読んだコマンドの語は、本物の Parser が読む語と同じ', { skip: !host && 'Windows の PowerShell が無い' }, t => {
  const dir = tempDir(t);
  const input = join(dir, 'in.txt');
  writeFileSync(input, PS_ROWS.join('\n'), 'utf8');
  const real = spawnSync(host!, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PS_SCRIPT, 'utf16le').toString('base64')], { encoding: 'utf8', env: { ...process.env, CLIVE_LEX_IN: input } });
  assert.equal(real.status, 0, real.stderr);
  const byRow = new Map<number, string[][]>();
  const errored = new Set<number>();
  for (const line of real.stdout.split(/\r?\n/u)) {
    const parts = line.split('|');
    if (parts[0] === 'ERR') { errored.add(Number(parts[1])); continue; }
    if (parts[0] !== 'CMD') continue;
    const i = Number(parts[1]);
    byRow.set(i, [...(byRow.get(i) ?? []), parts.slice(2).join('|').split(SEP)]);
  }
  const wrong: string[] = [];
  for (const [i, row] of PS_ROWS.entries()) {
    if (errored.has(i)) { wrong.push(`${row}: 本物の Parser が構文エラー`); continue; }
    const lexed = lexShell(row, 'powershell');
    if (!lexed.ok) { wrong.push(`${row}: 読めない (${lexed.fail.code})`); continue; }
    const mine = lexed.statements.filter(s => s.kind === 'command').map(s => s.words.map(w => (w.dynamic ? '<<dyn>>' : w.text)));
    const theirs = byRow.get(i) ?? [];
    const key = (list: string[][]) => list.map(w => JSON.stringify(w)).sort();
    if (JSON.stringify(key(mine)) !== JSON.stringify(key(theirs))) wrong.push(`${row}: 字句 ${JSON.stringify(mine)} / 本物 ${JSON.stringify(theirs)}`);
  }
  assert.deepEqual(wrong, []);
});

test('PowerShell 5.1: 本物の Parser が違う語に読む書き方（曲がった引用符・ハイフンの仲間・NBSP・バッククォート）は、字句の読み取りが止める', { skip: !host && 'Windows の PowerShell が無い' }, t => {
  const rows = ['Write-Output ‘a b’', 'Write-Output “a b”', 'Get-ChildItem –Path x', 'Write-Output a b', 'Write-Output a`nb', 'Write-Output "a`"b"', 'Write-Output --% x y'];
  const dir = tempDir(t);
  const input = join(dir, 'in.txt');
  writeFileSync(input, rows.join('\n'), 'utf8');
  const real = spawnSync(host!, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PS_SCRIPT, 'utf16le').toString('base64')], { encoding: 'utf8', env: { ...process.env, CLIVE_LEX_IN: input } });
  assert.equal(real.status, 0, real.stderr);
  const realOf = (i: number): string[] | undefined => real.stdout.split(/\r?\n/u).filter(l => l.startsWith(`CMD|${i}|`)).map(l => l.split('|').slice(2).join('|'))[0]?.split(SEP);
  // 本物は引用符・ハイフンとして読む（空白で割った素朴な読み方とは語の数が違う）
  assert.deepEqual(realOf(0), ['Write-Output', 'a b']);
  assert.deepEqual(realOf(1), ['Write-Output', 'a b']);
  assert.deepEqual(realOf(2), ['Get-ChildItem', '-Path', 'x']);
  assert.equal(realOf(3)?.length, 3, 'NBSP は区切りとして読まれる');
  for (const row of rows) assert.equal(lexShell(row, 'powershell').ok, false, `${row} は読めない形として止める`);
});

test('字句の読み取りが止める形は、PowerShell 7 でも bash でも止める（シェルによらない）', () => {
  const rows = ['echo ‘a’', 'echo “a”', 'ls –la', 'echo a b', 'echo a​b', 'echo ＂a＂'];
  for (const shell of ['powershell', 'pwsh', 'bash', 'sh'] as ShellKind[]) for (const row of rows) assert.equal(lexShell(row, shell).ok, false, `${shell}: ${row}`);
});

const PS_COUNT_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$rows = $env:CLIVE_ROWS | ConvertFrom-Json
foreach ($s in $rows) {
  $errors = $null; $tokens = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($s, [ref]$tokens, [ref]$errors)
  $cmds = @($ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.CommandAst] }, $true))
  Write-Output ("" + $cmds.Count + "|" + (($cmds | ForEach-Object { $_.CommandElements.Count }) -join ','))
}
`;

// 審査で見つかった: CR 1 つは文の区切り、U+0085・U+2028・U+2029 は語の区切り。字句の読み取りは、どれも止める
test('PowerShell 5.1: 本物の Parser が文や語を分ける文字（CR 1 つ・U+0085・U+2028・U+2029）を、字句の読み取りは止める', { skip: !host && 'Windows の PowerShell が無い' }, () => {
  const rows = ['Write-Output a\rnode p.js', 'Set-Content README.md\rx', 'Write-Output a\u0085b', 'Write-Output a b', 'Write-Output a b'];
  const real = spawnSync(host!, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PS_COUNT_SCRIPT, 'utf16le').toString('base64')], { encoding: 'utf8', env: { ...process.env, CLIVE_ROWS: JSON.stringify(rows) } });
  assert.equal(real.status, 0, real.stderr);
  const counts = real.stdout.split(/\r?\n/u).filter(l => /^\d+\|/u.test(l));
  assert.deepEqual(counts, ['2|2,2', '2|2,1', '1|3', '1|3', '1|3'], '本物は CR で文を分け、U+0085 などで語を分ける');
  for (const row of rows) for (const shell of ['powershell', 'pwsh', 'bash', 'sh'] as ShellKind[]) assert.equal(lexShell(row, shell).ok, false, `${shell}: ${JSON.stringify(row)} は止める`);
  // CRLF は本物も 1 つの改行として読む
  const crlf = spawnSync(host!, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PS_COUNT_SCRIPT, 'utf16le').toString('base64')], { encoding: 'utf8', env: { ...process.env, CLIVE_ROWS: JSON.stringify(['Write-Output a\r\nWrite-Output b']) } });
  assert.match(crlf.stdout, /^2\|2,2$/mu);
  const mine = lexShell('Write-Output a\r\nWrite-Output b', 'powershell');
  assert.ok(mine.ok && mine.statements.length === 2 && mine.statements.every(s => s.words.length === 2));
});

// "…" の中の $( … ) は、中の文を本物の Parser と同じに読む（§11.15）。複数行の行・ヒア文字列を含む行があるので、JSON の配列で渡す
const PS_DQ_ROWS = [
  'Write-Output "$($x.Name)"', 'Write-Output "$(Get-Date)"', 'Write-Output "a$($b)c"', 'Write-Output "$("x $($y)")"', 'Write-Output "$(rm x)"', 'Write-Output "$(Set-Content SOUL.md x)"',
  '"$($x.Name)"', '"$(Get-Date)"', '"a$($b)c"', '"$("x $($y)")"', '"$(rm x)"', '"$(Set-Content SOUL.md x)"',
  'Write-Output "$(Get-Date -Format yyyy)"', 'Write-Output "名前は $($x.Name)"', 'Write-Output "$($f.Length) bytes"', 'Get-ChildItem | ForEach-Object { "$($_.Name) $($_.Length)" }',
  'Write-Output "$(Get-Date)-$(Get-Location)"', "Write-Output \"$(Write-Output '(a)')\"", "Write-Output \"$(Write-Output '\"')\"", "Write-Output \"$(Write-Output \"'\")\"", 'Write-Output "$(\nGet-Date\nGet-Location\n)"', 'Write-Output "a$()b"',
  "Write-Output \"a$(@'\nx\n'@)b\"", 'Write-Output "$(Get-Date)" "$(Get-Location)"', 'Write-Host "$(1) $(2)"', 'Write-Output "$(Get-Date -Format "yyyy-MM")"', 'Write-Output "$(Write-Output "a b")"',
  'Write-Output "$(Write-Output "$(Write-Output "deep")")"', 'Write-Output "$(Get-Date)$(Get-Location)x"', 'Write-Output "$( Get-Date )"', 'Write-Output "$(Get-Date;Get-Location)"', 'Write-Output "$(Get-Date | Out-String)"',
  'Write-Output "$((Get-Date).Year)"', 'Write-Output "$(Write-Output $(Get-Date))"', 'Write-Output "$(Write-Output (Get-Date))"', 'Write-Output "$(1,2)"', 'Write-Output "$(@(1,2).Count)"', 'Write-Output "$("a" + "b")"', 'Write-Output "x$([int]1)"', 'Get-Content "$(Get-Date).txt"', 'Set-Content "$(Get-Date).txt" x',
  'Write-Output "$(Remove-Item x)"', 'Write-Output "$(iex \'x\')"', 'Write-Output "a""b$(Get-Date)"', 'Write-Output "$(Get-Date)""$(Get-Location)"', 'Write-Output "$(\'a\'.ToUpper())"',
  'Write-Output "$(if ($true) { Get-Date })"', 'Write-Output "$(foreach ($i in 1,2) { Get-Date })"', 'Write-Output "$(Get-ChildItem | ForEach-Object { $_.Name })"',
  // "$$"（直前の最後の語）と "$^"（最初の語）は本物も変数として展開する。"$-" "$*" "$" だけなどは文字のまま
  'Write-Output "$$"', 'Write-Output "$^"', 'Write-Output "a$$b"', 'Write-Output "a$^b"', 'Write-Output "$$.txt"', 'Write-Output "$-"', 'Write-Output "$*"', 'Write-Output "a$"', 'Write-Output "$ b"', 'Write-Output "$#"', 'Write-Output "100$"',
];

const PS_DQ_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$rows = $env:CLIVE_ROWS | ConvertFrom-Json
for ($i = 0; $i -lt $rows.Count; $i++) {
  $errors = $null; $tokens = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($rows[$i], [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) { Write-Output ("ERR|" + $i); continue }
  $cmds = $ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.CommandAst] }, $true)
  foreach ($cmd in $cmds) {
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($e in $cmd.CommandElements) {
      if ($e -is [System.Management.Automation.Language.CommandParameterAst]) {
        $parts.Add('-' + $e.ParameterName)
        if ($e.Argument -ne $null) { if ($e.Argument -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $parts.Add($e.Argument.Value) } else { $parts.Add($e.Argument.Extent.Text) } }
      } elseif ($e -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $parts.Add($e.Value) }
      elseif ($e -is [System.Management.Automation.Language.ConstantExpressionAst]) { $parts.Add($e.Extent.Text) }
      else { $parts.Add('<<dyn>>') }
    }
    Write-Output ("CMD|" + $i + "|" + ($parts -join [string][char]31))
  }
}
`;

function realWordsOf(rows: readonly string[]): { byRow: Map<number, string[][]>; errored: Set<number> } {
  const real = spawnSync(host!, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PS_DQ_SCRIPT, 'utf16le').toString('base64')], { encoding: 'utf8', env: { ...process.env, CLIVE_ROWS: JSON.stringify(rows) } });
  assert.equal(real.status, 0, real.stderr);
  const byRow = new Map<number, string[][]>();
  const errored = new Set<number>();
  for (const line of real.stdout.split(/\r?\n/u)) {
    const parts = line.split('|');
    if (parts[0] === 'ERR') { errored.add(Number(parts[1])); continue; }
    if (parts[0] !== 'CMD') continue;
    const i = Number(parts[1]);
    byRow.set(i, [...(byRow.get(i) ?? []), parts.slice(2).join('|').split(SEP)]);
  }
  return { byRow, errored };
}

test('PowerShell 5.1: "…" の中の $( … ) は、字句の読み取りが読んだコマンド（中の文を含む）の語が、本物の Parser と同じ', { skip: !host && 'Windows の PowerShell が無い' }, () => {
  const { byRow, errored } = realWordsOf(PS_DQ_ROWS);
  const wrong: string[] = [];
  for (const [i, row] of PS_DQ_ROWS.entries()) {
    if (errored.has(i)) { wrong.push(`${row}: 本物の Parser が構文エラー`); continue; }
    for (const shell of ['powershell', 'pwsh'] as ShellKind[]) {
      const lexed = lexShell(row, shell);
      if (!lexed.ok) { wrong.push(`${shell}: ${row}: 読めない (${lexed.fail.code})`); continue; }
      const mine = lexed.statements.filter(s => s.kind === 'command').map(s => s.words.map(w => (w.dynamic ? '<<dyn>>' : w.text)));
      const theirs = byRow.get(i) ?? [];
      const key = (list: string[][]) => list.map(w => JSON.stringify(w)).sort();
      if (JSON.stringify(key(mine)) !== JSON.stringify(key(theirs))) wrong.push(`${shell}: ${row}: 字句 ${JSON.stringify(mine)} / 本物 ${JSON.stringify(theirs)}`);
    }
  }
  assert.deepEqual(wrong, []);
});

// 本物の Parser が読めるが、字句の読み取りは読みきれないとして止める形（止めるのが正しい側）。止める形が本物の Parser でどう読まれるかも見て、取り違えが無いことを確かめる
test('PowerShell 5.1: "…" の中の $( の読みきれない形（${・$$(・コメント・@" "@・閉じない）を、字句の読み取りは止める。本物の Parser の読みとの違いを確かめる', { skip: !host && 'Windows の PowerShell が無い' }, () => {
  const rows = [
    'Write-Output "${env:PATH}"', 'Write-Output "$$(Get-Date)"', 'Write-Output "$$$(Get-Date)"', 'Write-Output "$(Get-Date # c\n)"', 'Write-Output "$(@"\nx\n"@)"', 'Write-Output "$(Get-Date"', 'Write-Output "a`$(Get-Date)"', 'Write-Output "$(Get-Date `n)"',
    'Write-Output "$("$("$("$("$(1)")")")")"',
    "Write-Output \"$(Write-Output ')')\"", "Write-Output \"$(Write-Output '(')\"", 'Write-Output "$(Write-Output ")")"', 'Write-Output "$(Write-Output "(")"', "Write-Output \"a$(@'\nx)\n'@)b\"", 'Write-Output "$(Get-Date # )\n)"',
  ];
  const { byRow, errored } = realWordsOf(rows);
  for (const row of rows) for (const shell of ['powershell', 'pwsh'] as ShellKind[]) assert.equal(lexShell(row, shell).ok, false, `${shell}: ${JSON.stringify(row)} は止める`);
  // 取り違えの確認: $$( は $$ という変数と文字の ( … )（中は実行されない）、$$$( は $$ のあとの本物の置換（実行される）、コメントの中の ) は閉じない
  assert.deepEqual(byRow.get(1) ?? [], [['Write-Output', '<<dyn>>']], '$$( は置換ではない（読み違えても中の文は動かない側）');
  assert.deepEqual((byRow.get(2) ?? []).map(c => c[0]).sort(), ['Get-Date', 'Write-Output'], '$$$( のあとの $( は本物の置換');
  assert.deepEqual((byRow.get(3) ?? []).map(c => c[0]).sort(), ['Get-Date', 'Write-Output'], 'コメントの中の ) は閉じず、次の行の ) で閉じる');
  assert.ok(errored.has(5), '閉じない $( は本物の Parser も構文エラー');
  assert.deepEqual(byRow.get(0) ?? [], [['Write-Output', '<<dyn>>']], '${…} は変数（読めるが、字句の読み取りは止める側）');
  assert.deepEqual(byRow.get(6) ?? [], [['Write-Output', 'a$(Get-Date)']], 'バッククォートで打ち消した $( は文字');
  // 本物の Parser は、"…" の中の $( の終わりを、引用符やコメントに関わらず ( と ) の数だけで決める。括弧が引用符・ヒア文字列・コメントの中にある形は、本物は構文エラーになる（読み方が割れる）ので、字句の読み取りは止める
  for (const i of [9, 10, 11, 12, 13, 14]) assert.ok(errored.has(i), `${rows[i]}: 本物の Parser は ( ) を数だけで数えるので構文エラー`);
});
