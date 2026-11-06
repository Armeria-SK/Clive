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

// 最終審査で再現: bash は $( … ) の中を文として読むので、語の頭の # はコメントで、中の ) では閉じない。echo "$(# )<改行>./pwn.sh)" は ./pwn.sh を動かすのに、
// コメントを知らない切り出しは ) で閉じて、./pwn.sh を引用符の中の文字として見逃した。$( … ) の終わりがずれうる形（コメント・引用符の中の括弧・case）は止める
test('字句 11.2.3: bash の $( … ) と <( … ) の中の語の頭の # のコメント・引用符の中の括弧・case は、終わりの読み方がずれるので止める', () => {
  const hidden = [
    'echo "$(# )\n./pwn.sh)"', 'echo "$(echo a # )\n./pwn.sh)"', 'x="$(# )\n./pwn.sh)"', 'echo "a$(#)\n./pwn.sh\n)"', 'echo "$(: # ) ;\n./pwn.sh)"', 'echo $(# )\n./pwn.sh)', 'cat <(# )\n./pwn.sh)',
    'echo "$(echo "$(# )\n./pwn.sh)")"', 'echo "$(true;#x\n)"', 'echo "$(echo a)$(echo b #c\n)"',
    'echo "$(echo ")")"', "echo $(echo ')')", "echo \"$(grep -c '(' f)\"", 'echo "$(echo "(")"',
    'echo "$(case x in x) ./pwn.sh;; esac)"', 'echo $(case x in x) echo hi;; esac)', 'echo "$(true; case x in x) ./pwn.sh;; esac)"',
  ];
  for (const shell of ['bash', 'sh'] as const) for (const command of hidden) assert.equal(failure(command, shell), 'bash_sub', `${shell}: ${JSON.stringify(command)}`);
  for (const command of [
    'echo "$(echo a#b)"', 'echo "$(echo $#)"', 'echo "$(echo "#")"', "echo \"$(echo '#')\"", 'echo $(printf "%s" "a # b")', 'echo "$(date) # not (a comment"', 'echo hi # comment ) (', 'echo $(date +%s)',
    'echo "$(git log --oneline | head -n 5)"', 'echo "$(echo $(echo a))"', 'echo $(echo "a b" | wc -w) # ok )',
  ]) assert.equal(failure(command, 'bash'), null, `${JSON.stringify(command)} は読める`);
  assert.ok(read('case x in x) ls;; esac', 'bash').some(s => s.shapes.includes('control')), 'トップレベルの case は今までどおり読んで、今回だけにする');
});

test('字句 11.2.3: bash の $(( は、2 つ目の ( に対応する ) の次がまた ) のときだけ算術。そうでなければ $( の中の部分シェルとして、中の文を読む', () => {
  for (const [command, expected] of [['echo $((1 + 2))', 'echo $((1 + 2))'], ['echo $(( (1 + 2) * 3 ))', 'echo $(( (1 + 2) * 3 ))'], ['echo "$((n * 2))"', 'echo $((n * 2))'], ['echo $((1+2))', 'echo $((1+2))']] as const) {
    assert.deepEqual(read(command, 'bash').map(line), [expected], command);
  }
  for (const command of ['echo "$((true)\n./pwn.sh))"', 'x=$((true)\n./pwn.sh)', 'echo "$((true)\n/tmp/pwn))"', 'echo "$((true) ./pwn.sh)"']) {
    const seen = read(command, 'bash').map(s => s.words[0]?.text);
    assert.ok(seen.includes('true') && seen.some(w => w === './pwn.sh' || w === '/tmp/pwn'), `${JSON.stringify(command)}: 中の文を読んでいない ${JSON.stringify(seen)}`);
  }
  assert.deepEqual(read('echo $((1+2) + (3))', 'bash').map(line), ['1+2', '+', '3', 'echo $((1+2) + (3))'], '算術にならない $(( は、中を文として読む');
  assert.equal(failure('echo $((true)', 'bash'), 'unclosed');
  assert.equal(failure('echo $(( $(ls) ))', 'bash'), 'dollar_form');
});

test('字句 11.2.3: bash は [[ ]] の中でも語の頭の # をコメントに読む（中の引用符で、あとの文を引用符の中の文字に見せかけさせない）', () => {
  for (const command of ['[[ -n x # "\n]] && ./pwn.sh; echo "a" # "\n]]', "[[ -n x # '\n]] && ./pwn.sh; echo '' # '\n]]"]) {
    const seen = read(command, 'bash').map(s => s.words[0]?.text);
    assert.ok(seen.includes('./pwn.sh'), `${JSON.stringify(command)}: ./pwn.sh を文として読んでいない ${JSON.stringify(seen)}`);
  }
  assert.equal(read('[[ -n x ]] && echo a#b', 'bash').length, 2);
  assert.deepEqual(read('[[ "$a" == "#" ]] && echo ok', 'bash').map(line), ['[[ $a == # ]]', 'echo ok']);
});

