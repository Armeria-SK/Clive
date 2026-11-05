import assert from 'node:assert/strict';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { containsGitDir, expandGlob, isDirectory, listTree } from '../src/tools/hooks/path-expand.ts';
import { expandPath, isRemotePath, placePath, realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { PS_WRITER_ALLOW, tempDir } from './helpers.ts';

// 再審査の指摘: `//localhost/D$/…/USER.md` や `//?/D:/…/USER.md` は、本物の Windows で人格 USER.md を書き換えたのに、許可フォルダの外のふつうの確かめだけで通った。
// config.json・.env は、禁止（止める）がふつうの確かめに下がった。`\??\` は「cwd」に化けて、許可フォルダの中の書き込みとして通った。
// / を \ として読んだうえで、\\?\・\\.\・\??\ で始まるパスと、ネットワークのパス（UNC）は、どれも止める（ネットワーク越しの書き込みは、このPCの中で確かめられないため）

const windowsOnly = process.platform === 'win32' ? false : 'Windows のパスの決まりだけの確かめ';

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  mkdirSync(join(ws, 'skills'), { recursive: true });
  for (const [f, text] of [['SOUL.md', 'persona'], ['USER.md', 'user'], ['.env', 'SECRET=1'], ['notes.md', 'n']] as const) writeFileSync(join(ws, f), text);
  writeFileSync(join(base, 'config.json'), '{}');
  const policy: ScopePolicy = {
    roots: [{ path: ws, mode: 'write' }], deny: [realish(join(base, 'config.json'))], askOnWrite: [join(ws, 'SOUL.md'), join(ws, 'USER.md'), join(ws, 'skills')], skillsDir: join(ws, 'skills'),
  };
  const slash = (p: string): string => p.replaceAll('\\', '/');
  const drive = ws.slice(0, 1);
  // 同じファイルを指す、いろいろな書き方
  const forms = (abs: string): string[] => {
    const rest = slash(abs).slice(2);
    return [
      `//localhost/${drive}$${rest}`, `\\\\localhost\\${drive}$${rest.replaceAll('/', '\\')}`, `//127.0.0.1/${drive}$${rest}`, `//?/${slash(abs)}`, `\\\\?\\${abs}`, `//./${slash(abs)}`, `\\\\.\\${abs}`,
      `\\??\\${abs}`, `/??/${slash(abs)}`, `//?/UNC/localhost/${drive}$${rest}`, `\\\\?\\UNC\\localhost\\${drive}$${rest.replaceAll('/', '\\')}`, `\\/localhost/${drive}$${rest}`,
    ];
  };
  const ps = (command: string) => checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell: 'powershell', windows: true, allow: PS_WRITER_ALLOW });
  const bash = (command: string) => checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell: 'bash', windows: true });
  return { base, ws, policy, forms, ps, bash };
}

test('UNC・デバイスのパス: 人格・設定・秘密を、どの書き方で指しても止める（ふつうの確かめに下がらない）', { skip: windowsOnly }, t => {
  const f = fixture(t);
  const wrong: string[] = [];
  for (const target of [join(f.ws, 'USER.md'), join(f.ws, 'SOUL.md'), join(f.ws, '.env'), join(f.ws, 'notes.md'), join(f.base, 'config.json')]) {
    for (const form of f.forms(target)) {
      for (const command of [`Set-Content '${form}' pwned`, `Get-Content '${form}'`, `Remove-Item '${form}'`, `Add-Content -LiteralPath '${form}' -Value x`, `'x' > '${form}'`, `Copy-Item notes.md '${form}'`, `Copy-Item '${form}' sub`, `Out-File -FilePath '${form}'`]) {
        const v = f.ps(command);
        if (v.decision !== 'deny') wrong.push(`${command} → ${v.decision}${v.onceOnly ? '/once' : ''}`);
      }
      for (const command of [`echo x > '${form}'`, `cat '${form}'`, `cp notes.md '${form}'`, `rm '${form}'`]) {
        const v = f.bash(command);
        if (v.decision !== 'deny') wrong.push(`bash: ${command} → ${v.decision}${v.onceOnly ? '/once' : ''}`);
      }
    }
  }
  assert.deepEqual(wrong, []);
});

