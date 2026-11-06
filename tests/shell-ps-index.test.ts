import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { lexShell, type ShellKind, type Statement } from '../src/tools/hooks/shell-lex.ts';
import { tempDir } from './helpers.ts';

// 代入の左辺の添字（$a[ … ] = 1）と、先読みで読み飛ばしていたかもしれないほかの形の中の $( … ) も、トップレベルの文と同じに判定する（security-self-api.md §11.2.2）。
// 以前は、代入かどうかを見る先読みが添字の中のトークンを読み飛ばしたので、$a[$(Remove-Item x)] = 1 は文が 1 つも作られず、確かめなしで動いた。

const PS_SHELLS = ['powershell', 'pwsh'] as const;

function fixture(t: { after: (fn: () => void) => void }) {
  const ws = realish(join(tempDir(t), 'workspace'));
  const put = (rel: string, body = 'x') => { mkdirSync(join(ws, rel, '..'), { recursive: true }); writeFileSync(join(ws, rel), body); };
  put('SOUL.md'); put('USER.md'); put('f.txt'); put('x'); put('.env', 'SECRET=1');
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [join(ws, 'SOUL.md'), join(ws, 'USER.md'), join(ws, 'skills')], skillsDir: join(ws, 'skills') };
  const run = (command: string, shell: ShellKind) => checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell' || shell === 'pwsh' });
  return { ws, policy, ps: (c: string) => run(c, 'powershell'), pwsh: (c: string) => run(c, 'pwsh'), bash: (c: string) => run(c, 'bash') };
}

const level = (v: { decision: string; onceOnly: boolean }): string => (v.decision === 'allow' ? 'allow' : v.decision === 'deny' ? 'deny' : v.onceOnly ? 'once' : 'ask');
const commandLines = (statements: Statement[]): string[] => statements.filter(s => s.kind === 'command').map(s => s.words.map(w => w.text).join(' '));
const read = (command: string, shell: ShellKind): Statement[] => {
  const r = lexShell(command, shell, { windows: false });
  assert.ok(r.ok, `${shell}: ${JSON.stringify(command)} が読めない: ${r.ok ? '' : `${r.fail.code} ${r.fail.detail}`}`);
  return r.statements;
};

test('PowerShell: 代入の左辺の添字の中の $( … ) も、中の文を文として読む（以前は文が作られなかった）', () => {
  for (const shell of PS_SHELLS) {
    assert.deepEqual(commandLines(read('$a[$(Remove-Item x)] = 1', shell)), ['Remove-Item x']);
    assert.deepEqual(commandLines(read('$a.b[$(Set-Content SOUL.md pwned)] = 1', shell)), ['Set-Content SOUL.md pwned']);
    assert.deepEqual(commandLines(read('$a[0][$(Get-Content .env)] = 1', shell)), ['Get-Content .env']);
    assert.deepEqual(commandLines(read('$a[$(Get-Date)][$(Get-Location)] += 1', shell)), ['Get-Date', 'Get-Location']);
    assert.deepEqual(commandLines(read('$a[$a[$(Remove-Item x)]] = 1', shell)), ['Remove-Item x']);
    assert.deepEqual(commandLines(read('$a["k$(Get-Date -Format yyyy)"] = 1', shell)), ['Get-Date -Format yyyy']);
    assert.deepEqual(commandLines(read('$a[$(Remove-Item x)] = $(Get-Date)', shell)), ['Remove-Item x', 'Get-Date']);
    // 代入として読むこと（右辺は今までどおり）
    const statements = read('$a[$(Get-Date)] = 1', shell);
    assert.equal(statements.at(-1)!.kind, 'assign');
    assert.equal(statements.filter(s => s.kind === 'assign').length, 1);
  }
});

test('PowerShell: 代入ではない形を試し読みしても、文が重複しない・shapes が増えない', () => {
  for (const shell of PS_SHELLS) {
    const statements = read('$a[$(Get-Date)]', shell);
    assert.deepEqual(commandLines(statements), ['Get-Date']);
    assert.equal(statements.length, 3, 'Get-Date、添字の中の式、全体の式。試し読みで戻した分が重複して残らない');
    assert.deepEqual(statements.flatMap(s => s.shapes), []);
    const call = read('$x.Foo($(Get-Date)).Bar = 1', shell);
    assert.deepEqual(commandLines(call), ['Get-Date']);
    assert.ok(call.some(s => s.shapes.includes('method:Foo')), 'メソッドの呼び出しを含む左辺は代入として読まず、式として読む（今回だけの印が付く）');
  }
});

