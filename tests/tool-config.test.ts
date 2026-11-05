import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isToolConfigPath } from '../src/tools/hooks/tool-config.ts';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

// 審査で見つかった: git・curl・wget・npm・シェルの起動ファイルなどの設定は、あとで動く許可済みのコマンド（git status・curl）にコードを読み込ませられる。
// 許可フォルダの外への書き込みは「ふつうの確かめ」で、会話の許可で通ってしまっていた。ホームを許可フォルダにした設定では、確かめにもならない

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const home = realish(join(base, 'home'));
  const ws = realish(join(home, 'workspace'));
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(home, '.config', 'git'), { recursive: true });
  const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: join(home, '.config') };
  // ホーム全体を許可フォルダにしている設定（作業フォルダはその中）
  const policy: ScopePolicy = { roots: [{ path: home, mode: 'write' }], deny: [], askOnWrite: [join(ws, 'SOUL.md')] };
  const run = (command: string, shell: 'bash' | 'powershell') => checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell', env });
  return { base, home, ws, env, bash: (c: string) => run(c, 'bash'), ps: (c: string) => run(c, 'powershell') };
}

test('ツールの設定ファイル: git・curl・wget・npm・シェルの起動ファイル・PowerShell のプロファイルの場所を、名前で見分ける', t => {
  const f = fixture(t);
  const yes = [
    '.gitconfig', '.gitattributes', '.config/git/config', '.config/git/attributes', '.config/git/ignore', '.curlrc', '_curlrc', '.config/curlrc', '.wgetrc', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmrc',
    '.bashrc', '.bash_profile', '.profile', '.zshrc', '.zshenv', '.zprofile', '.inputrc', '.config/powershell/Microsoft.PowerShell_profile.ps1', 'Documents/WindowsPowerShell/profile.ps1',
    'Documents/WindowsPowerShell/Modules/x/x.psm1', 'Documents/PowerShell/Microsoft.PowerShell_profile.ps1', 'OneDrive/Documents/WindowsPowerShell/profile.ps1', '.config/pip/pip.conf', '.pip/pip.conf',
    '.cargo/config.toml', '.docker/config.json', 'AppData/Roaming/_curlrc', 'AppData/Roaming/.curlrc', 'AppData/Roaming/npm/etc/npmrc', 'AppData/Roaming/pip/pip.ini', '.jq',
  ];
  assert.deepEqual(yes.filter(rel => !isToolConfigPath(join(f.home, ...rel.split('/')), f.env)), []);
  const no = ['workspace/.gitconfig.md', 'workspace/notes.md', '.gitignore_global_notes', 'Documents/readme.md', 'workspace/.npmrc.example', 'workspace/src/profile.ps1', 'bashrc', 'AppData/Roaming/Code/settings.json'];
  assert.deepEqual(no.filter(rel => isToolConfigPath(join(f.home, ...rel.split('/')), f.env)), []);
  assert.equal(isToolConfigPath('/etc/gitconfig', f.env), true);
  assert.equal(isToolConfigPath('/etc/wgetrc', f.env), true);
  assert.equal(isToolConfigPath('C:\\Program Files\\Git\\etc\\gitconfig', f.env), true);
  assert.equal(isToolConfigPath('C:\\ProgramData\\Git\\config', f.env), true);
  assert.equal(isToolConfigPath('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\profile.ps1', f.env), true);
  assert.equal(isToolConfigPath(join(f.home, '.GITCONFIG'), f.env), process.platform === 'win32', '大文字小文字は Windows だけ区別しない');
});

