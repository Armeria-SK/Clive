import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entryMatches, parseAllowEntry } from '../src/tools/hooks/allow-entry.ts';
import { lexShell } from '../src/tools/hooks/shell-lex.ts';
import { ConfigError, defaultConfig, parseConfig, semanticProblems } from '../src/config/store.ts';
import { allowEntryRunsCode } from '../src/tools/hooks/listed-commands.ts';
import { accessWidening } from '../web/src/settings/access.ts';

// security-self-api.md §11.6: tools.shell.allow の項目は、決まったコマンドだけ（1 つの文・引用符や変数などを含まない）

test('書ける項目: 決まった語の並び', () => {
  assert.deepEqual(parseAllowEntry('npm test'), ['npm', 'test']);
  assert.deepEqual(parseAllowEntry('git status'), ['git', 'status']);
  assert.deepEqual(parseAllowEntry('  make   build  '), ['make', 'build']);
  assert.deepEqual(parseAllowEntry('npm run build:prod'), ['npm', 'run', 'build:prod']);
  assert.deepEqual(parseAllowEntry('node --test'), ['node', '--test']);
  assert.deepEqual(parseAllowEntry('docker ps'), ['docker', 'ps']);
});

test('書けない項目: 区切り・パイプ・リダイレクト・引用符・変数・ワイルドカード・置換・括弧・改行・見た目が違う文字', () => {
  const bad = [
    '', '   ', 'npm test; rm -rf .', 'npm test && rm x', 'npm test || x', 'npm test | node', 'npm test &', 'npm test > SOUL.md', 'npm test < in', 'node $x', 'node ${x}', 'echo $(ls)', 'echo `ls`',
    'curl *', 'ls *.md', 'ls ?', 'ls [a]', 'ls {a,b}', 'node "x.js"', "node 'x.js'", 'node "a b"', '(npm test)', 'npm test\nrm x', 'npm test\r', 'node \\x', 'x=1 npm test', 'ls ~', 'npm test', 'npm “test”',
    'npm –version', 'npm test ＆', '@x', '& npm', '. ./x.sh', '[io.file]::writealltext', '$x', '{ npm test }', 'if true; then npm test; fi',
  ];
  assert.deepEqual(bad.filter(entry => parseAllowEntry(entry) !== null), []);
});

test('当て方: 文の語の頭が項目とちょうど同じとき。コマンド名は Windows では大文字小文字を問わず、引数は問う', () => {
  const words = (command: string) => {
    const lexed = lexShell(command, 'bash');
    assert.equal(lexed.ok, true, command);
    return lexed.ok ? lexed.statements[0]!.words : [];
  };
  const entry = ['npm', 'test'];
  assert.equal(entryMatches(entry, words('npm test'), false), true);
  assert.equal(entryMatches(entry, words('npm test -- --watch'), false), true);
  assert.equal(entryMatches(entry, words('npm testx'), false), false);
  assert.equal(entryMatches(entry, words('npm run test'), false), false);
  assert.equal(entryMatches(entry, words('npm'), false), false);
  assert.equal(entryMatches(entry, words('npx test'), false), false);
  assert.equal(entryMatches(entry, words('NPM test'), false), false);
  assert.equal(entryMatches(entry, words('NPM test'), true), true);
  assert.equal(entryMatches(entry, words('npm Test'), true), false);
  assert.equal(entryMatches(entry, words('"npm" test'), false), true, '引用符を外した語が同じなら同じ語');
  assert.equal(entryMatches(entry, words('$c test'), false), false);
  assert.equal(entryMatches(['make'], words('make build'), false), true);
  assert.equal(entryMatches(['make'], words('makefile'), false), false);
  assert.equal(entryMatches([], words('make'), false), false);
});

test('設定を読むとき: 書けない項目は ConfigError で、場所つきで断る', () => {
  const config = defaultConfig();
  config.tools.shell.allow = ['npm test', 'npm test; rm -rf .', 'node $x'];
  const problems = semanticProblems(config);
  assert.equal(problems.filter(p => p.startsWith('tools.shell.allow:')).length, 2);
  assert.match(problems.join('\n'), /2 番目の「npm test; rm -rf \.」/u);
  assert.match(problems.join('\n'), /3 番目の「node \$x」/u);
  assert.throws(() => parseConfig(JSON.parse(JSON.stringify(config))), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.problems.length, 2);
    return true;
  });
  config.tools.shell.allow = ['npm test', 'git status', 'make build'];
  assert.deepEqual(semanticProblems(config).filter(p => p.startsWith('tools.shell.allow')), []);
  assert.doesNotThrow(() => parseConfig(JSON.parse(JSON.stringify(config))));
});

test('画面の確かめ: 一覧に無いコードを確かめずに動かす項目には、その注意が付く', () => {
  assert.equal(allowEntryRunsCode('git status'), false);
  assert.equal(allowEntryRunsCode('rg -n foo'), false);
  assert.equal(allowEntryRunsCode('git push'), false, '送信のふつうの確かめは、この項目では外れない（コードを動かすわけではない）');
  assert.equal(allowEntryRunsCode('npm test'), true, 'npm test は package.json の scripts を動かす');
  assert.equal(allowEntryRunsCode('node put.js'), true);
  assert.equal(allowEntryRunsCode('make build'), true);
  assert.equal(allowEntryRunsCode('awk'), true);
  assert.equal(allowEntryRunsCode('docker ps'), true);
  const before = { tools: { shell: { allow: ['git status'] } } };
  const after = { tools: { shell: { allow: ['git status', 'make build', 'git push', 'npm test', 'rg foo'] } } };
  assert.deepEqual(accessWidening(before, after), [
    { kind: 'shell-allow-added', command: 'make build', runsCode: true },
    { kind: 'shell-allow-added', command: 'git push', runsCode: false },
    { kind: 'shell-allow-added', command: 'npm test', runsCode: true },
    { kind: 'shell-allow-added', command: 'rg foo', runsCode: false },
  ]);
});
