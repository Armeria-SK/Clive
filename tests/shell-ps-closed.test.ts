import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand, type ShellVerdict } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

// 6 回目の審査の指摘: PowerShell のパラメータの結び付き（パイプで流れてくる値の名前から -Destination が決まる、など）を、ガードが真似しきれない。
// `'{"Destination":"SOUL.md"}' | ConvertFrom-Json | Copy-Item -Path evil.txt -Force` は確かめなしで通り、本当に SOUL.md を上書きし、.git/hooks/pre-commit を置いた。
// 決め: PowerShell では結び付きを真似るのをやめ、閉じる。確かめなしで動くのは「読むだけのコマンドレット」「文字を整えるだけのコマンドレット」「外部の読むコマンド」だけ。
// ファイルを書く・作る・移す・消すコマンドレットと、リダイレクト（> >>）は、書き込み先が決まっていても毎回確かめる（確かめなしで書くには file_write の道具を使う）。
// -Filter は Windows のファイル検索の決まり（末尾の ? が何にも当たらない・*. が拡張子のない名前に当たる）で名前を選ぶので、真似ない。

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  for (const d of ['skills/a', 'sub/deep', '.git/hooks']) mkdirSync(join(ws, d), { recursive: true });
  const files = [
    ['SOUL.md', 'persona'], ['USER.md', 'user'], ['.env', 'SECRET=1'], ['id_rsa', 'KEY'], ['notes.md', 'n'], ['a.txt', 'a'], ['evil.txt', 'evil'], ['people.csv', 'Destination\nSOUL.md\n'],
    ['skills/a/SKILL.md', 'skill'], ['sub/z.txt', 'z'], ['sub/deep/d.txt', 'd'],
  ] as const;
  for (const [f, text] of files) writeFileSync(join(ws, f), text);
  writeFileSync(join(base, 'config.json'), '{}');
  const policy: ScopePolicy = {
    roots: [{ path: ws, mode: 'write' }], deny: [realish(join(base, 'config.json'))], askOnWrite: [join(ws, 'SOUL.md'), join(ws, 'USER.md'), join(ws, 'skills')], skillsDir: join(ws, 'skills'),
  };
  const ps = (command: string, extra: { allow?: string[]; language?: 'ja' | 'en' } = {}) => checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell: 'powershell', windows: true, ...extra });
  const bash = (command: string) => checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell: 'bash', windows: false });
  return { base, ws, ps, bash };
}

const once = (v: ShellVerdict): boolean => v.onceOnly && v.decision === 'ask';
const blocked = (v: ShellVerdict): boolean => v.decision === 'deny' || once(v);
const show = (v: ShellVerdict): string => `${v.decision}${v.onceOnly ? '/once' : ''}`;

test('6 回目の再現: パイプで流れてきた値の名前から書き込み先が決まる Copy-Item・Move-Item・Rename-Item・Set-Content は、すべて今回だけ', t => {
  const f = fixture(t);
  const rows = [
    `'{"Destination":"SOUL.md"}' | ConvertFrom-Json | Copy-Item -Path evil.txt -Force`,
    `'{"Destination":".git/hooks/pre-commit"}' | ConvertFrom-Json | Copy-Item -Path evil.txt -Force`,
    `'{"Destination":"SOUL.md"}' | ConvertFrom-Json | Move-Item -Path evil.txt -Force`,
    `Import-Csv people.csv | Copy-Item -Path evil.txt -Force`,
    `Import-Csv people.csv | Move-Item -Path evil.txt -Force`,
    `Get-ChildItem a.txt | Select-Object @{n='Destination';e={'SOUL.md'}} | Copy-Item -Path evil.txt -Force`,
    `Get-ChildItem a.txt | Select-Object @{n='Destination';e={'.git/hooks/pre-commit'}} | Move-Item -Path evil.txt`,
    `'{"NewName":"SOUL.md"}' | ConvertFrom-Json | Rename-Item -Path notes.md`,
    `'{"Path":"SOUL.md"}' | ConvertFrom-Json | Set-Content -Value pwned`,
    `'{"LiteralPath":"SOUL.md"}' | ConvertFrom-Json | Add-Content -Value pwned`,
    `'{"Path":"SOUL.md"}' | ConvertFrom-Json | Clear-Content`,
    `'{"Path":"SOUL.md"}' | ConvertFrom-Json | Remove-Item`,
    `'{"FilePath":"SOUL.md"}' | ConvertFrom-Json | Out-File`,
    `Import-Csv people.csv | New-Item -Name x.txt`,
    `Import-Csv people.csv | Compress-Archive -DestinationPath z.zip`,
  ];
  const wrong = rows.filter(c => !once(f.ps(c))).map(c => `${c} → ${show(f.ps(c))}`);
  assert.deepEqual(wrong, []);
});

