import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { removeEnvValue, setEnvValue } from '../src/env-file.ts';
import { keyEnvName, keyProblem, MAX_KEY_CHARS, isSecretEnvName } from '../src/shared/provider-key.ts';
import { tempDir } from './helpers.ts';

// 段 9f: API キーを .env に書く部分。ほかの行・コメント・順番を残し、一時ファイルに書いてから置き換え、控えは 1 つ、Linux では 0600
const POSIX = process.platform !== 'win32';

function fixture(t: { after: (fn: () => void) => void }, content?: string) {
  const dir = tempDir(t);
  const path = join(dir, '.env');
  if (content !== undefined) writeFileSync(path, content);
  return { dir, path, text: () => readFileSync(path, 'utf8'), files: () => readdirSync(dir).sort() };
}

test('.env が無ければ作る。1 行だけ、改行で終わる', t => {
  const f = fixture(t);
  setEnvValue(f.path, 'CLIVE_X_API_KEY', 'sk-new-0001');
  assert.equal(f.text(), 'CLIVE_X_API_KEY=sk-new-0001\n');
  assert.deepEqual(f.files(), ['.env'], '元が無いので控えも無い');
});

test('ほかの行・コメント・空行・順番はそのまま。同じ名前の行だけ置き換える（名前が似ている行は触らない）', t => {
  const original = '# 鍵\nANTHROPIC_API_KEY=sk-ant-old\n\nCLIVE_X_API_KEY=old # メモ\nCLIVE_X_API_KEY_2=other\nexport FOO=bar\n# end\n';
  const f = fixture(t, original);
  setEnvValue(f.path, 'CLIVE_X_API_KEY', 'sk-new-0002');
  assert.equal(f.text(), '# 鍵\nANTHROPIC_API_KEY=sk-ant-old\n\nCLIVE_X_API_KEY=sk-new-0002\nCLIVE_X_API_KEY_2=other\nexport FOO=bar\n# end\n');
  const parsed = parseEnv(f.text());
  assert.equal(parsed.CLIVE_X_API_KEY, 'sk-new-0002');
  assert.equal(parsed.CLIVE_X_API_KEY_2, 'other');
  assert.equal(parsed.ANTHROPIC_API_KEY, 'sk-ant-old');
});

test('export 付きの行は export を残して置き換える。同じ名前が複数あれば 1 行にまとめる（古い鍵を残さない）', t => {
  const f = fixture(t, 'A=1\nexport K_API_KEY=old1\nB=2\nK_API_KEY="old2"\n');
  setEnvValue(f.path, 'K_API_KEY', 'fresh');
  assert.equal(f.text(), 'A=1\nexport K_API_KEY=fresh\nB=2\n');
  assert.equal(readFileSync(`${f.path}.bak`, 'utf8'), 'A=1\nexport K_API_KEY=old1\nB=2\nK_API_KEY="old2"\n');
});

test('無ければ末尾に足す。末尾が改行で終わっていなくても、前の行とつながらない。CRLF のファイルは CRLF で足す', t => {
  const plain = fixture(t, 'A=1');
  setEnvValue(plain.path, 'K_API_KEY', 'v');
  assert.equal(plain.text(), 'A=1\nK_API_KEY=v\n');
  const crlf = fixture(t, 'A=1\r\n# c\r\nB=2\r\n');
  setEnvValue(crlf.path, 'K_API_KEY', 'v');
  assert.equal(crlf.text(), 'A=1\r\n# c\r\nB=2\r\nK_API_KEY=v\r\n');
  setEnvValue(crlf.path, 'B', 'x');
  assert.equal(crlf.text(), 'A=1\r\n# c\r\nB=x\r\nK_API_KEY=v\r\n', '置き換えた行も元の改行を保つ');
});

test('複数行の引用符つきの値も、その鍵の行だけを置き換える（続きの行が残らない）', t => {
  const f = fixture(t, 'A=1\nK_API_KEY="line1\nline2"\nB=2\n');
  setEnvValue(f.path, 'K_API_KEY', 'v');
  assert.equal(f.text(), 'A=1\nK_API_KEY=v\nB=2\n');
});

