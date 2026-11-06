import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { resolvePaths, type AppPaths } from '../src/paths.ts';
import { ApprovalBroker, approvalPublic } from '../src/tools/approvals.ts';
import { lexShell } from '../src/tools/hooks/shell-lex.ts';
import { gitVersionAtLeast } from '../src/tools/shell/git-env.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { which } from '../src/tools/shell/runner.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// 本物のシェルで、判定と実行を通して確かめる（security-self-api.md §11.10 の「許す」の行が、本当に承認なしで、制限モードの PowerShell でも動くか）。
// Windows の PowerShell 5.1 と、あれば Git の bash。それ以外の環境では飛ばす

function setup(t: { after: (fn: () => void) => void }, shell: 'powershell' | 'bash') {
  const paths: AppPaths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config: AppConfig = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }];
  config.tools.shell.shell = shell;
  // 一覧に当たるはずのコマンドが確かめになったときに、長く待たずに落とす
  config.tools.shell.approvalTimeoutSec = 10;
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const events: RunEvent[] = [];
  const approvals = new ApprovalBroker(db, e => events.push(e.type === 'requested'
    ? { type: 'approval.requested', runId: e.view.runId, conversationId: e.view.conversationId, approval: approvalPublic(e.view) }
    : { type: 'approval.resolved', runId: e.view.runId, conversationId: e.view.conversationId, approvalId: e.view.id, outcome: e.outcome }));
  const registry = new ToolRegistry().register(shellRun);
  const policy = buildPolicy(parsed, paths);
  const controller = new AbortController();
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: controller.signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  const call = (command: string) => runToolCall({ id: `call-${Math.random()}`, name: 'shell_run', arguments: { command } }, ctx, { registry, approvals, db, emit: e => events.push(e), conversationAutoRead: () => false });
  const files = (name: string) => join(paths.workspace, name);
  const seed = () => {
    writeFileSync(files('a.txt'), 'line1\nline2\nline3\n');
    writeFileSync(files('notes.md'), 'notes\n');
    writeFileSync(files('SOUL.md'), 'persona');
    mkdirSync(files('sub'), { recursive: true });
    writeFileSync(files('sub/b.txt'), 'bee\n');
    mkdirSync(files('tmp'), { recursive: true });
    writeFileSync(files('tmp/SOUL.md'), 'evil persona');
  };
  seed();
  return { paths, call, approvals, files };
}

async function expectAsk(s: ReturnType<typeof setup>, command: string): Promise<void> {
  const pending = s.call(command);
  for (let i = 0; i < 300 && !s.approvals.pending().length; i++) await new Promise(r => setTimeout(r, 10));
  const request = s.approvals.pending()[0];
  assert.ok(request, `${command}: 承認の依頼が来ていない（確かめなしで動いた）`);
  assert.equal(request.onceOnly, true, `${command}: 今回だけの確かめでない`);
  s.approvals.decide(request.id, 'deny');
  const outcome = await pending;
  assert.equal(outcome.output.isError, true, command);
  assert.match(outcome.output.content, /拒否しました/u, command);
}

const psAvailable = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-Command', 'echo ok'], { encoding: 'utf8' }).stdout.trim() === 'ok';

test('実機（Windows PowerShell 5.1・制限モード）: 一覧に当たるコマンドは、承認なしで本当に動く', { skip: !psAvailable && 'Windows の PowerShell が無い' }, async t => {
  const s = setup(t, 'powershell');
  const rows: Array<[string, RegExp]> = [
    ['Get-ChildItem -Recurse -Filter *.txt | Select-Object -ExpandProperty Name', /a\.txt[\s\S]*b\.txt/u],
    ['Get-Content a.txt -TotalCount 2', /line1\s+line2/u],
    ['Get-ChildItem | Where-Object { $_.Length -gt 6 } | ForEach-Object { $_.Name }', /a\.txt/u],
    ['$files = Get-ChildItem -Recurse; $files.Count', /\b[0-9]+\b/u],
    ['Select-String -Path *.txt -Pattern line2', /line2/u],
    ['Get-Date -Format yyyy', /20[0-9]{2}/u],
    ['Get-ChildItem -Path . -Recurse -Include *.txt | Select-String line3', /line3/u],
    ['Get-ChildItem *.md | ForEach-Object { $_.Name }', /notes\.md[\s\S]*SOUL\.md|SOUL\.md[\s\S]*notes\.md/u],
    ['[DateTime]::Now.Year', /20[0-9]{2}/u],
    ['"x".ToUpper()', /X/u],
    ['if (Test-Path a.txt) { Write-Output yes } else { Write-Output no }', /yes/u],
    ['foreach ($f in Get-ChildItem *.txt) { $f.Name }', /a\.txt/u],
    ['Get-ChildItem sub | Sort-Object Name -Descending | Select-Object -First 1 | ForEach-Object { $_.Name }', /b\.txt/u],
    ['Write-Output "a b" | Out-String', /a b/u],
    ['Get-Content a.txt | Measure-Object -Line | ForEach-Object { $_.Lines }', /\b3\b/u],
    ['Join-Path sub b.txt', /sub\\b\.txt/u],
    ['Test-Path SOUL.md', /True/u],
    ['git --version', /git version/u],
    ['Start-Sleep -Milliseconds 100; Write-Output done', /done/u],
  ];
  for (const [command, expected] of rows) {
    const outcome = await s.call(command);
    assert.equal(outcome.decision, 'allow', `${command}: ${outcome.output.content}`);
    assert.equal(outcome.decidedBy !== 'user', true, `${command}: 承認を求めた`);
    assert.equal(outcome.output.isError, false, `${command}: ${outcome.output.content}`);
    assert.match(outcome.output.content, expected, command);
  }
  if (which('rg')) assert.match((await s.call('rg --version')).output.content, /ripgrep/u);
});

// 6 回目の審査の後: PowerShell でファイルを書く・作る・移す・消すコマンドレットとリダイレクトは、書き込み先が決まっていても毎回確かめる（§11.13）。拒否すれば何も起きない
test('実機（Windows PowerShell 5.1・制限モード）: 書く・作る・移す・消すコマンドレットとリダイレクトは、パスが決まっていても確かめになり、拒否すれば何も起きない', { skip: !psAvailable && 'Windows の PowerShell が無い' }, async t => {
  const s = setup(t, 'powershell');
  for (const command of [
    'Set-Content -Path out.txt -Value "hello"', 'New-Item -ItemType Directory -Path made', 'mkdir madeby', 'Copy-Item a.txt c.txt', 'Move-Item a.txt moved.txt', 'Rename-Item notes.md -NewName renamed.md', 'Remove-Item a.txt',
    'Get-Content a.txt | Out-File out2.txt', "'x' > out3.txt", 'Get-Content a.txt >> a.txt', 'Add-Content a.txt more', 'Clear-Content a.txt',
  ]) await expectAsk(s, command);
  for (const name of ['out.txt', 'made', 'madeby', 'c.txt', 'moved.txt', 'renamed.md', 'out2.txt', 'out3.txt']) assert.equal(existsSync(s.files(name)), false, `${name} ができた`);
  assert.equal(readFileSync(s.files('a.txt'), 'utf8'), 'line1\nline2\nline3\n', 'a.txt が変わった');
  assert.equal(readFileSync(s.files('notes.md'), 'utf8'), 'notes\n');
});

test('実機（Windows PowerShell 5.1・制限モード）: 組み立てた書き込み先・一覧に無いコード・入れるものは、確かめになり、拒否すれば動かない', { skip: !psAvailable && 'Windows の PowerShell が無い' }, async t => {
  const s = setup(t, 'powershell');
  for (const command of [
    "Set-Content ('SOUL'+'.md') pwned", 'Copy-Item tmp/SOUL.md', 'Move-Item tmp/SOUL.md', 'Copy-Item tmp/SOUL.md .', 'Move-Item tmp/SOUL.md .', 'Get-ChildItem *.md | Remove-Item', "Rename-Item notes.md -NewName SOUL.md", "New-Item -Path . -Name SOUL.md -Force",
    "node -e \"require('fs').writeFileSync('pwned','x')\"", 'npm install', 'pip install .', "Set-Content .git/hooks/pre-commit 'x'", 'Remove-Item -Recurse -Force *', "Set-Content 'SOUL.md.' pwned",
    '[Math]::Round(1.5)', "Invoke-Expression 'Get-Date'", 'iex "Get-Date"', 'Start-Process notepad',
  ]) await expectAsk(s, command);
  assert.equal(readFileSync(s.files('SOUL.md'), 'utf8'), 'persona', '人格が書き換わった');
  assert.equal(readFileSync(s.files('notes.md'), 'utf8'), 'notes\n');
  assert.equal(existsSync(s.files('pwned')), false);
  assert.equal(existsSync(s.files('tmp/SOUL.md')), true, '動かされていない');
  for (const command of ['Write-Output ‘x’', 'ls --% x', '``n`o`de --eval=1']) {
    const outcome = await s.call(command);
    assert.equal(outcome.decision, 'deny', command);
    assert.match(outcome.output.content, /書き方を判定できません/u, command);
  }
});

// 審査の指摘（深い審査）: パスの引数が無い Set-Content・Clear-Content は、パイプで流れてきたファイルの PSPath を束縛して、本当に書き換えた。
// 読む側も、`Get-ChildItem -Force | Select-String -Pattern SECRET` が .env を読んだ。本物の Windows PowerShell 5.1（制限モード）で、動かないことと、文字だけ・秘密のない一覧は動くことを確かめる
test('実機（Windows PowerShell 5.1・制限モード）: パイプで流れてくるファイルへの書き込みは確かめになり、秘密を含む一覧の読み取りは止まる。文字や秘密のない一覧は動く', { skip: !psAvailable && 'Windows の PowerShell が無い' }, async t => {
  const s = setup(t, 'powershell');
  writeFileSync(s.files('.env'), 'SECRET=1\n');
  for (const command of [
    'Get-Item SOUL.md | Set-Content -Value pwned', 'Get-ChildItem tmp -Recurse -File | Set-Content -Value x', 'Get-ChildItem | ForEach-Object { $_ | Set-Content -Value x }', 'Get-ChildItem -Recurse -File | Clear-Content',
    'Get-ChildItem | ForEach-Object { $_ | Select-String line }', 'Get-ChildItem sub | ForEach-Object { Get-Content $_.FullName }',
  ]) await expectAsk(s, command);
  assert.equal(readFileSync(s.files('SOUL.md'), 'utf8'), 'persona', '人格が書き換わった');
  assert.equal(readFileSync(s.files('tmp/SOUL.md'), 'utf8'), 'evil persona');
  assert.equal(readFileSync(s.files('a.txt'), 'utf8'), 'line1\nline2\nline3\n');
  assert.equal(readFileSync(s.files('sub/b.txt'), 'utf8'), 'bee\n');
  for (const command of ['Get-ChildItem -Force | Select-String -Pattern SECRET', 'Get-ChildItem -Force | Get-Content', 'Get-ChildItem -Force | Get-FileHash', 'Get-ChildItem -Recurse | Select-String -Pattern SECRET']) {
    const outcome = await s.call(command);
    assert.equal(outcome.decision, 'deny', `${command}: ${outcome.output.content}`);
    assert.doesNotMatch(outcome.output.content, /SECRET=1/u, `${command}: 秘密が出た`);
  }
  for (const [command, expected] of [
    ['Get-Content a.txt | Select-String line2', /line2/u], ['Get-ChildItem sub | Select-String bee', /bee/u], ['Get-ChildItem -Recurse -Filter *.txt | Select-Object -ExpandProperty Name', /a\.txt/u],
    ['Get-ChildItem sub -Recurse | Get-Content', /bee/u], ['Get-ChildItem -Recurse -Include *.md | Select-String persona', /persona/u],
  ] as const) {
    const outcome = await s.call(command);
    assert.equal(outcome.decision, 'allow', `${command}: ${outcome.output.content}`);
    assert.equal(outcome.output.isError, false, `${command}: ${outcome.output.content}`);
    assert.match(outcome.output.content, expected, command);
  }
  // -Filter は Windows のファイル検索の決まりで名前を選ぶので、ファイルを読む次のコマンドに流すときは確かめになる
  await expectAsk(s, 'Get-ChildItem -Filter *.txt | Select-String line3');
});

