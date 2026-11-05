import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyStatements, noRepo, type Level, type MatchCtx, type RepoInfo } from '../src/tools/hooks/allowlist.ts';
import { sedScriptOk } from '../src/tools/hooks/allowlist-tools.ts';
import type { ShellKind } from '../src/tools/hooks/shell-lex.ts';

const isPs = (shell: ShellKind): boolean => shell === 'powershell' || shell === 'pwsh';
const ctxFor = (shell: ShellKind, over: Partial<MatchCtx> = {}): MatchCtx => ({ shell, windows: isPs(shell), repo: noRepo, selfHosts: [], ...over });
const classify = (command: string, shell: ShellKind = 'bash', over: Partial<MatchCtx> = {}) => classifyStatements(command, ctxFor(shell, over));
const levelOf = (command: string, shell: ShellKind = 'bash', over: Partial<MatchCtx> = {}): Level => classify(command, shell, over).level;
const keysOf = (command: string, shell: ShellKind = 'bash', over: Partial<MatchCtx> = {}): string[] =>
  classify(command, shell, over).results.flatMap(r => r.reasons.map(x => `${x.level}:${x.key}`));
const repo = (over: Partial<RepoInfo> = {}) => (): RepoInfo => ({ ...noRepo(), found: true, ...over });

function expectLevels(shell: ShellKind, rows: ReadonlyArray<readonly [string, Level | 'once-or-deny']>, over: Partial<MatchCtx> = {}): void {
  const wrong = rows.flatMap(([command, want]) => {
    const got = levelOf(command, shell, over);
    return (want === 'once-or-deny' ? got === 'once' || got === 'deny' : got === want) ? [] : [`${command}  → ${got} (want ${want})`];
  });
  assert.deepEqual(wrong, []);
}

// 毎日のコマンド（security-self-api.md 11.8 の「許す」の行）。ふつうの確かめ・今回だけの行は別の表
const BASH_ALLOW = [
  'ls -la', 'ls', 'cat README.md', 'head -n 50 x', 'tail -n 20 log', 'tail -5 log', 'grep -rn "TODO" src', 'rg -n foo', 'rg -n foo src', 'find . -name "*.md" -type f', 'wc -l *.md',
  'sort data.txt | uniq -c', "jq '.items[]' a.json", 'for f in *.md; do wc -l "$f"; done', 'git status', 'git log --oneline -20', 'git diff', 'git show HEAD~1 --stat', 'git branch -a',
  'mkdir -p out', 'touch a.txt', 'cp a.txt b.txt', 'mv a b', 'rm old.txt', 'rm -rf build', 'echo "x" > notes.txt', "sed -n '1,20p' f", "sed -i 's/a/b/g' f", 'tar -czf out.tgz dir', 'unzip -l a.zip',
  'node --version', 'node -v', 'python -V', 'python3 --version', 'npm ls', 'npm --version', 'npm view left-pad version --json', 'pip list', 'pip freeze', 'curl -sS https://example.com',
  'curl -o page.html https://example.com/x', 'cd sub && ls', 'LC_ALL=C sort f', 'x=1', 'export LANG=C', 'echo $HOME', 'git log --since="2 weeks ago" --author=me', 'tsc --noEmit -p .', 'date +%Y-%m-%d',
  'ls "$dir"', 'cat -- "$f"', 'diff a b', 'stat -c %s f', 'du -sh .', 'which node', 'basename "$f"', 'md5sum f', 'test -f x && echo yes', '[ -d src ]', 'seq 1 5', 'sleep 2', 'true', 'printenv HOME',
] as const;
const PS_ALLOW = [
  'Get-ChildItem -Recurse -Filter *.md', 'dir', 'ls', 'Get-ChildItem -Path src -Recurse -File', 'Get-Content x -TotalCount 20', 'Get-Content -Path a.txt -Raw', 'Select-String -Path *.ts -Pattern foo',
  'Get-ChildItem *.log | ForEach-Object { $_.Name }', 'Get-ChildItem | Where-Object { $_.Length -gt 1MB }', '$files = Get-ChildItem -Recurse; $files.Count',
  'Invoke-WebRequest -Uri https://example.com -UseBasicParsing -MaximumRedirection 0', 'git status', 'git log --oneline', 'rg -n foo', 'node --version',
  'Write-Output hi', 'Set-Location sub', 'cat a.txt', 'Get-Process', 'Start-Sleep 5', 'Get-ChildItem | Sort-Object Length -Descending | Select-Object -First 5',
  'Get-Date -Format yyyy-MM-dd', 'Get-ChildItem | Select-Object Name, Length', 'Test-Path src', 'Measure-Object -Line', 'Get-Content a.txt | Measure-Object -Line', 'Get-ChildItem | Format-Table Name, Length',
  'Select-String -Pattern foo -Path a.txt', 'curl.exe -sS https://example.com', 'tar.exe -tf a.tar', '& git status', 'Get-Location', 'Join-Path a b', 'Resolve-Path .', 'Get-FileHash a.txt -Algorithm SHA256',
  "Get-ChildItem | Where-Object { $_.Name -like '*.md' } | ForEach-Object { $_.FullName }", '$x = 5', 'Write-Host hello -ForegroundColor Green', 'Get-Content env:PATH',
  'if ($true) { Get-Date }', 'foreach ($f in Get-ChildItem) { $f.Name }', 'Get-Command git',
] as const;

test('毎日のコマンドは、確かめなしに動く（bash）', () => {
  expectLevels('bash', BASH_ALLOW.map(c => [c, 'allow'] as const));
});

test('毎日のコマンドは、確かめなしに動く（PowerShell 5.1・7）', () => {
  expectLevels('powershell', PS_ALLOW.map(c => [c, 'allow'] as const));
  expectLevels('pwsh', PS_ALLOW.filter(c => !c.startsWith('curl.exe')).map(c => [c, 'allow'] as const));
});

// PowerShell でファイルを書く・作る・移す・消すコマンドレットは、パスが決まっていても毎回確かめる（§11.13。確かめなしで書くには file_write の道具）
const PS_WRITE_ONCE = ['Set-Content -Path a.txt -Value "x"', 'New-Item -ItemType Directory out', 'Remove-Item -Recurse -Force build', 'Copy-Item a b', 'mkdir out', "'x' > a.txt", 'Get-Content a | Out-File b'] as const;
test('PowerShell の書くコマンドレット・リダイレクトは、パスが決まっていても今回だけ（5.1・7）', () => {
  expectLevels('powershell', PS_WRITE_ONCE.map(c => [c, 'once'] as const));
  expectLevels('pwsh', PS_WRITE_ONCE.map(c => [c, 'once'] as const));
});

