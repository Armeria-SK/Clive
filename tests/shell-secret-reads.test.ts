import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { expandGlob, GLOB_CAP, listTree } from '../src/tools/hooks/path-expand.ts';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { PS_WRITER_ALLOW, tempDir } from './helpers.ts';

// 再審査の指摘（低）: ワイルドカードに当たるものが 2,000 件を超えると、列挙しきれないので「ふつうの確かめ」にしていたが、その中に秘密のパスがあっても止めなかった。
// PowerShell の -Path のワイルドカードのエスケープ（バッククォート）つきの、引用符で囲んだ秘密の名前（'.en`v'）も、判定できない（ふつうの確かめ）で止めなかった。
// どちらも、秘密のパスに当たるなら、ふつうの確かめでなく止める

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  for (const d of ['sub', 'big', 'bigsecret']) mkdirSync(join(ws, d), { recursive: true });
  for (const [f, text] of [['SOUL.md', 'persona'], ['USER.md', 'user'], ['.env', 'SECRET=1'], ['notes.md', 'n'], ['sub/z.txt', 'z']] as const) writeFileSync(join(ws, f), text);
  for (let i = 0; i < GLOB_CAP + 100; i++) {
    const name = `f${String(i).padStart(5, '0')}.txt`;
    writeFileSync(join(ws, 'big', name), 'x');
    writeFileSync(join(ws, 'bigsecret', name), 'x');
  }
  // 並びの最後になる名前（先頭の 2,000 件に入らない）
  writeFileSync(join(ws, 'bigsecret', 'zzz.pem'), 'KEY');
  writeFileSync(join(base, 'config.json'), '{}');
  const policy: ScopePolicy = {
    roots: [{ path: ws, mode: 'write' }], deny: [realish(join(base, 'config.json'))], askOnWrite: [join(ws, 'SOUL.md'), join(ws, 'USER.md')], skillsDir: join(ws, 'skills'),
  };
  const ps = (command: string) => checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell: 'powershell', windows: true, allow: PS_WRITER_ALLOW });
  const bash = (command: string) => checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell: 'bash', windows: false });
  return { base, ws, ps, bash };
}

test('expandGlob: 2,000 件を超えて列挙しきれなくても、当たったものの中の秘密のパスを返す（先頭の 2,000 件に入っていなくても）', t => {
  const f = fixture(t);
  const secret = expandGlob(join(f.ws, 'bigsecret', '*'), true);
  assert.equal(secret.complete, false);
  assert.equal(secret.matches.length <= GLOB_CAP + 1, true, '返す一覧は上限まで');
  assert.equal(secret.secret, join(f.ws, 'bigsecret', 'zzz.pem'));
  const plain = expandGlob(join(f.ws, 'big', '*'), true);
  assert.equal(plain.complete, false);
  assert.equal(plain.secret, undefined, '秘密が無ければ返さない');
  assert.equal(expandGlob(join(f.ws, 'sub', '*'), true).secret, undefined);
});

test('listTree: 上限を超えて一覧しきれなくても、秘密のパスを返す', t => {
  const f = fixture(t);
  const tree = listTree(join(f.ws, 'bigsecret'), false, 100);
  assert.equal(tree.complete, false);
  assert.equal(tree.entries.length, 100);
  assert.equal(tree.secret, join(f.ws, 'bigsecret', 'zzz.pem'));
  assert.equal(listTree(join(f.ws, 'big'), false, 100).secret, undefined);
});

test('ワイルドカードに当たるものが 2,000 件を超えるとき: 秘密のパスが含まれるなら止める。含まれなければ、これまでどおりふつうの確かめ', t => {
  const f = fixture(t);
  for (const c of ['Get-Content bigsecret/*', 'Select-String -Path bigsecret/* -Pattern x', 'Get-ChildItem bigsecret | Get-Content', 'Copy-Item bigsecret/* sub/']) {
    assert.equal(f.ps(c).decision, 'deny', `${c}: ${f.ps(c).decision}`);
  }
  assert.equal(f.bash('cat bigsecret/*').decision, 'deny');
  for (const c of ['Get-Content big/*', 'Select-String -Path big/* -Pattern x']) {
    const v = f.ps(c);
    assert.equal(v.decision, 'ask', c);
    assert.equal(v.onceOnly, false, c);
    assert.match(v.reasons.join('\n'), /ワイルドカードに当たるものが多い/u, c);
  }
  // 書く・消す側も、当たったものの中の秘密のパスは止める
  assert.equal(f.ps('Remove-Item bigsecret/*').decision, 'deny');
});

test('PowerShell: ワイルドカードのエスケープ（バッククォート）つきで秘密のパスを指す読み取りは止める。秘密でなければ、これまでどおり判定できないので確かめる', t => {
  const f = fixture(t);
  const secrets = [
    "Get-Content '.en`v'", "Get-Content -Path '.e`nv'", "Select-String -Path '.en`v' -Pattern S", "Get-ChildItem '.en`v'", "Copy-Item '.en`v' sub/", "Get-Content '`.env'", "Get-Content '.env`'", "Get-Content 'bigsecret/zzz`.pem'",
    "Get-Content '..\\conf`ig.json'", "Get-Content '.e`*'", "gc '.en`v'", "Get-FileHash '.en`v'", "Import-Csv '.en`v'", "'x' > '.en`v'", "Set-Content '.en`v' x",
    // 本物の PowerShell 5.1 で .env を読む書き方（[ ] の中のバッククォートつきの文字）
    "Get-Content '.en[`v]'", "Get-Content -Path '.[`e]nv'", "Select-String -Path '.en[`v]' -Pattern S", "Get-ChildItem '.[`n`e]nv'",
  ];
  const wrong = secrets.filter(c => f.ps(c).decision !== 'deny').map(c => `${c} → ${f.ps(c).decision}`);
  assert.deepEqual(wrong, []);
  // 秘密でない名前は、これまでどおり（判定できないので確かめる）。-LiteralPath は文字どおりなので、バッククォートの名前のファイル
  assert.equal(f.ps("Get-Content 'no`tes.md'").decision, 'ask');
  assert.equal(f.ps("Get-Content 'sub/z`.txt'").decision, 'ask');
  assert.equal(f.ps("Get-Content -LiteralPath '.en`v'").decision, 'allow');
  assert.equal(f.ps("Set-Content 'SOU`L.md' x").onceOnly, true, '人格への書き込みは、これまでどおり今回だけ');
});

test('パイプで流れるファイルの一覧が上限（20,000 件）を超えても、その中の秘密のパスは止める。秘密が無ければふつうの確かめ', t => {
  const f = fixture(t);
  const dir = join(f.ws, 'huge');
  mkdirSync(dir);
  for (let i = 0; i < 20_050; i++) writeFileSync(join(dir, `f${String(i).padStart(6, '0')}.txt`), '');
  const v = f.ps('Get-ChildItem huge | Get-Content');
  assert.equal(v.decision, 'ask');
  assert.match(v.reasons.join('\n'), /ワイルドカードに当たるものが多い/u);
  writeFileSync(join(dir, 'zzz.pem'), 'KEY');
  assert.equal(f.ps('Get-ChildItem huge | Get-Content').decision, 'deny');
});