// 確かめになる（拒否すれば動かない）か、確かめにも進まず止まる。確かめなしで動いたら失敗
async function expectBlocked(s: ReturnType<typeof setup>, command: string): Promise<void> {
  let settled = false;
  const pending = s.call(command).then(outcome => { settled = true; return outcome; });
  for (let i = 0; i < 300 && !settled && !s.approvals.pending().length; i++) await new Promise(r => setTimeout(r, 10));
  const request = s.approvals.pending()[0];
  assert.ok(request || settled, `${command}: 確かめも拒否もなく動いている`);
  if (request) {
    assert.equal(request.onceOnly, true, `${command}: 今回だけの確かめでない`);
    s.approvals.decide(request.id, 'deny');
  }
  const outcome = await pending;
  assert.notEqual(outcome.decision, 'allow', command);
  assert.equal(outcome.output.isError, true, command);
  assert.doesNotMatch(outcome.output.content, /SECRET=1|PRIVATE-KEY/u, `${command}: 秘密が出た`);
}

// 6 回目の審査: `'{"Destination":"SOUL.md"}' | ConvertFrom-Json | Copy-Item -Path evil.txt -Force`（と Import-Csv・計算した列）は、確かめなしで通り、SOUL.md を上書きし .git/hooks/pre-commit を置いた。
// `Get-ChildItem -Force -Recurse -Filter '.env?' | Select-String SECRET` は .env を表示した。本物の Windows PowerShell 5.1 で、素のシェルでは本当に起きること（前提）と、Clive のシェルでは確かめになるか止まり、拒否すれば何も起きないことを確かめる
test('実機（Windows PowerShell 5.1・制限モード）: パイプの値の名前で書き込み先が決まる書き込みと、-Filter・-Include 越しの秘密の読み取りは、確かめになるか止まり、拒否すれば何も起きない', { skip: !psAvailable && 'Windows の PowerShell が無い' }, async t => {
  const s = setup(t, 'powershell');
  const plant = (dir: string): void => {
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    for (const [name, text] of [['SOUL.md', 'persona'], ['.env', 'SECRET=1\n'], ['id_rsa', 'PRIVATE-KEY\n'], ['evil.txt', 'evil\n'], ['a.txt', 'a\n'], ['people.csv', 'Destination\nSOUL.md\n']] as const) writeFileSync(join(dir, name), text);
  };
  plant(s.paths.workspace);
  const writes: Array<[string, (dir: string) => boolean]> = [
    [`'{"Destination":"SOUL.md"}' | ConvertFrom-Json | Copy-Item -Path evil.txt -Force`, d => readFileSync(join(d, 'SOUL.md'), 'utf8') === 'evil\n'],
    [`'{"Destination":".git/hooks/pre-commit"}' | ConvertFrom-Json | Copy-Item -Path evil.txt -Force`, d => existsSync(join(d, '.git', 'hooks', 'pre-commit'))],
    [`'{"Destination":"SOUL.md"}' | ConvertFrom-Json | Move-Item -Path evil.txt -Force`, d => readFileSync(join(d, 'SOUL.md'), 'utf8') === 'evil\n'],
    [`Import-Csv people.csv | Copy-Item -Path evil.txt -Force`, d => readFileSync(join(d, 'SOUL.md'), 'utf8') === 'evil\n'],
    [`Import-Csv people.csv | Move-Item -Path evil.txt -Force`, d => readFileSync(join(d, 'SOUL.md'), 'utf8') === 'evil\n'],
    [`Get-ChildItem a.txt | Select-Object @{n='Destination';e={'SOUL.md'}} | Copy-Item -Path evil.txt -Force`, d => readFileSync(join(d, 'SOUL.md'), 'utf8') === 'evil\n'],
    [`Get-ChildItem a.txt | Select-Object @{n='Destination';e={'.git/hooks/pre-commit'}} | Copy-Item -Path evil.txt -Force`, d => existsSync(join(d, '.git', 'hooks', 'pre-commit'))],
  ];
  const scratch = join(s.paths.workspace, '..', 'premise');
  for (const [command, happened] of writes) {
    rmSync(scratch, { recursive: true, force: true });
    plant(scratch);
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: scratch, encoding: 'utf8' });
    assert.equal(happened(scratch), true, `前提: 素の PowerShell では本当に書かれる: ${command}`);
  }
  for (const [command] of writes) await expectBlocked(s, command);
  assert.equal(readFileSync(s.files('SOUL.md'), 'utf8'), 'persona', '人格が書き換わった');
  assert.equal(existsSync(s.files('.git/hooks/pre-commit')), false, '.git/hooks にフックが置かれた');
  assert.equal(readFileSync(s.files('evil.txt'), 'utf8'), 'evil\n', '元のファイルが動いた');

  const reads = [
    `Get-ChildItem -Force -Recurse -Filter '.env?' | Select-String SECRET`, `Get-ChildItem -Force -Recurse -Filter '*.' | Select-String KEY`, `Get-ChildItem -Force -Recurse -Filter 'id_rsa?' | Select-String KEY`,
    "Get-ChildItem -Force -Recurse -Include '.en`v' | Select-String SECRET", `Get-ChildItem -Force -Recurse -Filter '.env?' | Get-Content`,
  ];
  for (const command of reads) {
    const raw = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: s.paths.workspace, encoding: 'utf8' });
    assert.match(raw.stdout, /SECRET=1|PRIVATE-KEY/u, `前提: 素の PowerShell は秘密を表示する: ${command}`);
  }
  for (const command of reads) await expectBlocked(s, command);
});

// 再審査の指摘: `//localhost/D$/…/USER.md`（管理共有）や `//?/D:/…`（デバイスのパス）は、本物の Windows で人格を書き換えたのに、許可フォルダの外のふつうの確かめだけで通った。
// 本物の Windows PowerShell 5.1 で、その書き方が本当に書けること（前提）と、Clive のシェルでは確かめにも進まず止まることを確かめる
test('実機（Windows PowerShell 5.1・制限モード）: 管理共有・デバイスのパスで人格を書き換える書き方は、確かめにも進まず止まる', { skip: !psAvailable && 'Windows の PowerShell が無い' }, async t => {
  const s = setup(t, 'powershell');
  const ws = s.paths.workspace;
  const fwd = ws.replaceAll('\\', '/');
  const share = `//localhost/${ws.slice(0, 1)}$${fwd.slice(2)}`;
  let reachable = false;
  try { reachable = statSync(share).isDirectory(); } catch { reachable = false; }
  if (!reachable) { t.skip('この PC の管理共有（\\\\localhost\\C$）が開いていない'); return; }
  // 前提: 素の PowerShell は、管理共有・デバイスのパスごしに、作業フォルダのファイルを書ける
  for (const [name, path] of [['share', `${share}/probe-share.txt`], ['device', `//?/${fwd}/probe-device.txt`]] as const) {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Set-Content -LiteralPath '${path}' -Value x`], { encoding: 'utf8' });
    assert.equal(existsSync(s.files(`probe-${name}.txt`)), true, `前提: 素の PowerShell は ${name} のパスごしに書ける`);
  }
  for (const path of [`${share}/SOUL.md`, `//?/${fwd}/SOUL.md`, `\\\\?\\${ws}\\SOUL.md`, `//./${fwd}/SOUL.md`, `\\??\\${ws}\\SOUL.md`, `\\\\localhost\\${ws.slice(0, 1)}$\\${ws.slice(3)}\\SOUL.md`]) {
    for (const command of [`Set-Content '${path}' -Value pwned`, `'pwned' > '${path}'`, `Get-Content '${path}'`]) {
      const outcome = await s.call(command);
      assert.equal(outcome.decision, 'deny', `${command}: ${outcome.output.content}`);
      assert.match(outcome.output.content, /ネットワークのパス/u, command);
    }
  }
  assert.equal(readFileSync(s.files('SOUL.md'), 'utf8'), 'persona', '管理共有ごしに人格が書き換わった');
});

// 再審査の指摘（低）: 当たるものが 2,000 件を超えるワイルドカードの中の秘密のパスと、バッククォートでエスケープした秘密の名前（'.en`v'）は、ふつうの確かめで通っていた。
// 本物の Windows PowerShell 5.1 で、その書き方が .env を読めること（前提）と、Clive のシェルでは確かめにも進まず止まることを確かめる
test('実機（Windows PowerShell 5.1・制限モード）: バッククォートでエスケープした秘密の名前と、2,000 件を超えるワイルドカードの中の秘密は、確かめにも進まず止まる', { skip: !psAvailable && 'Windows の PowerShell が無い' }, async t => {
  const s = setup(t, 'powershell');
  writeFileSync(s.files('.env'), 'SECRET=1\n');
  // 前提: 素の PowerShell は、-Path の [ ] の中のバッククォートつきの文字（'.en[`v]'）で .env を読む
  for (const path of ['.en[`v]', '.[`e]nv']) {
    const raw = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-Content -Path '${path}'`], { cwd: s.paths.workspace, encoding: 'utf8' });
    assert.match(raw.stdout, /SECRET=1/u, `前提: 素の PowerShell は '${path}' で .env を読む`);
  }
  for (const command of ["Get-Content '.en[`v]'", "Select-String -Path '.[`e]nv' -Pattern SECRET", "Get-ChildItem '.en[`v]'", "Get-Content '.en`v'"]) {
    const outcome = await s.call(command);
    assert.equal(outcome.decision, 'deny', `${command}: ${outcome.output.content}`);
    assert.doesNotMatch(outcome.output.content, /SECRET=1/u, `${command}: 秘密が出た`);
  }
  mkdirSync(s.files('many'));
  for (let i = 0; i < 2100; i++) writeFileSync(s.files(`many/f${String(i).padStart(5, '0')}.txt`), 'x');
  writeFileSync(s.files('many/zzz.pem'), 'PRIVATE-KEY\n');
  for (const command of ['Get-Content many/*', 'Select-String -Path many/* -Pattern PRIVATE', 'Get-ChildItem many | Get-Content']) {
    const outcome = await s.call(command);
    assert.equal(outcome.decision, 'deny', `${command}: ${outcome.output.content.slice(0, 200)}`);
    assert.doesNotMatch(outcome.output.content, /PRIVATE-KEY/u, `${command}: 秘密が出た`);
  }
});

// 7 回目の審査（致命）: PowerShell 5.1 は外部のプログラムの空の引数を捨てる。`git grep -e '' -- '-O./x.sh'` は、git に `grep -e -- -O./x.sh` として渡り、x.sh が動いた
test('実機（Windows PowerShell 5.1・制限モード）: git grep -e \'\' -- -O./x.sh は、素のシェルでは x.sh が動くが、Clive のシェルでは止まって動かない', { skip: !psAvailable && 'Windows の PowerShell が無い' }, async t => {
  if (spawnSync('git', ['--version']).status !== 0) { t.skip('git が無い'); return; }
  const s = setup(t, 'powershell');
  const repo = s.paths.workspace;
  const marker = join(repo, 'ran.txt');
  spawnSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'dash -- here\n');
  writeFileSync(join(repo, 'x.sh'), `#!/bin/sh\necho ran > "${marker.replaceAll('\\', '/')}"\ncat >/dev/null\n`, { mode: 0o755 });
  spawnSync('git', ['add', 'a.txt'], { cwd: repo });
  const command = `git grep -e '' -- '-O./x.sh'`;
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: repo, encoding: 'utf8' });
  assert.equal(existsSync(marker), true, '前提: 素の PowerShell 5.1 では、空の引数が捨てられて x.sh が動く');
  rmSync(marker);
  for (const c of [command, `git grep -e "" -- '-O./x.sh'`, `git grep -e '' '-O./x.sh'`]) {
    const outcome = await s.call(c);
    assert.equal(outcome.decision, 'deny', `${c}: ${outcome.output.content}`);
    assert.match(outcome.output.content, /引数/u, c);
  }
  assert.equal(existsSync(marker), false, 'Clive のシェルで x.sh が動いた');
});