// 1 回目・2 回目の審査で再現された抜け（コマンドの文字だけで決まるもの）。どれも確かめなしには動かない
const BYPASS_BASH = [
  'node --eval=1', 'node -e 1', 'node --print=1', 'node -p 1', 'python -cprint(1)', 'python -c "print(1)"', 'perl -eprint', 'perl -e 1', 'ruby -e1', 'node -r ./p.js -v', 'node --require=./p.js', 'node --import=./p.mjs',
  'python3 -mhttp.server', 'python3 -m http.server', 'node script.js', 'python script.py', 'tar -I ./p.sh -cf a.tar x', 'tar --use-compress-program=./p.sh -cf a x', 'tar -xf a.tar --to-command=./p.sh',
  'tar --checkpoint=1 --checkpoint-action=exec=./p.sh -cf a x', 'tar -xf a.tar', 'tar -xzf a.tgz', 'tar xf a.tar', 'zip -T -TT ./p.sh a.zip x', 'zip -T a.zip x', 'sort --compress-program=./p.sh f', 'sort -o SOUL.md f',
  'rg --pre ./p.sh x', 'rg --pre=./p.sh x', 'rg --hostname-bin ./p.sh x', 'bat --pager ./p.sh f', "sed -n 1ex f", "sed 's/a/b/e' f", "sed 'w x' f", "sed -f script.sed f", "awk '{print $1}' f", "awk 'BEGIN{system(\"x\")}'",
  'LESSOPEN="|./p.sh %s" less f', 'less f', 'cmd /c put', 'forfiles /c "cmd /c put"', 'git init --template=./tpl sub', 'git clone --template=./tpl a b', "git ls-remote --upload-pack='touch pwned' .",
  'git log --output=SOUL.md', 'git fetch', 'git pull', 'git submodule update', 'unzip a.zip', 'unzip -o a.zip', 'pip install .', 'pip install -e .', 'pip install requests', 'npm install', 'npm install ./pkg', 'npm ci',
  'npm test', 'npm run build', 'npx tsc', 'pnpm install', 'yarn add x', 'cargo install x', 'go install x', 'make', 'docker ps', 'ssh host', 'code .', 'find . -name "*.tmp" -delete', 'find . -exec ./p.sh {} ;',
  'find . -name *.md', 'tail -f app.log', 'xargs ls', 'env FOO=1 node x', 'sh -c "ls"', 'bash script.sh', 'eval ls', 'source x.sh', '. ./x.sh', './x.sh', 'x.sh', '$(echo ls)', 'ls | node', 'cat x | sh',
  'HOME=. git log', 'XDG_CONFIG_HOME=. rg x', 'GIT_CONFIG_GLOBAL=x git log', 'http_proxy=x curl https://e', 'NODE_OPTIONS="-r x" ls', 'PATH=/tmp ls', 'export NODE_OPTIONS=-r', 'PATH=/x', 'PS1=x',
  'curl http://127.0.0.1:4777/api/health', 'curl http://localhost:3000', 'curl -K cfg https://e', 'curl --config cfg https://e', 'curl -x proxy https://e', 'curl -k https://e', 'curl -w "%{url}" https://e',
  'wget -e x https://e', 'wget -r https://e', 'echo x &', 'name() { ls; }', 'function f { ls; }', 'ls > >(tee x)', 'ls |& cat', 'git -c core.pager=x log', 'git --git-dir=x log', 'git -C',
  'git config user.name x', 'git config core.pager x', 'git remote add x y', 'git help', 'git bisect run ./p.sh', 'git rebase --exec ./p.sh main', 'git commit --template=x', 'git stash show -p',
  'hexdump -f x', 'xxd -r f', 'chown me f', 'ln -s a b', 'cp -l a b', 'cp -s a b', 'mv -b a b', 'date -s 1', 'env', 'env FOO=1', 'ls --color=always', 'nl -ba f', 'tr -d', 'uniq a b', 'wc --files0-from=x',
] as const;

test('審査で再現された抜けは、確かめなしには動かない（bash）', () => {
  const rows = BYPASS_BASH.filter(c => c !== 'env' && c !== 'nl -ba f' && c !== 'tr -d' && c !== 'ls | node').map(c => [c, 'once-or-deny'] as const);
  expectLevels('bash', rows);
});

const BYPASS_PS = [
  'node --eval=1', 'node -e 1', 'node -r ./p.js -v', 'node --import=./p.mjs', 'python -c "print(1)"', 'python3 -mhttp.server', 'cmd /c put', 'forfiles /c "cmd /c put"', 'Expand-Archive a.zip out', 'tar -xf a.tar', 'tar.exe -xf a.tar',
  'Get-ChildItem *.md | Remove-Item', 'Get-ChildItem tmp | Copy-Item -Destination .', 'Get-ChildItem | Move-Item', 'Get-ChildItem | Rename-Item', 'git ls-remote --upload-pack=x .', 'git init --template=x sub',
  '[Math]::Round(1.5)', '[IO.File]::ReadAllText("x")', 'New-Object System.Net.WebClient', 'Add-Type -TypeDefinition x', 'Invoke-Expression "ls"', 'iex "ls"', '& $x', '& "C:\\x.exe"', '. ./x.ps1',
  '& { ls }', '$env:NODE_OPTIONS=\'-r x\'', "$PSDefaultParameterValues['Out-File:FilePath']='SOUL.md'", '$ErrorActionPreference = "Stop"', '$PWD = 1', '$profile = 1', 'function f { ls }', 'filter f { $_ }',
  'try { ls } catch { }', 'switch (1) { 1 { ls } }', 'while ($true) { ls }', 'do { ls } while ($true)', 'Start-Process notepad', 'Invoke-Command -ScriptBlock { ls }', 'Get-ChildItem @p', 'ls @args', 'sc x', 'Set-Content -Path a.txt -Value x -Stream s',
  'Get-Content a.txt -Wait', 'Get-Content -Path a.txt -Stream s', 'Get-ChildItem -Path function:', 'Get-Content function:foo', 'Get-Item HKLM:\\Software', 'Set-Location function:', 'New-Item -ItemType SymbolicLink -Path a -Value b',
  'New-Item -ItemType Junction -Path a -Value b', 'ForEach-Object Delete', 'Get-ChildItem | ForEach-Object -Parallel { $_ }', 'Get-Content a | ForEach-Object { $_.Delete() }', 'Get-ChildItem -Attributes Hidden', 'Select-String -Path a -Pattern b -Wait',
  'Invoke-WebRequest -Uri http://127.0.0.1:4777/api/health', 'Invoke-WebRequest -Uri https://e -Headers @{a=1}', 'iwr https://e -Proxy http://p', 'Get-Process | Stop-Process',
  'Stop-Process -Name x', 'Rename-Item a -NewName b -Stream x', 'Remove-Item a -Stream x', 'Copy-Item a b -ToSession $s', 'Get-ChildItem | Out-GridView', 'Write-Output "$(ls)"', 'Write-Output "${env:PATH}"', 'Get-ChildItem -Pat src',
  'Get-ChildItem -Rec', 'git -c core.pager=x log', 'grep x y', 'awk 1 f', 'sed -i x f', 'ls > $null; & $x', 'echo hi > SOUL.md; iex $x',
] as const;

test('審査で再現された抜けは、確かめなしには動かない（PowerShell）', () => {
  const skip = new Set(['ls > $null; & $x', 'echo hi > SOUL.md; iex $x']);
  expectLevels('powershell', BYPASS_PS.filter(c => !skip.has(c)).map(c => [c, 'once-or-deny'] as const));
  expectLevels('pwsh', BYPASS_PS.filter(c => !skip.has(c) && !c.startsWith('sc x')).map(c => [c, 'once-or-deny'] as const));
});

test('書き方を判定できないものは止める（deny）', () => {
  const bash = ['n\\ode --eval=1', '`ls`', "echo $'x'", 'echo ${x:-y}', 'ls >&3', 'exec 3<>/dev/tcp/h/80', 'cat /dev/tcp/h/80', 'echo ‘x’', 'echo “x”', 'ls –la', 'ls\u00a0-la', 'echo ＂x＂', 'ls "unclosed', 'echo ~root'];
  const ps = ["``n`o`de --eval=1", 'ls --% x', '<# c #> ls', 'echo @"\nx\n"@', 'echo ${function:x}', 'echo "$(ls)"', 'Get-ChildItem –Path x', 'ls && ls'];
  assert.deepEqual(bash.filter(c => levelOf(c, 'bash') !== 'deny'), []);
  assert.deepEqual(ps.filter(c => levelOf(c, 'powershell') !== 'deny'), []);
  assert.equal(levelOf('ls && ls', 'pwsh'), 'allow');
});

