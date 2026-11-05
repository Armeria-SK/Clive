import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { isToolConfigPath, wgetConfigFile } from '../src/tools/hooks/tool-config.ts';
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
  if (process.platform === 'win32') {
    assert.equal(isToolConfigPath('C:\\Program Files\\Git\\etc\\gitconfig', f.env), true);
    assert.equal(isToolConfigPath('C:\\ProgramData\\Git\\config', f.env), true);
    assert.equal(isToolConfigPath('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\profile.ps1', f.env), true);
  }
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

// ── curl・wget の設定ファイルを「読む」側（書く側は上）──
// curl の .curlrc・wget の .wgetrc は、読み込まれるたびに保存先・送り先・ヘッダを変えられる。許可された curl・wget が、書き込みを見張られていない場所へ書く。
// 見つかる場所は、本物の curl 8.19（Windows の System32 と Git for Windows）と GNU Wget 1.21.2（WSL）で確かめた

const curlAvailable = spawnSync('curl', ['--version']).status === 0;

function curlFixture(t: { after: (fn: () => void) => void }) {
  const f = fixture(t);
  const curlHome = join(f.base, 'curl-home');
  const env = { ...f.env, CURL_HOME: curlHome };
  mkdirSync(curlHome, { recursive: true });
  mkdirSync(join(f.home, 'AppData', 'Roaming'), { recursive: true });
  const run = (command: string, shell: 'bash' | 'powershell' = 'bash') => checkShellCommand(command, f.ws, { policy: { roots: [{ path: f.home, mode: 'write' }], deny: [] }, outsideRoots: 'ask', shell, windows: shell === 'powershell', env });
  return { ...f, env, curlHome, run };
}

test('curl の設定ファイルが見つかる場所のどれかにあれば、curl は今回だけ。-q を最初に付けるか、ファイルが無ければ、これまでどおり', t => {
  const f = curlFixture(t);
  const places = [
    join(f.curlHome, '.curlrc'), join(f.curlHome, '_curlrc'), join(f.home, '.curlrc'), join(f.home, '_curlrc'), join(f.env.APPDATA, '.curlrc'), join(f.env.APPDATA, '_curlrc'),
    join(f.home, 'Application Data', '.curlrc'), join(f.env.XDG_CONFIG_HOME, 'curlrc'), join(f.ws, '.curlrc'), join(f.ws, '_curlrc'),
  ];
  assert.equal(f.run('curl https://example.com/').decision, 'allow', '設定ファイルが無ければ許す');
  for (const place of places) {
    mkdirSync(join(place, '..'), { recursive: true });
    writeFileSync(place, 'output = "SOUL.md"\n');
    const v = f.run('curl -sS https://example.com/');
    assert.equal(v.onceOnly, true, `${place}: ${v.decision} ${v.reasons.join(' / ')}`);
    assert.match(v.reasons.join(), /curl の設定ファイル/u, place);
    assert.equal(f.run('curl -q -sS https://example.com/').decision, 'allow', `${place} -q`);
    assert.equal(f.run('curl.exe -sS https://example.com/', 'powershell').onceOnly, true, `${place} PowerShell`);
    rmSync(place);
    assert.equal(f.run('curl -sS https://example.com/').decision, 'allow', `${place} 消したあと`);
  }
  // 空の行・コメントだけの設定ファイルは、読まれても何も変わらないので、確かめない
  writeFileSync(join(f.home, '.curlrc'), '# 何もない\n\n   # コメント\r\n');
  assert.equal(f.run('curl https://example.com/').decision, 'allow');
  writeFileSync(join(f.home, '.curlrc'), '# コメント\noutput = "SOUL.md"\n');
  assert.equal(f.run('curl https://example.com/').onceOnly, true);
});

test('wget の設定ファイルが見つかる場所のどれかにあれば、wget は今回だけ。--no-config を最初に付けるか、ファイルが無ければ、これまでどおり', t => {
  const f = curlFixture(t);
  const wgetrc = join(f.base, 'my-wgetrc');
  const places: Array<[string, Record<string, string>]> = [[join(f.home, '.wgetrc'), {}], [wgetrc, { WGETRC: wgetrc }]];
  const wget = 'wget --max-redirect=0 https://example.com/';
  for (const [place, extra] of places) {
    const run = (command: string) => checkShellCommand(command, f.ws, { policy: { roots: [{ path: f.home, mode: 'write' }], deny: [] }, outsideRoots: 'ask', shell: 'bash', windows: false, env: { ...f.env, ...extra } });
    assert.equal(run(wget).decision, 'allow', `${place} 設定ファイルが無ければ許す`);
    writeFileSync(place, 'output_document = SOUL.md\n');
    const v = run(wget);
    assert.equal(v.onceOnly, true, `${place}: ${v.decision} ${v.reasons.join(' / ')}`);
    assert.match(v.reasons.join(), /wget の設定ファイル/u, place);
    assert.equal(run('wget --no-config --max-redirect=0 https://example.com/').decision, 'allow', `${place} --no-config`);
    rmSync(place);
  }
});

test('curl・wget の設定ファイルの書き込み先: CURL_HOME・WGETRC・Application Data の下も、ツールの設定ファイル', t => {
  const f = curlFixture(t);
  assert.equal(isToolConfigPath(join(f.curlHome, '.curlrc'), f.env), true);
  assert.equal(isToolConfigPath(join(f.curlHome, '_curlrc'), f.env), true);
  assert.equal(isToolConfigPath(join(f.home, 'Application Data', '.curlrc'), f.env), true);
  assert.equal(isToolConfigPath(join(f.base, 'my-wgetrc'), { ...f.env, WGETRC: join(f.base, 'my-wgetrc') }), true);
  assert.equal(isToolConfigPath(join(f.base, 'my-wgetrc'), f.env), false);
  assert.equal(isToolConfigPath(join(f.curlHome, 'notes.md'), f.env), false);
});

