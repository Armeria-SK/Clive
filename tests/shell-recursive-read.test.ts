import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { listTree } from '../src/tools/hooks/path-expand.ts';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand, type ShellVerdict } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

// 7 回目の審査（高）: フォルダを再帰して中身を読むコマンドは、フォルダの下の秘密のパスを調べていなかった。
// `findstr /s SECRET *` と `grep -r SECRET sub` は本当に .env を表示した。rg の -uu・--hidden・-u、`grep -r .`、`git grep --no-index` / `--untracked` も許していた。
// 決め: 再帰して読むものは、-Recurse の一覧と同じに、フォルダの下を歩く（20,000 件まで。名前は 10 万件まで数えて秘密を探す）。秘密のパスがあれば止め、数え切れなければふつうの確かめ。
//   ・名前で絞る指定（--include・findstr のファイル名のワイルドカード）は真似ない（Windows のファイル検索の決まりで 8.3 の短い名前にも当たる）。絞らずに、全部を調べる
//   ・rg だけは、既定では「.」で始まる名前（隠しファイル・隠しフォルダ）を読まない。-u -uu -uuu --hidden と -g（グロブは隠しも読む）があれば読む。無視の一覧（.gitignore）は真似ない
//   ・名前だけを出すもの（find・ls -R・tree・rg --files・dir）は読まない

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  const put = (rel: string, body = 'x') => { mkdirSync(join(ws, rel, '..'), { recursive: true }); writeFileSync(join(ws, rel), body); };
  for (const f of ['a.txt', 'notes.md', 'sub/z.txt', 'sub/deep/d.txt', 'plain/p.txt', 'plain/inner/q.txt', 'hid/h.txt', 'clean/a.txt', 'clean/sub/b.txt', 'clean/.cache/c.txt']) put(f);
  // 秘密: 隠しの .env（ルート・フォルダの中）・隠しでない id_rsa・server.pem・隠しフォルダの中の id_rsa
  put('.env', 'SECRET=1'); put('hid/.env', 'SECRET=2'); put('sec1/id_rsa', 'KEY'); put('keys/server.pem', 'PEM'); put('.hiddensec/id_rsa', 'KEY'); put('clean/.env', 'SECRET=3');
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [join(ws, 'SOUL.md'), join(ws, 'USER.md')], skillsDir: join(ws, 'skills') };
  const run = (shell: 'bash' | 'powershell') => (command: string, cwd = '.'): ShellVerdict =>
    checkShellCommand(command, join(ws, cwd), { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell' });
  return { base, ws, bash: run('bash'), ps: run('powershell'), put };
}

const show = (v: ShellVerdict): string => `${v.decision}${v.onceOnly ? '/once' : ''} ${v.reasons.join(' / ').slice(0, 120)}`;
type Row = readonly [command: string, cwd?: string];
function expectAll(run: (c: string, cwd?: string) => ShellVerdict, rows: readonly Row[], want: (v: ShellVerdict) => boolean, label: string): void {
  const wrong = rows.filter(([c, cwd]) => !want(run(c, cwd))).map(([c, cwd]) => `${cwd ? `[${cwd}] ` : ''}${c} → ${show(run(c, cwd))}`);
  assert.deepEqual(wrong, [], label);
}
const denied = (v: ShellVerdict): boolean => v.decision === 'deny';
const allowed = (v: ShellVerdict): boolean => v.decision === 'allow';

test('grep -r / -R: フォルダの下に秘密のパスがあれば止める。パスが無ければ「.」。-r が無ければ読まない', t => {
  const f = fixture(t);
  expectAll(f.bash, [
    ['grep -r SECRET hid'], ['grep -rn x sec1'], ['grep -R x keys'], ['grep -r x .'], ['grep -r x'], ['grep -rl x sub hid'], ['grep -e x -r hid'], ['grep -r -e SECRET -- hid'], ["grep -r --include='*.txt' x hid"],
    ['grep -r --exclude-dir=hid x .'], ['grep -r x .hiddensec'], ['grep -r x sub/..'], ['grep -r x', 'clean'], ['grep -r x ../hid', 'sub'], ['egrep -r x hid'], ['fgrep -R x keys'], ['grep -rn x sub hid plain'],
  ], denied, '秘密があれば止める');
  expectAll(f.bash, [
    ['grep -r x sub'], ['grep -rn x plain'], ['grep -r x sub plain'], ['grep x hid'], ['grep -r x plain/p.txt'], ['grep -rn x sub/deep'], ['grep -r x sub', 'clean'], ['grep -r x plain/inner'], ['grep x a.txt'], ['grep -rn x sub/deep sub/z.txt'],
  ], allowed, '秘密が無い、または再帰しない');
});

test('rg: 既定では隠しファイルを読まない。-u・-uu・-uuu・--hidden・-g があれば読む。隠しでない秘密（id_rsa・*.pem）は既定でも読む。名前だけの --files は読まない', t => {
  const f = fixture(t);
  expectAll(f.bash, [
    ['rg x keys'], ['rg x sec1'], ['rg x'], ['rg -n x .'], ['rg -l x sec1'], ['rg -c x keys'], ['rg -e x keys'], ['rg x .hiddensec'], ['rg x sub keys'],
    ['rg --hidden x hid'], ['rg -uu x hid'], ['rg -uuu x hid'], ['rg -u x hid'], ["rg -g '.env' x hid"], ["rg -g '*' x hid"], ['rg --hidden x', 'clean'], ['rg -uu x', 'clean'], ['rg -u x', 'clean'], ["rg -g '.env' x", 'clean'],
    ['rg --files-with-matches x sec1'], ['rg --count-matches x keys'], ['rg --json x keys'],
  ], denied, '秘密があれば止める');
  expectAll(f.bash, [
    ['rg x sub'], ['rg x plain'], ['rg x hid'], ['rg --no-ignore x hid'], ['rg -n x sub plain'], ['rg --files sec1'], ['rg --files'], ['rg x', 'clean'], ['rg -n x sub', 'clean'], ['rg --no-ignore x', 'clean'], ['rg -i -n --max-depth=2 x plain'],
    ['rg x plain/p.txt'], ['rg --type-list'],
  ], allowed, '既定では隠しを読まない・名前だけ・秘密が無い');
  expectAll(f.ps, [['rg x keys'], ['rg --hidden x', 'clean'], ['rg -uu x hid'], ["rg -g '.env' x", 'clean']], denied, 'PowerShell の rg も同じ');
  expectAll(f.ps, [['rg x', 'clean'], ['rg x sub'], ['rg --files']], allowed, 'PowerShell の rg: 既定');
});

test('findstr（PowerShell）: ワイルドカードの引数は findstr が展開する。/s は下の階層まで。/d のフォルダも歩く', t => {
  const f = fixture(t);
  expectAll(f.ps, [
    ['findstr /s SECRET *'], ['findstr SECRET *'], ['findstr /s x *.txt'], ['findstr /s x a.txt'], ['findstr /s x hid\\*'], ['findstr x hid\\*'], ['findstr /s x sub\\* hid\\*'], ['findstr /i /s /n x *'], ["findstr /s /c:'x y' *"],
    ['findstr x .*'], ['findstr /s x ?.txt'], ['findstr SECRET *', 'clean'], ['findstr /d:..\\hid x *', 'plain'], ['findstr /s /d:..\\hid x a.txt', 'plain'], ['findstr x hid/*'], ['findstr /s x keys\\*.pem'], ['findstr /s x *', 'clean'],
    ['findstr x *.', 'clean'], ['findstr x .env?', 'clean'],
  ], denied, '秘密があれば止める');
  expectAll(f.ps, [
    ['findstr x a.txt'], ['findstr x sub\\z.txt'], ['findstr /s x sub\\*'], ['findstr x sub\\*'], ['findstr x plain\\*.txt'], ['findstr /s x plain\\*'], ['findstr /s x *', 'plain'], ['findstr x *.txt', 'plain'], ['findstr /s x *.txt', 'plain'],
    ['findstr /d:inner x *', 'plain'], ['findstr /s x p.txt', 'plain'], ['findstr /s x *', 'sub'], ['findstr /i /c:"x" a.txt'],
  ], allowed, '秘密が無い・ワイルドカードも再帰も無い');
});

test('git grep --no-index / --untracked、git diff --no-index: 作業フォルダの下を歩く。既定の git grep（追跡しているものだけ）はこれまでどおり', t => {
  const f = fixture(t);
  for (const run of [f.ps, f.bash]) {
    expectAll(run, [
      ['git grep --untracked x'], ['git grep --no-index x'], ['git grep -e x --untracked'], ['git grep --untracked x -- hid'], ['git grep --no-index x sec1'], ["git grep --untracked x -- '*.txt'"], ["git grep --untracked x -- sub '*.txt'"], ['git grep --untracked x -- sub ":(top)plain"'], ['git grep --no-index -e x -- keys'],
      ['git diff --no-index hid plain'], ['git diff --no-index sec1 sub'], ['git grep --untracked x', 'clean'], ['git grep -n --no-index x'],
    ], denied, '秘密があれば止める');
    expectAll(run, [
      ['git grep x'], ['git grep -e x -- sub'], ['git grep --untracked x -- sub'], ['git grep --no-index x plain'], ['git diff --no-index sub plain'], ['git grep -n x'], ['git grep --untracked x', 'plain'], ['git grep --cached x'],
    ], allowed, '秘密が無い・追跡しているものだけ');
  }
});

test('diff -r: 両方のフォルダの下を歩く。-r が無ければ読まない', t => {
  const f = fixture(t);
  expectAll(f.bash, [['diff -r hid plain'], ['diff -rq sec1 sub'], ['diff -ru keys sub'], ['diff -r -N plain hid']], denied, '秘密があれば止める');
  expectAll(f.bash, [['diff -r sub plain'], ['diff sub plain'], ['diff -ru sub plain/inner'], ['diff a.txt notes.md']], allowed, '秘密が無い・再帰しない');
});

test('名前だけを出すコマンドは、これまでどおり: find・ls -R・tree・du・fd・dir・Get-ChildItem -Recurse（読む次のコマンドが無い）', t => {
  const f = fixture(t);
  expectAll(f.bash, [['find . -name "*.txt"'], ['ls -R hid'], ['tree hid'], ['du -a hid'], ['fd x hid'], ['find sec1 -type f']], allowed, 'bash: 名前だけ');
  expectAll(f.ps, [['Get-ChildItem -Recurse hid'], ['dir hid'], ['tree.com /F hid'], ['where.exe /R hid *.txt']], allowed, 'PowerShell: 名前だけ');
});

test('上限（20,000 件）を超えて歩ききれないときはふつうの確かめ。その中に秘密があれば止める', t => {
  const f = fixture(t);
  const dir = join(f.ws, 'huge');
  mkdirSync(dir);
  for (let i = 0; i < 20_050; i++) writeFileSync(join(dir, `f${String(i).padStart(6, '0')}.txt`), '');
  for (const [run, c] of [[f.bash, 'grep -r x huge'], [f.ps, 'findstr /s x huge\\*']] as const) {
    const v = run(c);
    assert.equal(v.decision, 'ask', `${c}: ${show(v)}`);
    assert.equal(v.onceOnly, false, c);
    assert.match(v.reasons.join('\n'), /ワイルドカードに当たるものが多い/u, c);
  }
  writeFileSync(join(dir, 'zzz.pem'), 'KEY');
  for (const [run, c] of [[f.bash, 'grep -r x huge'], [f.bash, 'rg x huge']] as const) assert.equal(run(c).decision, 'deny', c);
});

test('listTree（隠しを飛ばす）: 「.」で始まる名前は一覧に入れず、その下へも入らず、秘密を探すときにも数えない', t => {
  const f = fixture(t);
  const dir = join(f.ws, 'tree');
  f.put('tree/v.txt'); f.put('tree/.env', 'S'); f.put('tree/.h/inner.txt'); f.put('tree/.h/id_rsa', 'K'); f.put('tree/sub/ok.txt'); f.put('tree/sub/.x'); f.put('tree/keys/a.pem', 'P');
  const rel = (paths: readonly string[]) => paths.map(p => p.slice(dir.length + 1).replaceAll('\\', '/')).sort();
  const all = listTree(dir, true);
  assert.ok(rel(all.entries).includes('.env') && rel(all.entries).includes('.h/id_rsa'), '既定は隠しも挙げる');
  const visible = listTree(dir, true, 20_000, true);
  assert.deepEqual(rel(visible.entries), ['keys', 'keys/a.pem', 'sub', 'sub/ok.txt', 'v.txt']);
  assert.equal(rel([visible.secret ?? ''])[0], 'keys/a.pem', '隠しの秘密ではなく、隠しでない秘密を返す');
  // 上限を超えたあとも、隠しの秘密は数えず、隠しでない秘密を見つける
  const capped = listTree(dir, true, 2, true);
  assert.equal(capped.complete, false);
  assert.equal(rel([capped.secret ?? ''])[0], 'keys/a.pem');
});
