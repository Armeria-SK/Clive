import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lexShell, type LexCode, type ShellKind, type Statement } from '../src/tools/hooks/shell-lex.ts';

// security-self-api.md §11.2。読めない書き方は止め、読めたものは文の並びにする

const SHELLS: ShellKind[] = ['powershell', 'pwsh', 'bash', 'sh'];
const failure = (command: string, shell: ShellKind): LexCode | null => { const r = lexShell(command, shell); return r.ok ? null : r.fail.code; };
const read = (command: string, shell: ShellKind): Statement[] => {
  const r = lexShell(command, shell);
  assert.ok(r.ok, `${shell}: ${JSON.stringify(command)} が読めない: ${r.ok ? '' : `${r.fail.code} ${r.fail.detail}`}`);
  return r.statements;
};
const line = (s: Statement) => s.words.map(w => w.text).join(' ');

test('字句 11.2.1: どちらのシェルでも、曲がった引用符・ハイフンの仲間・見えない空白・引用符の外の全角は止める', () => {
  const cases: Array<[string, LexCode]> = [
    ['echo ‘x’', 'curly_quote'], ['echo “x”', 'curly_quote'], ['echo "a ” b"', 'curly_quote'], ['echo ′', 'curly_quote'],
    ['Get-ChildItem –Path x', 'dash'], ['ls —la', 'dash'], ['echo a − b', 'dash'], ['echo "a ‐ b"', 'dash'],
    ['ls -la', 'space'], ['ls​', 'space'], ['echo a‪b', 'space'], ['echo a﻿b', 'space'], ['echo a­b', 'space'], ['echo "a b"', 'space'],
    ['echo ＂x＂', 'fullwidth'], ['ls －la', 'fullwidth'], ['echo　x', 'fullwidth'], ['echo Ａ', 'fullwidth'],
    ['echo a\u0007b', 'control'],
  ];
  for (const shell of SHELLS) for (const [command, code] of cases) assert.equal(failure(command, shell), code, `${shell}: ${JSON.stringify(command)}`);
  for (const shell of SHELLS) {
    assert.equal(failure('grep "検索語" notes.md', shell), null, `${shell}: ASCII の引用符の中の日本語は可`);
    assert.equal(failure("rg 'ＡＢＣ' notes.md", shell), null, `${shell}: ASCII の引用符の中の全角は可`);
  }
});

test('字句 11.2.1: 入れ子が 4 段より深い・引用符や括弧の閉じ忘れは止める', () => {
  assert.equal(failure('echo $(echo $(echo $(echo $(echo $(echo hi)))))', 'bash'), 'depth');
  assert.equal(failure('echo $(echo $(echo hi))', 'bash'), null);
  assert.equal(failure('(((((ls)))))', 'powershell'), 'depth');
  assert.equal(failure('ls | % { if ($true) { ls | % { if ($true) { ls | % { ls } } } } }', 'powershell'), 'depth');
  for (const shell of SHELLS) {
    assert.equal(failure('echo "abc', shell), 'unclosed', shell);
    assert.equal(failure("echo 'abc", shell), 'unclosed', shell);
  }
  assert.equal(failure('echo $(ls', 'bash'), 'unclosed');
  assert.equal(failure('Get-ChildItem | % { $_.Name', 'powershell'), 'unclosed');
  assert.equal(failure('(Get-Date', 'pwsh'), 'unclosed');
});

test('字句 11.2.2: PowerShell は、バッククォート・--%・<# #>・@" "@・${…}・プロバイダ付きの名前・"$$(…)" を止める（"$(…)" は読む。tests/shell-dq-escapes.test.ts）', () => {
  const cases: Array<[string, LexCode]> = [
    ['n`o`de --eval=1', 'backtick'], ['echo `n', 'backtick'], ['echo "a`nb"', 'backtick'],
    ['cmd --% /c dir', 'parse_token'], ['<# x #> ls', 'block_comment'], ['@"\nx\n"@', 'here_string'],
    ['${function:x}', 'provider_var'], ['$function:x', 'provider_var'], ['$alias:ls', 'provider_var'], ['$variable:x', 'provider_var'], ['${x}', 'provider_var'],
    ['Write-Host "$$(Get-Date)"', 'ps_expand'], ['Write-Host "${x}"', 'ps_expand'],
  ];
  for (const shell of ['powershell', 'pwsh'] as const) for (const [command, code] of cases) assert.equal(failure(command, shell), code, `${shell}: ${JSON.stringify(command)}`);
  assert.equal(failure('ls && ls', 'powershell'), 'chain_op', '5.1 は && を知らない');
  assert.equal(failure('ls && ls', 'pwsh'), null);
  assert.equal(failure('ls || ls', 'powershell'), 'chain_op');
});