// 本物の curl で、見つかる場所を確かめる（候補の一覧が、本物の読み方と合っているか）。-q を最初に付けると読まれないことも。
// 場所は 1 つずつ、ほかの場所を空にした環境で確かめる（CURL_HOME が空のフォルダでも設定されていると、ほかの場所の _curlrc は読まれないなど、組み合わせで変わるため）
test('本物の curl: 一覧の場所の設定ファイルは本当に読まれ、-q を最初に付けると読まれない', { skip: !curlAvailable && 'curl が無い' }, t => {
  const f = curlFixture(t);
  const target = join(f.base, 'target.txt');
  writeFileSync(target, 'body\n');
  const url = pathToFileURL(target).href;
  const windows = process.platform === 'win32';
  // newer: 新しい curl（8.19 は読む。7.81 は読まない）だけが読む場所。古い curl では本物が読まないので、Clive 側の確かめだけを見る
  const places: Array<{ v: string; rel: string; windowsOnly?: true; newer?: true }> = [
    { v: 'CURL_HOME', rel: '.curlrc' }, { v: 'HOME', rel: '.curlrc' }, { v: 'HOME', rel: '.config/curlrc', newer: true }, { v: 'XDG_CONFIG_HOME', rel: 'curlrc', newer: true },
    { v: 'CURL_HOME', rel: '_curlrc', windowsOnly: true }, { v: 'HOME', rel: '_curlrc', windowsOnly: true }, { v: 'USERPROFILE', rel: '.curlrc', windowsOnly: true }, { v: 'USERPROFILE', rel: '_curlrc', windowsOnly: true },
    { v: 'USERPROFILE', rel: 'Application Data/.curlrc', windowsOnly: true }, { v: 'APPDATA', rel: '.curlrc', windowsOnly: true }, { v: 'APPDATA', rel: '_curlrc', windowsOnly: true },
  ];
  const empty = join(f.base, 'empty');
  mkdirSync(empty);
  const policy: ScopePolicy = { roots: [{ path: f.home, mode: 'write' }], deny: [] };
  let n = 0;
  for (const place of places.filter(p => windows || !p.windowsOnly)) {
    const dir = join(f.base, `place-${n++}`);
    const file = join(dir, ...place.rel.split('/'));
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, 'write-out = "CONFIGREAD"\n');
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', HOME: empty, USERPROFILE: empty, APPDATA: empty, [place.v]: dir };
    const label = `${place.v}/${place.rel}`;
    if (!place.newer) assert.match(spawnSync('curl', ['-s', url], { cwd: empty, env, encoding: 'utf8' }).stdout, /CONFIGREAD/u, `本物の curl が読まない場所: ${label}`);
    assert.doesNotMatch(spawnSync('curl', ['-q', '-s', url], { cwd: empty, env, encoding: 'utf8' }).stdout, /CONFIGREAD/u, `-q でも読まれた: ${label}`);
    assert.equal(checkShellCommand('curl -sS https://example.com/', f.ws, { policy, outsideRoots: 'ask', shell: 'bash', windows: false, env }).onceOnly, true, `Clive の一覧に無い場所: ${label}`);
    assert.equal(checkShellCommand('curl -q -sS https://example.com/', f.ws, { policy, outsideRoots: 'ask', shell: 'bash', windows: false, env }).decision, 'allow', `-q でも確かめになる: ${label}`);
  }
});

// 読めない設定ファイルは、中が空かを確かめられないので、設定ありとして確かめる
test('読めない設定ファイルがあれば、curl は今回だけ', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'chmod 000 で読めなくできない環境' }, t => {
  const f = curlFixture(t);
  const rc = join(f.home, '.curlrc');
  writeFileSync(rc, '# コメントだけ\n');
  chmodSync(rc, 0);
  try { assert.equal(f.run('curl -sS https://example.com/').onceOnly, true); } finally { chmodSync(rc, 0o644); }
});

// 本物の wget は、読む設定ファイルを --version に載せる（(user) は ~/.wgetrc、(env) は WGETRC）。Clive の一覧と合っているか
const wgetAvailable = spawnSync('wget', ['--version']).status === 0;
test('本物の wget: ~/.wgetrc と WGETRC は、本当に読まれる場所として載る', { skip: !wgetAvailable && 'wget が無い' }, t => {
  const f = curlFixture(t);
  const version = (extra: Record<string, string>) => spawnSync('wget', ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: f.home, ...extra } }).stdout;
  const user = join(f.home, '.wgetrc');
  writeFileSync(user, 'header = X-Probe: 1\n');
  assert.equal(version({}).includes(`${user} (user)`), true, 'wget --version に (user) の .wgetrc が載らない');
  assert.equal(wgetConfigFile({ HOME: f.home }), user);
  const env = join(f.base, 'my-wgetrc');
  writeFileSync(env, 'header = X-Probe: 1\n');
  assert.equal(version({ WGETRC: env }).includes(`${env} (env)`), true, 'wget --version に (env) の WGETRC が載らない');
  assert.equal(wgetConfigFile({ HOME: f.home, WGETRC: env }), env);
});