test('UNC・デバイスのパス: 作業フォルダの外のネットワークの共有・デバイスも止める。cd の先も、ワイルドカードも', { skip: windowsOnly }, t => {
  const f = fixture(t);
  for (const command of [
    "Get-Content '//server/share/a.txt'", "Get-ChildItem '\\\\server\\share'", "Set-Location '//server/share'", "Set-Location '\\\\?\\C:\\'", "Get-Content '//?/C:/Windows/win.ini'", "Get-Content '\\\\.\\PhysicalDrive0'", "Get-Content '//localhost/C$/Windows/win.ini'",
    "Get-ChildItem '//localhost/C$/Users/*'", "Set-Content '//?/C:/Users/*/x' x", "Copy-Item notes.md '//server/share/'", "Get-Content //server/share/a.txt", "Set-Content \\\\server\\share\\a.txt x",
  ]) {
    const v = f.ps(command);
    assert.equal(v.decision, 'deny', `${command}: ${v.decision} ${v.reasons.join(' / ')}`);
  }
  assert.match(f.ps("Get-Content '//server/share/a.txt'").reasons.join('\n'), /ネットワークのパス/u);
  assert.match(f.ps("Get-Content '//?/C:/Windows/win.ini'").reasons.join('\n'), /\\\\\?\\/u);
});

test('UNC・デバイスのパス: ふつうのパス（スラッシュ・ドライブ・相対）は、これまでどおり', { skip: windowsOnly }, t => {
  const f = fixture(t);
  const slash = (p: string): string => p.replaceAll('\\', '/');
  for (const command of ['Get-Content notes.md', 'Set-Content notes.md x', `Get-Content '${slash(join(f.ws, 'notes.md'))}'`, `Set-Content '${join(f.ws, 'notes.md')}' x`, 'Set-Content ./notes.md x', 'Set-Content .\\notes.md x', 'Get-Content sub/../notes.md']) {
    assert.equal(f.ps(command).decision, 'allow', command);
  }
  assert.equal(f.ps(`Get-Content '${slash(join(f.base, 'config.json'))}'`).decision, 'deny', '禁止のパスは、ふつうの書き方でも止める');
  assert.equal(f.ps("Get-Content 'C:/Windows/win.ini'").decision, 'ask', '許可フォルダの外のふつうのパスは、これまでどおりふつうの確かめ');
});

test('isRemotePath・expandPath・placePath: / を \\ として読み、UNC・デバイスのパスは、調べる前に止める。ネットワークには触れない', { skip: windowsOnly }, t => {
  const f = fixture(t);
  for (const p of ['//server/share/a', '\\\\server\\share', '//?/C:/x', '\\\\?\\C:\\x', '//./C:/x', '\\\\.\\C:\\x', '\\??\\C:\\x', '/??/C:/x', '\\/server/share']) assert.equal(isRemotePath(p), true, p);
  for (const p of ['C:/x', 'C:\\x', 'x/y', '/x', '\\x', 'a//b', './//a', '??']) assert.equal(isRemotePath(p), false, p);
  for (const p of ['//localhost/C$/x/USER.md', '//?/C:/x/USER.md', '\\??\\C:\\x\\USER.md', '//server/share/a']) {
    const e = expandPath(p, f.ws);
    assert.ok('path' in e, p);
    assert.equal(isRemotePath((e as { path: string }).path), true, `${p}: 展開のあとも、ネットワーク・デバイスのパスのまま（cwd に化けない）`);
    assert.equal(placePath((e as { path: string }).path, f.policy).kind, 'deny', p);
  }
  // 変数の展開のあとでネットワーク・デバイスのパスになるものも同じ（? をワイルドカードに読んで、別の場所に化けない）
  assert.deepEqual(expandPath('$env:TEMP/x', f.ws, { TEMP: '\\\\server\\share\\tmp' }), { path: '\\\\server\\share\\tmp\\x' });
  assert.deepEqual(expandPath('$env:TEMP/USER.md', f.ws, { TEMP: '\\\\?\\C:\\x' }), { path: '\\\\?\\C:\\x\\USER.md' });
  // 展開の前でも決める（バッククォートや $( ) で「分からない」にならない）
  assert.deepEqual(expandPath('//server/sh`are/a', f.ws), { path: '\\\\server\\sh`are\\a' });
  // 調べる道具も、ネットワークには触れない（SMB の応答待ちで止まらない）。この PC の管理共有が開いていれば、触れていないことを確かめる
  assert.equal(isDirectory('//server/share/a'), false);
  assert.deepEqual(expandGlob('//server/share/*', true), { prefix: '//server/share/*', matches: [], complete: false });
  assert.deepEqual(listTree('//server/share', true), { entries: [], complete: false });
  const share = `//localhost/${f.ws.slice(0, 1)}$${f.ws.replaceAll('\\', '/').slice(2)}`;
  let reachable = false;
  try { reachable = statSync(share).isDirectory(); } catch { reachable = false; }
  if (reachable) {
    assert.equal(isDirectory(share), false, '管理共有に触れた');
    assert.deepEqual(listTree(share, true), { entries: [], complete: false }, '管理共有の中身を読んだ');
    assert.deepEqual(expandGlob(`${share}/*`, true).matches, [], '管理共有をワイルドカードで読んだ');
    assert.equal(containsGitDir(share), true, '管理共有の下を調べずに、git のフォルダがあるとみなす');
  }
});