// "…" の中の $( … ) は、中の文をトップレベルの文と同じに調べる（§11.15）。読むだけ・整えるだけは承認なしで本当に動き、中で書く・消す・コードを動かすものは確かめになって、拒否すれば何も起きない
test('実機（Windows PowerShell 5.1・制限モード）: "…" の中の $( … ) は、読むだけなら承認なしで本当に動き、中で書く・消す部分式は確かめになって、拒否すれば何も書かれない', { skip: !psAvailable && 'Windows の PowerShell が無い' }, async t => {
  const s = setup(t, 'powershell');
  const rows: Array<[string, RegExp]> = [
    ['Get-ChildItem *.txt | ForEach-Object { "$($_.Name) $($_.Length)" }', /a\.txt 18/u],
    ['Write-Output "$((Get-Item a.txt).Length) bytes"', /18 bytes/u],
    ['Write-Host "year $(Get-Date -Format yyyy)"', /year 20[0-9]{2}/u],
    ['Write-Output "a$("x $(Get-Date -Format yyyy)")c"', /ax 20[0-9]{2}c/u],
    ['Write-Output "名前は $((Get-Item a.txt).Name)"', /名前は a\.txt/u],
    ['foreach ($f in Get-ChildItem *.txt) { Write-Host "[$($f.Name)]" }', /\[a\.txt\]/u],
    ['"$(Get-Date -Format yyyy)-$(Get-Item a.txt | ForEach-Object { $_.Name })"', /20[0-9]{2}-a\.txt/u],
    ["Write-Output \"it's $((Get-Item a.txt).Name)\"", /it's a\.txt/u],
  ];
  for (const [command, expected] of rows) {
    const outcome = await s.call(command);
    assert.equal(outcome.decision, 'allow', `${command}: ${outcome.output.content}`);
    assert.equal(outcome.decidedBy !== 'user', true, `${command}: 承認を求めた`);
    assert.equal(outcome.output.isError, false, `${command}: ${outcome.output.content}`);
    assert.match(outcome.output.content, expected, command);
  }
  const raw = (command: string): string => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: s.paths.workspace, encoding: 'utf8' }).stdout;
  raw('Write-Output "$(Set-Content raw.txt hello)"');
  assert.equal(existsSync(s.files('raw.txt')), true, '前提: 素の PowerShell では、"…" の中の部分式が本当に書く');
  rmSync(s.files('raw.txt'));
  for (const command of [
    'Write-Output "$(Set-Content out.txt hello)"', 'Write-Output "$(Set-Content SOUL.md pwned)"', 'Write-Output "$(Remove-Item a.txt)"', 'Write-Output "$(New-Item -ItemType Directory made)"', 'Write-Output "$(Copy-Item a.txt c.txt)"',
    'Write-Output "x$("y $(Move-Item a.txt moved.txt)")"', "Write-Output \"$(iex 'Get-Date')\"", 'Get-ChildItem *.txt | ForEach-Object { "$(Remove-Item $_.FullName)" }', 'Write-Output "$(Get-Date)" > out2.txt', 'Write-Output "$(Rename-Item notes.md -NewName renamed.md)"',
  ]) await expectAsk(s, command);
  assert.equal(readFileSync(s.files('SOUL.md'), 'utf8'), 'persona', '人格が書き換わった');
  assert.equal(readFileSync(s.files('a.txt'), 'utf8'), 'line1\nline2\nline3\n', 'a.txt が変わった');
  assert.equal(readFileSync(s.files('notes.md'), 'utf8'), 'notes\n');
  for (const name of ['out.txt', 'made', 'c.txt', 'moved.txt', 'out2.txt', 'renamed.md']) assert.equal(existsSync(s.files(name)), false, `${name} ができた`);
  // 秘密の読み取りは確かめにも進まず止まり、秘密は出ない。読みきれない形は動かす前に止まる
  writeFileSync(s.files('.env'), 'SECRET=1\n');
  assert.match(raw('Write-Output "$(Get-Content .env)"'), /SECRET=1/u, '前提: 素の PowerShell では、部分式が秘密を読む');
  const secret = await s.call('Write-Output "$(Get-Content .env)"');
  assert.equal(secret.decision, 'deny');
  assert.doesNotMatch(secret.output.content, /SECRET=1/u);
  for (const command of ['Write-Output "${env:PATH}"', 'Write-Output "$$(Get-Date)"', "Write-Output \"$(Write-Output ')')\"", 'Write-Output "$(Get-Date # c`n)"']) {
    const outcome = await s.call(command);
    assert.equal(outcome.decision, 'deny', `${command}: ${outcome.output.content}`);
    assert.match(outcome.output.content, /書き方を判定できません/u, command);
  }
});

// 代入の左辺の添字（$a[ … ] = 1）の中の $( … ) も、トップレベルの文と同じに調べる。以前は代入かどうかの先読みが添字の中を読み飛ばして、確かめなしで書いた・消した
test('実機（Windows PowerShell 5.1・制限モード）: 代入の左辺の添字の中で書く・消す部分式は、素の PowerShell では動くが、Clive のシェルでは確かめになり、拒否すれば何も書かれない', { skip: !psAvailable && 'Windows の PowerShell が無い' }, async t => {
  const s = setup(t, 'powershell');
  writeFileSync(s.files('x'), 'keep');
  writeFileSync(s.files('.env'), 'SECRET=1\n');
  const raw = (command: string) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage';${command}`], { cwd: s.paths.workspace, encoding: 'utf8' });
  raw('$a = @(1,2); $a[$(Set-Content premise.txt hello; 0)] = 5');
  assert.equal(existsSync(s.files('premise.txt')), true, '前提: 素の PowerShell（制限モード）では、添字の中の部分式が本当に書く');
  raw('$a = @(1,2); $a[$(Remove-Item x; 0)] = 5');
  assert.equal(existsSync(s.files('x')), false, '前提: 素の PowerShell では、添字の中の部分式が本当に消す');
  raw('$a = @{}; $a[$(Set-Content SOUL.md pwned; 1)] = 1');
  assert.equal(readFileSync(s.files('SOUL.md'), 'utf8').trim(), 'pwned', '前提: 素の PowerShell では、添字の中の部分式が人格を書き換える');
  rmSync(s.files('premise.txt'));
  writeFileSync(s.files('x'), 'keep');
  writeFileSync(s.files('SOUL.md'), 'persona');
  for (const command of [
    '$a = @(1,2); $a[$(Remove-Item x; 0)] = 5', '$a = @(1,2); $a[$(Set-Content out.txt hello; 0)] = 5', '$a = @{}; $a[$(Set-Content SOUL.md pwned; 1)] = 1', '$a = @{}; $a["k$(Set-Content out2.txt hello)"] = 1',
    '$a = @(1,2); $a[$(Remove-Item x; 0)] += 5', '$a = @(1,2); $a[($(Remove-Item x; 0))] = 5', '$a = @(1,2); $a[0..$(Remove-Item x; 1)] = 5', '$a = @{}; $a.b = @{}; $a.b[$(Set-Content out3.txt hello; 1)] = 1',
    '$a = @{}; $a[$a[$(Set-Content out4.txt hello; 1)]] = 1',
  ]) await expectAsk(s, command);
  assert.equal(readFileSync(s.files('x'), 'utf8'), 'keep', 'x が消えた');
  assert.equal(readFileSync(s.files('SOUL.md'), 'utf8'), 'persona', '人格が書き換わった');
  for (const name of ['premise.txt', 'out.txt', 'out2.txt', 'out3.txt', 'out4.txt']) assert.equal(existsSync(s.files(name)), false, `${name} ができた`);
  for (const command of ['$a = @(1,2); $a[$(Get-Content .env | Out-Null; 0)] = 5', '$a = @{}; $a[$(Get-Content .env)] = 1', '$a = @{}; $a["$(Get-Content .env)"] = 1']) {
    const outcome = await s.call(command);
    assert.equal(outcome.decision, 'deny', `${command}: ${outcome.output.content}`);
    assert.doesNotMatch(outcome.output.content, /SECRET=1/u, `${command}: 秘密が出た`);
  }
  // ふつうの代入は、今までどおり承認なしで動く
  for (const [command, expected] of [
    ['$a = @(1,2,3); $a[1] = 9; $a -join ","', /1,9,3/u], ['$a = @(1,2,3); $a[-1] = 9; $a -join ","', /1,2,9/u], ['$h = @{}; $h["a"] = 1; $h.a', /\b1\b/u], ['$h = @{}; $h["k$(Get-Date -Format yyyy)"] = 7; $h.Count', /\b1\b/u],
    ['$a = @(1,2,3); $i = 2; $a[$i] = 5; $a -join ","', /1,2,5/u], ['$h = @{}; $h.b = @{}; $h.b["x"] = 3; $h.b.x', /\b3\b/u],
  ] as const) {
    const outcome = await s.call(command);
    assert.equal(outcome.decision, 'allow', `${command}: ${outcome.output.content}`);
    assert.equal(outcome.decidedBy !== 'user', true, `${command}: 承認を求めた`);
    assert.equal(outcome.output.isError, false, `${command}: ${outcome.output.content}`);
    assert.match(outcome.output.content, expected, command);
  }
});

const bashPath = which('bash');
const bashAvailable = bashPath !== undefined && spawnSync(bashPath, ['--noprofile', '--norc', '-c', 'echo ok'], { encoding: 'utf8' }).stdout.trim() === 'ok';

test('実機（bash）: 一覧に当たるコマンドは承認なしで動き、組み立てた書き込み先は確かめになる', { skip: !bashAvailable && 'bash が無い' }, async t => {
  const s = setup(t, 'bash');
  const rows: Array<[string, RegExp]> = [
    ['ls', /a\.txt/u], ['cat a.txt | head -n 2', /line1\s+line2/u], ['grep -rn line2 .', /a\.txt/u], ['find . -name "*.txt" -type f | sort', /b\.txt/u], ['wc -l a.txt', /3/u], ['echo hello > out.txt && cat out.txt', /hello/u],
    ['mkdir -p made/inner && ls made', /inner/u], ['cp a.txt c.txt && cmp a.txt c.txt && echo same', /same/u], ['sed -n "2p" a.txt', /line2/u], ['for f in *.txt; do echo "$f"; done', /a\.txt/u], ['git --version', /git version/u],
    ['sort a.txt | uniq -c | head -n 1', /1 line1/u], ['tar -cf out.tar a.txt && tar -tf out.tar', /a\.txt/u], ['rm -f c.txt && ls', /a\.txt/u],
  ];
  for (const [command, expected] of rows) {
    const outcome = await s.call(command);
    assert.equal(outcome.decision, 'allow', `${command}: ${outcome.output.content}`);
    assert.equal(outcome.output.isError, false, `${command}: ${outcome.output.content}`);
    assert.match(outcome.output.content, expected, command);
  }
  for (const command of ['cp tmp/SOUL.md .', 'mv tmp/SOUL.md .', 'cp -r tmp/. .', 'rm -rf -- *', 'echo x > SOUL.md', "node -e 1", 'awk 1 a.txt', 'tar -xf out.tar']) await expectAsk(s, command);
  assert.equal(readFileSync(s.files('SOUL.md'), 'utf8'), 'persona');
  assert.equal(existsSync(s.files('tmp/SOUL.md')), true);
});

