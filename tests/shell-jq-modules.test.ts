import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand, type ShellVerdict } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

// 9 回目の審査（中）: jq のプログラムは `import "名前" as $d;` で、探索の道（-L・~/.jq・プログラムのフォルダ）にある .json を読み込め、`include "名前";` で .jq のコードを読み込める。
// 読むパスの調べ（秘密のパスは止める）は、プログラムの文の中の名前までは見ない。
// PowerShell では jq は一覧に無く、もともと今回だけ（tools.shell.allow に書いたのは持ち主の選び）
// 決め（真似ずに閉じる）: プログラムに import か include の語があれば今回だけ。-f / --from-file のプログラムは、ファイルの中身を分類の時点では確かめられない
//   （同じコマンドの前の文で書かれることもある）ので、常に今回だけ。-L / --library-path は常に今回だけ。どれも tools.shell.allow に `jq` と書いても外せない

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  mkdirSync(ws, { recursive: true });
  for (const f of ['f.json', 'prog.jq']) writeFileSync(join(ws, f), '{}');
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [join(ws, 'SOUL.md'), join(ws, 'USER.md')], skillsDir: join(ws, 'skills') };
  const bash = (command: string, allow?: string[]): ShellVerdict =>
    checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell: 'bash', windows: false, ...(allow ? { allow } : {}) });
  return { bash };
}
const show = (v: ShellVerdict): string => `${v.decision}${v.onceOnly ? '/once' : ''} ${v.reasons.join(' / ').slice(0, 100)}`;
const once = (v: ShellVerdict): boolean => v.decision === 'ask' && v.onceOnly;

const MODULE_FORMS = [
  `jq 'import "a" as a; .' f.json`, `jq 'import "d" as $d; $d' f.json`, `jq 'include "a"; .' f.json`, `jq -n 'include "a" {search:"./"}; 1'`, `jq -r 'import "a" as a; a::f' f.json`,
  `jq '.a | import "x" as x; .' f.json`, `jq -c 'include "m"; .[]' f.json`, `jq --arg k v 'import "a" as a; .' f.json`, `jq -n '"x" | import'`, `jq 'IMPORT "a" as a; .' f.json`,
  'jq -L lib .a f.json', 'jq -Llib .a f.json', 'jq -L . .a f.json', 'jq --library-path lib .a f.json', 'jq --library-path=lib .a f.json', 'jq -r -L lib .a f.json', 'jq .a -L lib f.json',
  'jq -f prog.jq f.json', 'jq --from-file prog.jq f.json', 'jq -n -f prog.jq', "printf 'import \"a\" as a; .' > p.jq; jq -f p.jq f.json", 'jq "$prog" f.json', 'jq ".a | $filter" f.json',
];

test('jq: import・include のあるプログラム、-L・--library-path、-f のプログラムは今回だけ（tools.shell.allow に jq と書いても外せない）', t => {
  const f = fixture(t);
  const wrong: string[] = [];
  for (const c of MODULE_FORMS) {
    if (!once(f.bash(c))) wrong.push(`bash ${c} → ${show(f.bash(c))}`);
    if (!once(f.bash(c, ['jq']))) wrong.push(`bash(allow jq) ${c} → ${show(f.bash(c, ['jq']))}`);
  }
  assert.deepEqual(wrong, []);
});

test('jq: モジュールを使わないふつうのプログラムは、これまでどおり確かめなし（import に似た名前の語も）', t => {
  const f = fixture(t);
  const wrong: string[] = [];
  for (const c of [
    "jq '.items[]' f.json", "jq -r '.a.b' f.json", "jq '.important' f.json", "jq '.included | length' f.json", "jq -n '1 + 1'", "jq --arg x 1 '.[$x]' f.json", `jq -c '.[] | select(.n == "x")' f.json`,
    "jq '.imports' f.json", "jq '.[] | .reimport' f.json", "jq --indent 4 . f.json", "jq -S . f.json", "jq --slurpfile s f.json '$s' f.json", "jq -e '.ok' f.json", 'jq . f.json',
  ]) if (f.bash(c).decision !== 'allow') wrong.push(`bash ${c} → ${show(f.bash(c))}`);
  assert.deepEqual(wrong, []);
});