test('控え（.env.bak）は 1 つだけ。2 回書くと、直前の内容に入れ替わる。一時ファイルは残らない', t => {
  const f = fixture(t, 'K_API_KEY=first\n');
  setEnvValue(f.path, 'K_API_KEY', 'second');
  assert.equal(readFileSync(`${f.path}.bak`, 'utf8'), 'K_API_KEY=first\n');
  setEnvValue(f.path, 'K_API_KEY', 'third');
  assert.equal(readFileSync(`${f.path}.bak`, 'utf8'), 'K_API_KEY=second\n');
  assert.deepEqual(f.files(), ['.env', '.env.bak']);
});

test('置き換えは一時ファイルからの置き換え: 同じファイルに別の名前（ハードリンク）があっても、書き換え後も元の中身のまま（その場で上書きしていない）', t => {
  const f = fixture(t, 'K_API_KEY=old\nOTHER=1\n');
  const link = join(f.dir, 'old-link');
  linkSync(f.path, link);
  setEnvValue(f.path, 'K_API_KEY', 'new');
  assert.equal(readFileSync(link, 'utf8'), 'K_API_KEY=old\nOTHER=1\n', '古い中身を指したまま');
  assert.equal(f.text(), 'K_API_KEY=new\nOTHER=1\n');
});

test('書けなかったとき（.env がフォルダ）は、何も壊さず、一時ファイルも残さず、投げる。鍵は文に入らない', t => {
  const dir = tempDir(t);
  const path = join(dir, '.env');
  mkdirSync(path);
  const secret = 'sk-never-in-error-7777';
  assert.throws(() => setEnvValue(path, 'K_API_KEY', secret), (error: unknown) => error instanceof Error && !String(error.stack).includes(secret));
  assert.deepEqual(readdirSync(dir).sort(), ['.env']);
  assert.equal(statSync(path).isDirectory(), true);
});

test('リンクの .env には書かない（置き換えるとリンクが外れ、リンク先の中身を写してしまうため）', t => {
  const dir = tempDir(t);
  const target = join(dir, 'real');
  writeFileSync(target, 'X=1\n');
  const path = join(dir, '.env');
  try { symlinkSync(target, path); } catch { t.skip('この環境ではシンボリックリンクを作れない'); return; }
  assert.throws(() => setEnvValue(path, 'K_API_KEY', 'v'));
  assert.equal(readFileSync(target, 'utf8'), 'X=1\n');
});


test('Linux: .env は 0600 で作る・保つ。元がゆるい権限でも、新しい .env と控えは 0600', { skip: !POSIX }, t => {
  const created = fixture(t);
  setEnvValue(created.path, 'K_API_KEY', 'v');
  assert.equal(statSync(created.path).mode & 0o777, 0o600);
  const loose = fixture(t, 'A=1\n');
  chmodSync(loose.path, 0o644);
  setEnvValue(loose.path, 'K_API_KEY', 'v');
  assert.equal(statSync(loose.path).mode & 0o777, 0o600);
  assert.equal(statSync(`${loose.path}.bak`).mode & 0o777, 0o600);
});

test('どんな文字の鍵も、起動で読み込むのと同じ読み方で、そのまま読み戻せる（# ・引用符・空白・= ・$ ・バックスラッシュ・日本語）', t => {
  const BS = String.fromCharCode(92);
  const values = ['sk-abc_123', 'a b', 'a#b', 'a #b', "it's", 'q"q', 'back`tick', 'a=b=c', `x${BS}y`, '$HOME', '${X}', 'あいう', "'lead", '"lead', '`lead', '#start', `a${BS}nb`, `end${BS}`, `a${BS}"b`, 'sp  ace'];
  for (const value of values) {
    const f = fixture(t, 'FIRST=1\nLAST=2\n');
    setEnvValue(f.path, 'K_API_KEY', value);
    const parsed = parseEnv(f.text());
    assert.equal(parsed.K_API_KEY, value, JSON.stringify(value));
    assert.equal(parsed.FIRST, '1');
    assert.equal(parsed.LAST, '2');
  }
});

test('三種類の引用符と # を全部含む鍵は、安全に書けないので投げる（.env は変えない）', t => {
  const f = fixture(t, 'A=1\n');
  assert.throws(() => setEnvValue(f.path, 'K_API_KEY', `#'"\`x`));
  assert.equal(f.text(), 'A=1\n');
  assert.deepEqual(f.files(), ['.env']);
});

