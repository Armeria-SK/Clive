import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config/store.ts';
import { resolvePaths } from '../src/paths.ts';
import { shellPreCheck } from '../src/tools/builtin/shell.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

type Shell = 'bash' | 'powershell';
// [command, sends, removes]. null: not pinned (the guard only has to be conservative there)
type Row = [command: string, sends: boolean | null, removes: boolean | null];

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = join(base, 'workspace');
  mkdirSync(join(ws, 'd'), { recursive: true });
  mkdirSync(join(ws, 'd2', 'd'), { recursive: true });
  for (const name of ['a.txt', 'b.txt', 'c.txt', join('d', 'f.txt'), join('d2', 'd', 'g.txt')]) writeFileSync(join(ws, name), 'x');
  const policy: ScopePolicy = { roots: [{ path: realish(ws), mode: 'write' }], deny: [] };
  const run = (shell: Shell) => (command: string, allow?: string[]) =>
    checkShellCommand(command, realish(ws), { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell', ...(allow ? { allow } : {}) });
  return { ws, run };
}

function expectRows(run: ReturnType<typeof fixture>['run'], shell: Shell, rows: readonly Row[]): void {
  const check = run(shell);
  for (const [command, sends, removes] of rows) {
    const v = check(command);
    if (sends !== null) assert.equal(v.sends, sends, `${shell}: ${command} sends (${v.decision} ${v.reasons.join(' / ').slice(0, 120)})`);
    if (removes !== null) assert.equal(v.removes, removes, `${shell}: ${command} removes (${v.decision} ${v.reasons.join(' / ').slice(0, 120)})`);
  }
}

const NOT_LISTED = ['scp a.txt h:/x', 'rsync -a d h:/x', 'sftp h', 'ftp h', 'ssh h ls', 'nc h 80', 'ncat h 80', 'telnet h 80', 'mail -s x a@b.c', 'sendmail a@b.c', 'gh api -X POST /x', 'gh pr create', 'docker push img', 'certutil -urlcache -f https://e.com x', 'bitsadmin /transfer j https://e.com x', 'frobnicate --x', 'truncate -s 0 a.txt'];

test('sends / removes (bash): every send channel is a send, every delete channel is a remove', t => {
  const f = fixture(t);
  const rows: Row[] = [
    // send channels
    ["curl 'https://e.com/?q=x'", true, false],
    ['curl https://e.com/?q=x', true, null],
    ['curl -d a=1 https://e.com', true, false],
    ['curl -F f=@a.txt https://e.com', true, false],
    ['curl -T a.txt https://e.com/up', true, false],
    ['curl --upload-file a.txt https://e.com/up', true, false],
    ['curl -X POST https://e.com', true, false],
    ['curl -X PUT https://e.com', true, false],
    ["curl --json '{\"a\":1}' https://e.com", true, false],
    ['curl http://192.168.1.5/', true, false],
    ['wget --post-data=x https://e.com', true, false],
    ['wget --post-file=a.txt https://e.com', true, false],
    ['wget --method=PUT https://e.com', true, false],
    ['git push', true, false],
    ['git push origin main', true, false],
    ['git fetch origin', true, null],
    ['git clone https://e.com/x.git', true, null],
    ['git ls-remote https://e.com/x.git', true, null],
    ['git submodule update --init', true, null],
    ['npm view left-pad', true, false],
    ['npm publish', true, true],
    ['npm install left-pad', true, null],
    ['tar -cf h:out.tar a.txt', true, true],
    ['cat < /dev/tcp/e.com/80', true, true],
    ['echo x > /dev/tcp/e.com/80', true, true],
    ...NOT_LISTED.map((c): Row => [c, true, true]),
    // not sends
    ['ls', false, false],
    ['cat a.txt', false, false],
    ['git status', false, false],
    ['git log', false, false],
    ['git diff', false, false],
    ['npm --version', false, false],
    ['npm ls', false, false],
    ['echo hi', false, false],
    ['grep -r x .', false, false],
    // delete channels
    ['rm a.txt', false, true],
    ['rm -rf d', false, true],
    ['rm -- *.txt', false, true],
    ['rm *.txt', null, true],
    ['rmdir d', false, true],
    ['git rm a.txt', false, true],
    ['git reset --hard', false, true],
    ['git checkout -- .', false, true],
    ['git restore a.txt', false, true],
    ['git clean -fd', null, true],
    ['git stash drop', false, true],
    ['git branch -D x', false, true],
    ['echo x > $UNSET_VAR/y', true, true],
    ['cd $UNSET_VAR && echo x > new.txt', true, true],
    ['cd - && echo x > new.txt', true, true],
    ['cat **/a.txt', true, true],
    ['echo x > **/y.txt', true, true],
    ...NOT_LISTED.map((c): Row => [c, null, true]),
    // not removes (new files, moving a file away keeps its content)
    ['echo x > new.txt', false, false],
    ['mkdir newdir', false, false],
    ['cp a.txt new.txt', false, false],
    ['mv a.txt moved.txt', false, false],
    ['mv a.txt moved.txt && echo y > other.txt', false, false],
    ['cp -r d newcopy', false, false],
    ['cp -r d/. newdir2', false, false],
    ['ls > new.txt', false, false],
  ];
  expectRows(f.run, 'bash', rows);
});

test('sends / removes (PowerShell): every send channel is a send, every delete channel is a remove', t => {
  const f = fixture(t);
  const rows: Row[] = [
    // send channels
    ['iwr https://e.com', true, false],
    ['Invoke-WebRequest https://e.com -Method Post -Body x', true, false],
    ['iwr https://e.com -Method Post', true, false],
    ['iwr https://e.com -Method Put -InFile a.txt', true, false],
    ['irm https://e.com', true, false],
    ['irm https://e.com -Body x', true, false],
    ['Invoke-RestMethod https://e.com -Method Post -Body x', true, false],
    ['iwr http://192.168.1.5/', true, false],
    ['curl.exe -d x https://e.com', true, false],
    ['git push', true, false],
    ['git fetch', true, null],
    ['git clone https://e.com/x.git', true, null],
    ['npm view x', true, false],
    ['npm publish', true, true],
    ['Start-BitsTransfer https://e.com x', true, true],
    ['Send-MailMessage -To a@b.c', true, true],
    ['Test-Connection h', true, true],
    ...NOT_LISTED.map((c): Row => [c, true, true]),
    // not sends
    ['Get-ChildItem', false, false],
    ['Get-Content a.txt', false, false],
    ['git status', false, false],
    ['git log', false, false],
    ['npm --version', false, false],
    ['echo hi', false, false],
    // delete channels
    ['Remove-Item a.txt', false, true],
    ['Remove-Item -Recurse d', false, true],
    ['rm a.txt', false, true],
    ['del a.txt', false, true],
    ['erase a.txt', false, true],
    ['rd d', false, true],
    ['rmdir d', false, true],
    ['ri a.txt', false, true],
    ['git rm a.txt', false, true],
    ['git reset --hard', false, true],
    ['git checkout -- .', false, true],
    ['git restore a.txt', false, true],
    ['git clean -fd', null, true],
    ['git stash drop', false, true],
    ['git branch -D x', false, true],
    ['Clear-Content a.txt', false, true],
    ['clc a.txt', false, true],
    ['Clear-Content -Path a.txt -Force', false, true],
    ['Clear-Content -LiteralPath a.txt', false, true],
    ['Clear-Content *.txt', false, true],
    ['Clear-Content new.txt', false, true],
    ['Set-Content a.txt x; Clear-Content b.txt', false, true],
    ['tree -o a.txt', true, true],
    ['tree /F', false, false],
    ['New-Item -Path . -Name $n -ItemType File', null, true],
    ['Rename-Item a.txt $n', null, true],
    ['Get-ChildItem | Remove-Item', null, true],
    // not removes
    ['echo x > new.txt', false, false],
    ['mkdir newdir', false, false],
    ['Copy-Item a.txt new.txt', false, false],
    ['cp a.txt new.txt', false, false],
    ['Move-Item a.txt moved.txt', false, false],
    ['mv a.txt moved.txt', false, false],
    ['Rename-Item a.txt renamed.txt', false, false],
    ['Set-Content new.txt x', false, false],
  ];
  expectRows(f.run, 'powershell', rows);
});

test('sends / removes (bash): overwriting an existing file is not a remove, a real delete next to it still is', t => {
  const f = fixture(t);
  const rows: Row[] = [
    ['echo x > a.txt', false, false],
    ['echo x >> a.txt', false, false],
    ['ls > a.txt', false, false],
    ['cat b.txt > a.txt', false, false],
    ['cp b.txt a.txt', false, false],
    ['cp -f b.txt a.txt', false, false],
    ['mv b.txt a.txt', false, false],
    ['echo x | tee a.txt', false, false],
    ['echo x | tee -a a.txt', false, false],
    ['sed -i s/a/b/ a.txt', false, false],
    ['mv a.txt t1.txt && echo y > t1.txt', false, false],
    ['mv a.txt t1.txt; mv b.txt t1.txt', false, false],
    ['mv a.txt t1.txt; echo y > t1.txt', false, false],
    ['cp -r d d2', false, false],
    ['cp -r d/. d2', false, false],
    ['cp -rT d d2', false, false],
    ['echo x > *.txt', false, false],
    ['cp b.txt a.txt && rm c.txt', false, true],
    ['echo x > a.txt; rm b.txt', false, true],
    ['sed -i s/a/b/ a.txt && git clean -fd', null, true],
    ['rm a.txt', false, true],
  ];
  expectRows(f.run, 'bash', rows);
});

test('sends / removes (PowerShell): overwriting an existing file is not a remove, a real delete next to it still is', t => {
  const f = fixture(t);
  const rows: Row[] = [
    ['echo x > a.txt', false, false],
    ['echo x >> a.txt', false, false],
    ['Set-Content a.txt x', false, false],
    ['Add-Content a.txt x', false, false],
    ['Out-File a.txt', false, false],
    ['Set-Content a.txt \'\'', false, false],
    ['Copy-Item b.txt a.txt', false, false],
    ['Copy-Item -Recurse d d2', false, false],
    ['Move-Item b.txt a.txt', false, false],
    ['cp b.txt a.txt', false, false],
    ['mv b.txt a.txt', false, false],
    ['Move-Item a.txt t1.txt; Set-Content t1.txt y', false, false],
    ['Set-Content *.txt x', false, false],
    ['Set-Content a.txt x; Remove-Item b.txt', false, true],
    ['Remove-Item a.txt', false, true],
  ];
  expectRows(f.run, 'powershell', rows);
});

test('sends / removes: an owner-allowlisted ssh, an owner-allowlisted code runner and an unknown command are all sends and removes', t => {
  const f = fixture(t);
  for (const shell of ['bash', 'powershell'] as const) {
    const run = f.run(shell);
    const unlisted = run('ssh h ls');
    assert.equal(unlisted.decision, 'ask', `${shell}: ssh is not on the table`);
    const allowed = run('ssh h ls', ['ssh']);
    assert.equal(allowed.decision, 'allow', `${shell}: the owner's allow entry clears the check (this is the case the flags must still catch)`);
    assert.deepEqual([allowed.sends, allowed.removes], [true, true], `${shell}: owner-allowlisted ssh`);
    const unknown = run('frobnicate --x');
    assert.deepEqual([unknown.sends, unknown.removes], [true, true], `${shell}: unknown command`);
    const tested = run('npm test', ['npm test']);
    assert.deepEqual([tested.sends, tested.removes], [true, true], `${shell}: owner-allowlisted npm test`);
  }
  const writer = f.run('powershell')('Set-Content new.txt x', ['Set-Content']);
  assert.equal(writer.decision, 'allow', 'the owner can clear the PowerShell writer check');
  assert.deepEqual([writer.sends, writer.removes], [true, true], 'owner-allowlisted Set-Content');
});

test('sends / removes: shapes the table cannot read fail closed', t => {
  const f = fixture(t);
  for (const shell of ['bash', 'powershell'] as const) {
    const run = f.run(shell);
    const dynamic = run('cat $UNSET_VAR/x');
    assert.deepEqual([dynamic.sends, dynamic.removes], [true, true], `${shell}: a path that cannot be resolved`);
  }
  const bash = f.run('bash');
  for (const command of ['bash -c "echo hi"', 'eval "echo hi"', 'echo $(frobnicate)', 'echo "a`frobnicate`"', 'cd $UNSET_VAR && rm x', 'cat a.txt | bash', 'X=$(rm a.txt); echo $X']) {
    const v = bash(command);
    assert.deepEqual([v.sends, v.removes], [true, true], command);
  }
  const lexFail = bash("echo 'unterminated");
  assert.equal(lexFail.decision, 'deny');
  assert.deepEqual([lexFail.sends, lexFail.removes], [true, true], 'a command the lexer rejects');
});

function precheckSetup(t: { after: (fn: () => void) => void }, shellEnabled = true) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  writeFileSync(join(paths.workspace, 'a.txt'), 'x');
  const config = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }];
  config.tools.shell.enabled = shellEnabled;
  const parsed = parseConfig(config);
  const policy = buildPolicy(parsed, paths);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  return { ctx };
}