test('パイプを受ける書くコマンドレットは、持ち主が tools.shell.allow に書いていても今回だけ（パイプの値の結び付きは外せない）', t => {
  const f = fixture(t);
  const allow = ['Copy-Item', 'Set-Content', 'Out-File', 'Remove-Item', 'Move-Item', 'Add-Content'];
  for (const c of [
    `'{"Destination":"SOUL.md"}' | ConvertFrom-Json | Copy-Item -Path evil.txt -Force`, `Get-Content a.txt | Set-Content b.txt`, `Get-Content a.txt | Out-File out.txt`, `Get-ChildItem | Remove-Item`,
    `Import-Csv people.csv | Move-Item -Path evil.txt`, `Get-Content a.txt | Add-Content -Path log.txt`,
    // 改行でつないだパイプ・かっこで囲んだ元・変数に受ける形・ループの中・複数の段
    `'{"Destination":"SOUL.md"}' |\nConvertFrom-Json |\nCopy-Item -Path evil.txt -Force`, `Get-Content a.txt\n| Set-Content b.txt`, `(Get-Content a.txt) | Set-Content b.txt`, `$x = Get-Content a.txt | Set-Content b.txt`,
    `foreach ($o in 1,2) { $o | Copy-Item -Path a.txt }`, `Get-Content a.txt | ForEach-Object { $_ } | Out-File out.txt`,
  ]) {
    const v = f.ps(c, { allow });
    assert.equal(once(v), true, `${c}: ${show(v)} ${v.reasons.join(' / ')}`);
  }
});

test('書くコマンドレットは、パスがすべて決まっていても今回だけ。別名も同じ。理由に file_write の案内が付く', t => {
  const f = fixture(t);
  const rows = [
    'Set-Content out.txt hello', 'Set-Content -Path out.txt -Value hello', 'Set-Content -LiteralPath out.txt -Value hello', 'Add-Content out.txt hello', 'ac out.txt hello', 'Clear-Content a.txt', 'clc a.txt',
    'Out-File out.txt', 'Out-File -FilePath out.txt -Append', 'Tee-Object -FilePath out.txt', 'tee out.txt',
    'Copy-Item a.txt b.txt', 'copy a.txt b.txt', 'cp a.txt b.txt', 'cpi a.txt b.txt', 'Copy-Item a.txt sub/', 'Copy-Item sub sub2 -Recurse',
    'Move-Item a.txt b.txt', 'move a.txt b.txt', 'mv a.txt b.txt', 'mi a.txt b.txt', 'Rename-Item a.txt c.txt', 'ren a.txt c.txt', 'rni a.txt c.txt',
    'New-Item x.txt', 'New-Item -ItemType Directory -Path made', 'ni x.txt', 'New-Item -Path sub -Name y.txt -ItemType File', 'mkdir made', 'md made', 'mkdir -Path made -Force',
    'Remove-Item a.txt', 'rm a.txt', 'del a.txt', 'erase a.txt', 'rd sub', 'rmdir sub', 'ri a.txt', 'Remove-Item sub -Recurse -Force',
    'Compress-Archive -Path sub -DestinationPath out.zip', 'Expand-Archive -Path out.zip -DestinationPath sub',
    'Invoke-WebRequest https://example.com -MaximumRedirection 0 -OutFile page.html', 'iwr https://example.com -MaximumRedirection 0 -OutFile page.html',
    'Get-Content a.txt | Out-File out.txt', 'Get-ChildItem | Out-String | Set-Content listing.txt',
  ];
  const wrong = rows.filter(c => !once(f.ps(c))).map(c => `${c} → ${show(f.ps(c))}`);
  assert.deepEqual(wrong, []);
  assert.match(f.ps('Set-Content out.txt hello').reasons.join('\n'), /file_write/u, '日本語の理由に file_write の案内がある');
  assert.match(f.ps('Set-Content out.txt hello', { language: 'en' }).reasons.join('\n'), /file_write/u, '英語の理由にも');
});

