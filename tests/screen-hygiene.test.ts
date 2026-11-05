import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// 画面（web/src）の片付けの見張り。辞書の外に日本語の文字が残っていないこと、辞書に使われない項目が溜まっていないことを、毎回の npm test で確かめる。

const WEB = join(import.meta.dirname, '..', 'web', 'src');

function walk(dir: string, skip: (name: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (!skip(entry.name)) out.push(...walk(path, skip)); } else if (/\.tsx?$/u.test(entry.name)) out.push(path);
  }
  return out;
}

const JAPANESE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u;

// コメントを外した行（行の途中の // と /* */ と JSX のコメント）。文字列の中の // は URL なので残す。
function codeLines(text: string): Array<{ no: number; code: string }> {
  const out: Array<{ no: number; code: string }> = [];
  let inBlock = false;
  text.split(/\r?\n/u).forEach((line, index) => {
    let code = line;
    if (inBlock) {
      const end = code.indexOf('*/');
      if (end < 0) return;
      code = code.slice(end + 2);
      inBlock = false;
    }
    code = code.replace(/\{\/\*.*?\*\/\}/gu, '').replace(/\/\*.*?\*\//gu, '');
    const start = code.indexOf('/*');
    if (start >= 0) { inBlock = true; code = code.slice(0, start); }
    code = code.replace(/(^|[^:'"`])\/\/.*$/u, '$1');
    out.push({ no: index + 1, code });
  });
  return out;
}

test('画面の文字は辞書に集める: web/src の辞書（i18n/）の外に、日本語の文字が無い（API に送る曜日の値だけ除く）', () => {
  const files = walk(WEB, name => name === 'i18n' || name === 'avatars');
  assert.ok(files.length > 50, `${files.length} ファイルしか読めていない`);
  const hits: string[] = [];
  for (const file of files) {
    for (const { no, code } of codeLines(readFileSync(file, 'utf8'))) {
      if (!JAPANESE.test(code)) continue;
      // 曜日の値（月〜日）は、サーバーの src/tasks/schedule.ts の DAY_MAP と対で API に送る値で、表示の文字ではない
      if (file.endsWith('weekdays.ts') && /^\s*\{ value: '[月火水木金土日]', label: 'weekday\.\w+' \},?\s*$/u.test(code)) continue;
      hits.push(`${file.slice(WEB.length + 1)}:${no}: ${code.trim().slice(0, 100)}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('辞書に、使われない項目が無い（文字列として、または `…${}` の前半・キー名の前半として、どこかで使われている）', () => {
  const dictionary = readFileSync(join(WEB, 'i18n', 'ja.ts'), 'utf8');
  const keys = [...dictionary.matchAll(/^ {2}'([^']+)':/gmu)].map(m => m[1]!);
  assert.ok(keys.length > 800, `${keys.length} 件しか読めていない`);
  const literals = new Set<string>();
  const prefixes = new Set<string>();
  const literal = /(["'`])((?:\\.|(?!\1)[^\\])*?)\1/gu;
  const addFrom = (text: string): void => {
    for (const m of text.matchAll(literal)) {
      const value = m[2]!;
      if (m[1] === '`' && value.includes('${')) {
        prefixes.add(value.slice(0, value.indexOf('${')));
        for (const inner of value.matchAll(/\$\{([^}]*)\}/gu)) addFrom(inner[1]!);
      } else literals.add(value);
      if (/^[a-zA-Z][\w.]*\.$/u.test(value)) prefixes.add(value);
    }
  };
  for (const file of walk(WEB)) {
    if (/[\\/]i18n[\\/](ja|en)\.ts$/u.test(file)) continue;
    addFrom(readFileSync(file, 'utf8'));
  }
  const unused = keys.filter(key => !literals.has(key) && ![...prefixes].some(prefix => prefix !== '' && key.startsWith(prefix)));
  assert.deepEqual(unused, []);
});
