import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { APP_ROOT, resolvePaths } from '../src/paths.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { fileEdit, fileWrite } from '../src/tools/builtin/files.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { checkShellCommand, type ShellGuardOptions } from '../src/tools/hooks/shell-guard.ts';
import { placePath, realish } from '../src/tools/hooks/scope.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { PS_WRITER_ALLOW, tempDir, testConfig } from './helpers.ts';

// 段 9f: .env は、API キーを画面から入れられるようになっても、モデルの道具（file_write・シェル）からは書けない。
// 画面だけの API（鍵を入れる）も、シェルからは「毎回の確かめ」を通らないと呼べない

function fixture(t: { after: (fn: () => void) => void }) {
  const paths = { ...resolvePaths(tempDir(t)), env: '' };
  paths.env = join(paths.data, 'app', '.env');
  mkdirSync(join(paths.data, 'app'), { recursive: true });
  mkdirSync(paths.workspace, { recursive: true });
  const config = parseConfig(testConfig());
  const policy = buildPolicy(config, paths);
  const ws = realish(defaultWorkspace(policy, paths));
  const opts = (extra: Partial<ShellGuardOptions> = {}): ShellGuardOptions => ({ policy, outsideRoots: 'ask', ...extra });
  const bash = (command: string, extra: Partial<ShellGuardOptions> = {}) => checkShellCommand(command, ws, opts({ shell: 'bash', windows: false, ...extra }));
  const ps = (command: string, extra: Partial<ShellGuardOptions> = {}) => checkShellCommand(command, ws, opts({ shell: 'powershell', windows: true, allow: PS_WRITER_ALLOW, ...extra }));
  return { paths, config, policy, ws, bash, ps };
}

test('書き込みの場所: .env とその控え・一時ファイルは禁止の場所。製品のフォルダの本物の .env も同じ', t => {
  const f = fixture(t);
  for (const name of ['.env', '.env.bak', '.env.1234.1700000000000.tmp']) {
    const placed = placePath(join(f.paths.data, 'app', name), f.policy);
    assert.equal(placed.kind, 'deny', name);
  }
  assert.equal(placePath(join(APP_ROOT, '.env'), buildPolicy(f.config, resolvePaths(f.paths.data))).kind, 'deny', '本物の置き場所（製品のフォルダ）');
  assert.equal(placePath(f.paths.env, f.policy).kind, 'deny', 'App が書く .env（paths.env）');
});

test('App が書く鍵のファイル（paths.env）は、名前が .env でなくても禁止の場所（名前の決まりだけに頼らない）', t => {
  const f = fixture(t);
  const odd = { ...f.paths, env: join(f.paths.data, 'app', 'keys-file') };
  assert.equal(placePath(odd.env, buildPolicy(f.config, odd)).kind, 'deny');
  assert.equal(placePath(odd.env, f.policy).kind, 'outside', '前提: 別の名前は、ほかの決まりには当たらない');
});

test('file_write・file_edit: .env（App が書くもの）への書き込みは拒否。中身は変わらない', async t => {
  const f = fixture(t);
  writeFileSync(f.paths.env, 'FAKE_KEY=original\n');
  const db = openDatabase(':memory:', MIGRATIONS);
  const registry = new ToolRegistry().register(fileWrite).register(fileEdit).register(shellRun);
  const approvals = new ApprovalBroker(db, () => undefined);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: f.config, paths: f.paths, policy: f.policy,
    workspace: defaultWorkspace(f.policy, f.paths), taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  const call = (name: string, args: unknown) => runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, ctx, { registry, approvals, db, emit: () => undefined });
  for (const path of [f.paths.env, `${f.paths.env}.bak`, join(f.paths.data, 'app', '.env.9.9.tmp')]) {
    const result = await call('file_write', { path, content: 'FAKE_KEY=stolen\n' });
    assert.match(result.output.content, /拒否/u, path);
    const edit = await call('file_edit', { path, old_string: 'original', new_string: 'stolen' });
    assert.match(edit.output.content, /拒否|見つかりません|ありません/u, path);
  }
  assert.equal(readFileSync(f.paths.env, 'utf8'), 'FAKE_KEY=original\n');
  assert.equal(existsSync(`${f.paths.env}.bak`), false);
});

test('シェルからの書き込み・読み出し: .env（とその控え・一時ファイル）は止める（bash も PowerShell も）', t => {
  const f = fixture(t);
  const env = f.paths.env.replaceAll('\\', '/');
  const targets = [env, `${env}.bak`, `${join(f.paths.data, 'app', '.env.9.9.tmp').replaceAll('\\', '/')}`];
  for (const target of targets) {
    for (const command of [`echo K=1 >> "${target}"`, `echo K=1 > ${target}`, `cp notes.txt "${target}"`, `mv notes.txt "${target}"`, `printf x | tee "${target}"`, `cat "${target}"`, `rm "${target}"`, `sed -i s/a/b/ "${target}"`]) {
      assert.equal(f.bash(command).decision, 'deny', `bash: ${command}`);
    }
    for (const command of [`Set-Content -Path "${target}" -Value x`, `Add-Content "${target}" x`, `"x" | Out-File "${target}"`, `Get-Content "${target}"`, `Copy-Item notes.txt "${target}"`, `Remove-Item "${target}"`, `echo x > "${target}"`]) {
      assert.equal(f.ps(command).decision, 'deny', `powershell: ${command}`);
    }
  }
});

test('鍵を入れる API をシェルから呼ぶ形は、毎回の確かめ（今回だけ）か止める: curl・Invoke-RestMethod・node -e・/dev/tcp', t => {
  const f = fixture(t);
  const url = 'http://127.0.0.1:4777/api/providers/my-llm/key';
  const sure = (v: { decision: string; onceOnly: boolean }) => v.decision === 'deny' || (v.decision === 'ask' && v.onceOnly);
  for (const command of [
    `curl -X PUT -H "Content-Type: application/json" -d '{"key":"abc"}' ${url}`, `curl --request=PUT -d@body.json ${url}`, `curl -XDELETE ${url}`, `curl ${url}`,
    `node -e "fetch('${url}',{method:'PUT',body:'{}'})"`, 'exec 3<>/dev/tcp/127.0.0.1/4777; printf "PUT /api/providers/my-llm/key HTTP/1.1" >&3',
  ]) assert.equal(sure(f.bash(command)), true, `bash: ${command}`);
  for (const command of [`Invoke-RestMethod -Method Put -Uri ${url} -Body '{}'`, `irm ${url} -Method Delete`, `Invoke-WebRequest ${url}`, `curl.exe -X PUT ${url}`]) {
    assert.equal(sure(f.ps(command)), true, `powershell: ${command}`);
  }
  assert.equal(sure(f.bash('curl http://localhost:4777/api/providers/x/key')), true, 'localhost');
  assert.equal(sure(f.bash('curl http://[::1]:4777/api/providers/x/key')), true, '::1');
  assert.equal(sure(f.bash(`curl ${url}`, { selfHosts: ['box.tail1234.ts.net'] })), true);
  assert.equal(sure(f.bash('curl https://box.tail1234.ts.net/api/providers/x/key', { selfHosts: ['box.tail1234.ts.net'] })), true, 'Tailscale 側の自分の宛先');
});