test('リダイレクト（> >> 2> *>）は、書き込み先が決まっていても今回だけ。$null と 2>&1 は書かないので可', t => {
  const f = fixture(t);
  for (const c of ['Get-Content a.txt > out.txt', 'Get-Content a.txt >> out.txt', 'Get-Content a.txt 2> err.txt', 'Get-Content a.txt *> all.txt', 'Write-Output hi > sub/new.txt', "'x' > out.txt", 'git status > status.txt']) {
    assert.equal(once(f.ps(c)), true, `${c}: ${show(f.ps(c))}`);
  }
  for (const c of ['Get-Content a.txt > $null', 'Get-Content a.txt 2> $null', 'git status 2>&1', 'Get-Content a.txt *> $null']) {
    assert.equal(f.ps(c).decision, 'allow', `${c}: ${show(f.ps(c))}`);
  }
  // リダイレクトは、tools.shell.allow に書いてあっても外せない
  assert.equal(once(f.ps('Get-Content a.txt > out.txt', { allow: ['Get-Content a.txt'] })), true);
});

test('持ち主が tools.shell.allow に書いた書くコマンド（パイプなし）は、これまでの「一覧に無い」と同じに外せる。守る場所・禁止のパス・外は外せない', t => {
  const f = fixture(t);
  const allow = ['Set-Content notes.md', 'Copy-Item a.txt'];
  const free = f.ps('Set-Content notes.md hello', { allow });
  assert.equal(free.decision, 'allow', `${show(free)} ${free.reasons.join(' / ')}`);
  assert.equal(f.ps('Copy-Item a.txt b.txt', { allow }).decision, 'allow');
  assert.equal(once(f.ps('Set-Content notes.md hello')), true, '書いていなければ今回だけ');
  // 項目に当たらない別のファイルは、これまでどおり今回だけ
  assert.equal(once(f.ps('Set-Content other.md hello', { allow })), true);
  // パスの調べは外せない
  assert.equal(once(f.ps('Copy-Item a.txt SOUL.md', { allow })), true, '人格');
  assert.equal(once(f.ps('Copy-Item a.txt .git/hooks/pre-commit', { allow })), true, '.git');
  assert.equal(f.ps('Copy-Item a.txt .env', { allow }).decision, 'deny', '秘密のパス');
  assert.equal(f.ps('Copy-Item a.txt ../config.json', { allow }).decision, 'deny', '禁止の一覧');
});

test('書くコマンドレットの先が秘密のパス・禁止の一覧・ネットワークのパスなら、今回だけでなく止める', t => {
  const f = fixture(t);
  for (const c of ['Set-Content .env x', 'Remove-Item .env', 'Copy-Item a.txt id_rsa', 'Out-File .env', "'x' > .env", 'Set-Content ../config.json x', 'Copy-Item a.txt ../config.json', 'Move-Item a.txt //localhost/C$/x.txt', 'Set-Content //?/C:/x.txt y']) {
    assert.equal(f.ps(c).decision, 'deny', `${c}: ${show(f.ps(c))}`);
  }
});

test('Get-ChildItem -Filter は Windows のファイル検索の決まりで名前を選ぶので、真似ない: 秘密を読む形は今回だけか止める', t => {
  const f = fixture(t);
  const rows = [
    // 末尾の ? は何にも当たらなくてもよい（'.env?' は .env に当たる）、*. は拡張子のない名前に当たる
    `Get-ChildItem -Force -Recurse -Filter '.env?' | Select-String SECRET`, `Get-ChildItem -Force -Recurse -Filter '*.' | Select-String KEY`, `Get-ChildItem -Force -Recurse -Filter 'id_rsa?' | Select-String KEY`,
    `Get-ChildItem -Force -Recurse -Filter '.env?' | Get-Content`, `Get-ChildItem -Force -Filter '.en?' | Get-Content`, `Get-ChildItem -Force -Filter .env | Get-Content`, `Get-ChildItem -Force -Filter 'ENV~1' | Get-Content`,
    `gci -Force -Recurse -Filter '*.' | Get-FileHash`, `Get-ChildItem -Force -Recurse -Filter '.env?' | Import-Csv`, `Get-ChildItem -Recurse -Filter *.md | Select-String n`, `Get-ChildItem -Filter *.md | Select-String n`,
    `Get-ChildItem sub -Recurse -Filter *.txt | Get-Content`, `Get-ChildItem -Force -Recurse -Filter '.env?' | Sort-Object Name | Select-Object -First 3 | Get-Content`,
  ];
  const wrong = rows.filter(c => !blocked(f.ps(c))).map(c => `${c} → ${show(f.ps(c))}`);
  assert.deepEqual(wrong, []);
  // 一覧を表示するだけ（パイプで読む次のコマンドが無い）なら、これまでどおり
  for (const c of ["Get-ChildItem -Force -Recurse -Filter '.env?'", 'Get-ChildItem -Filter *.md', 'Get-ChildItem sub -Recurse -Filter *.txt | Select-Object Name', "Get-ChildItem -Filter '*.' | Measure-Object"]) {
    assert.equal(f.ps(c).decision, 'allow', `${c}: ${show(f.ps(c))}`);
  }
});

