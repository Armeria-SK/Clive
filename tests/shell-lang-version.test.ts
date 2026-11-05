import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand, type ShellVerdict } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

// 9 回目の審査（中）: 言語の道具の「バージョンを見るだけ」の形は、その道具が起動のときに作業フォルダの設定を読むなら、設定で別のコードを動かせる。
//   ・yarn: .yarnrc の yarn-path（Berry は .yarnrc.yml の yarnPath）が指す JS を動かす。corepack の shim は package.json の packageManager で別の版を取ってきて動かす
//   ・pnpm: packageManager の版へ切り替える（corepack の shim も同じ）
//   ・cargo・rustc: rustup の shim が rust-toolchain(.toml) を読み、toolchain の path に書かれた場所の cargo・rustc を動かす（無ければ取ってくる）
//   ・go: go.mod・go.work の toolchain 行で、GOTOOLCHAIN=auto（既定）のとき、別の Go を取ってきて動かす。go version も go env もそうなる（下の実機の試験）
// 決め: この 4 つ（go は version と env の 2 つの形）を一覧から外し、今回だけにする。持ち主が tools.shell.allow に書けば外せる（持ち主の選び）
// 同じ観点で調べて、一覧に残したもの（実機で確かめたもの: node・python・py・npm・pip。道具が無くて確かめていないもの: deno・bun・tsc は、--version を設定より先に処理する作りとして残した）:
//   ・node --version: 作業フォルダの node.config.json を読まない（--experimental-default-config-file を付けても動かない。Node 24.16 で確かめた）
//   ・python --version / -V と py -V: site を読み込む前に終わるので、user-site の .pth・sitecustomize.py・usercustomize.py は動かない（Python 3.14 で確かめた）。
//     ただし pip --version と pip list・freeze・show は python を起こして site を読み込むので、それらは動く → user-site の置き場所への書き込みを今回だけにした（別のコミット）
//   ・npm --version / -v: 作業フォルダの .npmrc の registry に要求を出さない（update-notifier が動かない。npm 11.13 で確かめた）

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  mkdirSync(ws, { recursive: true });
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [join(ws, 'SOUL.md'), join(ws, 'USER.md')], skillsDir: join(ws, 'skills') };
  const run = (shell: 'bash' | 'powershell') => (command: string, allow?: string[]): ShellVerdict =>
    checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell', ...(allow ? { allow } : {}) });
  return { ws, bash: run('bash'), ps: run('powershell') };
}
const show = (v: ShellVerdict): string => `${v.decision}${v.onceOnly ? '/once' : ''} ${v.reasons.join(' / ').slice(0, 100)}`;
const once = (v: ShellVerdict): boolean => v.decision === 'ask' && v.onceOnly;

const DROPPED = ['yarn --version', 'yarn -v', 'pnpm --version', 'pnpm -v', 'cargo --version', 'rustc --version', 'go version', 'go env', 'go env GOPATH'];
const KEPT = ['node --version', 'node -v', 'python --version', 'python -V', 'python3 --version', 'py -V', 'npm --version', 'npm -v', 'pip --version', 'pip list', 'pip freeze', 'deno --version', 'bun --version', 'tsc --version'];

test('yarn・pnpm・cargo・rustc の --version と、go の version・env は、作業フォルダの設定でコードが動くので今回だけ。node・python・py・npm・pip・deno・bun・tsc は、これまでどおり', t => {
  const f = fixture(t);
  const wrong: string[] = [];
  for (const shell of ['bash', 'ps'] as const) {
    for (const c of DROPPED) if (!once(f[shell](c))) wrong.push(`${shell} ${c} → ${show(f[shell](c))}`);
    for (const c of KEPT) if (f[shell](c).decision !== 'allow') wrong.push(`${shell} ${c} → ${show(f[shell](c))}`);
  }
  if (f.bash('python3.11 -V').decision !== 'allow') wrong.push('bash python3.11 -V');
  assert.deepEqual(wrong, []);
});

test('一覧から外したバージョンの形は、持ち主が tools.shell.allow に書けば確かめなしになる（持ち主の選び）。ほかの形は変わらない', t => {
  const f = fixture(t);
  assert.equal(f.bash('go version', ['go version']).decision, 'allow');
  assert.equal(f.bash('yarn --version', ['yarn --version']).decision, 'allow');
  assert.equal(once(f.bash('go version', ['go env'])), true, '別の形の項目は当たらない');
  assert.equal(once(f.bash('yarn add x', ['yarn --version'])), true);
});

// 実機の Go（1.21 以上）: go.mod の toolchain 行が、go version も go env も、別の Go への切り替え（取ってくる）に向かわせる。GOPROXY=off で、外には出ない
const goVersion = ((): number | undefined => {
  const r = spawnSync('go', ['version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const m = /go1\.(\d+)/u.exec(r.stdout ?? '');
  return m ? Number(m[1]) : undefined;
})();
test('実機の Go: go.mod の toolchain 行があると、go version も go env も別の Go へ切り替えようとする（GOPROXY=off なので外には出ない）', { skip: (goVersion === undefined || goVersion < 21) && 'Go 1.21 以上が無い' }, t => {
  const dir = join(tempDir(t), 'gomod');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'go.mod'), 'module probe\n\ngo 1.99.0\n\ntoolchain go1.99.9\n');
  const env = { ...process.env, GOPROXY: 'off', GOTOOLCHAIN: 'auto', GOFLAGS: '' };
  for (const args of [['version'], ['env'], ['env', 'GOVERSION']]) {
    const r = spawnSync('go', args, { cwd: dir, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.match(`${r.stdout}${r.stderr}`, /go1\.99\.9/u, `go ${args.join(' ')}: ${r.stdout}${r.stderr}`);
  }
  // 設定の無いフォルダでは、そのまま版を答える
  const plain = join(tempDir(t), 'plain');
  mkdirSync(plain, { recursive: true });
  assert.match(spawnSync('go', ['version'], { cwd: plain, env, encoding: 'utf8', timeout: 60000, windowsHide: true }).stdout, /^go version go1\./u);
});