test('PowerShell: 添字の中の文は、トップレベルの文と同じ判定になる。書く・消す・秘密を読むものは確かめか止める', t => {
  const f = fixture(t);
  const sameAsTop: Array<[string, string]> = [
    ['$a[$(Remove-Item x)] = 1', 'Remove-Item x'],
    ['$a[$(Set-Content SOUL.md pwned)] = 1', 'Set-Content SOUL.md pwned'],
    ['$a[$(Set-Content out.txt x)] = 1', 'Set-Content out.txt x'],
    ['$a[$(Get-Content .env)] = 1', 'Get-Content .env'],
    ['$a[$(Get-Content ../outside.txt)] = 1', 'Get-Content ../outside.txt'],
    ['$a[$(node -e 1)] = 1', 'node -e 1'],
    ['$a[$(iex "Get-Date")] = 1', 'iex "Get-Date"'],
    ['$a.b[$(Remove-Item x)] = 1', 'Remove-Item x'],
    ['$a[0][$(Remove-Item x)] = 1', 'Remove-Item x'],
    ['$a.b[0].c[$(Remove-Item x)] = 1', 'Remove-Item x'],
    ['$a[$(Remove-Item x)] += 1', 'Remove-Item x'],
    ['$a[$(Remove-Item x)] -= 1', 'Remove-Item x'],
    ['$a[$a[$(Remove-Item x)]] = 1', 'Remove-Item x'],
    ['$a[1..$(Remove-Item x)] = 1', 'Remove-Item x'],
    ['$a[($(Remove-Item x))] = 1', 'Remove-Item x'],
    ['$a[(Remove-Item x)] = 1', 'Remove-Item x'],
    ['$a[@($(Remove-Item x))] = 1', 'Remove-Item x'],
    ['$a["$(Remove-Item x)"] = 1', 'Remove-Item x'],
    ['$a["$(Get-Content .env)"] = 1', 'Get-Content .env'],
    ['$a[0].b["x$(Remove-Item x)"] = 1', 'Remove-Item x'],
    ['$a[Remove-Item] = 1', 'Remove-Item'],
    ['$a[$(Remove-Item x)] = $(Get-Date)', 'Remove-Item x'],
    ['$a[$(Get-Date)] = $(Remove-Item x)', 'Remove-Item x'],
    ['$a[$(Get-Date)][$(Remove-Item x)] = 1', 'Remove-Item x'],
  ];
  const wrong: string[] = [];
  for (const [wrapped, bare] of sameAsTop) {
    const inner = level(f.ps(bare));
    assert.notEqual(inner, 'allow', `前提: ${bare} は確かめか止める`);
    for (const [shell, run] of [['powershell', f.ps], ['pwsh', f.pwsh]] as const) {
      const outer = level(run(wrapped));
      if (outer === 'allow') wrong.push(`${shell}: 確かめなしで動く: ${wrapped}`);
      else if (outer !== inner) wrong.push(`${shell}: ${wrapped} → ${outer}、中の文だけだと ${inner}（${bare}）`);
    }
  }
  assert.deepEqual(wrong, []);
  assert.equal(level(f.ps('$a[$(Get-Content .env)] = 1')), 'deny');
  assert.equal(level(f.ps('$a["$(Get-Content .env)"] = 1')), 'deny');
  const soul = f.ps('$a[$(Set-Content SOUL.md pwned)] = 1');
  assert.deepEqual([soul.decision, soul.onceOnly], ['ask', true]);
  assert.match(soul.reasons.join('\n'), /SOUL\.md|人格/u);
});

test('PowerShell: 添字が読むだけ・変数・文字なら、代入は今までどおり確かめなしで動く', t => {
  const f = fixture(t);
  const allow = [
    '$a[0] = 1', '$a[$i] = 1', "$h['k'] = 1", '$h["k"] = 1', '$a.b.c = 1', '$a[0].b = 1', '$a[$(Get-Date)] = 1', '$h["k$(Get-Date)"] = 1', '$a[(Get-Date).Year] = 1', '$h[$k] += 2', '$a[-1] = 1',
    '$a[$x.Length] = 1', '$a[$(Get-Date)][$(Get-Location)] = 1', '$a[$(Get-Date)] = $(Get-Date)', '$env:FOO.Length',
  ];
  const wrong = allow.flatMap(c => PS_SHELLS.flatMap(shell => { const v = (shell === 'powershell' ? f.ps : f.pwsh)(c); return v.decision === 'allow' ? [] : [`${shell}: ${c} → ${level(v)} ${v.reasons.join(' / ')}`]; }));
  assert.deepEqual(wrong, []);
});