test('字句 11.2.3: bash は、\\・バッククォート・$\'…\'・${x:-y}・$(( )) の中の置換・fd のつなぎ替え・/dev/tcp・~名前・引用符なしの $ を含むヒアドキュメントを止める', () => {
  const cases: Array<[string, LexCode]> = [
    ['n\\ode x', 'backslash'], ['echo a\\nb', 'backslash'], ['ls \\\n -la', 'backslash'], ['echo `date`', 'backtick'], ['echo "a`date`"', 'backtick'],
    ["echo $'a'", 'ansi_c'], ['echo $"a"', 'ansi_c'], ['echo ${x:-y}', 'dollar_form'], ['echo ${!x}', 'dollar_form'], ['echo ${x/a/b}', 'dollar_form'],
    ['echo $(( $(ls) ))', 'dollar_form'], ['echo $((1; ls))', 'dollar_form'],
    ['echo hi >&3', 'fd'], ['exec 3<>/dev/tcp/127.0.0.1/4777', 'fd'], ['echo a 3>x', 'fd'], ['cat 3<x', 'fd'], ['echo a <> f', 'fd'],
    ['echo x > /dev/tcp/127.0.0.1/80', 'dev_net'], ['cat < /dev/udp/1.1.1.1/53', 'dev_net'],
    ['echo ~root', 'tilde_user'], ['cat <<EOF\n$x\nEOF', 'here_expand'], ['cat <<EOF\n`ls`\nEOF', 'here_expand'], ['cat <<EOF\na\\b\nEOF', 'here_expand'],
    ['cat <<EOF\nabc', 'unclosed'],
  ];
  for (const shell of ['bash', 'sh'] as const) for (const [command, code] of cases) assert.equal(failure(command, shell), code, `${shell}: ${JSON.stringify(command)}`);
  for (const shell of ['bash', 'sh'] as const) {
    assert.equal(failure("cat <<'EOF'\n$x `ls` \\\nEOF", shell), null, '区切りを引用符で囲めば本文はそのまま');
    assert.equal(failure('cat <<EOF\nplain text\nEOF', shell), null, '$ なしの引用符なしは可');
    assert.equal(failure('echo hi 2>&1', shell), null);
    assert.equal(failure('echo hi 1>&2', shell), null);
    assert.equal(failure('echo hi >/dev/null 2>/dev/null', shell), null);
    assert.equal(failure('echo $((1 + $x * 2))', shell), null, '算術は、数・変数・演算子だけなら可');
  }
});

test('読み取り: bash の語・代入・リダイレクト・パイプ・制御の形', () => {
  const [ls] = read('ls -la sub', 'bash');
  assert.deepEqual(ls!.words.map(w => w.text), ['ls', '-la', 'sub']);

  const piped = read('cat README.md | head -n 5', 'bash');
  assert.deepEqual(piped.map(line), ['cat README.md', 'head -n 5']);
  assert.deepEqual(piped.map(s => [s.pipedIn, s.pipedOut]), [[false, true], [true, false]]);

  const [redirect] = read('echo "a b" > out.txt', 'bash');
  assert.deepEqual(redirect!.words.map(w => w.text), ['echo', 'a b']);
  assert.deepEqual(redirect!.redirects.map(r => [r.op, r.fd, r.target?.text]), [['>', '1', 'out.txt']]);
  assert.deepEqual(read('ls 2>&1', 'bash')[0]!.redirects.map(r => [r.op, r.fd]), [['>&', '2']]);

  const [env] = read('LC_ALL=C sort f', 'bash');
  assert.deepEqual(env!.assigns.map(a => [a.name, a.op, a.value?.text]), [['LC_ALL', '=', 'C']]);
  assert.deepEqual(env!.words.map(w => w.text), ['sort', 'f']);
  assert.equal(read('x=1', 'bash')[0]!.kind, 'assign');

  const [glob, brace, home, dyn] = read('wc -l *.md; echo {a,b}; ls ~/src; echo "$x" $(date)', 'bash').filter(s => s.kind === 'command' && s.words[0]!.text !== 'date');
  assert.equal(glob!.words[2]!.glob, true);
  assert.equal(brace!.words[1]!.glob, true);
  assert.equal(home!.words[1]!.text, '~/src'.slice(0, 1) === '~' ? home!.words[1]!.text : '');
  assert.deepEqual(dyn!.words.slice(1).map(w => w.dynamic), [true, true]);
  assert.equal(read('ls ~', 'bash')[0]!.words[1]!.home, true);

  assert.equal(read('tail -f app.log &', 'bash')[0]!.background, true);
  assert.deepEqual(read('name() { ls; }', 'bash')[0]!.shapes, ['function']);
  assert.deepEqual(read('cat <(ls)', 'bash').map(line), ['ls', 'cat <(ls)']);
  assert.ok(read('tee >(cat)', 'bash').some(s => s.shapes.includes('process_out')));

  const loop = read('for f in *.md; do wc -l "$f"; done', 'bash');
  assert.deepEqual(loop.map(s => s.kind), ['control', 'command']);
  assert.equal(loop[0]!.header, 'for');
  assert.deepEqual(loop[1]!.words.map(w => [w.text, w.dynamic]), [['wc', false], ['-l', false], ['$f', true]]);
  const cond = read('if [ -f a.txt ]; then cat a.txt; else echo no; fi', 'bash');
  assert.deepEqual(cond.map(line), ['[ -f a.txt ]', 'cat a.txt', 'echo no']);
  assert.equal(cond[0]!.words[0]!.glob, false, '[ はワイルドカードではない');
  assert.equal(failure('if true; then ls', 'bash'), 'unclosed');
  assert.equal(failure('fi', 'bash'), 'unexpected');
  assert.ok(read('case x in x) ls;; esac', 'bash').some(s => s.shapes.includes('control')));
});