// "…" の中の \ は、$ ` " \ 改行の前でだけ特別（§11.15）。読むだけの形は承認なしで本当に動き、\$( は文字のままで何も動かさない
test('実機（bash）: "…" の中の \\ を含む読むだけのコマンドは承認なしで本当に動き、echo "\\$(rm x)" は文字を出すだけで何も消さない', { skip: !bashAvailable && 'bash が無い' }, async t => {
  const s = setup(t, 'bash');
  writeFileSync(s.files('lines.txt'), 'main.ts\nnotes.md\nfoo|bar\nline1\nline3\n');
  writeFileSync(s.files('x'), 'keep');
  const rows: Array<[string, string]> = [
    ['grep "\\.ts$" lines.txt', 'main.ts'],
    ['grep "line1\\|line3" lines.txt', 'line1\nline3'],
    ['grep "foo\\|nothing" lines.txt', 'foo|bar'],
    ['echo "a\\nb"', 'a\\nb'],
    ['echo "\\$HOME"', '$HOME'],
    ['echo "say \\"hi\\""', 'say "hi"'],
    ['echo "\\$(rm x)"', '$(rm x)'],
    ['echo "tab\\there" | wc -c', '10'],
  ];
  for (const [command, expected] of rows) {
    const outcome = await s.call(command);
    assert.equal(outcome.decision, 'allow', `${command}: ${outcome.output.content}`);
    assert.equal(outcome.decidedBy !== 'user', true, `${command}: 承認を求めた`);
    assert.equal(outcome.output.isError, false, `${command}: ${outcome.output.content}`);
    assert.equal(outcome.output.content.split('\n\n').slice(2).join('\n\n').trim(), expected, command);
  }
  assert.equal(readFileSync(s.files('x'), 'utf8'), 'keep', 'echo "\\$(rm x)" で x が消えた');
});

// Windows の Git Bash に bash -c で渡すと、連続する \\ が 1 つに減る。Clive のシェルはスクリプトを標準入力で渡す（runner.ts）ので減らず、ガードの読みどおりに動く
test('実機（bash・Windows）: "…" の中の連続する \\\\ は、素の bash -c では減って置換が動くが、Clive のシェルでは減らず、ガードの読みどおり文字のまま出て、置換の touch は動かない', { skip: (process.platform !== 'win32' || !bashAvailable) && 'Windows の Git Bash が無い' }, async t => {
  const s = setup(t, 'bash');
  const dangerous = 'echo "\\\\\\$(touch made)"';
  const raw = spawnSync(bashPath!, ['--noprofile', '--norc', '-c', dangerous], { cwd: s.paths.workspace, encoding: 'utf8' });
  assert.equal(raw.stdout, '\\\n', '前提: 素の bash -c では、\\\\\\$ が \\\\$ に減って、$( が置換になる');
  assert.equal(existsSync(s.files('made')), true, '前提: 置換の touch が動く');
  rmSync(s.files('made'));
  const body = (outcome: { output: { content: string } }): string => outcome.output.content.split('\n\n').slice(2).join('\n\n').trim();
  const lexed = lexShell(dangerous, 'bash');
  assert.ok(lexed.ok && lexed.statements.length === 1 && lexed.statements[0]!.words[1]!.text === '\\$(touch made)', 'ガードは、置換のない 1 つの文として読む');
  const outcome = await s.call(dangerous);
  assert.equal(outcome.decision, 'allow', outcome.output.content);
  assert.equal(outcome.decidedBy !== 'user', true, '承認を求めた');
  assert.equal(outcome.output.isError, false, outcome.output.content);
  assert.equal(body(outcome), '\\$(touch made)', 'ガードの読みと同じ文字が出る');
  assert.equal(existsSync(s.files('made')), false, 'Clive のシェルで置換の touch が動いた');
  for (const [command, expected] of [
    ['echo "a\\\\b"', 'a\\b'], ['echo "\\\\\\\\"', '\\\\'], ['echo "x\\\\" "y"', 'x\\ y'], ['echo "\\\\$HOME_UNSET_XYZ"', '\\'], ['grep -c "line\\\\|notes" a.txt', '3'],
  ] as const) {
    const run = await s.call(command);
    assert.equal(run.decision, 'allow', `${command}: ${run.output.content}`);
    assert.equal(run.decidedBy !== 'user', true, `${command}: 承認を求めた`);
    assert.equal(body(run), expected, command);
  }
  // 本物の置換（\\ のあとの $( ）は、今までどおり中の文が判定される: コードを動かす文は確かめになり、拒否すれば動かない
  await expectAsk(s, 'echo "\\\\$(node -e 1)"');
});

// 全角の見張りは、字句の読み取りと同じ引用符の組み方で、引用符の外の全角（＂--pre=x＂ は Windows で " になって引数を割る）を止める
test('実機（bash）: "…" の中の $( ) の中の引用符・コメント・ヒアドキュメントの引用符に惑わされず、引用符の外の全角は動かす前に止まる。引用符の中の全角は動く', { skip: !bashAvailable && 'bash が無い' }, async t => {
  const s = setup(t, 'bash');
  for (const command of [`echo "$(echo '"')" ＂--pre=x＂`, "echo a # it's\necho ＂--pre=x＂ done", "cat <<'EOF'\nit's\nEOF\necho ＂--pre=x＂ done", 'echo "$(echo ＡＢ)"']) {
    const outcome = await s.call(command);
    assert.equal(outcome.decision, 'deny', `${command}: ${outcome.output.content}`);
    assert.match(outcome.output.content, /書き方を判定できません/u, command);
    assert.doesNotMatch(outcome.output.content, /done/u, `${command}: 動いた`);
  }
  for (const [command, expected] of [[`echo "$(echo 'ＡＢ')"`, 'ＡＢ'], [`echo "ＡＢ $(echo '"')"`, 'ＡＢ "']] as const) {
    const outcome = await s.call(command);
    assert.equal(outcome.decision, 'allow', `${command}: ${outcome.output.content}`);
    assert.equal(outcome.output.content.split('\n\n').slice(2).join('\n\n').trim(), expected, command);
  }
});

// 最終審査で再現: $( ) の終わりの切り出しが bash とずれて、コメントの後ろ・case の )・$(( の部分シェル・[[ ]] のコメントと閉じ方・$[ ]・(( )) が、中の文を隠していた。
// 素の bash では pwn.sh が動くこと（前提）と、Clive のシェルでは止まるか確かめになり、拒否すれば pwn.sh が動かないことを確かめる。ふつうの [[ ]] は承認なしで動く
test('実機（bash）: 文を隠す形（$( ) の中のコメント・case の )・$(( の部分シェル・[[ ]]・$[ ]・(( ））は、素の bash では pwn.sh が動くが、Clive のシェルでは止まるか確かめになり、拒否すれば動かない', { skip: !bashAvailable && 'bash が無い' }, async t => {
  const s = setup(t, 'bash');
  const marker = s.files('ran.txt');
  writeFileSync(s.files('pwn.sh'), '#!/bin/sh\necho ran > ran.txt\n', { mode: 0o755 });
  const rows = [
    'echo "$(# )\n./pwn.sh)"', 'x="$(# )\n./pwn.sh)"', 'echo "a$(#)\n./pwn.sh\n)"', 'echo "$(: # ) ;\n./pwn.sh)"', 'cat <(# )\n./pwn.sh)', 'echo "$(case x in x) ./pwn.sh;; esac)"', 'echo "$((true)\n./pwn.sh))"',
    '[[ -n x # "\n]] && ./pwn.sh; echo "a" # "\n]]', 'if [[ -n x ]]; then ./pwn.sh ]] ; fi', 'if [[ -n x ]] then ./pwn.sh; fi', 'echo $[1 # $(./pwn.sh)]', '(( ls # )); ./pwn.sh',
  ];
  for (const command of rows) {
    rmSync(marker, { force: true });
    spawnSync(bashPath!, ['--noprofile', '--norc', '-c', command], { cwd: s.paths.workspace, encoding: 'utf8' });
    assert.equal(existsSync(marker), true, `前提: 素の bash では pwn.sh が動く: ${JSON.stringify(command)}`);
    rmSync(marker);
    await expectBlocked(s, command);
    assert.equal(existsSync(marker), false, `Clive のシェルで pwn.sh が動いた: ${JSON.stringify(command)}`);
  }
  for (const [command, expected] of [['if [[ -f a.txt ]]; then echo yes; fi', /yes/u], ['[[ -n x ]] && echo ok || echo no', /ok/u], ['echo "$(echo a#b) $#"', /a#b/u], ['echo $((1 + 2))', /3/u]] as const) {
    const outcome = await s.call(command);
    assert.equal(outcome.decision, 'allow', `${command}: ${outcome.output.content}`);
    assert.equal(outcome.decidedBy !== 'user', true, `${command}: 承認を求めた`);
    assert.match(outcome.output.content, expected, command);
  }
});

const gitAvailable = spawnSync('git', ['--version']).status === 0;

// 8 回目の審査（致命）: curl は URL の { } [ ] を展開し、-o の #1 に差し込み、-O は展開した名前で保存する。
// 本物の curl と、この PC の小さなサーバーで、素のシェルでは本当に書かれる・届くこと（前提）と、-g があれば文字どおりになることを確かめ、Clive のシェルでは止まって何も起きないことを確かめる
const curlExe = which('curl');
async function startEcho(): Promise<{ port: number; seen: string[]; close: () => void }> {
  const seen: string[] = [];
  const server = createServer((req, res) => { seen.push(req.url ?? ''); res.end('body-from-server\n'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, seen, close: () => server.close() };
}
const curlRaw = (args: string[], cwd: string): Promise<{ code: number; stderr: string }> =>
  new Promise(resolve => { execFile(curlExe!, args, { cwd, timeout: 15_000 }, (error, _out, stderr) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stderr })); });

test('実機（curl 8.19）: { } [ ] は展開されて #1 に差し込まれ、-g なら文字どおり。展開で別のホスト名・保存先になる', { skip: !curlExe && 'curl が無い' }, async t => {
  const echo = await startEcho();
  t.after(() => echo.close());
  const base = tempDir(t);
  const raw = join(base, 'raw');
  mkdirSync(join(raw, '.git', 'hooks'), { recursive: true });
  mkdirSync(join(raw, 'sub'), { recursive: true });
  const url = (path: string): string => `http://127.0.0.1:${echo.port}/${path}`;
  await curlRaw(['-sS', '-o', '#1.md', url('{SOUL}')], raw);
  assert.equal(existsSync(join(raw, 'SOUL.md')), true, '-o の #1 に { } の中が差し込まれる');
  await curlRaw(['-sS', '-O', url('{USER.md,zz}')], raw);
  assert.equal(existsSync(join(raw, 'USER.md')) && existsSync(join(raw, 'zz')), true, '-O は展開した名前で保存する');
  await curlRaw(['-sS', '-o', '#1', url('{.git/hooks/post-index-change}')], raw);
  assert.equal(existsSync(join(raw, '.git', 'hooks', 'post-index-change')), true, 'フォルダの区切りも通る');
  await curlRaw(['-sS', '-o', '#1', url('{../config.json}')], join(raw, 'sub'));
  assert.equal(existsSync(join(raw, 'config.json')), true, '親のフォルダにも書ける');
  echo.seen.length = 0;
  await curlRaw(['-sS', `http://{127.0.0.1}:${echo.port}/api/health`], raw);
  await curlRaw(['-sS', `http://loc{alhost}:${echo.port}/api/health`], raw);
  assert.deepEqual(echo.seen, ['/api/health', '/api/health'], 'ホスト名の一部の { } も展開されて、この PC のサーバーに届く');
  const bracket = await curlRaw(['-sS', `http://[::1]:${echo.port}/`], raw);
  assert.notEqual(bracket.code, 0, '[ ] は、-g が無いと IPv6 の書き方でもグロブとして読まれてエラーになる');
  // -g があれば、URL も -o も文字どおり
  const lit = join(base, 'lit');
  mkdirSync(lit);
  echo.seen.length = 0;
  await curlRaw(['-g', '-sS', '-o', '#1.md', url('{SOUL}')], lit);
  assert.equal(existsSync(join(lit, '#1.md')), true, '-g では -o の #1 は文字どおりの名前');
  assert.equal(existsSync(join(lit, 'SOUL.md')), false, '-g では展開されない');
  assert.equal(echo.seen.length, 1);
  assert.match(decodeURIComponent(echo.seen[0]!), /\{SOUL\}/u, '-g では { } がパスにそのまま入る');
  echo.seen.length = 0;
  const host = await curlRaw(['-g', '-sS', `http://{127.0.0.1}:${echo.port}/api/health`], lit);
  assert.notEqual(host.code, 0, '-g では、ホスト名の { } は文字どおりで、解決できない');
  assert.deepEqual(echo.seen, [], '-g では、この PC のサーバーに届かない');
});

for (const shell of ['powershell', 'bash'] as const) {
  const available = shell === 'powershell' ? psAvailable : bashAvailable;
  test(`実機（${shell}）: curl の { } [ ] で保存先・宛先を変える形は、確かめになるか止まり、拒否すれば何も起きない。保存する形は、決まっていても毎回確かめる`, { skip: (!available || !curlExe) && 'シェルか curl が無い' }, async t => {
    const echo = await startEcho();
    t.after(() => echo.close());
    const s = setup(t, shell);
    mkdirSync(s.files('.git/hooks'), { recursive: true });
    const curl = shell === 'powershell' ? 'curl.exe' : 'curl';
    const configJson = join(s.paths.workspace, '..', 'config.json');
    for (const command of [
      `${curl} -sS -o '#1.md' 'https://example.com/{SOUL}'`, `${curl} -sS -O 'https://example.com/{USER.md,zz}'`, `${curl} -sS -o '#1' 'https://example.com/{.git/hooks/post-index-change}'`,
      `${curl} -sS -o '#1' 'https://example.com/{../config.json}'`, `${curl} -sS 'http://{127.0.0.1}:${echo.port}/api/health'`, `${curl} -sS 'http://loc{alhost}:${echo.port}/api/health'`,
      `${curl} -sS -o page.html https://example.com/x`, `${curl} -sS -O https://example.com/x.zip`, `${curl} -sS -o '#1.md' 'https://example.com/a'`,
    ]) await expectBlocked(s, command);
    assert.equal(readFileSync(s.files('SOUL.md'), 'utf8'), 'persona', '人格が書き換わった');
    for (const name of ['USER.md', 'zz', '.git/hooks/post-index-change', 'page.html', 'x.zip']) assert.equal(existsSync(s.files(name)), false, `${name} ができた`);
    assert.equal(existsSync(configJson), false, 'config.json ができた');
    assert.deepEqual(echo.seen, [], 'この PC のサーバーに届いた');
  });
}

// 8 回目の審査（高）: findstr /f:list.txt は、list.txt に書かれたファイルを読む。チェックサムの -c も、一覧のファイルに書かれたファイルを読む。引用符で囲んだフラグも、プログラムにはフラグ
test('実機（Windows PowerShell 5.1・制限モード）: findstr /f: は素のシェルでは一覧のファイル（.env）を読むが、Clive のシェルでは今回だけの確かめになり、拒否すれば動かない。引用符つきの /s も下を歩いて止まる', { skip: !psAvailable && 'Windows の PowerShell が無い' }, async t => {
  const s = setup(t, 'powershell');
  seedSecrets(s);
  writeFileSync(s.files('list.txt'), '.env\n');
  const raw = (command: string): string => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: s.paths.workspace, encoding: 'utf8' }).stdout;
  for (const command of ['findstr /f:list.txt SECRET=', "findstr '/f:list.txt' SECRET="]) {
    assert.match(raw(command), /SECRET=root/u, `前提: 素のシェルでは一覧のファイルが読まれる: ${command}`);
    await expectAsk(s, command);
  }
  await expectDenied(s, ["findstr '/s' SECRET *", 'findstr "/s" SECRET *'], raw);
});