test('ふつうの確かめ（会話の許可で越えられる）になるもの', () => {
  const rows: Array<[string, ShellKind, string]> = [
    ['git add .', 'bash', 'ask:list.git_write'], ['git commit -m "x"', 'bash', 'ask:list.git_write'], ['git push', 'bash', 'ask:list.git_push'], ['git push origin main', 'bash', 'ask:list.git_push'],
    ['curl -X POST https://api.example.com -d @a.json', 'bash', 'ask:ask.curl'], ['curl --json "{}" https://e', 'bash', 'ask:ask.curl'], ['wget --max-redirect=0 --post-data=x https://e', 'bash', 'ask:ask.wget'],
    ['curl http://192.168.1.5/x', 'bash', 'ask:list.lan'], ['curl http://printer.local/x', 'bash', 'ask:list.lan'], ['Invoke-WebRequest -Uri https://e -Method Post -Body x -MaximumRedirection 0', 'powershell', 'ask:ask.powershell'],
    ['Invoke-RestMethod https://e -Method Put -MaximumRedirection 0', 'powershell', 'ask:ask.powershell'], ['git commit -m x', 'powershell', 'ask:list.git_write'],
  ];
  for (const [command, shell, key] of rows) assert.ok(keysOf(command, shell).includes(key), `${command}: ${keysOf(command, shell).join(',')}`);
  for (const [command, shell] of rows) assert.equal(levelOf(command, shell), 'ask', command);
});

test('一覧に無いものは、何が一覧に無いかを理由に言う（持ち主の許可で外せるのはこの種類だけ）', () => {
  const awk = classify("awk '{print $1}' f").results[0]!.reasons;
  assert.deepEqual(awk.map(r => [r.key, r.exempt]), [['list.command', true]]);
  const pre = classify('rg --pre ./x foo').results[0]!.reasons;
  assert.deepEqual(pre.map(r => [r.key, r.exempt, r.params.flag]), [['list.flag', true, '--pre']]);
  const node = classify('node script.js').results[0]!.reasons;
  assert.deepEqual(node.map(r => [r.key, r.exempt]), [['list.form', true]]);
  for (const [command, key] of [['npm install', 'list.install'], ['pip install -e .', 'list.install'], ['tar -xf a', 'list.expand'], ['HOME=. git log', 'list.env'], ['curl http://127.0.0.1/', 'code.loopback']] as const) {
    const r = classify(command).results.flatMap(x => x.reasons).find(x => x.key === key);
    assert.ok(r, command);
    assert.equal(r.exempt, false, `${command} は tools.shell.allow で外せない`);
  }
});

test('値の分からない引数（C5）: 読むだけのコマンドでは許し、ほかは「--」のあとだけ許す', () => {
  const rows: Array<[string, Level]> = [
    ['ls $dir', 'allow'], ['cat $f', 'allow'], ['grep foo $f', 'allow'], ['grep -r foo *.ts', 'allow'], ['wc -l $(ls)', 'allow'],
    ['sort $f', 'once'], ['sort *.txt', 'once'], ['rg foo $dir', 'once'], ['find $dir -name x', 'once'], ['git log $x', 'once'], ['cp $a $b', 'once'], ['rm $f', 'once'], ['mkdir $d', 'once'],
    ['sort -- $f', 'allow'], ['rg foo -- $dir', 'allow'], ['rm -- $f', 'allow'], ['rm -f -- *.o', 'allow'],
  ];
  const wrong = rows.flatMap(([c, want]) => (levelOf(c) === want ? [] : [`${c} → ${levelOf(c)} (want ${want})`]));
  assert.deepEqual(wrong, []);
  assert.equal(levelOf('Get-ChildItem $dir', 'powershell'), 'allow');
  assert.equal(levelOf('Remove-Item $f', 'powershell'), 'once');
});

test('flag の綴り: 長い名前の省略・まとめた短い flag・値の付け方（C3）', () => {
  assert.equal(levelOf('sort --compress-prog=./p.sh f'), 'once');
  assert.equal(levelOf('grep --incl=x foo .'), 'once');
  assert.equal(levelOf('rg --max-dep=2 foo'), 'once');
  assert.equal(levelOf('grep --include=x foo .'), 'allow');
  assert.equal(levelOf('grep -rn foo src'), 'allow');
  assert.equal(levelOf('grep -rnA3 foo src'), 'allow');
  assert.equal(levelOf('grep -rnx foo src'), 'allow');
  assert.equal(levelOf('grep -rnz foo src'), 'allow');
  assert.equal(levelOf('grep -rnf pats src'), 'allow');
  assert.equal(levelOf('grep -rnQ foo src'), 'once');
  assert.equal(levelOf('head -n5 f'), 'allow');
  assert.equal(levelOf('head -n x f'), 'once');
  assert.equal(levelOf('find . -type x'), 'once');
  assert.equal(levelOf('find . -type f -o -type d'), 'allow');
  assert.equal(levelOf('ls --color=never'), 'allow');
  assert.equal(levelOf('ls --color'), 'once');
  assert.equal(levelOf('Get-ChildItem -Rec'), 'once');
  assert.equal(levelOf('get-childitem -RECURSE', 'powershell'), 'allow');
  assert.equal(levelOf('Get-ChildItem -Path:src -Recurse:$true', 'powershell'), 'allow');
  assert.equal(levelOf('Get-Content a -TotalCount x', 'powershell'), 'once');
  assert.equal(levelOf('Get-ChildItem -ErrorAction SilentlyContinue', 'powershell'), 'allow');
  assert.equal(levelOf('Get-ChildItem -ErrorAction Inquire', 'powershell'), 'once');
  assert.equal(levelOf('Get-ChildItem -ea Stop', 'powershell'), 'allow');
  assert.equal(levelOf('Get-ChildItem -OutVariable PSItem', 'powershell'), 'once');
  assert.equal(levelOf('Get-ChildItem -OutVariable files', 'powershell'), 'allow');
});

test('sed のスクリプトの決まり', () => {
  const ok = ['p', '1,20p', '$p', '/x/p', '/x/,/y/d', 's/a/b/g', 's|a|b|', 's/a/b/gI', 's/a/b/2', 'y/abc/xyz/', '1d;$d', 'p;p', '1!d', 'q5', '/x/I{p}', '=', 'n;d', 's/a\\/b/c/'];
  const bad = ['e', '1e', '1ex', 's/a/b/e', 's/a/b/w x', 'w x', 'r x', 'R x', 'W x', 'a x', 'i x', 'c x', '{p}', 'f', 's/a/b', 'x;e', 'p;1ex', '/x/e', 's/a/b/ge', 'y/a/b', 's;a;b;e', '1~2p', '\\%x%p'];
  assert.deepEqual(ok.filter(s => !sedScriptOk(s)).filter(s => s !== '/x/I{p}'), []);
  assert.deepEqual(bad.filter(s => sedScriptOk(s)), []);
});

test('git のリポジトリの設定: ふつうでなければ git はすべて今回だけ、フックは書く操作だけを変える', () => {
  const odd = repo({ configOk: false, badKey: 'core.fsmonitor' });
  for (const c of ['git status', 'git log -p', 'git diff', 'git branch', 'git add .', 'git push', 'git -C fake log -p']) assert.equal(levelOf(c, 'bash', { repo: odd }), 'once', c);
  assert.ok(keysOf('git status', 'bash', { repo: odd }).includes('once:list.git_config'));
  assert.equal(levelOf('git status', 'bash', { repo: repo({ unreadable: true }) }), 'once');
  assert.ok(keysOf('git status', 'bash', { repo: repo({ unreadable: true }) }).includes('once:list.git_unreadable'));
  const hookPath = repo({ hooksPath: true });
  assert.equal(levelOf('git status', 'bash', { repo: hookPath }), 'allow');
  assert.equal(levelOf('git log --oneline', 'bash', { repo: hookPath }), 'allow');
  assert.equal(levelOf('git commit -m x', 'bash', { repo: hookPath }), 'once');
  assert.equal(levelOf('git push', 'bash', { repo: hookPath }), 'once');
  assert.ok(keysOf('git commit -m x', 'bash', { repo: hookPath }).includes('once:list.git_hooks_path'), 'core.hooksPath のフックは動かない、と札に書く');
  assert.equal(keysOf('git commit -m x', 'bash', { repo: hookPath }).includes('once:list.git_hooks'), false);
  const hookFiles = repo({ hooksFiles: true });
  assert.ok(keysOf('git commit -m x', 'bash', { repo: hookFiles }).includes('once:list.git_hooks'));
  assert.equal(levelOf('git -C sub commit -m x', 'bash', { repo: hookFiles }), 'once');
  assert.equal(levelOf('git add .', 'bash', { repo: hookFiles }), 'once');
  assert.equal(levelOf('git diff', 'bash', { repo: hookFiles }), 'allow');
  const asked: Array<string | undefined> = [];
  levelOf('git -C sub log', 'bash', { repo: dashC => { asked.push(dashC); return noRepo(); } });
  levelOf('git log', 'bash', { repo: dashC => { asked.push(dashC); return noRepo(); } });
  assert.deepEqual(asked, ['sub', undefined]);
});