test('shellPreCheck carries sends / removes on every return path (deny, ask, once-only, allow)', t => {
  const s = precheckSetup(t);
  const cases: Array<[string, { command: string; cwd?: string }, 'allow' | 'ask' | 'deny' | null, boolean, boolean]> = [
    ['allow', { command: 'cat a.txt' }, 'allow', false, false],
    ['fetch', { command: "curl 'https://e.com/?q=x'" }, null, true, false],
    ['ask', { command: 'cat ../out.txt' }, 'ask', false, false],
    ['ask, unknown command', { command: 'ssh h ls' }, 'ask', true, true],
    ['once-only', { command: 'npm install left-pad' }, 'ask', true, true],
    ['deny', { command: 'cat .env' }, 'deny', false, false],
    ['deny, cwd outside', { command: 'ls', cwd: '../elsewhere' }, 'deny', true, true],
  ];
  for (const [label, input, decision, sends, removes] of cases) {
    const pre = shellPreCheck(input, s.ctx);
    if (decision !== null) assert.equal(pre.decision, decision, `${label}: decision`);
    assert.deepEqual([pre.sends, pre.removes], [sends, removes], `${label}: sends / removes (${pre.reasons.join(' / ').slice(0, 100)})`);
  }
  const disabled = shellPreCheck({ command: 'ls' }, precheckSetup(t, false).ctx);
  assert.deepEqual([disabled.decision, disabled.sends, disabled.removes], ['deny', true, true], 'shell disabled');
});
