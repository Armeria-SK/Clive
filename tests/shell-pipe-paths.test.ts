import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { listTree } from '../src/tools/hooks/path-expand.ts';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

// 審査の指摘（深い審査）: Set-Content・Add-Content・Clear-Content は、パスの引数が無いと、パイプで流れてきたファイルの PSPath を束縛する。
// `Get-Item SOUL.md | Set-Content -Value pwned` や `Get-ChildItem -Recurse -File | Clear-Content` は、確かめなしで通り、本当に書き換えた。
// 読む側も同じ: `Get-ChildItem -Force | Select-String -Pattern SECRET` は .env を読んだ。パイプで流れてくるファイルは、次のコマンドが書く・読むものとして調べる

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  for (const d of ['skills/a', 'sub/deep']) mkdirSync(join(ws, d), { recursive: true });
  for (const [f, text] of [['SOUL.md', 'persona'], ['USER.md', 'user'], ['.env', 'SECRET=1'], ['notes.md', 'n'], ['a.txt', 'a'], ['skills/a/SKILL.md', 'skill'], ['sub/z.txt', 'z'], ['sub/deep/d.txt', 'd']] as const) writeFileSync(join(ws, f), text);
  const policy: ScopePolicy = {
    roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [join(ws, 'SOUL.md'), join(ws, 'USER.md'), join(ws, 'skills')], skillsDir: join(ws, 'skills'),
  };
  const ps = (command: string) => checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell: 'powershell', windows: true });
  return { base, ws, ps };
}

const once = (v: { onceOnly: boolean; decision: string }): boolean => v.onceOnly && v.decision === 'ask';
const show = (v: { onceOnly: boolean; decision: string }): string => `${v.decision}${v.onceOnly ? '/once' : ''}`;

test('パイプ: パスの引数が無い Set-Content・Add-Content・Clear-Content などは、流れてくるものが何でも今回だけ', t => {
  const f = fixture(t);
  const rows = [
    'Get-Item SOUL.md | Set-Content -Value pwned', 'Get-ChildItem skills -Recurse -File | Set-Content -Value x', 'Get-ChildItem | ForEach-Object { $_ | Set-Content -Value x }',
    'Get-ChildItem -Recurse -File | Clear-Content', 'Get-Item USER.md | Add-Content -Value x', '$files | Set-Content -Value x', 'Get-ChildItem | ForEach-Object { $_ | Add-Content -Value z }',
    'Get-Item skills | New-Item -Name pwn.txt', 'Get-ChildItem | Where-Object { $_.Length -gt 0 } | Clear-Content', 'Get-ChildItem sub | Sort-Object | Set-Content -Value y',
    'Get-ChildItem | ForEach-Object { $_ | Clear-Content }', 'ls | sc -Value x', 'Get-Item SOUL.md | Copy-Item -Destination sub', 'Get-Item SOUL.md | Remove-Item',
  ];
  const wrong = rows.filter(c => !once(f.ps(c))).map(c => `${c} → ${show(f.ps(c))}`);
  assert.deepEqual(wrong, []);
});

test('パイプ: 書くパスの引数があるものは、これまでどおり。流れてくる文字を書く先は決まっている', t => {
  const f = fixture(t);
  for (const command of [
    'Get-Content a.txt | Set-Content b.txt', 'Get-ChildItem | Select-Object Name | Set-Content names.txt', 'Get-Content a.txt | Out-File out.txt', 'Get-ChildItem sub | Out-String | Add-Content -Path log.txt',
    'Get-ChildItem sub | Set-Content -LiteralPath z2.txt', 'Get-Content a.txt | Tee-Object -FilePath t.txt',
  ]) {
    const v = f.ps(command);
    assert.equal(v.decision, 'allow', `${command}: ${show(v)} ${v.reasons.join(' / ')}`);
  }
});

test('パイプ: パスの引数が無い読むコマンドは、流れてくるファイルの一覧を読むものとして調べ、秘密のパスに当たれば止める', t => {
  const f = fixture(t);
  const rows = [
    'Get-ChildItem -Force | Select-String -Pattern SECRET', 'Get-ChildItem -Force | Get-Content', 'Get-ChildItem -Force | Import-Csv', 'Get-ChildItem -Force | Get-FileHash',
    'Get-ChildItem | Select-String SECRET', 'ls | cat', 'gci -Recurse | Select-String x', 'Get-ChildItem . | Get-FileHash', 'Get-ChildItem *.* | Get-Content', 'Get-ChildItem .e* | Get-Content',
    'Get-ChildItem | Where-Object { $_.Length -gt 0 } | Select-String x', 'Get-ChildItem | Sort-Object Name | Select-Object -First 3 | Get-Content', 'Get-Item .env | Get-Content', 'Get-Item .e* | Select-String S', 'Resolve-Path .env | Get-Content',
    'Get-ChildItem -Name | Get-Content', 'Get-ChildItem -Recurse -Filter .env | Get-Content', 'Get-ChildItem -Recurse -Include .env | Get-Content',
  ];
  const wrong = rows.filter(c => f.ps(c).decision !== 'deny').map(c => `${c} → ${show(f.ps(c))}`);
  assert.deepEqual(wrong, []);
});