test('curl・wget: 設定ファイルがあれば今回だけ（最初の -q・--no-config を除く）。無ければ、これまでどおり', () => {
  const has = { toolConfig: (tool: 'curl' | 'wget') => ({ file: `/h/.${tool}rc` }) };
  const rows: Array<[string, ShellKind, Level]> = [
    ['curl https://example.com/', 'bash', 'once'], ['curl -sS https://example.com/', 'bash', 'once'], ['curl -q https://example.com/', 'bash', 'allow'], ['curl -q -sS https://example.com/', 'bash', 'allow'],
    ['curl -sS -q https://example.com/', 'bash', 'once'], ['curl -qs https://example.com/', 'bash', 'once'], ['curl -L -q https://example.com/', 'bash', 'once'],
    ['wget --max-redirect=0 https://example.com/', 'bash', 'once'], ['wget --no-config --max-redirect=0 https://example.com/', 'bash', 'allow'], ['wget --max-redirect=0 --no-config https://example.com/', 'bash', 'once'],
    ['curl.exe -sS https://example.com/', 'powershell', 'once'], ['curl.exe -q -sS https://example.com/', 'powershell', 'allow'],
  ];
  assert.deepEqual(rows.flatMap(([c, shell, want]) => (levelOf(c, shell, has) === want ? [] : [`${c} (${shell}) → ${levelOf(c, shell, has)} (want ${want})`])), []);
  const reasons = classify('curl https://example.com/', 'bash', has).results.flatMap(r => r.reasons);
  assert.deepEqual(reasons.map(r => [r.key, r.level, r.exempt]), [['list.tool_rc', 'once', false]]);
  // cd の先が分からず調べられないときは、別の理由で今回だけ（-q・--no-config が最初にあれば許す）
  const unknown = { toolConfig: () => ({ unknownCwd: true as const }) };
  assert.deepEqual(classify('curl https://example.com/', 'bash', unknown).results.flatMap(r => r.reasons.map(x => [x.key, x.level, x.exempt])), [['list.tool_rc_cwd', 'once', false]]);
  assert.equal(levelOf('wget --max-redirect=0 https://example.com/', 'bash', unknown), 'once');
  assert.equal(levelOf('curl -q https://example.com/', 'bash', unknown), 'allow');
  assert.equal(levelOf('wget --no-config --max-redirect=0 https://example.com/', 'bash', unknown), 'allow');
  // 判定が終わるたびに afterStatement が、文の順に呼ばれる
  const seen: Array<string | undefined> = [];
  classify('cd sub && ls; cd - ; ls', 'bash', { afterStatement: r => { seen.push(r.cwd ? (r.cwd.word?.text ?? null) as string : undefined); } });
  assert.deepEqual(seen, ['sub', undefined, null, undefined]);
  // 設定ファイルが無ければ、これまでどおり（-q・--no-config は付けても付けなくてもよい）
  for (const [c, shell] of [['curl https://example.com/', 'bash'], ['curl -q https://example.com/', 'bash'], ['wget --max-redirect=0 https://example.com/', 'bash'], ['wget --no-config --max-redirect=0 https://example.com/', 'bash'], ['curl.exe -sS https://example.com/', 'powershell']] as const) {
    assert.equal(levelOf(c, shell), 'allow', c);
    assert.equal(levelOf(c, shell, { toolConfig: () => undefined }), 'allow', c);
  }
  // 免除（tools.shell.allow）では消せない
  assert.equal(classify('curl https://example.com/', 'bash', has).results[0]!.reasons.every(r => r.exempt === false), true);
});

test('git: ホーム・システムの設定を洗い出せない git（2.32 より古い）では、git はすべて今回だけ。--version と version は除く', () => {
  for (const c of ['git status', 'git log -p', 'git diff', 'git branch', 'git add .', 'git push', 'git -C fake log -p', 'git config --list']) {
    assert.equal(levelOf(c, 'bash', { gitIsolated: false }), 'once', c);
    assert.ok(keysOf(c, 'bash', { gitIsolated: false }).includes('once:list.git_old'), c);
    assert.equal(levelOf(c, 'bash', { gitIsolated: true }), c.includes('add') || c.includes('push') ? 'ask' : 'allow', c);
  }
  for (const c of ['git --version', 'git version']) assert.equal(levelOf(c, 'bash', { gitIsolated: false }), 'allow', c);
  assert.equal(levelOf('git status', 'bash'), 'allow');
  // 免除（tools.shell.allow）では消せない
  assert.equal(classify('git status', 'bash', { gitIsolated: false }).results[0]!.reasons.every(r => r.exempt === false), true);
});

// コマンドレベルの上書き（GIT_CONFIG_COUNT）は、コマンドから書き換えられない。環境変数 GIT_CONFIG_*・git -c・--config-env は、どの書き方でも今回だけ
test('git: GIT_CONFIG_COUNT・KEY・VALUE・PARAMETERS を環境に置く書き方、-c、--config-env は、どれも今回だけ', () => {
  const bash = [
    'GIT_CONFIG_COUNT=0 git status', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=x git status', 'GIT_CONFIG_KEY_0=core.fsmonitor git status', 'GIT_CONFIG_VALUE_0=x git status',
    'GIT_CONFIG_PARAMETERS="x" git status', 'env GIT_CONFIG_COUNT=0 git status', 'export GIT_CONFIG_COUNT=0', 'export GIT_CONFIG_KEY_0=x', 'GIT_CONFIG_COUNT=0; git status', 'declare -x GIT_CONFIG_COUNT=0',
    'git -c core.fsmonitor=x status', 'git -c core.fsmonitor=false status', 'git -ccore.fsmonitor=x status', 'git --config-env=core.fsmonitor=V status', 'git --config-env core.fsmonitor=V status', 'git -C . -c core.pager=x log',
    'git --no-pager -c core.pager=x log', 'git -c core.hooksPath=/evil commit -m x',
  ];
  const ps = [
    '$env:GIT_CONFIG_COUNT = "0"; git status', '$env:GIT_CONFIG_KEY_0 = "x"', 'Set-Item Env:GIT_CONFIG_COUNT 0', 'Set-Content Env:GIT_CONFIG_COUNT 0', 'New-Item Env:GIT_CONFIG_COUNT -Value 0',
    '[Environment]::SetEnvironmentVariable("GIT_CONFIG_COUNT","0")', 'git -c core.fsmonitor=x status', 'git --config-env=core.fsmonitor=V status', 'git -ccore.fsmonitor=x status',
  ];
  const wrong = [
    ...bash.filter(c => levelOf(c, 'bash') !== 'once').map(c => `bash: ${c} → ${levelOf(c, 'bash')}`),
    ...ps.filter(c => levelOf(c, 'powershell') !== 'once').map(c => `powershell: ${c} → ${levelOf(c, 'powershell')}`),
  ];
  assert.deepEqual(wrong, []);
  // 環境変数に置く書き方は、tools.shell.allow（持ち主が書いた許可）でも消せない
  assert.equal(classify('GIT_CONFIG_COUNT=0 git status', 'bash').results.every(r => r.reasons.every(x => x.exempt === false)), true);
});