test('実機（bash）: md5sum -c は素のシェルでは一覧のファイルを読んで照合するが、Clive のシェルでは今回だけの確かめになり、拒否すれば動かない', { skip: !bashAvailable && 'bash が無い' }, async t => {
  const s = setup(t, 'bash');
  seedSecrets(s);
  const bash = (command: string): string => spawnSync(bashPath!, ['--noprofile', '--norc', '-c', command], { cwd: s.paths.workspace, encoding: 'utf8' }).stdout;
  bash('md5sum .env > sums.txt');
  assert.match(bash('md5sum -c sums.txt'), /\.env: OK/u, '前提: 素のシェルでは、一覧に書かれた .env が読まれて照合される');
  await expectAsk(s, 'md5sum -c sums.txt');
  await expectAsk(s, "md5sum '-c' sums.txt");
  assert.equal((await s.call('md5sum a.txt')).decision, 'allow', '照合でない md5sum は、これまでどおり');
});

// 7 回目の審査（高）: フォルダを再帰して中身を読むコマンドは、下の秘密のパスを調べていなかった。素のシェルで本当に表示されること（前提）と、Clive のシェルでは止まり、秘密が出ないことを確かめる
function seedSecrets(s: ReturnType<typeof setup>): void {
  mkdirSync(s.files('proj/inner'), { recursive: true });
  writeFileSync(s.files('.env'), 'SECRET=root\n');
  writeFileSync(s.files('proj/.env'), 'SECRET=proj\n');
  writeFileSync(s.files('proj/inner/.env'), 'SECRET=inner\n');
  writeFileSync(s.files('proj/inner/a.txt'), 'plain SECRET-word\n');
}
async function expectDenied(s: ReturnType<typeof setup>, commands: readonly string[], raw: (command: string) => string): Promise<void> {
  for (const command of commands) {
    assert.match(raw(command), /SECRET=(?:root|proj|inner)/u, `前提: 素のシェルでは秘密が出る: ${command}`);
    const outcome = await s.call(command);
    assert.equal(outcome.decision, 'deny', `${command}: ${outcome.output.content}`);
    assert.doesNotMatch(outcome.output.content, /SECRET=(?:root|proj|inner)/u, `${command}: 秘密が出た`);
  }
}

test('実機（Windows PowerShell 5.1・制限モード）: findstr /s・findstr のワイルドカード・git grep --untracked / --no-index は、フォルダの下に秘密のパスがあれば止まり、秘密は出ない', { skip: !psAvailable && 'Windows の PowerShell が無い' }, async t => {
  const s = setup(t, 'powershell');
  seedSecrets(s);
  if (gitAvailable) spawnSync('git', ['init', '-q'], { cwd: s.paths.workspace });
  const raw = (command: string): string => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: s.paths.workspace, encoding: 'utf8' }).stdout;
  await expectDenied(s, ['findstr /s SECRET *', 'findstr SECRET *', 'findstr /s SECRET proj\\*', 'findstr /s SECRET a.txt .env', 'findstr /s /i secret *.*', ...(gitAvailable ? ['git grep --no-index SECRET', 'git grep --untracked SECRET', 'git grep --no-index SECRET -- proj'] : [])], raw);
  // 秘密の無いフォルダは、これまでどおり確かめなしで動く
  mkdirSync(s.files('clean'), { recursive: true });
  writeFileSync(s.files('clean/c.txt'), 'SECRET-word\n');
  const clean = await s.call('findstr /s SECRET clean\\*');
  assert.equal(clean.decision, 'allow', clean.output.content);
  assert.match(clean.output.content, /SECRET-word/u);
});

// 7 回目の審査（中）: アーカイブを作ってから読む。tar は中身をそのまま入れ、out2.tar という名前は秘密のパスではない
test('実機（Windows PowerShell 5.1・制限モード）: アーカイブを作ってから読む形は、元のフォルダの下に秘密のパスがあれば、アーカイブを作る段で止まる', { skip: !psAvailable && 'Windows の PowerShell が無い' }, async t => {
  const s = setup(t, 'powershell');
  seedSecrets(s);
  const raw = (command: string): string => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: s.paths.workspace, encoding: 'utf8' }).stdout;
  assert.match(raw('tar.exe -cf out2.tar proj; Select-String -Path out2.tar -Pattern SECRET'), /SECRET=(?:proj|inner)/u, '前提: 素のシェルでは、作った tar から秘密が読める');
  rmSync(s.files('out2.tar'));
  for (const command of ['tar.exe -cf out2.tar proj', 'tar -czf out2.tgz proj', 'tar.exe -cf out2.tar .', 'Compress-Archive -Path proj -DestinationPath out2.zip']) {
    const outcome = await s.call(command);
    assert.equal(outcome.decision, 'deny', `${command}: ${outcome.output.content}`);
  }
  for (const name of ['out2.tar', 'out2.tgz', 'out2.zip']) assert.equal(existsSync(s.files(name)), false, `${name} ができた`);
  mkdirSync(s.files('clean'), { recursive: true });
  writeFileSync(s.files('clean/c.txt'), 'plain\n');
  const clean = await s.call('tar.exe -cf out3.tar clean');
  assert.equal(clean.decision, 'allow', clean.output.content);
  assert.equal(existsSync(s.files('out3.tar')), true);
});

test('実機（bash）: tar -c で作ってから読む形は、元のフォルダの下に秘密のパスがあれば止まる', { skip: !bashAvailable && 'bash が無い' }, async t => {
  const s = setup(t, 'bash');
  seedSecrets(s);
  const out = spawnSync(bashPath!, ['--noprofile', '--norc', '-c', 'tar -cf out.tar proj && grep -a SECRET out.tar'], { cwd: s.paths.workspace, encoding: 'utf8' }).stdout;
  assert.match(out, /SECRET=(?:proj|inner)/u, '前提: 素のシェルでは、作った tar から秘密が読める');
  rmSync(s.files('out.tar'));
  const outcome = await s.call('tar -cf out.tar proj');
  assert.equal(outcome.decision, 'deny', outcome.output.content);
  assert.equal(existsSync(s.files('out.tar')), false);
});

test('実機（bash）: grep -r・diff -r は、フォルダの下に秘密のパスがあれば止まり、秘密は出ない。秘密の無いフォルダは止めない', { skip: !bashAvailable && 'bash が無い' }, async t => {
  const s = setup(t, 'bash');
  seedSecrets(s);
  mkdirSync(s.files('proj2/inner'), { recursive: true });
  writeFileSync(s.files('proj2/inner/.env'), 'SECRET=other\n');
  const raw = (command: string): string => spawnSync(bashPath!, ['--noprofile', '--norc', '-c', command], { cwd: s.paths.workspace, encoding: 'utf8' }).stdout;
  await expectDenied(s, ['grep -r SECRET proj', 'grep -rn SECRET .', 'grep -r SECRET', 'grep -R SECRET proj/inner', 'diff -r proj proj2'], raw);
  mkdirSync(s.files('clean'), { recursive: true });
  writeFileSync(s.files('clean/c.txt'), 'SECRET-word\n');
  const clean = await s.call('grep -r SECRET clean');
  assert.equal(clean.decision, 'allow', clean.output.content);
  assert.match(clean.output.content, /SECRET-word/u);
});

