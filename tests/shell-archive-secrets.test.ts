import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand, type ShellVerdict } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

// 7 回目の審査（中）: アーカイブを作ってから読む。`tar.exe -cf out2.tar sub; Select-String -Path out2.tar -Pattern SECRET` は、sub の下の .env の中身を表示した
// （out2.tar という名前は秘密のパスではなく、tar は中身をそのまま入れる）。
// 決め: アーカイブを作るコマンド（tar -c・zip・Compress-Archive）の元のフォルダの下に秘密のパスがあれば止める。無ければ、これまでの書き込みの決まりのまま。
//   元のフォルダの歩き方は、再帰して読むコマンドと同じ（shell-recursive-read.test.ts）。7z・rar など一覧にないものは、もともと今回だけ（コマンドを見て許可する）

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  const put = (rel: string, body = 'x') => { mkdirSync(join(ws, rel, '..'), { recursive: true }); writeFileSync(join(ws, rel), body); };
  for (const f of ['a.txt', 'notes.md', 'sub/z.txt', 'sub/deep/d.txt', 'plain/p.txt', 'plain/inner/q.txt', 'hid/h.txt']) put(f);
  put('.env', 'SECRET=1'); put('hid/.env', 'SECRET=2'); put('sec1/id_rsa', 'KEY'); put('keys/server.pem', 'PEM');
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [join(ws, 'SOUL.md'), join(ws, 'USER.md')], skillsDir: join(ws, 'skills') };
  const run = (shell: 'bash' | 'powershell') => (command: string, extra: { allow?: string[] } = {}): ShellVerdict =>
    checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell', ...extra });
  return { ws, bash: run('bash'), ps: run('powershell') };
}
const show = (v: ShellVerdict): string => `${v.decision}${v.onceOnly ? '/once' : ''} ${v.reasons.join(' / ').slice(0, 100)}`;

test('tar -c・zip: 元のフォルダの下に秘密のパスがあれば止める。無ければ、これまでの書き込みの決まりのまま', t => {
  const f = fixture(t);
  const wrong: string[] = [];
  for (const c of [
    'tar -cf out.tar hid', 'tar -czf out.tgz .', 'tar -cvf out.tar sub hid', 'tar cf out.tar sec1', 'tar -cf - hid', 'tar -cf out.tar -C hid .', "tar -cf out.tar --exclude='*.tmp' keys", 'tar -cjf out.tbz keys',
    'zip -r out.zip hid', 'zip out.zip sec1', 'zip -r out.zip .', 'zip -rq out.zip keys', 'zip -r out.zip sub hid', 'tar -cf out.tar -C sub ../hid', 'tar -cf out.tar . -C plain', 'tar -C sub -cf out.tar ../hid', 'tar -cf out.tar -C sub -C ../hid .',
  ]) if (f.bash(c).decision !== 'deny') wrong.push(`bash ${c} → ${show(f.bash(c))}`);
  for (const c of ['tar.exe -cf out2.tar hid', 'tar -cf out2.tar .', 'tar -cf out2.tar sub hid', 'tar.exe -cf out2.tar -C hid .', 'tar -czf out2.tgz keys']) if (f.ps(c).decision !== 'deny') wrong.push(`ps ${c} → ${show(f.ps(c))}`);
  assert.deepEqual(wrong, []);
  for (const c of ['tar -cf out.tar sub', 'tar -czf out.tgz plain', 'tar -cf out.tar -C plain .', 'zip -r out.zip sub', 'tar -tf out.tar', 'zip -r out.zip plain/p.txt', 'tar -cf out.tar a.txt notes.md', 'zip out.zip a.txt', 'tar -cvf out.tar sub plain', 'tar -C plain -cf out.tar .', 'tar -cf out.tar -C sub -C deep .', 'tar -cf out.tar -C plain inner']) {
    assert.equal(f.bash(c).decision, 'allow', `bash ${c}: ${show(f.bash(c))}`);
  }
  for (const c of ['tar.exe -cf out2.tar sub', 'tar -cf out2.tar plain', 'tar -tf out2.tar']) assert.equal(f.ps(c).decision, 'allow', `ps ${c}: ${show(f.ps(c))}`);
  // 守る場所への書き込みは、これまでどおり今回だけ
  assert.equal(f.bash('tar -cf SOUL.md sub').onceOnly, true);
});

test('Compress-Archive: 元のフォルダの下に秘密のパスがあれば止める（tools.shell.allow に書いてあっても）。無ければ、これまでどおり今回だけ（書いてあれば確かめなし）', t => {
  const f = fixture(t);
  const allow = ['Compress-Archive'];
  for (const c of ['Compress-Archive -Path hid -DestinationPath out.zip', 'Compress-Archive -LiteralPath sec1 -DestinationPath out.zip', 'Compress-Archive -Path sub, keys -DestinationPath out.zip', 'Compress-Archive hid out.zip']) {
    assert.equal(f.ps(c).decision, 'deny', c);
    assert.equal(f.ps(c, { allow }).decision, 'deny', `allow あり: ${c}`);
  }
  for (const c of ['Compress-Archive -Path sub -DestinationPath out.zip', 'Compress-Archive -Path plain, sub -DestinationPath out.zip']) {
    assert.equal(f.ps(c).onceOnly, true, c);
    assert.equal(f.ps(c, { allow }).decision, 'allow', `allow あり: ${c}`);
  }
});

test('アーカイブを作る名前だけの読み取り・一覧は、これまでどおり（元のフォルダを歩かない）', t => {
  const f = fixture(t);
  for (const c of ['tar -tf out.tar', 'tar -tvf out.tar', 'unzip -l out.zip', 'gzip -l out.gz', 'ls hid', 'find hid -type f']) assert.equal(f.bash(c).decision, 'allow', c);
});