test('パイプ: 流れてくるファイルが分からない読むコマンドは今回だけ（変数・ScriptBlock の $_・計算したもの・文字列をパスにするもの）', t => {
  const f = fixture(t);
  const rows = [
    '$files | Get-Content', '$files | Select-String x', 'Get-ChildItem | ForEach-Object { $_ | Select-String x }', 'Get-ChildItem | ForEach-Object { $_ | Get-Content }',
    'Get-ChildItem | ForEach-Object { Get-Content $_ }', 'Get-ChildItem | ForEach-Object { Get-Content $_.FullName }', 'Get-ChildItem | ForEach-Object { Get-Content -Path $_ }',
    'Get-ChildItem | ForEach-Object { Select-String -Path $_ -Pattern x }', 'Get-ChildItem sub | Where-Object { (Get-Content $_.FullName) -match "x" }',
    'Get-Content a.txt | Get-Item', 'Get-Content a.txt | Get-ChildItem', 'Get-Content a.txt | Import-Csv', 'Get-ChildItem sub -Name | Get-Item', 'Get-ChildItem | Select-Object -ExpandProperty Name | Get-Content',
    'Get-ChildItem | Select-Object @{n="Path";e={$_.FullName}} | Get-Content', 'Get-Process | Get-FileHash', 'Get-ChildItem sub | Select-String z | Get-Content', '(Get-ChildItem) | Get-Content',
    'Get-ChildItem $d | Get-Content',
  ];
  const wrong = rows.filter(c => !once(f.ps(c))).map(c => `${c} → ${show(f.ps(c))}`);
  assert.deepEqual(wrong, []);
});

test('パイプ: 流れてくるのが文字だけ、または秘密を含まないファイルの一覧なら、これまでどおり確かめなし', t => {
  const f = fixture(t);
  for (const command of [
    'Get-Content a.txt | Select-String x', 'Get-Content a.txt | Select-Object -First 2', 'Get-ChildItem | Select-Object Name', 'Get-ChildItem sub | Select-String z', 'Get-ChildItem sub -Recurse | Select-String z',
    'Get-ChildItem -Recurse sub | Where-Object { $_.Length -gt 0 } | Select-String z', 'Get-ChildItem *.md | Select-String n', 'Get-ChildItem -Filter *.md | Select-String n', 'Get-ChildItem -Recurse -Include *.md | Select-String n',
    'Get-ChildItem sub -Recurse -Filter *.txt | Get-Content', 'Get-ChildItem -Include *.md -Recurse | Get-Content -Raw -Encoding UTF8 | Select-String x', 'Get-ChildItem sub | Get-Item', 'Get-Item notes.md | Get-Content', 'Get-Item a.txt | Get-FileHash', 'Resolve-Path a.txt | Get-Content', 'Get-ChildItem sub | Sort-Object Name | Select-String z',
    'Get-Content a.txt | Measure-Object -Line', 'Get-ChildItem | Measure-Object', 'Get-ChildItem | Format-Table Name', 'Get-ChildItem sub | ForEach-Object { $_.Name }', 'Get-ChildItem | Where-Object { $_.Name -like "n*" } | Select-Object Name',
    'Write-Output hello | Select-String h', 'echo hello | Select-String h', 'Get-ChildItem sub | Select-Object FullName', 'git status | Select-String modified', 'Get-Content a.txt | Out-String',
  ]) {
    const v = f.ps(command);
    assert.equal(v.decision, 'allow', `${command}: ${show(v)} ${v.reasons.join(' / ')}`);
  }
});

test('listTree: 下の階層まで、フォルダとファイルを幅優先で挙げる。上限を超えたら途中まで返して complete: false', t => {
  const f = fixture(t);
  const flat = listTree(join(f.ws, 'sub'), false);
  assert.deepEqual(flat.entries.map(p => p.slice(f.ws.length + 1).replaceAll('\\', '/')).sort(), ['sub/deep', 'sub/z.txt']);
  assert.equal(flat.complete, true);
  const deep = listTree(join(f.ws, 'sub'), true);
  assert.deepEqual(deep.entries.map(p => p.slice(f.ws.length + 1).replaceAll('\\', '/')).sort(), ['sub/deep', 'sub/deep/d.txt', 'sub/z.txt']);
  const capped = listTree(f.ws, true, 3);
  assert.equal(capped.entries.length, 3);
  assert.equal(capped.complete, false);
  assert.equal(listTree(join(f.ws, 'missing'), true).complete, false, '読めないフォルダは complete: false');
});