test('git: 前に置ける引数・サブコマンドごとの扱い', () => {
  const rows: Array<[string, Level]> = [
    ['git --no-pager log', 'allow'], ['git -C sub status', 'allow'], ['git -P diff', 'allow'], ['git --version', 'allow'], ['git version', 'allow'],
    ['git -c core.pager=x log', 'once'], ['git --exec-path=x log', 'once'], ['git --git-dir=x log', 'once'], ['git --work-tree=x log', 'once'], ['git -C a -C b log', 'once'],
    ['git log --oneline -n 5', 'allow'], ['git log -p --stat', 'allow'], ['git log --format=%H', 'allow'], ['git log --ext-diff', 'once'], ['git log --textconv', 'once'], ['git log --output=x', 'once'], ['git log --show-signature', 'once'],
    ['git diff --cached', 'allow'], ['git diff --output=x', 'once'], ['git diff --ext-diff', 'once'], ['git blame -L 1,5 f', 'allow'], ['git blame --contents x f', 'once'],
    ['git branch', 'allow'], ['git branch -a', 'allow'], ['git branch -r', 'allow'], ['git branch --show-current', 'allow'], ['git branch new', 'ask'], ['git branch -D x', 'ask'], ['git tag', 'allow'], ['git tag -l "v*"', 'allow'], ['git tag v1', 'ask'],
    ['git cat-file -p HEAD', 'allow'], ['git cat-file --textconv HEAD:f', 'once'], ['git cat-file --batch', 'once'], ['git grep -n foo', 'allow'], ['git grep -O foo', 'once'], ['git ls-files', 'allow'], ['git rev-parse --show-toplevel', 'allow'],
    ['git stash list', 'allow'], ['git stash', 'ask'], ['git stash pop', 'ask'], ['git reflog', 'allow'], ['git reflog show HEAD', 'allow'], ['git reflog expire --all', 'once'], ['git remote', 'allow'], ['git remote -v', 'allow'], ['git remote show origin', 'once'],
    ['git config --get user.name', 'allow'], ['git config --list', 'allow'], ['git config user.name', 'allow'], ['git config user.name x', 'once'], ['git config --global x y', 'once'], ['git worktree list', 'allow'], ['git worktree add x', 'once'],
    ['git checkout -b feature', 'ask'], ['git switch main', 'ask'], ['git restore --staged f', 'ask'], ['git reset --hard', 'ask'], ['git merge main', 'ask'], ['git rebase main', 'ask'], ['git rebase --exec ./x main', 'once'], ['git rebase -i main', 'once'],
    ['git cherry-pick abc', 'ask'], ['git revert abc', 'ask'], ['git apply p.diff', 'ask'], ['git mv a b', 'ask'], ['git rm f', 'ask'], ['git commit -am x', 'ask'], ['git commit --amend --no-edit', 'ask'],
    ['git push -u origin main', 'ask'], ['git push --receive-pack=x origin', 'once'], ['git push --exec=x', 'once'], ['git push ext::sh origin', 'once'], ['git push https://x/y.git', 'once'], ['git push origin HEAD:main', 'ask'],
    ['git fetch', 'once'], ['git pull', 'once'], ['git clone x y', 'once'], ['git ls-remote .', 'once'], ['git init', 'once'], ['git submodule update', 'once'], ['git bisect start', 'once'], ['git gc', 'once'], ['git filter-branch', 'once'],
    ['git log $x', 'once'], ['git log -- $f', 'allow'], ['git show HEAD:README.md', 'allow'], ['git log feature/x..main', 'allow'], ['git log "a b"', 'once'],
  ];
  const wrong = rows.flatMap(([c, want]) => (levelOf(c) === want ? [] : [`${c} → ${levelOf(c)} (want ${want})`]));
  assert.deepEqual(wrong, []);
});

// 審査の指摘（深い審査）: push の宛先が、このリポジトリの設定に無い名前だと、git はそれをフォルダ（や URL）として扱い、そのフォルダのフックを動かす。設定にある名前だけを通す
test('git push の宛先は、このリポジトリの設定にある remote の名前だけ。無い名前（フォルダ名になりうる）は今回だけ', () => {
  const found = (remotes: string[]) => ({ repo: repo({ remotes }) });
  const level = (c: string, remotes: string[]) => levelOf(c, 'bash', found(remotes));
  assert.equal(level('git push origin main', ['origin']), 'ask');
  assert.equal(level('git push -u origin main', ['origin', 'upstream']), 'ask');
  assert.equal(level('git push upstream', ['origin', 'upstream']), 'ask');
  assert.equal(level('git push', ['origin']), 'ask', '宛先なしは、設定の既定の宛先');
  for (const c of ['git push victim', 'git push victim main', 'git push origin2 main', 'git push Origin']) assert.equal(level(c, ['origin']), 'once', c);
  assert.equal(level('git push origin', []), 'once', 'remote が 1 つも無いなら、どの名前もフォルダ');
  const keys = classify('git push victim', 'bash', found(['origin'])).results.flatMap(r => r.reasons.map(x => `${x.level}:${x.key}:${x.exempt}`));
  assert.equal(keys.includes('once:list.git_remote:false'), true, keys.join());
  // リポジトリが見つからないときは、git が先に失敗する（宛先を使わない）ので、これまでどおり
  assert.equal(levelOf('git push origin main'), 'ask');
  assert.equal(levelOf('git push victim', 'bash', { repo: repo({ found: false }) }), 'ask');
  // 名前に見えないもの（フォルダ・URL）は、これまでどおり今回だけ
  for (const c of ['git push ../victim', 'git push ./v', 'git push /abs/v', 'git push https://x/y.git', 'git push "ext::sh -c x" main', 'git push $x']) assert.equal(level(c, ['origin']), 'once', c);
});

// 再審査の指摘: remote の url が この PC のフォルダ・file:// のとき、git push はそのフォルダのフックを動かす（ローカルの転送の子には、フックの上書きが届かない）。ふつうの確かめでなく今回だけ
test('git push の宛先が、この PC のフォルダ・file:// を指す remote なら今回だけ。宛先なしの push も、そういう remote があれば今回だけ', () => {
  const local = (remotes: string[], localRemotes: string[]) => ({ repo: repo({ remotes, localRemotes }) });
  const level = (c: string, remotes: string[], localRemotes: string[]) => levelOf(c, 'bash', local(remotes, localRemotes));
  for (const c of ['git push up', 'git push up main', 'git push -u up HEAD:main', 'git push --force up']) assert.equal(level(c, ['origin', 'up'], ['up']), 'once', c);
  assert.equal(level('git push origin main', ['origin', 'up'], ['up']), 'ask', '別の remote はふつうの確かめ');
  assert.equal(level('git push', ['origin', 'up'], ['up']), 'once', '宛先なしは、どの remote に行くか分からない');
  assert.equal(level('git push --all', ['up'], ['up']), 'once');
  assert.equal(level('git push', ['origin'], []), 'ask');
  assert.equal(level('git push up', ['up'], []), 'ask', 'ローカルでない remote');
  assert.ok(classify('git push up', 'bash', local(['up'], ['up'])).results.flatMap(r => r.reasons.map(x => `${x.level}:${x.key}:${x.exempt}`)).includes('once:list.git_remote_local:false'));
  assert.equal(level('git status', ['up'], ['up']), 'allow', '読むだけはこれまでどおり');
  assert.equal(level('git fetch up', ['up'], ['up']), 'once', 'fetch は もともと今回だけ');
});