// 最終審査のあとの確認で再現: [[ x ]]; の ]]; を閉じとして読まず、then のあとの文を [[ の引数に隠せた。bash は ]] のすぐあとの ; & | ( ) < > で閉じ、次の語を文の頭と見る（then・do も言葉）
test('字句 11.2.3: bash の [[ … ]] は ]] のすぐあとの ; & | ( ) で閉じ、次の語は新しい文の頭（then のあとの文を [[ の引数に隠させない）', () => {
  for (const command of ['if [[ -n x ]]; then pwn ]] ; fi', 'if [[ -n x ]] then pwn; fi', 'while [[ -n x ]] do pwn; done']) {
    const seen = read(command, 'bash').map(s => s.words[0]?.text);
    assert.ok(seen.includes('pwn'), `${JSON.stringify(command)}: pwn を文として読んでいない ${JSON.stringify(seen)}`);
  }
  assert.deepEqual(read('if [[ -f a ]]; then echo hi; fi', 'bash').map(line), ['[[ -f a ]]', 'echo hi'], 'ふつうの if [[ ]]; then は読める');
  assert.deepEqual(read('[[ -f a ]] && echo yes || echo no', 'bash').map(line), ['[[ -f a ]]', 'echo yes', 'echo no']);
  assert.deepEqual(read('( [[ a ]] ) | cat', 'bash').map(line), ['[[ a ]]', 'cat']);
  assert.deepEqual(read('[[ x =~ (a|b) ]] && echo m', 'bash').map(line), ['[[ x =~ (a|b) ]]', 'echo m'], '中の ( | ) は、閉じる前なら語の一部');
  assert.deepEqual(read('[[ -n x ]] > out.txt', 'bash')[0]!.redirects.map(r => [r.op, r.target?.text]), [['>', 'out.txt']]);
});

// 最終確認の乱数の試験で見つけた: [[ ]] の中の <( … ) >( … ) も、本物の bash はプロセス置換として中のコマンドを動かす。[[ の中では語を空白でだけ切るので、語の一部の文字として見逃していた
test('字句 11.2.3: bash の [[ … ]] の中の <( … ) と >( … ) も、中の文を読む（プロセス置換は中のコマンドを動かす）', () => {
  for (const command of ['[[ >(pwn) = a ]]', '[[ <(pwn) = a ]]', '[[ -n <(pwn) ]]', '[[ a == b || <(pwn) ]]', '[[ x == a<(pwn) ]]', '[[ x =~ >(pwn) ]]', 'if [[ -n <(pwn) ]]; then echo a; fi']) {
    const seen = read(command, 'bash').map(s => s.words[0]?.text);
    assert.ok(seen.includes('pwn'), `${JSON.stringify(command)}: pwn を文として読んでいない ${JSON.stringify(seen)}`);
  }
  assert.ok(read('[[ -n >(cat) ]]', 'bash').some(s => s.shapes.includes('process_out')), '>( … ) は書き込みの先が見えないので今回だけ');
  assert.equal(failure('[[ -n <(pwn ]]', 'bash'), 'unclosed');
  assert.deepEqual(read('[[ a < b ]] && echo lt', 'bash').map(line), ['[[ a < b ]]', 'echo lt'], '(  の付かない < は今までどおり文字列の比較');
});

// 同じく乱数の試験で見つけた: <( … ) >( … ) の閉じ ) のすぐあとに続く文字は、bash では同じ語の続き（# はコメントでなく語の一部）。
// 字句の読み取りは、置換を 1 つの語として閉じてしまい、続きの # を語の頭のコメントと読んで、あとの文を隠していた（cat <(true)#; pwn）
// 同じく乱数の試験で見つけた: >&2# の # は、本物の bash では語 2# の一部で（>&語 は、語が数字でなければ 2# というファイルへの書き込み）、コメントでない。字句の読み取りは >&2 を fd の複製と読んで、続きの # をコメントと読み、あとの文を隠していた。
// NAME=( … ) の配列の代入も同じ: ech=()#o の # は語の一部（コメントでない）
test('字句 11.2.3: bash の >&N のすぐあとに語の文字が続く形と、NAME=( … ) の配列の代入は、# の読み方がずれるので止める', () => {
  for (const command of ['>&2# echo a | pwn', 'echo hi >&2#x; pwn', 'echo hi >&2x', 'echo hi 2>&1# ; pwn', 'echo hi >&-x', 'cat <&0# ; pwn', 'echo hi >&2.txt']) {
    for (const shell of ['bash', 'sh'] as const) assert.equal(failure(command, shell), 'fd', `${shell}: ${JSON.stringify(command)}`);
  }
  for (const command of ['ech=()#o } a | pwn', 'x=(1 2 3)', 'x+=(a)', 'export x=(a)#; pwn', 'declare -a x=(a b); pwn', 'local x=(a)', 'readonly x=(a)#c; pwn']) {
    for (const shell of ['bash', 'sh'] as const) assert.equal(failure(command, shell), 'unexpected', `${shell}: ${JSON.stringify(command)}`);
  }
  for (const command of ['echo hi >&2', 'echo hi 2>&1 | cat', 'echo hi >&2; pwn', 'echo hi >&2 # c', 'echo hi 1>&2>/dev/null', 'cat <&- | cat', 'echo hi >&2&', 'x=1; y=$(echo a)', 'f() { :; }; f']) {
    assert.equal(failure(command, 'bash'), null, `${JSON.stringify(command)} は読める`);
  }
  assert.ok(read('echo hi >&2; pwn', 'bash').some(s => s.words[0]?.text === 'pwn'));
});