test('Get-ChildItem -Include / -Exclude: PowerShell のワイルドカードのエスケープ（バッククォート）や [ ] を含む指定は真似ない。* ? だけの指定は、これまでどおり名前を選べる', t => {
  const f = fixture(t);
  const rows = [
    "Get-ChildItem -Force -Recurse -Include '.en`v' | Get-Content", "Get-ChildItem -Force -Recurse -Include '.en`v' | Select-String SECRET", "Get-ChildItem -Force -Recurse -Include '.e`nv','*.md' | Get-Content",
    "Get-ChildItem -Force -Recurse -Include '.en[v]' | Get-Content", "Get-ChildItem -Force -Recurse -Include '.e[a-z]v' | Get-Content", 'Get-ChildItem -Force -Recurse -Include $pattern | Get-Content',
    // Exclude は引き算だけなので、分からない書き方なら引かない（多めに調べる）
    "Get-ChildItem -Force -Recurse -Exclude '.en`v' | Get-Content", 'Get-ChildItem -Force -Recurse -Exclude $skip | Select-String x', "Get-ChildItem -Force -Recurse -Exclude '.e[a-z]v','id_rsa' | Get-Content",
  ];
  const wrong = rows.filter(c => !blocked(f.ps(c))).map(c => `${c} → ${show(f.ps(c))}`);
  assert.deepEqual(wrong, []);
  for (const c of ['Get-ChildItem -Recurse -Include *.md | Select-String n', 'Get-ChildItem -Recurse -Include *.md,*.txt | Get-Content', 'Get-ChildItem sub -Recurse -Exclude *.log | Get-Content', 'Get-ChildItem -Recurse -Include d.* -Exclude *.log | Get-Content']) {
    assert.equal(f.ps(c).decision, 'allow', `${c}: ${show(f.ps(c))}`);
  }
});

test('Invoke-WebRequest・Invoke-RestMethod: パイプで流れてくる値が -Uri や -OutFile に結び付くので、パイプを受けるときは今回だけ', t => {
  const f = fixture(t);
  for (const c of [`'{"Uri":"http://192.168.0.1/"}' | ConvertFrom-Json | Invoke-WebRequest -MaximumRedirection 0`, `Import-Csv people.csv | iwr -MaximumRedirection 0`, `Import-Csv people.csv | Invoke-RestMethod -MaximumRedirection 0 -Uri https://example.com`]) {
    assert.equal(once(f.ps(c, { allow: ['Invoke-WebRequest', 'iwr', 'Invoke-RestMethod'] })), true, c);
  }
});

test('シェルの道具の説明が、PowerShell の書き込みは毎回確認が要ることと、書くなら file_write を使うことを、モデルに伝える。既存の制限モードの注意も残る', () => {
  assert.match(shellRun.description, /PowerShell では[^。]*ファイルを書く[^。]*毎回ユーザーの確認が要る。ファイルを書くときは[^。]*file_write/u);
  assert.match(shellRun.description, /Get-ChildItem -Filter の結果[^。]*確認が要る/u);
  assert.match(shellRun.description, /curl・wget でファイルに保存する形[^。]*毎回ユーザーの確認が要る。curl の URL に[^。]*-g/u);
  assert.match(shellRun.description, /制限モード[^。]*\[pscustomobject\]/u);
});