// 審査の指摘（深い審査）: ホスト名の末尾のドット（localhost.）は、同じ名前を指す。ループバックと LAN の確かめをすり抜けていた
test('C9: 末尾のドットのホスト（localhost.・127.0.0.1.・192.168.1.5.）も、ループバック・LAN と同じに確かめる', () => {
  const keysOf2 = (c: string, shell: ShellKind = 'bash', over: Partial<MatchCtx> = {}): string[] => classify(c, shell, over).results.flatMap(r => r.reasons.map(x => `${x.level}:${x.key}`));
  for (const host of ['localhost.', 'LOCALHOST.', 'localhost.:7800', 'foo.localhost.', 'a.b.localhost.:3000', '127.0.0.1.', '127.0.0.1.:7800', '0.0.0.0.']) {
    assert.ok(keysOf2(`curl http://${host}/api/settings`).includes('once:code.loopback'), `curl ${host}`);
    for (const c of [`Invoke-WebRequest http://${host}/x`, `iwr http://${host}/x`, `irm http://${host}/x`, `curl.exe -sS http://${host}/x`]) assert.ok(keysOf2(c, 'powershell').includes('once:code.loopback'), c);
    assert.ok(keysOf2(`wget --max-redirect=0 http://${host}/x`).includes('once:code.loopback'), `wget ${host}`);
  }
  for (const host of ['192.168.1.5.', 'printer.local.', 'nas.lan.', 'x.home.arpa.', '10.0.0.1.:8080']) assert.ok(keysOf2(`curl http://${host}/x`).includes('ask:list.lan'), host);
  // Tailscale の名前など、server.origins の host も、末尾のドットつきで当たる
  assert.ok(keysOf2('curl https://box.tailnet.ts.net./api/health', 'bash', { selfHosts: ['box.tailnet.ts.net'] }).includes('once:code.loopback'));
  assert.ok(keysOf2('curl https://box.tailnet.ts.net/api/health', 'bash', { selfHosts: ['box.tailnet.ts.net.'] }).includes('once:code.loopback'));
  // ふつうのホストは、末尾のドットがあっても、これまでどおり許す
  for (const c of ['curl https://example.com./x', 'curl https://api.example.org./v1']) assert.equal(levelOf(c), 'allow', c);
});

test('git の remote の URL に、コードを動かす書き方（ext::）は押し込めない（push の宛先）', () => {
  assert.equal(levelOf('git push "ext::sh -c x" main'), 'once');
  assert.equal(levelOf('git push origin'), 'ask');
});

test('実体の確かめ（C2）: PATH で見つかった実体が許可フォルダの中なら、その名前の一覧はすべて今回だけ', () => {
  const planted = { external: (name: string) => ({ ok: name !== 'git', ext: '.exe', detail: `/work/${name}` }) };
  assert.equal(levelOf('git status', 'bash', planted), 'once');
  assert.ok(keysOf('git status', 'bash', planted).includes('once:list.external'));
  assert.equal(levelOf('ls', 'bash', planted), 'allow');
  assert.equal(levelOf('git status', 'powershell', planted), 'once');
  assert.equal(levelOf('echo hi', 'bash', { external: () => ({ ok: false, ext: '', detail: 'x' }) }), 'allow');
  assert.equal(levelOf('ls', 'bash', { external: () => ({ ok: false, ext: '', detail: 'x' }) }), 'once');
  assert.equal(levelOf('Get-ChildItem', 'powershell', { external: () => ({ ok: false, ext: '', detail: 'x' }) }), 'allow');
  assert.equal(classify('ls', 'bash', { external: () => ({ ok: false, ext: '', detail: 'x' }) }).results[0]!.reasons[0]!.exempt, false);
});

test('Windows の引数の決まり（C7）: 引用符・末尾の \\・.cmd に渡す記号・広い文字を受け取らないプログラムへの ASCII 以外は止める', () => {
  const ps = (c: string, ext = '.exe') => levelOf(c, 'powershell', { external: () => ({ ok: true, ext, detail: '' }) });
  assert.equal(ps('rg \'a" --pre=x "b\' f'), 'deny');
  assert.equal(ps("rg 'a b\\' f"), 'deny');
  assert.equal(ps("rg 'あ' f"), 'allow');
  assert.equal(ps("git log --grep 'あ'"), 'allow');
  assert.equal(ps("curl.exe 'https://e/あ'"), 'deny');
  assert.equal(ps('npm view "x&calc"', '.cmd'), 'deny');
  assert.equal(ps('rg foo src'), 'allow');
  assert.equal(levelOf("rg 'a\" b' f", 'bash', { windows: false }), 'allow');
});

test('代入（C8）', () => {
  const rows: Array<[string, ShellKind, Level]> = [
    ['LC_ALL=C sort f', 'bash', 'allow'], ['TZ=UTC date', 'bash', 'allow'], ['NO_COLOR=1 ls', 'bash', 'allow'], ['PAGER=cat git log', 'bash', 'allow'], ['GIT_PAGER=cat git log', 'bash', 'allow'], ['PAGER=less git log', 'bash', 'once'],
    ['LANG=$x ls', 'bash', 'once'], ['HOME=. git log', 'bash', 'once'], ['GIT_DIR=x git log', 'bash', 'once'], ['GIT_CONFIG_COUNT=1 git log', 'bash', 'once'], ['FOO=1 ls', 'bash', 'once'], ['foo=1', 'bash', 'allow'], ['FOO=1', 'bash', 'once'], ['proxy_x=1', 'bash', 'once'],
    ['export TZ=UTC', 'bash', 'allow'], ['export HOME=.', 'bash', 'once'], ['export FOO', 'bash', 'allow'],
    ['$x = 1', 'powershell', 'allow'], ['$my_var = Get-Date', 'powershell', 'allow'], ['$env:LANG = "C"', 'powershell', 'once'], ['$env:PATH = "x"', 'powershell', 'once'], ['$ErrorActionPreference = "Stop"', 'powershell', 'once'],
    ['$PSDefaultParameterValues = @{}', 'powershell', 'once'], ['$null = 1', 'powershell', 'once'], ['$HOME = 1', 'powershell', 'once'], ['$input = 1', 'powershell', 'once'], ['$x += 1', 'powershell', 'allow'], ['$ofs = "x"', 'powershell', 'once'],
  ];
  const wrong = rows.flatMap(([c, shell, want]) => (levelOf(c, shell) === want ? [] : [`${c} → ${levelOf(c, shell)} (want ${want})`]));
  assert.deepEqual(wrong, []);
});

test('ネットワーク: 宛先の決まり（C9）と、書き込み先（-o・-O・wget の名前）', () => {
  assert.equal(levelOf('curl https://example.com'), 'allow');
  assert.equal(levelOf('curl https://example.com/a.tgz -o a.tgz'), 'allow');
  assert.equal(levelOf('curl -sS ftp://example.com/x'), 'once');
  assert.equal(levelOf('curl example.com'), 'once');
  assert.equal(levelOf('curl $url'), 'once');
  assert.equal(levelOf('curl https://x --output-dir out -O'), 'allow');
  assert.equal(levelOf('curl http://[::1]:3000/'), 'once');
  assert.equal(levelOf('curl http://0x7f.1/'), 'once');
  assert.equal(levelOf('curl http://2130706433/'), 'once');
  assert.equal(levelOf('curl http://app.localhost/'), 'once');
  assert.equal(levelOf('curl http://tailnet.example.ts.net/', 'bash', { selfHosts: ['tailnet.example.ts.net'] }), 'once');
  assert.equal(levelOf('wget -q --max-redirect=0 https://e/x.zip'), 'allow');
  assert.equal(levelOf('wget -qO- --max-redirect=0 https://e/x'), 'allow');
  assert.equal(levelOf('wget -O out.txt --max-redirect=0 https://e/x'), 'allow');
  const c = classify('curl -O https://e/a/b.txt --output-dir out').results[0]!;
  assert.deepEqual(c.remoteNames.map(r => [r.url.text, r.dir?.text]), [['https://e/a/b.txt', 'out']]);
  assert.equal(c.fetch, true);
  assert.equal(classify('wget --max-redirect=0 https://e/a.zip').results[0]!.remoteNames.length, 1);
  assert.equal(classify('wget --max-redirect=0 -O x https://e/a.zip').results[0]!.remoteNames.length, 0);
  assert.equal(levelOf('Invoke-WebRequest -Uri https://e -OutFile a.html -MaximumRedirection 0', 'powershell'), 'once');
  assert.equal(levelOf('Invoke-WebRequest -Uri https://e -Method Delete -MaximumRedirection 0', 'powershell'), 'ask');
  assert.equal(levelOf('Invoke-WebRequest -Uri https://e -Method Trace -MaximumRedirection 0', 'powershell'), 'once');
  assert.equal(levelOf('curl https://e -MaximumRedirection 0', 'powershell'), 'allow');
  assert.equal(levelOf('curl https://e -Method Post -MaximumRedirection 0', 'powershell'), 'ask');
  assert.equal(levelOf('wget http://127.0.0.1/', 'powershell'), 'once');
  assert.equal(classify('Invoke-WebRequest -Uri https://e', 'powershell').results[0]!.fetch, true);
});

