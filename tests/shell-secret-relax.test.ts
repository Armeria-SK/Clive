import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { listTree } from '../src/tools/hooks/path-expand.ts';
import { isSecretPath, realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand, type ShellVerdict } from '../src/tools/hooks/shell-guard.ts';
import { guardText } from '../src/shared/messages/guard.ts';
import { tempDir } from './helpers.ts';

// 持ち主の判断（secret-path の摩擦をゆるめる）:
//  (a) フォルダを再帰して読む・まとめる・写す歩き（grep -r・rg・findstr /s・tar -c・cp -r ほか）が、node_modules の中の秘密らしいパスに当たったら、止めずに「今回だけ」の確かめにする（当たったパスを札に出す）。node_modules の外は今までどおり止める
//  (b) 名前だけを出すコマンド（ls・tree・find・dir / Get-ChildItem のパイプで読む次のコマンドが無いもの）は、パスが秘密のフォルダ（secrets・secret）だというだけでは止めない。中身を読むものは今までどおり止める

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  const put = (rel: string, body = 'x') => { mkdirSync(join(ws, rel, '..'), { recursive: true }); writeFileSync(join(ws, rel), body); };
  for (const f of ['a.txt', 'src/app.js', 'proj/src/a.js', 'proj/node_modules/pkg/index.js', 'deps/node_modules/pkg/index.js']) put(f);
  // 依存パッケージの中だけにある秘密らしい名前
  put('proj/node_modules/pkg/.env', 'DEP=1'); put('proj/node_modules/pkg/server.pem', 'PEM'); put('proj/node_modules/other/id_rsa', 'KEY');
  put('onlydep/node_modules/dep/test/secrets/fixture.txt', 'S');
  // node_modules の外にも秘密がある（依存の秘密と一緒でも止める）
  put('mixed/node_modules/dep/.env', 'DEP=1'); put('mixed/.env', 'REAL=1');
  put('mixed2/node_modules/dep/server.pem', 'PEM'); put('mixed2/secrets/token.txt', 'T');
  // 秘密のフォルダ
  put('secrets/token.txt', 'TOKEN'); put('secrets/notes.md', 'N'); put('secret/key.txt', 'K'); put('vault/secrets/deep.txt', 'D'); put('withenv/secrets/.env', 'E');
  put('.env', 'REAL=2');
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [join(ws, 'SOUL.md'), join(ws, 'USER.md')], skillsDir: join(ws, 'skills') };
  const run = (shell: 'bash' | 'powershell') => (command: string, cwd = '.'): ShellVerdict =>
    checkShellCommand(command, join(ws, cwd), { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell' });
  return { ws, bash: run('bash'), ps: run('powershell') };
}

const show = (v: ShellVerdict): string => `${v.decision}${v.onceOnly ? '/once' : ''} ${v.reasons.join(' / ').slice(0, 160)}`;
type Row = readonly [command: string, cwd?: string];
function expectAll(run: (c: string, cwd?: string) => ShellVerdict, rows: readonly Row[], want: (v: ShellVerdict) => boolean, label: string): void {
  const wrong = rows.filter(([c, cwd]) => !want(run(c, cwd))).map(([c, cwd]) => `${cwd ? `[${cwd}] ` : ''}${c} → ${show(run(c, cwd))}`);
  assert.deepEqual(wrong, [], label);
}
const denied = (v: ShellVerdict): boolean => v.decision === 'deny';
const allowed = (v: ShellVerdict): boolean => v.decision === 'allow';
const askedOnce = (v: ShellVerdict): boolean => v.decision === 'ask' && v.onceOnly;
// 依存パッケージの秘密らしいパスが理由に出ている（札に当たったパスが見える）
const listsDependencyPath = (v: ShellVerdict): boolean => v.reasons.some(r => r.includes('node_modules') && /\.env|server\.pem|id_rsa|secrets/u.test(r));

// ── (a) node_modules の中の秘密 ──

test('(a) 再帰して読む・まとめる・写す歩きが node_modules の中の秘密らしいパスに当たったら、止めずに今回だけの確かめ。当たったパスが理由に出る', t => {
  const f = fixture(t);
  expectAll(f.bash, [
    ['grep -r x proj'], ['grep -rn x proj/node_modules'], ['grep -R x proj/node_modules/pkg'], ['rg x proj'], ['rg --hidden x proj'], ['rg -uu x proj/node_modules/pkg'],
    ['tar -cf out.tar proj'], ['cp -r proj copy1'], ['cp -a proj copy2'], ['grep -r x onlydep'], ['grep -r x .', 'proj'], ['rg x', 'proj'],
  ], askedOnce, 'bash: 今回だけの確かめ');
  expectAll(f.bash, [['grep -r x proj'], ['rg x proj'], ['tar -cf out.tar proj'], ['cp -r proj copy1'], ['grep -r x onlydep']], listsDependencyPath, 'bash: 当たったパスが理由に出る');
  expectAll(f.ps, [
    ['Get-ChildItem -Recurse proj | Select-String x'], ['Get-ChildItem -Recurse -Force proj | Get-Content'], ['Compress-Archive -Path proj -DestinationPath out.zip'], ['rg x proj'], ['Copy-Item -Recurse proj copy3'],
  ], askedOnce, 'PowerShell: 今回だけの確かめ');
  assert.ok(askedOnce(f.ps('findstr /s x *', 'proj')), show(f.ps('findstr /s x *', 'proj')));
  assert.ok(denied(f.ps('findstr /s x *', 'mixed')), show(f.ps('findstr /s x *', 'mixed')));
  expectAll(f.ps, [['Get-ChildItem -Recurse proj | Select-String x'], ['Compress-Archive -Path proj -DestinationPath out.zip']], listsDependencyPath, 'PowerShell: 当たったパスが理由に出る');
  // 秘密らしいパスが無い依存だけなら、今までどおり確かめなし
  expectAll(f.bash, [['grep -r x deps'], ['rg x deps'], ['grep -r x proj/src'], ['cp -r deps copy4']], allowed, '秘密が無ければ変わらない');
});

test('(a) node_modules の外にも秘密があれば、依存の秘密と一緒でも止める。作業フォルダの .env は止める。歩きでなく、秘密のパスを直接指す形も止める', t => {
  const f = fixture(t);
  expectAll(f.bash, [
    ['grep -r x mixed'], ['rg --hidden x mixed'], ['grep -r x mixed2'], ['rg x mixed2'], ['tar -cf out.tar mixed'], ['cp -r mixed copy5'], ['grep -r x .'], ['grep -r x'], ['grep -rn x .', 'mixed'],
    ['cat proj/node_modules/pkg/.env'], ['grep x proj/node_modules/pkg/.env'], ['cat proj/node_modules/pkg/server.pem'], ['head proj/node_modules/other/id_rsa'],
  ], denied, '止める');
  expectAll(f.ps, [['Get-ChildItem -Recurse mixed | Select-String x'], ['rg --hidden x mixed'], ['Get-Content proj/node_modules/pkg/.env'], ['Get-ChildItem -Recurse . | Get-Content']], denied, 'PowerShell: 止める');
});

test('(a) listTree: node_modules の中の秘密らしいパスは depSecrets に、外の秘密は secret に分ける。上限を超えても外の秘密は見つける', t => {
  const f = fixture(t);
  const deps = listTree(join(f.ws, 'proj'), true);
  assert.equal(deps.secret, undefined);
  assert.ok(deps.depSecrets!.length >= 3 && deps.depSecrets!.every(p => p.includes('node_modules')), JSON.stringify(deps.depSecrets));
  const mixed = listTree(join(f.ws, 'mixed'), true);
  assert.ok(mixed.secret!.endsWith('.env') && !mixed.secret!.includes('node_modules'));
  assert.ok(mixed.depSecrets!.length >= 1);
  const capped = listTree(join(f.ws, 'mixed2'), true, 1);
  assert.equal(capped.complete, false);
  assert.ok(capped.secret !== undefined || (capped.depSecrets ?? []).length > 0, '上限を超えても秘密を探し続ける');
  assert.ok(listTree(join(f.ws, 'mixed2'), true, 1).secret!.includes('secrets'), '外の秘密 secrets/ を、node_modules の秘密より優先して返す');
  assert.equal(listTree(join(f.ws, 'deps'), true).depSecrets, undefined, '依存に秘密らしいパスが無ければ付けない');
});

test('(a) 札に出す理由の文は日本語・英語にあり、当たったパスの数とパスを載せる。多いときは数件だけ出して、ほかの数を数える', () => {
  const ja = guardText('ja', 'list.secret_in_deps', { count: 7, paths: 'a, b' });
  const en = guardText('en', 'list.secret_in_deps', { count: 7, paths: 'a, b' });
  assert.match(ja, /node_modules/u);
  assert.match(ja, /7/u);
  assert.match(ja, /a, b/u);
  assert.match(en, /node_modules/u);
  assert.match(en, /7/u);
  assert.doesNotMatch(en, /[　-ヿ㐀-䶿一-鿿]/u);
});

// ── (b) 名前だけを出すコマンド ──

test('(b) 名前だけを出すコマンド（ls・tree・find・dir / Get-ChildItem）は、秘密のフォルダ（secrets・secret）を指すだけでは止めない', t => {
  const f = fixture(t);
  expectAll(f.bash, [
    ['ls secrets'], ['ls -la secrets'], ['ls -R secrets'], ['ls secret'], ['ls -l vault/secrets'], ['ls secrets/token.txt'], ['ls secrets/to*'], ['ls -1 secrets secret'],
    ['tree secrets'], ['tree -a vault'], ['find secrets -name "*.txt"'], ['find secrets -type f'], ['find . -name token.txt'], ['find vault/secrets -maxdepth 1'],
  ], allowed, 'bash: 名前だけは止めない');
  expectAll(f.ps, [
    ['Get-ChildItem secrets'], ['dir secrets'], ['gci secret'], ['ls secrets'], ['Get-ChildItem -Recurse secrets'], ['Get-ChildItem secrets -Name'], ['Get-ChildItem -Path vault/secrets'], ['Get-ChildItem -LiteralPath secrets'],
    ['tree.com /F secrets'], ['Get-ChildItem secrets/to*'],
  ], allowed, 'PowerShell: 名前だけは止めない');
});

test('(b) 中身を読むものは、秘密のフォルダを指せば今までどおり止める。名前だけの次に読むコマンドがつながる形も止める', t => {
  const f = fixture(t);
  expectAll(f.bash, [
    ['cat secrets/token.txt'], ['head secrets/token.txt'], ['tail -n 3 secrets/notes.md'], ['grep x secrets/token.txt'], ['grep -r x secrets'], ['rg x secrets'], ['wc -l secrets/token.txt'], ['cat secret/key.txt'], ['cat vault/secrets/deep.txt'],
    ['cat secrets/*'], ['cp secrets/token.txt copy.txt'], ['cp -r secrets copy6'], ['tar -cf out.tar secrets'], ['stat secrets/token.txt'], ['du secrets'],
    ['ls secrets; cat secrets/token.txt'], ['ls secrets && grep x secrets/notes.md'],
  ], denied, 'bash: 読むものは止める');
  expectAll(f.ps, [
    ['Get-Content secrets/token.txt'], ['Get-ChildItem secrets | Get-Content'], ['Get-ChildItem -Recurse secrets | Select-String x'], ['gci secrets | cat'], ['dir secrets | Get-Content'],
    ['Select-String x secrets/token.txt'], ['Get-Item secrets'], ['Test-Path secrets'], ['Copy-Item secrets copy7 -Recurse'], ['Get-ChildItem secrets; Get-Content secrets/token.txt'], ['Get-ChildItem secrets/* | Get-Content'],
  ], denied, 'PowerShell: 読むものは止める');
});

test('(b) 秘密のフォルダでなく、秘密のファイルの名前（.env・id_rsa・.pem など）や .ssh・.aws などは、名前だけを出すコマンドでも今までどおり止める', t => {
  const f = fixture(t);
  expectAll(f.bash, [['ls .env'], ['ls secrets/.env'], ['ls withenv/secrets/.env'], ['ls proj/node_modules/other/id_rsa'], ['ls -a ~/.ssh'], ['find .env'], ['tree secrets/.env']], denied, 'bash');
  expectAll(f.ps, [['Get-ChildItem .env'], ['dir secrets/.env'], ['Get-ChildItem withenv/secrets/.env'], ['dir ~/.aws']], denied, 'PowerShell');
  // 比べる基準: 秘密のフォルダの外の名前だけのコマンドは今までどおり
  expectAll(f.bash, [['ls'], ['ls -la src'], ['tree src']], allowed, '変わらない');
});

test('isSecretPath: 既定は今までどおり。files は secrets・secret のフォルダだけを外し、none は何も秘密にしない', () => {
  for (const p of ['/w/secrets/token.txt', '/w/secret', '/w/secrets']) assert.equal(isSecretPath(p), true, p);
  for (const p of ['/w/secrets/token.txt', '/w/secret', '/w/secrets/', '/w/vault/secrets/deep.txt']) assert.equal(isSecretPath(p, 'files'), false, `files: ${p}`);
  for (const p of ['/w/secrets/.env', '/w/id_rsa', '/w/a/server.pem', '/w/.ssh/config', '/w/.env.local', '/w/.npmrc']) assert.equal(isSecretPath(p, 'files'), true, `files: ${p}`);
  for (const p of ['/w/.env', '/w/secrets/x']) assert.equal(isSecretPath(p, 'none'), false, `none: ${p}`);
});
