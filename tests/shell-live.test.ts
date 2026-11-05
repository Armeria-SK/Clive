import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { resolvePaths, type AppPaths } from '../src/paths.ts';
import { ApprovalBroker, approvalPublic } from '../src/tools/approvals.ts';
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
  const call = (command: string) => runToolCall({ id: `call-${Math.random()}`, name: 'shell_run', arguments: { command } }, ctx, { registry, approvals, db, emit: e => events.push(e) });
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
    ['Set-Content -Path out.txt -Value "hello"; Get-Content out.txt', /hello/u],
    ['New-Item -ItemType Directory -Path made | Out-Null; Test-Path made', /True/u],
    ['mkdir madeby | Out-Null; Test-Path madeby', /True/u],
    ['Copy-Item a.txt c.txt; (Get-Content c.txt).Count', /\b3\b/u],
    ['Select-String -Path *.txt -Pattern line2', /line2/u],
    ['Get-Date -Format yyyy', /20[0-9]{2}/u],
    ['Remove-Item c.txt; Test-Path c.txt', /False/u],
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
  assert.equal(readFileSync(s.files('out.txt'), 'utf8').trim(), 'hello');
  assert.equal(existsSync(s.files('c.txt')), false);
  if (which('rg')) assert.match((await s.call('rg --version')).output.content, /ripgrep/u);
});

test('実機（Windows PowerShell 5.1・制限モード）: 組み立てた書き込み先・一覧に無いコード・入れるものは、確かめになり、拒否すれば動かない', { skip: !psAvailable && 'Windows の PowerShell が無い' }, async t => {
  const s = setup(t, 'powershell');
  for (const command of [
    "Set-Content ('SOUL'+'.md') pwned", 'Copy-Item tmp/SOUL.md .', 'Move-Item tmp/SOUL.md .', 'Get-ChildItem *.md | Remove-Item', "Rename-Item notes.md -NewName SOUL.md", "New-Item -Path . -Name SOUL.md -Force",
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