test('入れるもの（11.7）はすべて今回だけ、情報を見るだけの形は許す', () => {
  for (const c of ['npm install', 'npm i x', 'npm ci', 'npm add x', 'pnpm install', 'pnpm add x', 'yarn add x', 'bun install', 'bun add x', 'pip install .', 'pip install -e .', 'pip3 install x', 'pipx install x', 'uv pip install x', 'uv sync', 'cargo install x', 'go install x', 'go get x', 'gem install x', 'composer install', 'poetry add x', 'conda install x']) {
    assert.ok(keysOf(c).includes('once:list.install'), c);
  }
  for (const c of ['npm --version', 'npm ls --depth=1', 'npm list --json', 'npm outdated', 'npm view left-pad', 'npm view left-pad version', 'pnpm --version', 'yarn --version', 'pip --version', 'pip list --outdated', 'pip show requests', 'go version', 'go env', 'cargo --version', 'rustc --version', 'deno --version', 'bun --version', 'tsc --version', 'py -V', 'python3.11 -V']) {
    assert.equal(levelOf(c), 'allow', c);
  }
  for (const c of ['npm view "x&calc"', 'npm view x --registry http://e', 'npm ls --prefix /x', 'pip list --index-url x', 'pip show -f x', 'python3 -m pip install x', 'go run x.go', 'cargo build', 'cargo run', 'deno run x.ts', 'bun run x', 'tsc', 'tsc -p tsconfig.json']) {
    assert.notEqual(levelOf(c), 'allow', c);
  }
});

test('形の印: 呼び出し・splatting・関数の定義・後ろで動かす & は今回だけ', () => {
  const rows: Array<[string, ShellKind, string]> = [
    ['& $x', 'powershell', 'once:shape.call'], ['. ./x.ps1', 'powershell', 'once:shape.dot_source'], ['Get-ChildItem @p', 'powershell', 'once:shape.splat'], ['function f { ls }', 'powershell', 'once:shape.control'],
    ['[Math]::Round(1.5)', 'powershell', 'once:shape.static'], ['[IO.File]::ReadAllText("x")', 'powershell', 'once:shape.static'], ['$x.Delete()', 'powershell', 'once:shape.method'], ['$x.ToString()', 'powershell', 'allow'],
    ['name() { ls; }', 'bash', 'once:shape.function'], ['sleep 1 &', 'bash', 'once:shape.background'], ['ls |& cat', 'bash', 'once:shape.pipe_stderr'], ['ls >(tee x)', 'bash', 'once:shape.process_out'], ['case x in x) ls;; esac', 'bash', 'once:shape.control'],
  ];
  for (const [c, shell, key] of rows) {
    if (key === 'allow') assert.equal(levelOf(c, shell), 'allow', c);
    else assert.ok(keysOf(c, shell).includes(key), `${c}: ${keysOf(c, shell).join(',')}`);
  }
  for (const [c, shell, key] of rows) if (key !== 'allow') assert.ok(classify(c, shell).results.flatMap(r => r.reasons).filter(r => r.key === key.slice(5)).every(r => !r.exempt), c);
});

test('PowerShell: 書くコマンドレットは常に今回だけ。パイプを受けるときは、持ち主の許可で外せない理由が付く。書き込み先は、これまでどおりそのパスで調べる', () => {
  const reasons = (c: string) => classify(c, 'powershell').results.flatMap(r => r.reasons);
  for (const c of ['Get-ChildItem | Remove-Item', 'Get-ChildItem | Move-Item -Destination x', 'Get-ChildItem | Set-Content -Path a.txt', 'Import-Csv a.csv | Copy-Item -Path x']) {
    assert.ok(keysOf(c, 'powershell').includes('once:list.ps_pipe'), c);
    assert.ok(reasons(c).filter(r => r.key === 'list.ps_pipe').every(r => !r.exempt), c);
  }
  for (const c of ['Remove-Item a.txt', 'Set-Content a.txt x', '$x | Out-String']) assert.ok(!keysOf(c, 'powershell').includes('once:list.ps_pipe'), c);
  assert.ok(reasons('Remove-Item a.txt').filter(r => r.key === 'list.ps_write').every(r => r.exempt), '書くコマンドレット自体は、持ち主が選んだコマンドとして外せる');
  assert.ok(keysOf("'x' > a.txt", 'powershell').includes('once:list.ps_write'));
  assert.ok(reasons("'x' > a.txt").filter(r => r.key === 'list.ps_write').every(r => !r.exempt), 'リダイレクトは外せない');
  const r = classify('Copy-Item a.txt -Destination out -Recurse', 'powershell').results[0]!;
  assert.deepEqual(r.copies.map(c => [c.kind, c.sources.map(w => w.text), c.dest?.text, c.recursive]), [['copy', ['a.txt'], 'out', true]]);
  const n = classify('New-Item -Path out -Name x.txt', 'powershell').results[0]!;
  assert.deepEqual(n.copies.map(c => [c.kind, c.dest?.text, c.name?.text]), [['join', 'out', 'x.txt']]);
  const rn = classify('Rename-Item a.txt -NewName SOUL.md', 'powershell').results[0]!;
  assert.deepEqual(rn.copies.map(c => [c.kind, c.sources.map(w => w.text), c.name?.text]), [['rename', ['a.txt'], 'SOUL.md']]);
});

test('調べるパス: 読む・書く・組み立て・消す・cd', () => {
  const cp = classify('cp -r a b c/').results[0]!;
  assert.deepEqual(cp.copies.map(c => [c.sources.map(w => w.text), c.dest?.text, c.recursive]), [[['a', 'b'], 'c/', true]]);
  assert.deepEqual(cp.paths.map(p => [p.word.text, p.mode]), [['a', 'read'], ['b', 'read'], ['c/', 'write']]);
  const mv = classify('mv -t out a b').results[0]!;
  assert.deepEqual(mv.copies.map(c => [c.sources.map(w => w.text), c.dest?.text, c.dirFlag]), [[['a', 'b'], 'out', true]]);
  const rm = classify('rm -rf build').results[0]!;
  assert.equal(rm.deletes, true);
  assert.deepEqual(rm.paths.map(p => [p.word.text, p.mode, p.recursive]), [['build', 'write', true]]);
  assert.deepEqual(classify('echo x > a.txt 2>/dev/null').results[0]!.paths.map(p => [p.word.text, p.mode]), [['a.txt', 'write']]);
  assert.deepEqual(classify('wc -l < in.txt').results[0]!.paths.map(p => [p.word.text, p.mode]), [['in.txt', 'read']]);
  assert.deepEqual(classify('tar -czf out.tgz src').results[0]!.paths.map(p => [p.word.text, p.mode]), [['out.tgz', 'write'], ['src', 'read'], ['src', 'read']], '元のフォルダは、読む 1 つと、下を歩く 1 つ');
  assert.deepEqual(classify('tar -czf out.tgz src').results[0]!.paths.map(p => p.list !== undefined), [false, false, true]);
  assert.deepEqual(classify('tar -tf a.tar').results[0]!.paths.map(p => [p.word.text, p.mode]), [['a.tar', 'read']]);
  assert.equal(levelOf('tar -tf host:a.tar'), 'once');
  assert.deepEqual(classify('cd sub').results[0]!.cwd?.word?.text, 'sub');
  assert.equal(classify('cd').results[0]!.cwd?.word, null);
  assert.equal(classify('popd').results[0]!.cwd?.word, null);
  assert.equal(classify('Set-Location ..', 'powershell').results[0]!.cwd?.word?.text, '..');
  assert.deepEqual(classify('zip -r out.zip src -x "*.git*"').results[0]!.paths.map(p => [p.word.text, p.mode]), [['out.zip', 'write'], ['src', 'read'], ['src', 'read']]);
  assert.deepEqual(classify("sed -i 's/a/b/' f").results[0]!.paths.map(p => [p.word.text, p.mode]), [['f', 'write']]);
  assert.deepEqual(classify("sed -n '1p' f").results[0]!.paths.map(p => [p.word.text, p.mode]), [['f', 'read']]);
  assert.deepEqual(classify('Get-Content env:PATH', 'powershell').results[0]!.paths, []);
  assert.deepEqual(classify('git -C sub log', 'bash').results[0]!.paths.map(p => [p.word.text, p.mode]), [['sub', 'read']]);
});