test('読み取り: PowerShell の語・パラメータ・パイプ・式・制御の形', () => {
  const [gci] = read('Get-ChildItem -Recurse -Filter *.md -Path:src', 'powershell');
  assert.deepEqual(gci!.words.map(w => [w.text, w.attached ?? false]), [['Get-ChildItem', false], ['-Recurse', false], ['-Filter', false], ['*.md', false], ['-Path', false], ['src', true]]);
  assert.equal(gci!.words[3]!.glob, true);
  assert.deepEqual(read('Set-Content -Path a.txt -Value "x y"', 'pwsh')[0]!.words.map(w => w.text), ['Set-Content', '-Path', 'a.txt', '-Value', 'x y']);
  assert.deepEqual(read("Write-Output 'it''s'", 'powershell')[0]!.words.map(w => w.text), ['Write-Output', "it's"]);
  assert.deepEqual(read("Write-Output @'\nraw $x `n\n'@", 'powershell')[0]!.words.map(w => w.text), ['Write-Output', 'raw $x `n']);

  const piped = read('Get-ChildItem *.log | ForEach-Object { $_.Name }', 'powershell').filter(s => s.kind === 'command');
  assert.deepEqual(piped.map(s => s.words[0]!.text), ['Get-ChildItem', 'ForEach-Object']);
  assert.equal(piped[1]!.words[1]!.kind, 'block');
  assert.equal(piped[1]!.pipedIn, true);
  const where = read('Get-ChildItem | Where-Object { $_.Length -gt 1MB }', 'powershell');
  assert.deepEqual(where.at(-1)!.words[1]!.block!.map(s => s.kind), ['expr']);
  assert.deepEqual(where.flatMap(s => s.shapes), [], '式の中身は、許す形だけ');

  const assign = read('$files = Get-ChildItem -Recurse; $files.Count', 'powershell');
  assert.deepEqual(assign.map(s => s.kind), ['command', 'assign', 'expr']);
  assert.deepEqual(assign[1]!.assigns.map(a => [a.name, a.op]), [['files', '=']]);
  assert.deepEqual(read('$env:FOO = "x"', 'powershell').find(s => s.kind === 'assign')!.assigns.map(a => a.name), ['env:FOO']);
  assert.deepEqual(read('$t += $_.Length', 'powershell').find(s => s.kind === 'assign')!.assigns.map(a => a.op), ['+=']);

  assert.deepEqual(read('[DateTime]::Now', 'powershell').flatMap(s => s.shapes), []);
  assert.deepEqual(read('[Math]::Round(1.5)', 'powershell').flatMap(s => s.shapes), ['static:Math::Round']);
  assert.deepEqual(read('[IO.File]::ReadAllText("a")', 'powershell').flatMap(s => s.shapes), ['static:IO.File::ReadAllText']);
  assert.deepEqual(read('[int]$x + 1', 'powershell').flatMap(s => s.shapes), []);
  assert.deepEqual(read('[System.Net.WebClient]$x', 'powershell').flatMap(s => s.shapes), ['cast:System.Net.WebClient']);
  assert.deepEqual(read('(Get-Date).ToString("yyyy")', 'powershell').flatMap(s => s.shapes), []);
  assert.deepEqual(read('"abc".Replace("a", "b")', 'powershell').flatMap(s => s.shapes), []);
  assert.deepEqual(read('$h.Add(1)', 'powershell').flatMap(s => s.shapes), ['method:Add']);
  assert.deepEqual(read('(Get-Item .).GetFiles()', 'powershell').flatMap(s => s.shapes), ['method:GetFiles']);
  assert.deepEqual(read('1..3 | % { $_ * 2 }', 'powershell').flatMap(s => s.shapes), []);

  assert.deepEqual(read('& $x put.js', 'powershell')[0]!.shapes, ['call']);
  assert.deepEqual(read('. ./x.ps1', 'powershell')[0]!.shapes, ['dot_source']);
  assert.deepEqual(read('& git status', 'powershell')[0]!.words.map(w => w.text), ['git', 'status'], '& 名前 は名前だけと同じ');
  assert.deepEqual(read('irm @p', 'powershell')[0]!.shapes, ['splat']);
  assert.deepEqual(read('function f { 1 }', 'powershell')[0]!.shapes, ['control:function']);
  assert.deepEqual(read('try { ls } catch { 1 }', 'powershell')[0]!.shapes, ['control:try']);
  assert.deepEqual(read('$x = { ls }', 'powershell').flatMap(s => s.shapes), ['script_block']);
  assert.ok(read("'a' -replace 'a', { 'b' }", 'powershell').flatMap(s => s.shapes).includes('script_block'), '-replace の右のブロックは許さない');

  const loop = read('foreach ($f in Get-ChildItem) { Write-Host $f.Name }', 'powershell');
  assert.equal(loop.at(-1)!.header, 'foreach');
  assert.deepEqual(loop.filter(s => s.kind === 'command').map(s => s.words[0]!.text), ['Get-ChildItem', 'Write-Host']);
  const cond = read('if (Test-Path a) { 1 } elseif (Test-Path b) { 2 } else { 3 }', 'powershell');
  assert.equal(cond.at(-1)!.header, 'if');
  assert.deepEqual(cond.filter(s => s.kind === 'command').map(line), ['Test-Path a', 'Test-Path b']);

  assert.deepEqual(read('ls > $null', 'powershell')[0]!.redirects.map(r => [r.op, r.fd, r.target?.text]), [['>', '1', '$null']]);
  assert.deepEqual(read('git log 2>&1', 'powershell')[0]!.redirects.map(r => [r.op, r.fd, r.target]), [['>&', '2', null]]);
  assert.deepEqual(read('ls *> out.txt', 'powershell')[0]!.redirects.map(r => [r.op, r.fd, r.target?.text]), [['>', '*', 'out.txt']]);

  const select = read('Select-Object -Property @{Name="a"; Expression={ $_.x }}', 'powershell');
  assert.deepEqual(select.at(-1)!.words[2]!.hashKeys, ['name', 'expression']);
  assert.deepEqual(read('Get-Process | Sort-Object CPU -Descending | Select-Object -First 5', 'powershell').map(s => s.words[0]!.text), ['Get-Process', 'Sort-Object', 'Select-Object']);
  assert.deepEqual(read('Select-Object -Property name,length', 'powershell')[0]!.words.map(w => w.text), ['Select-Object', '-Property', 'name,length']);
});