// 同じく乱数の試験で見つけた: "…" の中の \ 改行は消えるので、"$\<改行>(pwn)" は "$(pwn)" で置換として動く（"$\<改行>HOME" は $HOME）。字句の読み取りは $ を文字、\ 改行を読み飛ばして、(pwn) を文字と読んでいた
test('字句 11.2.3: bash の "…" の中の $ のすぐあとの \\ 改行は、$ と次の文字をつなぐので止める。ほかの \\ 改行は今までどおり', () => {
  for (const command of ['echo "$\\\n(pwn)"', 'echo "$\\\nHOME"', 'echo "a$\\\n{x}"', 'echo "$\\\n$(pwn)"', 'echo "x" "$\\\n(\npwn\n)"']) {
    for (const shell of ['bash', 'sh'] as const) assert.equal(failure(command, shell), 'backslash', `${shell}: ${JSON.stringify(command)}`);
  }
  assert.deepEqual(read('echo "a\\\nb"', 'bash')[0]!.words.map(w => w.text), ['echo', 'ab']);
  assert.deepEqual(read('echo "$HOME\\\nx"', 'bash')[0]!.words.map(w => w.text), ['echo', '$HOMEx']);
  assert.deepEqual(read('echo "\\\n$HOME"', 'bash')[0]!.words.map(w => w.text), ['echo', '$HOME']);
});

test('字句 11.2.3: bash の <( … ) >( … ) のすぐあとの文字は同じ語の続き。# はコメントでなく、あとの文を隠さない', () => {
  for (const command of ['cat <(true)#; pwn', 'cat <(true)# & pwn', 'cat <(true)##& { pwn; }', 'echo >(cat)#; pwn', 'cat <(true)x#y; pwn', 'cat <(true)"a"#; pwn', 't<(rue &x)##& { pwn; }']) {
    const seen = read(command, 'bash').map(s => s.words[0]?.text);
    assert.ok(seen.includes('pwn'), `${JSON.stringify(command)}: pwn を文として読んでいない ${JSON.stringify(seen)}`);
  }
  assert.deepEqual(read('cat <(true)x; ls', 'bash').map(line), ['true', 'cat <(true)x', 'ls']);
  assert.deepEqual(read('diff <(ls a) <(ls b)', 'bash').map(line), ['ls a', 'ls b', 'diff <(ls a) <(ls b)'], '続きの無い置換は今までどおり');
  assert.deepEqual(read('cat <(true) # comment', 'bash').map(line), ['true', 'cat <(true)'], '空白をはさんだ # は今までどおりコメント');
});

// 同じく: $[ … ] と (( … )) は、中が式として読まれて # がコメントにならず、$( … ) も展開される。echo $[1 # $(pwn)] や (( ls # )); pwn は、# 以降を字句の読み取りがコメントと読んで隠していた
test('字句 11.2.3: bash の $[ … ] と (( … )) は、中の # がコメントにならないので止める', () => {
  for (const command of ['echo $[1 # $(pwn)]', 'echo "$[1]"', 'echo $[1]', '(( ls # )); pwn', '((i++))', 'for ((i=0;i<3;i++)); do ls; done', 'x=1; ((x))']) {
    for (const shell of ['bash', 'sh'] as const) assert.notEqual(failure(command, shell), null, `${shell}: ${JSON.stringify(command)}`);
  }
  assert.equal(failure('echo $[1]', 'bash'), 'dollar_form');
  assert.equal(failure('((i++))', 'bash'), 'unexpected');
  assert.deepEqual(read('( (ls) )', 'bash').map(line), ['ls'], '空白で離した入れ子の部分シェルは今までどおり');
  assert.deepEqual(read('echo $((1 + 2)); (ls)', 'bash').map(line), ['echo $((1 + 2))', 'ls'], '$(( は算術のまま');
});