// 審査で見つかった: ホームの ~/.gitconfig は、リポジトリの設定の検査に入っていなかった。そこに仕込まれた core.fsmonitor は、許可された `git status` で動く
for (const shell of ['powershell', 'bash'] as const) {
  const available = shell === 'powershell' ? psAvailable : bashAvailable;
  test(`実機（${shell}）: ホームの ~/.gitconfig に仕込んだ core.fsmonitor は、許可された git status では動かない。名前・メールは残る`, { skip: (!available || !gitAvailable) && 'シェルか git が無い' }, async t => {
    const s = setup(t, shell);
    const root = s.paths.workspace;
    const home = join(s.paths.workspace, '..', 'evil-home');
    mkdirSync(home, { recursive: true });
    const marker = join(home, 'marker');
    const hook = join(home, 'hook.sh');
    writeFileSync(hook, `#!/bin/sh\necho ran > "${marker.replaceAll('\\', '/')}"\nprintf '\\0'\n`, { mode: 0o755 });
    writeFileSync(join(home, '.gitconfig'), `[user]\n\tname = Taro Yamada\n\temail = taro@example.com\n[core]\n\tfsmonitor = ${hook.replaceAll('\\', '/')}\n`);
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.XDG_CONFIG_HOME;
    spawnSync('git', ['init', '-q'], { cwd: root });
    // 前提: 洗い出さない素の git では、ホームの設定のコードが動く
    spawnSync('git', ['status', '--short'], { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home } });
    assert.equal(existsSync(marker), true, '前提: 本物の git は、ホームの core.fsmonitor を動かす');
    rmSync(marker);
    const outcome = await s.call('git status --short');
    assert.equal(outcome.decision, 'allow', outcome.output.content);
    assert.equal(outcome.output.isError, false, outcome.output.content);
    assert.equal(existsSync(marker), false, 'ホームの設定のコードが動いた');
    const name = await s.call('git config --get user.name');
    assert.equal(name.decision, 'allow', name.output.content);
    assert.match(name.output.content, /Taro Yamada/u, '名前は洗い出した設定に残る');
    const email = await s.call('git config --get user.email');
    assert.match(email.output.content, /taro@example\.com/u, 'メールも残る');
    const hookSetting = await s.call('git config --get core.fsmonitor');
    assert.doesNotMatch(hookSetting.output.content, /hook\.sh/u, 'コードを動かせる項目は残らない');
  });
}

// 審査の指摘（深い審査）: 洗い出しで core.quotepath と core.excludesFile まで落ち、日本語のファイル名が八進数で出る・全体の無視の一覧が効かない、が起きた。Clive のシェルを通して、本物の git で確かめる
for (const shell of ['powershell', 'bash'] as const) {
  const available = shell === 'powershell' ? psAvailable : bashAvailable;
  test(`実機（${shell}）: ホームの core.quotepath=false と core.excludesFile は、Clive の git status でも効く（日本語のファイル名がそのまま出て、全体の無視の一覧が効く）`, { skip: (!available || !gitAvailable) && 'シェルか git が無い' }, async t => {
    const s = setup(t, shell);
    const root = s.paths.workspace;
    const home = join(s.paths.workspace, '..', 'quote-home');
    mkdirSync(home, { recursive: true });
    const ignore = join(home, 'ignore-global');
    writeFileSync(ignore, '*.secret-log\n');
    writeFileSync(join(home, '.gitconfig'), `[user]\n\tname = Taro\n\temail = taro@example.com\n[core]\n\tquotepath = false\n\texcludesFile = ${ignore.replaceAll('\\', '/')}\n`);
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.XDG_CONFIG_HOME;
    mkdirSync(join(root, 'q'));
    spawnSync('git', ['init', '-q'], { cwd: join(root, 'q') });
    writeFileSync(join(root, 'q', 'ひらがな.txt'), 'x');
    writeFileSync(join(root, 'q', 'build.secret-log'), 'x');
    const outcome = await s.call(shell === 'powershell' ? 'cd q; git status --short' : 'cd q && git status --short');
    assert.equal(outcome.decision, 'allow', outcome.output.content);
    assert.match(outcome.output.content, /\?\? ひらがな\.txt/u, '日本語のファイル名が、そのまま出ていない');
    assert.doesNotMatch(outcome.output.content, /secret-log/u, '全体の無視の一覧が効いていない');
  });
}

// 審査の追加の指摘: cd で動いた先のリポジトリの core.fsmonitor は、許可された git status で動いていた（最初の作業フォルダの設定しか見ていなかった）。
// 本物の git で、今回だけの確かめを断れば動かないこと、問題のないリポジトリは確かめなしで動くことを確かめる
for (const shell of ['powershell', 'bash'] as const) {
  const available = shell === 'powershell' ? psAvailable : bashAvailable;
  test(`実機（${shell}）: cd で動いた先のリポジトリの core.fsmonitor は今回だけの確かめになり、断れば動かない。問題のないリポジトリは確かめなしで動く`, { skip: (!available || !gitAvailable) && 'シェルか git が無い' }, async t => {
    const s = setup(t, shell);
    const root = s.paths.workspace;
    const fwd = (p: string): string => p.replaceAll('\\', '/');
    const marker = join(root, 'marker');
    const hook = join(root, 'hook.sh');
    writeFileSync(hook, `#!/bin/sh\necho ran > "${fwd(marker)}"\nprintf '\\0'\n`, { mode: 0o755 });
    for (const d of ['bad', 'good']) {
      mkdirSync(join(root, d));
      spawnSync('git', ['init', '-q'], { cwd: join(root, d) });
    }
    spawnSync('git', ['config', 'core.fsmonitor', fwd(hook)], { cwd: join(root, 'bad') });
    // 前提: 素の git では、bad のリポジトリの core.fsmonitor は git status で動く
    spawnSync('git', ['status', '--short'], { cwd: join(root, 'bad') });
    assert.equal(existsSync(marker), true, '前提: 本物の git は、リポジトリの core.fsmonitor を動かす');
    rmSync(marker);
    const ps = shell === 'powershell';
    for (const command of ps ? ['cd bad; git status', 'Set-Location bad; git status', 'Push-Location bad; git log -p'] : ['cd bad && git status', 'pushd bad && git diff', 'cd bad; git log -p']) {
      await expectAsk(s, command);
      assert.equal(existsSync(marker), false, `${command}: 断ったのに、リポジトリの設定のコードが動いた`);
    }
    const clean = await s.call(ps ? 'cd good; git status --short' : 'cd good && git status --short');
    assert.equal(clean.decision, 'allow', clean.output.content);
    assert.equal(clean.decidedBy !== 'user', true, '問題のないリポジトリで承認を求めた');
    assert.equal(clean.output.isError, false, clean.output.content);
    assert.equal(existsSync(marker), false);
  });
}

// 審査の追加の指摘: HEAD が不正なおとりのフォルダ（bare/dec）で、ガードは止まり、git は飛ばして上の裏のリポジトリ bare を使う。bare の設定の textconv が `git log -p` で動く。
// 本物の git で、今回だけの確かめを断れば動かないこと、HEAD が有効な（本物の）リポジトリは確かめなしで動くことを確かめる
for (const shell of ['powershell', 'bash'] as const) {
  const available = shell === 'powershell' ? psAvailable : bashAvailable;
  test(`実機（${shell}）: HEAD が不正なおとりの下で、上の裏のリポジトリの textconv は、今回だけの確かめになり、断れば動かない`, { skip: (!available || !gitAvailable) && 'シェルか git が無い' }, async t => {
    const s = setup(t, shell);
    const root = s.paths.workspace;
    const fwd = (p: string): string => p.replaceAll('\\', '/');
    const bare = join(root, 'bare');
    const work = join(root, 'wt');
    const marker = join(root, 'marker');
    const conv = join(root, 'conv.sh');
    mkdirSync(work);
    spawnSync('git', ['init', '-q', '--bare', bare]);
    const g = (...args: string[]) => spawnSync('git', ['--git-dir', bare, '--work-tree', work, '-c', 'user.name=t', '-c', 'user.email=t@e', ...args]);
    for (const text of ['one\n', 'two\n']) {
      writeFileSync(join(work, 'f.txt'), text);
      g('add', 'f.txt');
      g('commit', '-q', '-m', text.trim());
    }
    writeFileSync(conv, `#!/bin/sh\necho ran > "${fwd(marker)}"\ncat "$1"\n`, { mode: 0o755 });
    mkdirSync(join(bare, 'info'), { recursive: true });
    writeFileSync(join(bare, 'info', 'attributes'), '* diff=x\n');
    appendFileSync(join(bare, 'config'), `[diff "x"]\n\ttextconv = ${fwd(conv)}\n`);
    const decoy = join(bare, 'dec');
    mkdirSync(join(decoy, 'objects'), { recursive: true });
    mkdirSync(join(decoy, 'refs'), { recursive: true });
    writeFileSync(join(decoy, 'HEAD'), 'x');
    // 前提: 本物の git は、おとりを飛ばして上の bare を使い、その設定の textconv を動かす
    spawnSync('git', ['-C', decoy, 'log', '-p', '--oneline']);
    assert.equal(existsSync(marker), true, '前提: 本物の git は、上の裏のリポジトリの textconv を動かす');
    rmSync(marker);
    const ps = shell === 'powershell';
    for (const command of ps ? ['git -C bare/dec log -p', 'cd bare/dec; git log -p', 'Set-Location bare/dec; git show'] : ['git -C bare/dec log -p', 'cd bare/dec && git log -p', 'git -C bare/dec show']) {
      await expectAsk(s, command);
      assert.equal(existsSync(marker), false, `${command}: 断ったのに、上のリポジトリの設定のコードが動いた`);
    }
    // HEAD が有効なら、dec は本物のリポジトリ（設定は空）。確かめなしで通る
    writeFileSync(join(decoy, 'HEAD'), 'ref: refs/heads/main\n');
    const real = await s.call('git -C bare/dec status --short');
    assert.equal(real.decision, 'allow', real.output.content);
    assert.equal(real.decidedBy !== 'user', true, '本物のリポジトリで承認を求めた');
  });
}