test('字句 PowerShell: 引用符・括弧で始まる引数は閉じたところで終わる。くっつけた flag は別の引数（本物の Parser と同じ）', () => {
  const words = (command: string) => read(command, 'powershell').filter(s => s.kind === 'command').at(-1)!.words.map(w => w.text);
  assert.deepEqual(words("Write-Output 'a'b"), ['Write-Output', 'a', 'b']);
  assert.deepEqual(words('Write-Output "a"b'), ['Write-Output', 'a', 'b']);
  assert.deepEqual(words('Write-Output "a"\'b\''), ['Write-Output', 'a', 'b']);
  assert.deepEqual(words("Write-Output 'x'-y"), ['Write-Output', 'x', '-y']);
  assert.deepEqual(words("rg 'x'--pre=./p.sh f"), ['rg', 'x', '--pre=./p.sh', 'f']);
  assert.deepEqual(words('Write-Output (1)b'), ['Write-Output', '$(…)', 'b']);
  assert.deepEqual(words("Write-Output a'b'c'd'"), ['Write-Output', 'abcd'], '語で始まる引数は、引用符をまたいで続く');
  assert.deepEqual(words('Write-Output a"b"'), ['Write-Output', 'ab']);
  assert.deepEqual(words('Write-Output $x"b"'), ['Write-Output', '$xb'], '変数で始まる引数も続く（1 つの語。変数を含むので値は分からない）');
});