test('パイプの前後・複数の文: すべての文が一覧に当たる必要がある', () => {
  assert.equal(levelOf('ls | wc -l'), 'allow');
  assert.equal(levelOf('ls | node'), 'once');
  assert.equal(levelOf('ls; node x.js'), 'once');
  assert.equal(levelOf('ls && cat a || echo no'), 'allow');
  assert.equal(levelOf('echo $(node x.js)'), 'once');
  assert.equal(levelOf('echo $(ls)'), 'allow');
  assert.equal(levelOf('ls <(node x)'), 'once');
  assert.equal(levelOf('for f in *.md; do node "$f"; done'), 'once');
  assert.equal(levelOf('if test -f x; then cat x; else echo no; fi'), 'allow');
  assert.equal(levelOf('while read x; do echo $x; done'), 'once');
  assert.equal(levelOf('Get-ChildItem | ForEach-Object { node $_ }', 'powershell'), 'once');
  assert.equal(levelOf('Get-ChildItem | ForEach-Object { $_.Name; Write-Output $_ }', 'powershell'), 'allow');
  assert.equal(levelOf('Get-ChildItem | ForEach-Object { $_.Name; Remove-Item $_ }', 'powershell'), 'once');
  assert.equal(levelOf('Get-ChildItem | ForEach-Object { Start-Process $_ }', 'powershell'), 'once');
  assert.equal(levelOf('if (Test-Path a) { Get-Item a } else { Write-Output no }', 'powershell'), 'allow');
  assert.equal(levelOf('if (Test-Path a) { Remove-Item a } else { New-Item a }', 'powershell'), 'once');
  assert.equal(levelOf('if (Test-Path a) { node a }', 'powershell'), 'once');
  assert.equal(classify('ls | wc -l').results.length, 2);
});

test('名前の決まり（C1）: 引用符・変数・パスのコマンド名は一覧に当たらない', () => {
  for (const c of ['"ls"', "'ls' -la", '$cmd', '${cmd} x', './ls', '/bin/ls', '~/bin/ls', 'ls.sh', '"$(ls)"', '\\ls']) assert.notEqual(levelOf(c), 'allow', c);
  for (const c of ['& "ls"', '& ./x', '& $x', '.\\x.ps1', 'C:\\x\\ls.exe', '$x arg']) assert.notEqual(levelOf(c, 'powershell'), 'allow', c);
  assert.equal(levelOf('LS', 'bash', { windows: false }), 'once');
  assert.equal(levelOf('ls.exe', 'bash', { windows: true }), 'allow');
  assert.equal(levelOf('LS.EXE', 'bash', { windows: true }), 'allow');
  assert.equal(levelOf('git.exe status', 'powershell'), 'allow');
  assert.equal(levelOf('where.exe git', 'powershell'), 'allow');
  assert.equal(levelOf('ls.exe', 'powershell'), 'once');
});

// 審査で見つかった: 転送（リダイレクト）や Host・Origin ヘッダで、名前だけでは見抜けない形で Clive 自身の画面の API に届く。
// curl の -L・Host/Origin などのヘッダ、wget と iwr/irm の既定の転送の追いかけは、今回だけにする
test('Clive 自身の API に名前では届かせない: Host・Origin などのヘッダ・転送を追う指定は今回だけ', () => {
  const once = [
    'curl -H "Host: 127.0.0.1:7800" https://127.0.0.1.nip.io:7800/api/settings', "curl -H 'host:127.0.0.1' https://e.example/", 'curl --header "Origin: http://127.0.0.1:7800" https://e.example/',
    'curl --header="Origin: http://localhost" https://e.example/', 'curl -H "Sec-Fetch-Site: same-origin" https://e.example/', 'curl -H "X-Forwarded-Host: 127.0.0.1" https://e.example/',
    'curl -H "Tailscale-User-Login: me@example.com" https://e.example/', 'curl -H "Forwarded: host=127.0.0.1" https://e.example/', 'curl -H @headers.txt https://e.example/', 'curl -sS -H "Accept: x" -H "HOST: y" https://e.example/',
    'curl -L https://e.example/', 'curl -sSL https://e.example/x', 'curl --location https://e.example/', 'curl -sSLo out.html https://e.example/', 'curl -I -L https://e.example/',
    'wget https://e.example/x', 'wget -q https://e.example/x', 'wget --max-redirect=5 https://e.example/x', 'wget --max-redirect 3 https://e.example/x',
  ];
  const wrong = once.filter(c => levelOf(c, 'bash') !== 'once');
  assert.deepEqual(wrong, []);
  const allow = [
    'curl https://e.example/', 'curl -sS https://e.example/x', 'curl -H "Accept: application/json" https://e.example/', "curl -H 'User-Agent: clive' https://e.example/", 'curl -H "X-Api-Version: 2" https://e.example/',
    'wget --max-redirect=0 https://e.example/x', 'wget -q --max-redirect 0 https://e.example/x',
  ];
  assert.deepEqual(allow.filter(c => levelOf(c, 'bash') !== 'allow'), []);
  for (const c of ['curl -H "Host: x" https://e.example/']) assert.equal(classify(c).results[0]!.reasons.every(r => !r.exempt), true, 'ヘッダの偽装は tools.shell.allow でも外せない');
  assert.equal(classify('curl -L https://e.example/').results[0]!.reasons.some(r => r.exempt), true, '転送を追う指定は、持ち主が選んだコマンドとして外せる');
});

test('Invoke-WebRequest・Invoke-RestMethod（5.1 の curl・wget も）: 転送は既定で追うので、-MaximumRedirection 0 を付けたときだけ許す。-Headers は一覧に無い', () => {
  const once = [
    'Invoke-WebRequest -Uri https://e.example/', 'iwr https://e.example/', 'Invoke-RestMethod https://e.example/api', 'irm https://e.example/', 'iwr https://e.example/ -MaximumRedirection 5', 'iwr https://e.example/ -MaximumRedirection 1',
    'iwr https://e.example/ -MaximumRedirection $n', 'iwr https://e.example/ -UseBasicParsing', 'curl https://e.example/', 'wget https://e.example/x', 'iwr https://e.example/ -OutFile a.html',
    'iwr https://e.example/ -MaximumRedirection 0 -Headers @{Host="127.0.0.1:7800"}', 'irm https://e.example/ -MaximumRedirection 0 -Headers $h',
    'iwr https://e.example/ -MaximumRedirection 0 -OutFile a.html',
  ];
  for (const shell of ['powershell', 'pwsh'] as ShellKind[]) {
    const list = shell === 'pwsh' ? once.filter(c => !c.startsWith('curl ') && !c.startsWith('wget ')) : once;
    assert.deepEqual(list.filter(c => levelOf(c, shell) !== 'once'), [], shell);
  }
  const allow = ['Invoke-WebRequest -Uri https://e.example/ -MaximumRedirection 0', 'iwr https://e.example/ -MaximumRedirection 0 -UseBasicParsing', 'irm https://e.example/api -MaximumRedirection 0', 'curl https://e.example/ -MaximumRedirection 0'];
  assert.deepEqual(allow.filter(c => levelOf(c, 'powershell') !== 'allow'), []);
  assert.equal(levelOf('iwr https://e.example/ -MaximumRedirection 0 -Method Post -Body x', 'powershell'), 'ask', '送る形は、これまでどおりふつうの確かめ');
});