test('消す: 同じ名前の行をすべて外し、ほかは残す。控えを作る。無ければ何もしない（ファイルも作らない）', t => {
  const f = fixture(t, '# c\nK_API_KEY=a\nB=2\nexport K_API_KEY=b\n');
  assert.equal(removeEnvValue(f.path, 'K_API_KEY'), true);
  assert.equal(f.text(), '# c\nB=2\n');
  assert.equal(readFileSync(`${f.path}.bak`, 'utf8'), '# c\nK_API_KEY=a\nB=2\nexport K_API_KEY=b\n');
  assert.equal(removeEnvValue(f.path, 'K_API_KEY'), false);
  assert.equal(f.text(), '# c\nB=2\n');
  const none = fixture(t);
  assert.equal(removeEnvValue(none.path, 'K_API_KEY'), false);
  assert.deepEqual(none.files(), []);
});

test('鍵の検査（keyProblem）: 空・改行・制御文字・半角以外の文字・前後の空白・長すぎるものは断る。途中の空白と = は許す', () => {
  const ch = (code: number) => String.fromCharCode(code);
  assert.equal(keyProblem(''), 'empty');
  assert.equal(keyProblem('   '), 'empty');
  const chars = ['a\nb', 'a\r\nb', 'abc\n', '\nabc', 'a\tb', `a${ch(0)}b`, `a${ch(0x1b)}b`, `a${ch(0x7f)}b`, `a${ch(0x85)}b`, `a${ch(0x2028)}b`, `a${ch(0x2029)}b`, `${ch(0xa0)}abc`, `abc${ch(0x3000)}`, `a${ch(0x3042)}`, `key-${ch(0x30ad)}${ch(0x30fc)}`, `${ch(0xff41)}${ch(0xff42)}${ch(0xff43)}`];
  for (const bad of chars) assert.equal(keyProblem(bad), 'chars', JSON.stringify(bad));
  for (const bad of [' abc', 'abc ', ' abc ']) assert.equal(keyProblem(bad), 'padded', JSON.stringify(bad));
  assert.equal(keyProblem('x'.repeat(MAX_KEY_CHARS + 1)), 'too_long');
  assert.equal(keyProblem('x'.repeat(MAX_KEY_CHARS)), undefined);
  for (const ok of ['sk-ant-api03-AbC_dEf-123', 'a b', 'key=value==', '~!@#$%^&*()_+{}|:<>?']) assert.equal(keyProblem(ok), undefined, ok);
});

test('環境変数の名前: あればその名前、Anthropic は ANTHROPIC_API_KEY、ほかは ID から作る（- は _ に）。ほかのプロバイダと同じ名前になるときは番号を足す', () => {
  assert.equal(keyEnvName({ id: 'fake', kind: 'openai_compatible', apiKeyEnv: 'FAKE_KEY' }), 'FAKE_KEY');
  assert.equal(keyEnvName({ id: 'anthropic', kind: 'anthropic' }), 'ANTHROPIC_API_KEY');
  assert.equal(keyEnvName({ id: 'my-llm', kind: 'openai_compatible' }), 'CLIVE_MY_LLM_API_KEY');
  assert.equal(keyEnvName({ id: 'a_b', kind: 'ollama' }), 'CLIVE_A_B_API_KEY');
  assert.equal(keyEnvName({ id: 'a-b', kind: 'ollama' }, new Set(['CLIVE_A_B_API_KEY'])), 'CLIVE_A_B_API_KEY_2');
  assert.equal(keyEnvName({ id: 'a-b', kind: 'ollama' }, new Set(['CLIVE_A_B_API_KEY', 'CLIVE_A_B_API_KEY_2'])), 'CLIVE_A_B_API_KEY_3');
  assert.match(keyEnvName({ id: 'x'.repeat(40), kind: 'ollama' }), /^[A-Z][A-Z0-9_]{0,63}$/u, '一番長い ID でも名前の形に収まる');
});

test('鍵を持つ名前だけを書く（isSecretEnvName）: PATH などの環境変数は、鍵の名前として書き換えない', () => {
  for (const ok of ['ANTHROPIC_API_KEY', 'FAKE_KEY', 'MY_TOKEN', 'SVC_SECRET', 'DB_PASSWORD']) assert.equal(isSecretEnvName(ok), true, ok);
  for (const bad of ['PATH', 'NODE_OPTIONS', 'HOME', 'LD_PRELOAD', 'HTTP_PROXY', 'GIT_SSH_COMMAND']) assert.equal(isSecretEnvName(bad), false, bad);
});