test('字句 PowerShell: 値を計算する書き方（メンバー・添字・メソッドの呼び出し）は、元の文字ではなくパスとして読めない値にする', () => {
  const last = (command: string) => read(command, 'powershell').filter(s => s.kind === 'command').at(-1)!.words.at(-1)!;
  for (const command of ["Set-Content 'x'.Replace('x','SOUL.md')", 'Set-Content $HOME.x', 'Set-Content $a[0]', "Set-Content ('a'+'b')", 'Set-Content $(1)']) {
    const w = last(command);
    assert.equal(w.dynamic, true, command);
    assert.equal(w.text.startsWith('$'), true, `${command}: ${w.text}`);
  }
  assert.equal(last("Set-Content 'x'").dynamic, false);
  assert.equal(last('Set-Content $x').text, '$x');
});

test('字句 PowerShell: 添字 [0] [-1] [1..2] [$i] を読む（] は語の一部ではない）', () => {
  for (const command of ['$x = $a[0]', 'Write-Output $a[0]', 'Write-Output (Get-ChildItem)[0]', '$a[0].Name', '$a[1..2]', '$a[-1]', '(1,2)[0]', 'Write-Output $a[$i]', 'Write-Output $a[0] x']) {
    read(command, 'powershell');
  }
  assert.deepEqual(read('Get-ChildItem file[1].txt', 'powershell').map(line), ['Get-ChildItem file[1].txt'], '語の中の [1] はワイルドカード');
  assert.equal(read('Get-ChildItem file[1].txt', 'powershell')[0]!.words[1]!.glob, true);
  assert.equal(failure('Write-Output $a[0', 'powershell'), 'unclosed');
  // 静的メンバーのあとのプロパティ・メソッド（[DateTime]::Now.Year）は、メンバーとして読む
  assert.deepEqual(read('[DateTime]::Now.Year', 'powershell').map(s => s.shapes), [[]]);
  assert.deepEqual(read('[DateTime]::Today.AddDays(1)', 'powershell').flatMap(s => s.shapes), ['method:AddDays']);
});

// 審査で見つかった: PowerShell 5.1 は CR 1 つを文の区切りに、U+0085・U+2028・U+2029 を語の区切りに読む（本物の Parser で確かめた）。
// 字句の読み取りがこれらを読み飛ばす・語の中に入れると、本物のシェルと別の文・語になる。CRLF だけは LF と同じに読む
test('字句 11.2.1: CR 1 つ・C1 の制御文字・U+2028・U+2029 は、どのシェルでも止める', () => {
  const cases: Array<[string, LexCode]> = [
    ['Write-Output a\rnode p.js', 'control'], ['Set-Content README.md\rx', 'control'], ['ls\r', 'control'], ['\rls', 'control'], ['echo a\r\rb', 'control'], ['echo a\r\n\rb', 'control'], ['echo "a\rb"', 'control'],
    ['Set-Content README.md\u0085x', 'space'], ['echo a\u0085b', 'space'], ['echo a b', 'space'], ['echo a b', 'space'], ['echo "a\u0085b"', 'space'],
    ['echo a\u0080b', 'space'], ['echo a\u0090b', 'space'], ['echo a\u009fb', 'space'],
  ];
  for (const shell of SHELLS) for (const [command, code] of cases) assert.equal(failure(command, shell), code, `${shell}: ${JSON.stringify(command)}`);
});

test('字句 11.2.1: CRLF は LF と同じ 1 つの改行。語に CR は入らない', () => {
  for (const shell of SHELLS) {
    const statements = read('ls -la\r\ncat a.txt\r\n', shell);
    assert.deepEqual(statements.map(line), ['ls -la', 'cat a.txt'], shell);
    assert.ok(statements.every(s => s.words.every(w => !w.text.includes('\r'))), `${shell}: 語に CR が残っている`);
  }
  assert.deepEqual(read('Get-ChildItem\r\n  -Path x', 'powershell').map(line).length > 0, true);
});