test('PowerShell: 先読みで読み飛ばしていたかもしれない、ほかの形の中の $( … ) も、確かめなしでは動かない（メンバーアクセス・ハッシュの値・静的メソッド・配列・if/switch/while/for/foreach の条件・try）', t => {
  const f = fixture(t);
  // 中の文を読む形: トップレベルの文と同じ判定
  const parsed: Array<[string, string]> = [
    ['$x.($(Remove-Item x))', 'Remove-Item x'],
    ['$x.($(Remove-Item x)).y', 'Remove-Item x'],
    ['$a.($(Remove-Item x)) = 1', 'Remove-Item x'],
    ['$h = @{ a = $(Remove-Item x) }', 'Remove-Item x'],
    ['$h = @{ a = 1; b = $(Remove-Item x) }', 'Remove-Item x'],
    ['$h = @{ a = "$(Remove-Item x)" }', 'Remove-Item x'],
    ['$h = @{ a = { Remove-Item x } }', 'Remove-Item x'],
    ['@{ a = $(Remove-Item x) }', 'Remove-Item x'],
    ['Get-ChildItem | Select-Object @{n="a"; e=$(Remove-Item x)}', 'Remove-Item x'],
    ['[datetime]::Parse($(Remove-Item x))', 'Remove-Item x'],
    ['[datetime]::Now.ToString($(Remove-Item x))', 'Remove-Item x'],
    ['[Math]::Round($(Remove-Item x))', 'Remove-Item x'],
    ['Write-Output [datetime]::Parse($(Remove-Item x))', 'Remove-Item x'],
    ['$p = @{ Path = $(Remove-Item x) }; Get-Content @p', 'Remove-Item x'],
    ['@($(Remove-Item x))', 'Remove-Item x'],
    ['$z = @($(Remove-Item x), 2)', 'Remove-Item x'],
    ['Write-Output @($(Remove-Item x))', 'Remove-Item x'],
    ['if ($(Remove-Item x)) { 1 }', 'Remove-Item x'],
    ['if ($true) { 1 } elseif ($(Remove-Item x)) { 2 }', 'Remove-Item x'],
    ['if ($true) { 1 } else { $(Remove-Item x) }', 'Remove-Item x'],
    ['foreach ($i in $(Remove-Item x)) { 1 }', 'Remove-Item x'],
    ['$x.Foo($(Remove-Item x)).Bar = 1', 'Remove-Item x'],
    ['$x.Foo().Bar[$(Remove-Item x)] = 1', 'Remove-Item x'],
  ];
  const wrong: string[] = [];
  for (const [wrapped, bare] of parsed) {
    const inner = level(f.ps(bare));
    for (const [shell, run] of [['powershell', f.ps], ['pwsh', f.pwsh]] as const) {
      const outer = level(run(wrapped));
      if (outer === 'allow') wrong.push(`${shell}: 確かめなしで動く: ${wrapped}`);
      else if (outer !== inner && !(outer === 'once' && inner === 'ask')) wrong.push(`${shell}: ${wrapped} → ${outer}、中の文だけだと ${inner}（${bare}）`);
    }
  }
  assert.deepEqual(wrong, []);
  for (const c of ['$x.($(Get-Content .env))', '$h = @{ a = $(Get-Content .env) }', '@($(Get-Content .env))', 'if ($(Get-Content .env)) { 1 }', 'foreach ($i in $(Get-Content .env)) { 1 }', '[datetime]::Now.ToString($(Get-Content .env))', '$h = @{ k = { Get-Content .env } }']) {
    assert.equal(level(f.ps(c)), 'deny', c);
  }
  // 中を読まず、文全体を今回だけの確かめにする形（制御の形）: 確かめなしでは動かない
  for (const c of [
    'switch ($(Remove-Item x)) { default { 1 } }', 'switch ($x) { 1 { Remove-Item x } }', 'while ($(Remove-Item x)) { 1 }', 'for ($i = $(Remove-Item x); $i -lt 1; $i++) { 1 }', 'do { 1 } while ($(Remove-Item x))',
    'try { $(Remove-Item x) } catch { 1 }', 'try { 1 } catch { Remove-Item x }', 'try { 1 } finally { $(Remove-Item x) }', 'function f { $(Remove-Item x) }', 'switch ($(Get-Content .env)) { default { 1 } }',
  ]) {
    for (const run of [f.ps, f.pwsh]) assert.equal(level(run(c)), 'once', c);
  }
});

test('bash: 添字・条件・ループの中の $( … ) は、いつも中の文を文として読む（先読みで飛ばさない）', t => {
  const f = fixture(t);
  for (const c of [
    'a[$(touch SOUL.md)]=1', 'a[$(touch SOUL.md)]+=1', '[[ $(touch SOUL.md) == x ]]', '[[ a == $(touch SOUL.md) ]]', 'for i in $(touch SOUL.md); do echo $i; done', 'case $(touch SOUL.md) in x) echo;; esac',
    'declare a[$(touch SOUL.md)]=1', 'if touch SOUL.md; then echo; fi', 'while touch SOUL.md; do echo; done', 'x=$(touch SOUL.md)', 'echo "$(touch SOUL.md)"', 'cat <(touch SOUL.md)',
  ]) {
    assert.ok(commandLines(read(c, 'bash')).some(line => line.startsWith('touch SOUL.md')), `${c}: 中の touch が文になっていない`);
    assert.notEqual(level(f.bash(c)), 'allow', c);
  }
});