test('ツールの設定ファイルへの書き込み・消すこと・名前の変更は、許可フォルダの中でも外でも、シェルからは今回だけ', t => {
  const f = fixture(t);
  const bash = [
    `echo x > ${f.home.replaceAll('\\', '/')}/.gitconfig`, `echo x >> ${f.home.replaceAll('\\', '/')}/.curlrc`, `cp a.txt ${f.home.replaceAll('\\', '/')}/.wgetrc`, `mv a ${f.home.replaceAll('\\', '/')}/.config/git/config`,
    `rm ${f.home.replaceAll('\\', '/')}/.zprofile`, `tee ${f.home.replaceAll('\\', '/')}/.bashrc`, `mkdir -p ${f.home.replaceAll('\\', '/')}/.config/git/hooks`, `touch ${f.home.replaceAll('\\', '/')}/.zshrc`,
  ];
  const ps = [
    `Set-Content '${join(f.home, '.gitconfig')}' x`, `Add-Content '${join(f.home, '_curlrc')}' x`, `Set-Content '${join(f.home, 'Documents', 'WindowsPowerShell', 'profile.ps1')}' x`, `Copy-Item a.txt '${join(f.home, '.profile')}'`,
    `Remove-Item '${join(f.home, '.wgetrc')}'`, `New-Item -Path '${join(f.home, '.config', 'git')}' -Name config -Force`, `Out-File '${join(f.home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')}'`,
    `Set-Content '${join(f.home, 'AppData', 'Roaming', '_curlrc')}' x`,
  ];
  for (const command of bash) { const v = f.bash(command); assert.equal(v.onceOnly, true, `${command}: ${v.decision} ${v.reasons.join(' / ')}`); assert.match(v.reasons.join(), /ツールの設定ファイル/u, command); }
  for (const command of ps) { const v = f.ps(command); assert.equal(v.onceOnly, true, `${command}: ${v.decision} ${v.reasons.join(' / ')}`); assert.match(v.reasons.join(), /ツールの設定ファイル/u, command); }
  // 読むのは、これまでどおり
  assert.equal(f.bash(`cat ${f.home.replaceAll('\\', '/')}/.gitconfig`).decision, 'allow');
  assert.equal(f.ps(`Get-Content '${join(f.home, '.gitconfig')}'`).decision, 'allow');
  // ふつうのファイルは、これまでどおり
  assert.equal(f.bash('echo x > notes.md').decision, 'allow');
});

test('ツールの設定ファイルは、ワイルドカード・組み立てた先・フォルダごとの書き込みでも見落とさない', t => {
  const f = fixture(t);
  const h = f.home.replaceAll('\\', '/');
  writeFileSync(join(f.home, '.gitconfig'), '[user]\n');
  for (const command of [`rm -- ${h}/.git*`, `cp -r tmp/. ${h}`, `cp a.txt ${h}/.config/git/`, `rm -rf -- ${h}/.config/git`, `mv x ${h}/.curlrc`, `echo x > ${h}/.config/git/config`]) {
    mkdirSync(join(f.ws, 'tmp'), { recursive: true });
    const v = f.bash(command);
    assert.equal(v.onceOnly, true, `${command}: ${v.decision} ${v.reasons.join(' / ')}`);
  }
});

test('XDG_CONFIG_HOME が無くても、ホームの .config/git を見つける。フォルダごと消す・書くときは、中にある設定まで届くかを見る', t => {
  const f = fixture(t);
  assert.equal(isToolConfigPath(join(f.home, '.config', 'git', 'config'), { HOME: f.home }), true);
  assert.equal(isToolConfigPath(join(f.home, '.config', 'git', 'hooks', 'x'), { HOME: f.home }), true);
  assert.equal(isToolConfigPath(join(f.home, '.config', 'other', 'x'), { HOME: f.home }), false);
  // 人格などの守る場所を含まない設定で、フォルダごとの消去・コピーが設定に届くことだけを見る
  const policy: ScopePolicy = { roots: [{ path: f.home, mode: 'write' }], deny: [] };
  const h = f.home.replaceAll('\\', '/');
  const run = (command: string) => checkShellCommand(command, f.ws, { policy, outsideRoots: 'ask', shell: 'bash', windows: false, env: f.env });
  for (const command of [`rm -rf -- ${h}/.config`, `rm -rf -- ${h}/Documents`, `cp -r tmp/. ${h}`, `mv ${h}/Documents ${h}/elsewhere`]) {
    mkdirSync(join(f.home, 'Documents', 'WindowsPowerShell'), { recursive: true });
    mkdirSync(join(f.ws, 'tmp'), { recursive: true });
    const v = run(command);
    assert.equal(v.onceOnly, true, `${command}: ${v.decision} ${v.reasons.join(' / ')}`);
  }
  assert.equal(run(`rm -rf -- ${h}/workspace/build`).decision, 'allow', 'ふつうのフォルダの消去は、これまでどおり');
});
