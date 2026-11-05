import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isSecretPath, realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand, type ShellVerdict } from '../src/tools/hooks/shell-guard.ts';
import { PS_WRITER_ALLOW, tempDir } from './helpers.ts';

// 9 回目の審査（高）: `cp -r secrets stuff; cat stuff/token.txt` と `mv secrets stuff2; …` は、秘密のフォルダの中身を読めた。
// 秘密のフォルダの印（secrets/）が末尾の / を要り、フォルダそのもの（`secrets`）を指すパスは秘密に当たらなかった。コピー・移動で名前が変わると、中のファイルの名前（token.txt）は秘密のパスではない。
// 決め: フォルダそのものも秘密のパスに当たる。再帰してコピーする cp -r・cp -a と、mv・Copy-Item -Recurse・Move-Item の元は、tar -c・zip と同じに、フォルダの下を歩いて秘密のパスがあれば止める

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  const put = (rel: string, body = 'x') => { mkdirSync(join(ws, rel, '..'), { recursive: true }); writeFileSync(join(ws, rel), body); };
  for (const f of ['a.txt', 'sub/z.txt', 'plain/p.txt', 'plain/inner/q.txt']) put(f);
  put('secrets/token.txt', 'TOKEN'); put('secret/key.txt', 'KEY'); put('proj/secrets/token.txt', 'TOKEN'); put('proj/ok.txt'); put('hid/.env', 'SECRET=2'); put('hid/h.txt'); put('keys/server.pem', 'PEM');
  mkdirSync(join(ws, 'emptysec', 'secrets'), { recursive: true });
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [join(ws, 'SOUL.md'), join(ws, 'USER.md')], skillsDir: join(ws, 'skills') };
  const bash = (command: string, cwd = '.'): ShellVerdict => checkShellCommand(command, join(ws, cwd), { policy, outsideRoots: 'ask', shell: 'bash', windows: false });
  const ps = (command: string, cwd = '.'): ShellVerdict => checkShellCommand(command, join(ws, cwd), { policy, outsideRoots: 'ask', shell: 'powershell', windows: true, allow: PS_WRITER_ALLOW });
  return { ws, bash, ps };
}
const show = (v: ShellVerdict): string => `${v.decision}${v.onceOnly ? '/once' : ''} ${v.reasons.join(' / ').slice(0, 100)}`;

test('isSecretPath: secrets・secret のフォルダそのものも秘密のパス。名前が少し違うものは違う', () => {
  for (const p of ['/w/secrets', '/w/secret', '/w/secrets/', '/w/secrets/token.txt', '/w/a/secret/x', 'secrets', 'C:\\w\\Secrets', 'C:\\w\\secret']) assert.equal(isSecretPath(p), true, p);
  for (const p of ['/w/secretary', '/w/mysecrets', '/w/secrets.txt', '/w/secret.md', '/w/topsecret/x', '/w/notsecrets']) assert.equal(isSecretPath(p), false, p);
});

test('cp -r・mv で秘密のフォルダそのものを動かす形は止める（コピー先の中のファイルの名前は秘密のパスでないので、読めてしまう）', t => {
  const f = fixture(t);
  const wrong: string[] = [];
  for (const c of [
    'cp -r secrets stuff', 'cp -r secrets stuff; cat stuff/token.txt', 'cp -R secrets stuff', 'cp -a secrets stuff', 'cp -r secrets/ stuff', 'cp -r secrets/. stuff', 'cp -r secret stuff', 'cp -rT secrets stuff', 'cp -r -t stuff secrets',
    'mv secrets stuff2', 'mv secrets stuff2; cat stuff2/token.txt', 'mv secrets/ stuff2', 'mv secret stuff2', 'mv -t stuff2 secrets', 'cp -r proj/secrets stuff', 'mv proj/secrets stuff2', 'cp -r emptysec/secrets stuff',
    'cat secrets', 'ls secrets', 'mkdir secrets2/secrets',
  ]) if (f.bash(c).decision !== 'deny') wrong.push(`bash ${c} → ${show(f.bash(c))}`);
  for (const c of ['Copy-Item -Recurse secrets stuff', 'Copy-Item secrets stuff -Recurse', 'Move-Item secrets stuff2', 'Get-Content secrets', 'Copy-Item -Path secrets -Destination stuff -Recurse']) {
    if (f.ps(c).decision !== 'deny') wrong.push(`ps ${c} → ${show(f.ps(c))}`);
  }
  assert.deepEqual(wrong, []);
});

test('cp -r・cp -a・mv の元のフォルダの下に秘密のパスがあれば止める（tar -c・zip と同じに歩く）。無ければ、これまでどおり確かめなし', t => {
  const f = fixture(t);
  const wrong: string[] = [];
  for (const c of [
    'cp -r proj proj2', 'cp -a proj proj2', 'mv proj proj2', 'cp -r hid hid2', 'mv hid hid2', 'cp -r keys keys2', 'cp -r . ../backup', 'cp -r emptysec out', 'mv emptysec out', 'cp -r plain proj out', 'cp -r -t out plain hid', 'mv plain hid out',
    'cp -r proj/* out', 'cp -r p* out',
  ]) if (f.bash(c).decision !== 'deny') wrong.push(`bash ${c} → ${show(f.bash(c))}`);
  for (const c of ['Copy-Item -Recurse proj proj2', 'Move-Item proj proj2', 'Copy-Item -Recurse hid hid2', 'Move-Item hid hid2', 'Copy-Item -Recurse emptysec out', 'Move-Item -Path plain, hid -Destination out']) {
    if (f.ps(c).decision !== 'deny') wrong.push(`ps ${c} → ${show(f.ps(c))}`);
  }
  assert.deepEqual(wrong, []);
  for (const c of ['cp -r plain plain2', 'cp -a plain plain2', 'mv plain plain3', 'cp -r sub sub2', 'cp -r plain/inner copy', 'cp a.txt b.txt', 'mv a.txt c.txt', 'cp -r a.txt b.txt', 'cp -r plain sub out', 'mv sub plain/moved', 'cp a.txt sub/']) {
    // out は無いフォルダだが、書き込みは許可フォルダの中
    assert.equal(f.bash(c).decision, 'allow', `bash ${c}: ${show(f.bash(c))}`);
  }
  for (const c of ['Copy-Item -Recurse plain plain2', 'Move-Item plain plain3', 'Copy-Item a.txt b.txt']) assert.equal(f.ps(c).decision, 'allow', `ps ${c}: ${show(f.ps(c))}`);
});

test('再帰しない cp は、元のフォルダの下を歩かない（-r が無ければ cp はフォルダを断る）', t => {
  const f = fixture(t);
  for (const c of ['cp proj proj2', 'cp hid hid2']) assert.equal(f.bash(c).decision, 'allow', `bash ${c}: ${show(f.bash(c))}`);
});
