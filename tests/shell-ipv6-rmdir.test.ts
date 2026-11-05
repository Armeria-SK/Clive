import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand, type ShellVerdict } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

// 9 回目の審査（低）: IPv6 の書き方でも、この PC のサーバーに届く宛先はある。URL の { } [ ] を避ける -g（--globoff）を付けると、IPv6 のホストは [ ] で書くので、宛先の調べに届く。
//   WHATWG の URL は、[::ffff:127.0.0.1] を [::ffff:7f00:1]、[0:0:0:0:0:0:0:1] を [::1] に直す。IPv4 を埋め込んだ形（::ffff:a.b.c.d と ::a.b.c.d）と、未指定のアドレス [::]（Linux は自分に届く）は、
//   これまでの調べ（127.x・localhost・::1 だけ）に当たらず、確かめなしで Clive 自身の API に届いた。
// 決め: 埋め込まれた IPv4 を取り出して、IPv4 と同じに調べる（127.x・0.0.0.0 は今回だけ、LAN はふつうの確かめ）。[::] も今回だけ
// rmdir -p は、名前を書いていない親のフォルダまで消す（守る場所を含む）ので、一覧のフラグから外して今回だけ

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  mkdirSync(join(ws, 'a', 'b', 'c'), { recursive: true });
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [join(ws, 'SOUL.md'), join(ws, 'USER.md')], skillsDir: join(ws, 'skills') };
  const run = (shell: 'bash' | 'powershell') => (command: string, allow?: string[]): ShellVerdict =>
    checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell', ...(allow ? { allow } : {}) });
  return { bash: run('bash'), ps: run('powershell') };
}
const show = (v: ShellVerdict): string => `${v.decision}${v.onceOnly ? '/once' : ''} ${v.reasons.join(' / ').slice(0, 100)}`;
const once = (v: ShellVerdict): boolean => v.decision === 'ask' && v.onceOnly;

const LOOPBACK_V6 = [
  '[::1]', '[0:0:0:0:0:0:0:1]', '[::ffff:127.0.0.1]', '[::FFFF:127.0.0.1]', '[::ffff:7f00:1]', '[::]', '[0:0:0:0:0:0:0:0]', '[::127.0.0.1]', '[::7f00:1]', '[::ffff:127.1.2.3]', '[::ffff:0.0.0.0]',
  '[0000:0000:0000:0000:0000:ffff:7f00:0001]', '[0:0:0:0:0:ffff:127.0.0.1]', '[::ffff:7f00:1]:7800', '[::1]:7800',
];

test('-g を付けた IPv6 の宛先のうち、この PC に届くもの（::1・::・IPv4 を埋め込んだ 127.x と 0.0.0.0）は今回だけ（tools.shell.allow に curl と書いても外せない）', t => {
  const f = fixture(t);
  const wrong: string[] = [];
  for (const host of LOOPBACK_V6) {
    const url = `http://${host}${host.includes(']:') ? '' : ':7800'}/api/health`;
    for (const c of [`curl -g '${url}'`, `curl -sS -g '${url}'`, `curl --globoff '${url}'`, `wget --max-redirect=0 -O - '${url}'`]) {
      if (!once(f.bash(c))) wrong.push(`bash ${c} → ${show(f.bash(c))}`);
      if (!once(f.bash(c, ['curl', 'wget']))) wrong.push(`bash(allow) ${c} → ${show(f.bash(c, ['curl', 'wget']))}`);
    }
    for (const c of [`curl.exe -g '${url}'`, `Invoke-WebRequest -Uri '${url}' -MaximumRedirection 0`, `iwr '${url}' -MaximumRedirection 0`]) {
      if (!once(f.ps(c))) wrong.push(`ps ${c} → ${show(f.ps(c))}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('-g を付けた IPv6 の宛先のうち、IPv4 を埋め込んだ LAN（10.x・192.168.x・172.16-31.x）はふつうの確かめ。外のアドレスは、これまでどおり確かめなし', t => {
  const f = fixture(t);
  const wrong: string[] = [];
  for (const host of ['[::ffff:10.0.0.1]', '[::ffff:192.168.1.5]', '[::ffff:c0a8:105]', '[::ffff:172.16.0.1]', '[::ffff:169.254.1.1]', '[fd00::1]', '[fe80::1]']) {
    const c = `curl -g 'http://${host}/x'`;
    if (f.bash(c).decision !== 'ask' || f.bash(c).onceOnly) wrong.push(`${c} → ${show(f.bash(c))}`);
  }
  for (const host of ['[2606:4700:4700::1111]', '[2001:db8::1]', '[::ffff:8.8.8.8]', '[::ffff:808:808]', '[::2]', '[::ffff:128.0.0.1]', '[::ffff:11.0.0.1]']) {
    const c = `curl -g 'http://${host}/x'`;
    if (f.bash(c).decision !== 'allow') wrong.push(`${c} → ${show(f.bash(c))}`);
  }
  assert.deepEqual(wrong, []);
  for (const c of ['curl -sS https://example.com', 'curl -g https://example.com/a', 'curl http://8.8.8.8/']) assert.equal(f.bash(c).decision, 'allow', c);
});

test('rmdir -p は名前を書いていない親のフォルダまで消すので今回だけ。-p の無い rmdir は、これまでどおり', t => {
  const f = fixture(t);
  for (const c of ['rmdir -p a/b/c', 'rmdir -pv a/b/c', 'rmdir -v -p a/b/c', 'rmdir --parents a/b/c', 'rmdir -p -- a/b/c']) assert.equal(once(f.bash(c)), true, `${c}: ${show(f.bash(c))}`);
  assert.equal(f.bash('rmdir -p a/b/c', ['rmdir -p a/b/c']).decision, 'allow', '持ち主が書いた形は外せる');
  for (const c of ['rmdir a/b/c', 'rmdir -v a/b/c', 'rmdir a/b/c a/b']) assert.equal(f.bash(c).decision, 'allow', `${c}: ${show(f.bash(c))}`);
});

// 実機の curl: IPv4 を埋め込んだ書き方（[::ffff:127.0.0.1]）は、本当にこの PC のサーバーに届く。届く書き方はガードも今回だけにする
const curlAvailable = spawnSync('curl', ['--version'], { windowsHide: true }).status === 0;
test('実機の curl: [::ffff:127.0.0.1] と [::ffff:7f00:1] は、この PC のサーバーに届き、ガードは今回だけにする', { skip: !curlAvailable && 'curl が無い' }, async t => {
  const server = createServer((_req, res) => { res.writeHead(200); res.end('hit'); });
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen({ port: 0, host: '::', ipv6Only: false }, resolve); }); } catch { t.skip('IPv6 で待ち受けられない'); return; }
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as AddressInfo).port;
  const fetchBody = (host: string): Promise<string> => new Promise(resolve => {
    let out = '';
    const p = spawn('curl', ['-q', '-g', '-sS', '-m', '5', `http://${host}:${port}/`], { windowsHide: true });
    p.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    p.on('close', () => resolve(out));
  });
  if ((await fetchBody('[::1]')) !== 'hit') { t.skip('IPv6 のループバックが使えない'); return; }
  const f = fixture(t);
  for (const host of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]']) {
    assert.equal(await fetchBody(host), 'hit', `前提: ${host} は本当に届く`);
    assert.equal(once(f.bash(`curl -g 'http://${host}:${port}/api/health'`)), true, host);
  }
});
