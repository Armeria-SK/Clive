import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyStatements, noRepo, type Level, type MatchCtx } from '../src/tools/hooks/allowlist.ts';
import { which } from '../src/tools/shell/runner.ts';
import { tempDir } from './helpers.ts';

// 値を式として評価する bash の構文・組み込みは、評価する値や引数が整数の定数だけでなければ、毎回確かめる（持ち主の許可でも外せない）。
// 変数の値や、引用符で囲んだ文字列に a[$(コマンド)] が入っていると、配列の添字の展開で、そのコマンドが動くため（最終審査の指摘。本物の bash 5.3 で確かめた）

const ctx = (shell: 'bash' | 'sh'): MatchCtx => ({ shell, windows: false, repo: noRepo, selfHosts: [] });
const classify = (command: string, shell: 'bash' | 'sh' = 'bash') => classifyStatements(command, ctx(shell));
const levelOf = (command: string, shell: 'bash' | 'sh' = 'bash'): Level => classify(command, shell).level;
const reasonsOf = (command: string) => classify(command).results.flatMap(r => r.reasons);
const arithReasons = (command: string) => reasonsOf(command).filter(r => r.key === 'list.arith');

const RUNS_RAW = [
  "x='a[$(pwn)]'; [[ x -eq 0 ]]", "x='a[$(pwn)]'; echo $((x))", "x='a[$(pwn)]'; echo $((1 + $x))", "x='a[$(pwn)]'; echo $(($x))", "echo $((x))",
  "test -v 'a[$(pwn)]'", "[ -v 'a[$(pwn)]' ]", "[[ -v 'a[$(pwn)]' ]]", "[[ 'a[$(pwn)]' -eq 0 ]]", "[[ 0 -lt 'a[$(pwn)]' ]]", "[[ $x -ge 1 ]]",
  "let 'a[$(pwn)]=1'", "declare -i n='a[$(pwn)]'", "f() { local -i n='a[$(pwn)]'; }; f", "typeset -i n='a[$(pwn)]'", "declare 'a[$(pwn)]=1'", "printf -v 'a[$(pwn)]' x",
];

test('値を式として評価する形（変数・置換・添字の入った引数）は、今回だけ。持ち主の許可でも外せない', () => {
  for (const command of RUNS_RAW) {
    assert.equal(levelOf(command), 'once', command);
    assert.equal(levelOf(command, 'sh'), 'once', `sh: ${command}`);
  }
  // 式として評価する形そのものの理由は、持ち主の許可では外せない（exempt: false）
  for (const command of [
    "x='a[$(pwn)]'; echo $((x))", "echo $((1 + $x))", "[[ x -eq 0 ]]", "[[ $n -gt 3 ]]", "test -v 'a[$(pwn)]'", "[ -v $name ]", "[[ -v 'a[$(pwn)]' ]]", "let 'a[$(pwn)]=1'", "let x=1", "declare -i n=$m", "typeset -i n=x",
    "local -i n='a[$(pwn)]'", "declare 'a[$(pwn)]=1'",
  ]) {
    const reasons = arithReasons(command);
    assert.ok(reasons.length > 0, `${command}: list.arith の理由が無い (${reasonsOf(command).map(r => r.key).join()})`);
    assert.ok(reasons.every(r => r.exempt === false && r.level === 'once'), `${command}: 外せる理由になっている`);
  }
});

test('整数の定数だけの式・普通の名前を見る -v・数の比較の [ と test は、今までどおり確かめなしで動く', () => {
  for (const command of [
    'echo $((1+2))', 'echo $(( (1 + 2) * 3 ))', 'echo $((10 % 3 - 1))', 'x=$((2*21))', 'echo $(( ))', 'echo "$((1+1))"',
    '[[ 5 -gt 3 ]]', '[[ 1 -eq 1 && 2 -lt 3 ]]', '[[ -5 -le +3 ]]', '[[ -v HOME ]]', '[[ -v PATH ]]', '[ -v HOME ]', 'test -v _x1', '[[ -f a.txt ]]', '[[ -n "$x" ]]', '[[ "$a" == "b" ]]', '[[ a < b ]]',
    // [ と test は、-eq などの両側が整数でなければ失敗するだけで、式として評価しない（本物の bash 5.3 で確かめた: 下の実機の試験）
    '[ "$n" -gt 0 ]', 'test "$a" -eq "$b"', '[ $# -eq 0 ]', "[ 'a[x]' -eq 0 ]", 'test 1 -lt 2',
    'declare x=1', 'local y', 'declare -r z=abc', 'typeset -x w=1.5', 'declare -i n=5', 'declare -i n=-5', 'let 1+2',
  ]) {
    const level = levelOf(command);
    const reasons = arithReasons(command);
    if (command.startsWith('declare') || command.startsWith('local') || command.startsWith('typeset') || command.startsWith('let')) {
      // 一覧に無い組み込みなので今回だけ（今までどおり）。式として評価する形の理由（外せない）は付かない
      assert.equal(level, 'once', command);
      assert.deepEqual(reasons, [], `${command}: 外せない理由が付いた`);
    } else {
      assert.equal(level, 'allow', `${command}: ${reasonsOf(command).map(r => r.key).join()}`);
    }
  }
});

test('数の比較の両側のうち、片方でも整数の定数でなければ今回だけ。[[ の ( ) でくくった形も（読んで通さず、止める側に倒す）', () => {
  for (const command of ['[[ 1 -eq x ]]', '[[ x -eq 1 ]]', '[[ 1 -eq $x ]]', '[[ "$x" -eq 1 ]]', '[[ ( x ) -eq 1 ]]', '[[ 1 -eq 1 && x -lt 2 ]]', '[[ 0x1f -eq 31 ]]', '[[ 1+1 -eq 2 ]]', '[[ -v a[0] ]]', '[[ -v "$n" ]]']) {
    assert.equal(levelOf(command), 'once', command);
  }
});

// 実機: 本物の Git Bash で、素のシェルでは a[$(…)] が動くこと（前提）と、[ と test の数の比較は動かないこと（それで一覧の外にしない）を確かめる
const bashPath = which('bash');
const bashOk = bashPath !== undefined && spawnSync(bashPath, ['--noprofile', '--norc', '-c', 'echo ok'], { encoding: 'utf8' }).stdout.trim() === 'ok';

test('実機（bash）: 値を式として評価する形は、素の bash では添字の $( ) が動く。[ と test の数の比較は動かない', { skip: !bashOk && 'bash が無い' }, t => {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'cwd'));
  const ran = join(dir, 'cwd', 'ran.txt');
  const script = join(dir, 'script.sh');
  const runs = (command: string): boolean => {
    rmSync(ran, { force: true });
    writeFileSync(script, `pwn() { echo ran >> ran.txt; }\n${command}`);
    spawnSync(bashPath!, ['--noprofile', '--norc', script], { cwd: join(dir, 'cwd'), encoding: 'utf8' });
    return existsSync(ran);
  };
  for (const command of RUNS_RAW.filter(c => c !== 'echo $((x))' && c !== '[[ $x -ge 1 ]]')) assert.equal(runs(command), true, `前提: 素の bash では動く: ${command}`);
  for (const command of ["[ 'a[$(pwn)]' -eq 0 ]", "test 'a[$(pwn)]' -eq 0", "x='a[$(pwn)]'; [ \"$x\" -eq 0 ]"]) {
    assert.equal(runs(command), false, `[ と test の数の比較は式として評価しない: ${command}`);
    assert.equal(levelOf(command), 'allow', command);
  }
});