// 審査の指摘（洗い出した git の設定の書き換え）: 洗い出した設定のファイルは、データのフォルダの決まった場所にあり、そこへの書き込みはふつうの確かめだった。
// 確かめを許したあと、同じコマンドの中で書き込んで git status を動かすと、書き込んだ設定のコードが動いた。本物の git で、動かないことを確かめる
for (const shell of ['powershell', 'bash'] as const) {
  const available = shell === 'powershell' ? psAvailable : bashAvailable;
  test(`実機（${shell}）: 洗い出した git の設定の旧い置き場所に、確かめを許して書き込んでも、同じコマンドの git status では動かない`, { skip: (!available || !gitAvailable) && 'シェルか git が無い' }, async t => {
    const s = setup(t, shell);
    const root = s.paths.workspace;
    const fwd = (p: string): string => p.replaceAll('\\', '/');
    const marker = join(root, 'marker');
    const hook = join(root, 'hook.sh');
    writeFileSync(hook, `#!/bin/sh\necho ran > "${fwd(marker)}"\nprintf '\\0'\n`, { mode: 0o755 });
    mkdirSync(join(root, 'gr'));
    spawnSync('git', ['init', '-q'], { cwd: join(root, 'gr') });
    // 洗い出した設定が置かれる決まった場所（これまでの置き場所）
    const old = join(s.paths.data, 'git-global', 'gitconfig');
    const command = shell === 'powershell'
      ? `Set-Content -Path '${old}' -Value '[core]', 'fsmonitor = ${fwd(hook)}'; cd gr; git status`
      : `printf '[core]\\nfsmonitor = ${fwd(hook)}\\n' > '${fwd(old)}' && cd gr && git status`;
    const pending = s.call(command);
    for (let i = 0; i < 300 && !s.approvals.pending().length; i++) await new Promise(r => setTimeout(r, 10));
    const request = s.approvals.pending()[0];
    assert.ok(request, '書き込みが確かめにならず、承認の依頼が来ていない');
    s.approvals.decide(request.id, 'once');
    await pending;
    assert.equal(existsSync(marker), false, '同じコマンドで書き換えた設定のコードが動いた');
    // git が読む洗い出した設定の置き場所は、実行のたびに違い、終わると消える
    const origin = async () => /^(\S*git-run\S*hooks)$/mu.exec((await s.call('git config --get core.hooksPath')).output.content)?.[1];
    const first = await origin();
    const second = await origin();
    assert.ok(first && second, '実行ごとの置き場所が core.hooksPath に出ない');
    assert.notEqual(first, second, '2 回の実行が同じ置き場所を使う');
    assert.equal(first.includes('git-global'), false, 'これまでの決まった置き場所を使っている');
    for (const place of [first, second]) assert.equal(existsSync(place), false, `終わったのに残っている: ${place}`);
    const left = join(s.paths.data, 'git-run');
    assert.deepEqual(existsSync(left) ? readdirSync(left) : [], [], '置き場所が残っている');
    // コマンドレベルの上書き（リポジトリの設定より優先）が、実際の実行に渡っている
    assert.match((await s.call('git config --get core.fsmonitor')).output.content, /^false$/mu);
  });
}

// 審査の指摘（深い審査）: git のフックを毎回空のフォルダへ向けていたので、「フックが動きうります」の確かめを許しても pre-commit や秘密のスキャナーが動かなかった。
// 確かめなしの git はこれまでどおりフックの置き場所が空。持ち主がそのコマンドの確かめを許したときだけ、持ち主のフックのまま動く
for (const shell of ['powershell', 'bash'] as const) {
  const available = shell === 'powershell' ? psAvailable : bashAvailable;
  test(`実機（${shell}）: フックのあるリポジトリの git commit は今回だけの確かめになり、許したときだけ pre-commit が動く。フックが拒めば commit も止まる`, { skip: (!available || !gitAvailable) && 'シェルか git が無い' }, async t => {
    const s = setup(t, shell);
    const root = s.paths.workspace;
    const fwd = (p: string): string => p.replaceAll('\\', '/');
    const repo = join(root, 'hk');
    mkdirSync(repo);
    const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.name', 'Taro');
    git('config', 'user.email', 'taro@example.com');
    const marker = join(root, 'hook-ran');
    const writeHook = (exitCode: number): void => writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho ran >> "${fwd(marker)}"\nexit ${exitCode}\n`, { mode: 0o755 });
    const ask = async (command: string, decision: 'once' | 'deny') => {
      const pending = s.call(command);
      for (let i = 0; i < 300 && !s.approvals.pending().length; i++) await new Promise(r => setTimeout(r, 10));
      const request = s.approvals.pending()[0];
      assert.ok(request, `${command}: 承認の依頼が来ていない（確かめなしで動いた）`);
      assert.equal(request.onceOnly, true);
      assert.match(request.reasons.join('\n'), /フックが動きうります/u);
      s.approvals.decide(request.id, decision);
      return pending;
    };
    // コマンドの中の git config で、その実行の git に渡った設定を見る
    const commit = 'cd hk; git config --get core.hooksPath; git commit --allow-empty -q -m x';
    const count = (): number => Number(git('rev-list', '--all', '--count').stdout.trim() || 0);

    writeHook(0);
    // 許さなければ、フックは動かない
    const denied = await ask(commit, 'deny');
    assert.equal(denied.output.isError, true);
    assert.equal(existsSync(marker), false, '拒否したのにフックが動いた');
    // 確かめなしで動く git は、フックの置き場所が空のフォルダ
    const free = await s.call('cd hk; git config --get core.hooksPath');
    assert.equal(free.decision, 'allow', free.output.content);
    assert.match(free.output.content, /git-run\S*hooks/u);
    // 許せば、持ち主のフックが動く（フックの置き場所の上書きは無い）
    const allowed = await ask(commit, 'once');
    assert.equal(allowed.output.isError, false, allowed.output.content);
    assert.doesNotMatch(allowed.output.content, /git-run/u, '許した実行に、フックの置き場所の上書きがある');
    assert.equal(existsSync(marker), true, '許したのにフックが動かない');
    assert.equal(count(), 1);
    // フックが拒めば、commit も止まる（秘密のスキャナーが効く）
    rmSync(marker);
    writeHook(1);
    const blocked = await ask(commit, 'once');
    assert.equal(blocked.output.isError, true);
    assert.equal(existsSync(marker), true);
    assert.equal(count(), 1, 'フックが拒んだのに commit できた');
  });
}

// 再審査の指摘: 許したあと、設定の core.hooksPath（.husky など、確かめなしで書けるファイル）のフックが、見せていないまま動いた。許したときに動くのは、そのリポジトリ自身の .git/hooks だけ。
// 設定が core.hooksPath を指すリポジトリでは、許しても動かない（札にそう書く）。同じコマンドの中で core.hooksPath を書き換えても、.husky のフックは動かない
for (const shell of ['powershell', 'bash'] as const) {
  const available = shell === 'powershell' ? psAvailable : bashAvailable;
  test(`実機（${shell}）: 許しても、設定の core.hooksPath のフックは動かない。同じコマンドで core.hooksPath を書き換えても、.husky のフックは動かず、.git/hooks のフックだけが動く`, { skip: (!available || !gitAvailable) && 'シェルか git が無い' }, async t => {
    const s = setup(t, shell);
    const root = s.paths.workspace;
    const fwd = (p: string): string => p.replaceAll('\\', '/');
    const repo = join(root, 'hk2');
    mkdirSync(repo);
    const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.name', 'Taro');
    git('config', 'user.email', 'taro@example.com');
    const marker = (name: string): string => join(root, `ran-${name}`);
    const script = (name: string): string => `#!/bin/sh\necho ran >> "${fwd(marker(name))}"\nexit 0\n`;
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), script('own'), { mode: 0o755 });
    mkdirSync(join(repo, '.husky'));
    writeFileSync(join(repo, '.husky', 'pre-commit'), script('husky'), { mode: 0o755 });
    const ask = async (command: string, reason: RegExp) => {
      const pending = s.call(command);
      for (let i = 0; i < 300 && !s.approvals.pending().length; i++) await new Promise(r => setTimeout(r, 10));
      const request = s.approvals.pending()[0];
      assert.ok(request, `${command}: 承認の依頼が来ていない（確かめなしで動いた）`);
      assert.equal(request.onceOnly, true);
      assert.match(request.reasons.join('\n'), reason);
      s.approvals.decide(request.id, 'once');
      return pending;
    };
    const count = (): number => Number(git('rev-list', '--all', '--count').stdout.trim() || 0);
    // 設定が .husky を指す: そのフックは、許しても動かない（空のフォルダへ向けたまま）。.git/hooks のフックも、設定に隠れているので動かない
    git('config', 'core.hooksPath', '.husky');
    const first = await ask('cd hk2; git commit --allow-empty -q -m x', /core\.hooksPath を設定していますが、そのフックは Clive の git では動きません/u);
    assert.equal(first.output.isError, false, first.output.content);
    assert.equal(existsSync(marker('husky')), false, '設定の core.hooksPath のフックが動いた');
    assert.equal(existsSync(marker('own')), false);
    assert.equal(count(), 1);
    // 設定は無い: 同じコマンドの中で .husky を指すように書き換えても、動くのは .git/hooks のフックだけ
    git('config', '--unset', 'core.hooksPath');
    const second = await ask('cd hk2; git config core.hooksPath .husky; git commit --allow-empty -q -m y', /フックが動きうります/u);
    assert.equal(second.output.isError, false, second.output.content);
    assert.equal(existsSync(marker('husky')), false, '同じコマンドで書き換えた core.hooksPath のフックが動いた');
    assert.equal(existsSync(marker('own')), true, '.git/hooks のフックが動かない');
    assert.equal(count(), 2);
  });
}

// 審査の指摘: 子の PATH の '.'・空・相対の項目は、本物のシェルでは cd のあとの場所を指す。許可の一覧は最初の場所で調べるので、cd で動いた先に置いた git を見逃した
for (const shell of ['powershell', 'bash'] as const) {
  const available = shell === 'powershell' ? psAvailable : bashAvailable;
  test(`実機（${shell}）: PATH に '.' があっても、cd で動いた先に置いた git は動かない`, { skip: !available && 'シェルが無い' }, async t => {
    const s = setup(t, shell);
    const root = s.paths.workspace;
    const marker = join(root, 'marker');
    const ps = shell === 'powershell';
    // cd で動いた先 sub に、名前が git の偽物を置く
    if (ps) writeFileSync(join(root, 'sub', 'git.cmd'), `@echo off\r\necho ran> "${marker}"\r\n`);
    else writeFileSync(join(root, 'sub', 'git'), `#!/bin/sh\necho ran > "${marker.replaceAll('\\', '/')}"\n`, { mode: 0o755 });
    const key = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
    const saved = process.env[key];
    const places = ['.', '', 'sub', join('..', 'x')];
    process.env[key] = `${places.join(delimiter)}${delimiter}${saved ?? ''}`;
    try {
      await s.call(ps ? 'cd sub; git --version' : 'cd sub && git --version');
    } finally {
      if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
    }
    assert.equal(existsSync(marker), false, 'PATH の . が cd の先を指して、置いた git が動いた');
  });
}

// 審査の指摘（深い審査）: objects・refs がファイルでも、Windows の git は git のフォルダとして認め、その設定の diff.external が許可された `git diff --no-index` で動く。
// 本物の git で、今回だけの確かめを断れば動かないこと、確かめを許しても safe.bareRepository=explicit でそのフォルダの設定は読まれないことを確かめる
for (const shell of ['powershell', 'bash'] as const) {
  const available = shell === 'powershell' ? psAvailable : bashAvailable;
  test(`実機（${shell}）: objects・refs がファイルの偽の git フォルダの diff.external は、今回だけの確かめになり、断れば動かない。許しても動かない`, { skip: (!available || !gitAvailable) && 'シェルか git が無い' }, async t => {
    const s = setup(t, shell);
    const root = s.paths.workspace;
    const fwd = (p: string): string => p.replaceAll('\\', '/');
    const marker = join(root, 'marker');
    const ext = join(root, 'ext.sh');
    writeFileSync(ext, `#!/bin/sh\necho ran > "${fwd(marker)}"\nexit 0\n`, { mode: 0o755 });
    const fake = join(root, 'fake');
    mkdirSync(fake);
    writeFileSync(join(fake, 'HEAD'), 'ref: refs/heads/main');
    writeFileSync(join(fake, 'objects'), '', { mode: 0o755 });
    writeFileSync(join(fake, 'refs'), '', { mode: 0o755 });
    writeFileSync(join(fake, 'config'), `[diff]\n\texternal = ${fwd(ext)}\n`);
    // 前提: 素の git は、このフォルダの設定の diff.external を動かす（Windows。Linux では実行権限のあるファイルで同じ）
    spawnSync('git', ['-C', fake, 'diff', '--no-index', '../a.txt', '../notes.md']);
    assert.equal(existsSync(marker), true, '前提: 本物の git は、偽の git フォルダの diff.external を動かす');
    rmSync(marker);
    const command = 'git -C fake diff --no-index ../a.txt ../notes.md';
    await expectAsk(s, command);
    assert.equal(existsSync(marker), false, '断ったのに、偽の git フォルダの設定のコードが動いた');
    // 確かめを許しても、safe.bareRepository=explicit（git 2.38 以上）で、そのフォルダを git のフォルダとして見つけない
    if (!gitVersionAtLeast(spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout, 2, 38)) return;
    const pending = s.call(command);
    for (let i = 0; i < 300 && !s.approvals.pending().length; i++) await new Promise(r => setTimeout(r, 10));
    const request = s.approvals.pending()[0];
    assert.ok(request, '承認の依頼が来ていない');
    s.approvals.decide(request.id, 'once');
    await pending;
    assert.equal(existsSync(marker), false, '許したあとも、偽の git フォルダの設定のコードが動いた');
  });
}