const LEGIT_PS = [
  'Get-ChildItem', 'Get-ChildItem -Force', 'Get-ChildItem sub', 'Get-ChildItem sub -Recurse', 'Get-ChildItem -Recurse -Name', 'Get-ChildItem *.md', 'Get-ChildItem -Recurse -File', 'Get-ChildItem -Directory', 'dir sub', 'ls sub -Name', 'gci sub',
  'Get-ChildItem -Recurse -File | Measure-Object', 'Get-ChildItem sub | Select-Object Name', 'Get-ChildItem sub | Select-Object -ExpandProperty Name', 'Get-ChildItem sub | Sort-Object Name -Descending | Select-Object -First 3',
  'Get-ChildItem sub -Recurse | Where-Object { $_.Length -gt 0 } | Select-Object FullName', 'Get-ChildItem sub | ForEach-Object { $_.Name }', 'Get-ChildItem sub | Format-Table Name', 'Get-ChildItem sub | Select-Object Name, Length | ConvertTo-Json',
  'Get-ChildItem -Recurse -Include *.md | Select-String n', 'Get-ChildItem sub -Recurse | Select-String z', 'Get-ChildItem sub | Select-String z', 'Get-ChildItem sub -Recurse | Get-Content',
  'Get-Content a.txt', 'Get-Content a.txt -TotalCount 5', 'Get-Content a.txt -Tail 2', 'Get-Content -Path a.txt -Raw', 'Get-Content -LiteralPath a.txt', 'cat a.txt', 'type a.txt', 'gc a.txt -Head 3',
  'Get-Content a.txt | Select-String x', 'Get-Content a.txt | Measure-Object -Line', 'Get-Content a.txt | Select-Object -First 3', 'Get-Content a.txt | Out-String', 'Get-Content a.txt | ForEach-Object { $_.ToUpper() }',
  'Get-Content a.txt | Where-Object { $_ -match "a" }', 'Get-Content a.txt | Sort-Object -Unique', 'Get-Content a.txt | ConvertFrom-Json | ConvertTo-Json',
  'Select-String -Path *.txt -Pattern a', 'Select-String -Pattern a -Path sub/*.txt', 'Select-String -Path a.txt -Pattern a -CaseSensitive', 'sls a a.txt', 'Select-String -Path notes.md -Pattern n -Context 1,1',
  'Test-Path a.txt', 'Test-Path sub -PathType Container', 'Get-Item a.txt', 'Get-Item a.txt | Select-Object Length, LastWriteTime', 'Resolve-Path sub', 'Get-FileHash a.txt', 'Get-FileHash a.txt -Algorithm SHA256', 'Get-Item notes.md | Get-Content',
  'Get-Location', 'Join-Path sub z.txt', 'Split-Path a.txt -Leaf', 'Get-Date', 'Get-Date -Format yyyy', 'Write-Output hello', 'Write-Host hi', 'Start-Sleep -Milliseconds 10', 'Get-Command git', 'Get-Process | Select-Object -First 3 Name',
  'git status', 'git status --short | Select-String modified', 'git log --oneline -n 5', 'git diff --stat', 'git branch', 'rg foo sub', 'rg -n foo sub', 'rg --files',
  '$f = Get-ChildItem sub; $f.Count', 'foreach ($f in Get-ChildItem sub) { $f.Name }', 'if (Test-Path a.txt) { Get-Content a.txt }', 'Set-Location sub; Get-ChildItem', 'Write-Output hello | Select-String h', 'echo hello | Measure-Object -Character',
  'Get-Content a.txt > $null', 'Get-Content a.txt 2>&1',
];

test('毎日の読み取り（LEGIT_PS）は、これまでどおり確かめなしで動く', t => {
  const f = fixture(t);
  const wrong = LEGIT_PS.filter(c => f.ps(c).decision !== 'allow').map(c => `${c} → ${show(f.ps(c))} ${f.ps(c).reasons.join(' / ')}`);
  assert.deepEqual(wrong, []);
});

test('bash は変わらない: 書く・作る・移す・消す・リダイレクトは、パスが決まっていて守る場所でなければ確かめなし', t => {
  const f = fixture(t);
  for (const c of ['echo hi > out.txt', 'cp a.txt b.txt', 'mv a.txt b.txt', 'mkdir -p made/inner', 'touch x.txt', 'rm -f a.txt', 'tee out.txt < a.txt']) {
    assert.equal(f.bash(c).decision, 'allow', `${c}: ${show(f.bash(c))} ${f.bash(c).reasons.join(' / ')}`);
  }
  assert.equal(once(f.bash('echo x > SOUL.md')), true);
});