// 審査の指摘（深い審査）: 本物の PowerShell 5.1 は、引用符つきの -Path・位置のパスのワイルドカードも解決する。承認なしで人格・スキル・.git が書き換わり、秘密（.env）が読めた。
// 本物のシェルで、今回だけの確かめを断れば何も変わらないこと、秘密・config.json は止まり中身が出ないことを確かめる
test('実機（Windows PowerShell 5.1・制限モード）: 引用符つきのワイルドカードで、人格・スキル・.git は書けず、秘密・config.json・clive.db は読めない', { skip: !psAvailable && 'Windows の PowerShell が無い' }, async t => {
  const s = setup(t, 'powershell');
  const root = s.paths.workspace;
  mkdirSync(join(root, 'skills', 'a'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  const files: Array<[string, string]> = [['SOUL.md', 'persona'], ['USER.md', 'user'], ['.env', 'SECRET=1'], ['.git/description', 'desc'], ['skills/a/SKILL.md', 'skill'], [join('..', 'config.json'), '{"k":"CONFIGSECRET"}'], [join('..', 'clive.db'), 'DBSECRET']];
  for (const [f, text] of files) writeFileSync(join(root, f), text);
  const before = files.map(([f]) => readFileSync(join(root, f), 'utf8'));
  // 今回だけの確かめになる（断る）
  for (const command of [
    "Set-Content -Path 'SOUL.*' -Value pwned1", "Set-Content 'US?R.md' pwned2", "Set-Content -Path 'skill[s]/a/SKILL.md' -Value x", "Out-File -FilePath 'SOUL.m?' -InputObject pwned3",
    "Add-Content -Path '.gi[t]/description' -Value x -Force", "Set-Location 'skill[s]'; Set-Content a/SKILL.md x", "'x' > 'SOUL.*'", "Remove-Item 'SOUL.*'",
  ]) await expectAsk(s, command);
  // 止める
  for (const command of ["Get-Content '.en[v]'", "Get-Content '..\\config.jso[n]'", "Get-Content '..\\clive.d[b]'", "Select-String -Path '.en?' -Pattern S"]) {
    const outcome = await s.call(command);
    assert.equal(outcome.decision, 'deny', `${command}: ${outcome.output.content}`);
    assert.doesNotMatch(outcome.output.content, /SECRET=1|CONFIGSECRET|DBSECRET/u, `${command}: 秘密の中身が出た`);
  }
  assert.deepEqual(files.map(([f]) => readFileSync(join(root, f), 'utf8')), before, 'ファイルが変わった');
});

// 審査の指摘（深い審査）: `git push victim` の victim が remote の名前でなければ、git はそれをフォルダとして扱い、そのフォルダ（裏のリポジトリ）のフックを動かす。
// 本物の git で、今回だけの確かめを断れば動かないこと、設定にある remote の名前なら ふつうの確かめ（今回だけにはならない）であることを確かめる
for (const shell of ['powershell', 'bash'] as const) {
  const available = shell === 'powershell' ? psAvailable : bashAvailable;
  test(`実機（${shell}）: remote の名前でない push の宛先は、フックが動くので今回だけの確かめになり、断れば動かない。設定にある名前は今までどおり`, { skip: (!available || !gitAvailable) && 'シェルか git が無い' }, async t => {
    const s = setup(t, shell);
    const root = s.paths.workspace;
    const fwd = (p: string): string => p.replaceAll('\\', '/');
    const marker = join(root, 'marker');
    const victim = join(root, 'victim');
    const gr = join(root, 'gr');
    spawnSync('git', ['init', '-q', '--bare', victim]);
    mkdirSync(gr);
    spawnSync('git', ['init', '-q'], { cwd: gr });
    writeFileSync(join(gr, 'f.txt'), 'one\n');
    spawnSync('git', ['add', 'f.txt'], { cwd: gr });
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'one'], { cwd: gr });
    mkdirSync(join(victim, 'hooks'), { recursive: true });
    writeFileSync(join(victim, 'hooks', 'pre-receive'), `#!/bin/sh\necho ran > "${fwd(marker)}"\nexit 0\n`, { mode: 0o755 });
    // 前提: 素の git は、フォルダ名の宛先に push すると、そのフォルダのフックを動かす
    spawnSync('git', ['push', '-q', '../victim', 'HEAD:refs/heads/probe'], { cwd: gr });
    assert.equal(existsSync(marker), true, '前提: 本物の git は、宛先のフォルダのフックを動かす');
    rmSync(marker);
    spawnSync('git', ['remote', 'add', 'origin', 'https://example.invalid/r.git'], { cwd: gr });
    spawnSync('git', ['remote', 'add', 'up', fwd(victim)], { cwd: gr });
    const ps = shell === 'powershell';
    for (const command of ps ? ['cd gr; git push ../victim HEAD:refs/heads/x', 'cd gr; git push victim HEAD:refs/heads/x'] : ['cd gr && git push ../victim HEAD:refs/heads/x', 'cd gr && git push victim HEAD:refs/heads/x']) {
      await expectAsk(s, command);
      assert.equal(existsSync(marker), false, `${command}: 断ったのに、宛先のフォルダのフックが動いた`);
    }
    // 設定にある名前で、url がこの PC の外を指すものは、ふつうの確かめ（会話の許可で通る。今回だけにはならない）
    const pending = s.call(ps ? 'cd gr; git push origin HEAD:refs/heads/x' : 'cd gr && git push origin HEAD:refs/heads/x');
    for (let i = 0; i < 300 && !s.approvals.pending().length; i++) await new Promise(r => setTimeout(r, 10));
    const request = s.approvals.pending()[0];
    assert.ok(request, '承認の依頼が来ていない');
    assert.equal(request.onceOnly, false, '設定にある名前が今回だけの確かめになった');
    s.approvals.decide(request.id, 'deny');
    await pending;
    // 再審査の指摘: url が この PC のフォルダを指す remote への push は、そのフォルダのフックを動かす（フックの上書きは届かない）。ふつうの確かめでなく今回だけ
    const toUp = ps ? 'cd gr; git push up HEAD:refs/heads/x' : 'cd gr && git push up HEAD:refs/heads/x';
    await expectAsk(s, toUp);
    assert.equal(existsSync(marker), false, '断ったのに、url が指すフォルダのフックが動いた');
    // 裏のリポジトリ（名前が .git でない）のフックや設定への書き込みも、今回だけ
    const hookFile = join(victim, 'hooks', 'pre-receive');
    const before = readFileSync(hookFile, 'utf8');
    for (const command of ps ? ["Set-Content victim/hooks/pre-receive 'x'", "'x' > victim/hooks/pre-receive", "Copy-Item notes.md victim/hooks/pre-receive"] : ['echo x > victim/hooks/pre-receive', 'cp notes.md victim/hooks/pre-receive', 'tee victim/hooks/update < notes.md']) await expectAsk(s, command);
    assert.equal(readFileSync(hookFile, 'utf8'), before, '裏のリポジトリのフックが書き換わった');
    assert.equal(existsSync(join(victim, 'hooks', 'update')), false);
    // 許せば、フックは動く（許可が関所になっている）
    const pushing = s.call(toUp);
    for (let i = 0; i < 300 && !s.approvals.pending().length; i++) await new Promise(r => setTimeout(r, 10));
    const second = s.approvals.pending()[0];
    assert.ok(second, '承認の依頼が来ていない');
    assert.equal(second.onceOnly, true);
    assert.match(second.reasons.join('\n'), /この PC のフォルダ/u);
    s.approvals.decide(second.id, 'once');
    const pushed = await pushing;
    assert.equal(pushed.output.isError, false, pushed.output.content);
    assert.equal(existsSync(marker), true, '許したのに、フォルダのフックが動かない');
  });
}

// 9 回目の審査（高）: `cp -r secrets stuff; cat stuff/token.txt` は、素のシェルでは秘密のフォルダの中身を表示する。Clive のシェルでは、動かす前に止まり、コピー先もできず、中身も出ない
function seedSecretFolder(s: ReturnType<typeof setup>): void {
  for (const dir of ['secrets', 'proj', 'stuff', 'stuff2']) rmSync(s.files(dir), { recursive: true, force: true });
  mkdirSync(s.files('secrets'), { recursive: true });
  writeFileSync(s.files('secrets/token.txt'), 'TOKEN-9\n');
  mkdirSync(s.files('proj/secrets'), { recursive: true });
  writeFileSync(s.files('proj/secrets/token.txt'), 'TOKEN-9\n');
}
async function expectSecretFolderBlocked(s: ReturnType<typeof setup>, commands: readonly string[], raw: (command: string) => string): Promise<void> {
  for (const command of commands) {
    seedSecretFolder(s);
    assert.match(raw(command), /TOKEN-9/u, `前提: 素のシェルでは中身が出る: ${command}`);
    seedSecretFolder(s);
    const outcome = await s.call(command);
    assert.equal(outcome.decision, 'deny', `${command}: ${outcome.output.content}`);
    assert.doesNotMatch(outcome.output.content, /TOKEN-9/u, `${command}: 中身が出た`);
    for (const dir of ['stuff', 'stuff2']) assert.equal(existsSync(s.files(dir)), false, `${command}: ${dir} ができた`);
    assert.equal(readFileSync(s.files('secrets/token.txt'), 'utf8'), 'TOKEN-9\n', `${command}: 元のフォルダが動いた`);
  }
}
test('実機（bash）: cp -r・mv で秘密のフォルダを別の名前にして読む形は、動かす前に止まり、中身は出ない', { skip: !bashAvailable && 'bash が無い' }, async t => {
  const s = setup(t, 'bash');
  const bash = (command: string): string => spawnSync(bashPath!, ['--noprofile', '--norc', '-c', command], { cwd: s.paths.workspace, encoding: 'utf8' }).stdout;
  await expectSecretFolderBlocked(s, ['cp -r secrets stuff; cat stuff/token.txt', 'cp -r proj stuff; cat stuff/secrets/token.txt', 'mv secrets stuff2; cat stuff2/token.txt'], bash);
});

test('実機（Windows PowerShell 5.1・制限モード）: Copy-Item -Recurse・Move-Item で秘密のフォルダを別の名前にして読む形は、動かす前に止まり、中身は出ない', { skip: !psAvailable && 'Windows の PowerShell が無い' }, async t => {
  const s = setup(t, 'powershell');
  const raw = (command: string): string => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: s.paths.workspace, encoding: 'utf8' }).stdout;
  await expectSecretFolderBlocked(s, ['Copy-Item -Recurse secrets stuff; Get-Content stuff/token.txt', 'Copy-Item -Recurse proj stuff; Get-Content stuff/secrets/token.txt', 'Move-Item secrets stuff2; Get-Content stuff2/token.txt'], raw);
});
