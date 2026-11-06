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
    if (entry.isDirectory()) { if (!skip(entry.name)) out.push(...walk(path, skip)); } else if (/\.(?:tsx?|svg)$/u.test(entry.name)) out.push(path);
  }
  return out;
}

// 漢字・ひらがな・カタカナに加えて、日本語の句読点と記号（、。「」（）など = U+3000〜303F と、中黒 U+30FB）と全角形（！？：など = U+FF00〜FFEF）。
// 中黒と全角の記号は、文字の種類としては Han / Hiragana / Katakana に入らないので、別に数える。
const JAPANESE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|[　-〿・＀-￯]/u;

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
  // i18n/ だけが、日本語を書いてよい場所。avatars/ は SVG の絵だけ（.ts / .tsx は無い）だが、その中の文字も数える
  const files = walk(WEB, name => name === 'i18n');
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

// キー名の組み立て（`chat.kind.${x}` など）で、前半だけが分かるキーの前半。ここに書いたものだけが、「その前半で始まるキーを全部使っている」と数えられる。
// 足すときは、組み立てる側（値の種類が決まっているところ）を確かめて、ここに理由を書く。クラス名の組み立て（`pane${x}` など）は、キーに「.」が続かないので数えない。
const DYNAMIC_PREFIXES: Record<string, string> = {
  'chat.kind.': 'Composer.tsx: 入力欄の下の注記の種類ごとの文',
  'lang.': 'Palette.tsx / settings/LookSection.tsx: 言語の名前（LANGUAGES の値）',
  'mode.': 'Composer.tsx / ModeMenu.tsx / StatusBar.tsx / Chat.tsx: 権限モード（PERMISSION_MODES の値）の名前と説明（mode.normal と mode.normalDesc など）',
  'runs.seg.': 'Runs.tsx: 実行ログの切り替えの名前（実行 / 道具 / 振り返り）',
  'settings.look.motion.': 'settings/LookSection.tsx: 動きの名前（MOTIONS の値）',
  'settings.look.state.': 'settings/LookSection.tsx: 様子の見本の名前',
  'skills.seg.': 'SkillsPage.tsx: スキル・ツールの切り替えの名前',
  'worker.': 'settings/BehaviorSections.tsx: ワーカーの状態の名前',
};

test('辞書に、使われない項目が無い（キー全体が文字列で出てくるか、書き留めた「前半だけ組み立てるキー」の下にある）', () => {
  const dictionary = readFileSync(join(WEB, 'i18n', 'ja.ts'), 'utf8');
  const keys = [...dictionary.matchAll(/^ {2}'([^']+)':/gmu)].map(m => m[1]!);
  assert.ok(keys.length > 800, `${keys.length} 件しか読めていない`);
  const literals = new Set<string>();
  const templateHeads = new Set<string>();
  const literal = /(["'`])((?:\\.|(?!\1)[^\\])*?)\1/gu;
  const addFrom = (text: string): void => {
    for (const m of text.matchAll(literal)) {
      const value = m[2]!;
      if (m[1] === '`' && value.includes('${')) {
        templateHeads.add(value.slice(0, value.indexOf('${')));
        for (const inner of value.matchAll(/\$\{([^}]*)\}/gu)) addFrom(inner[1]!);
      } else literals.add(value);
    }
  };
  for (const file of walk(WEB)) {
    if (/[\\/]i18n[\\/](ja|en)\.ts$/u.test(file)) continue;
    addFrom(readFileSync(file, 'utf8'));
  }
  // 「.」で終わる前半は、キーの組み立てかもしれないので、書き留めてあるものだけを認める（書き留めていない新しいものが出たら、ここで落ちる）
  // （辞書のキーが 1 つも続かない前半 — 設定の項目の名前 `models.${id}` や、サーバーのコードの表 `engine.${key}` — は、辞書の話ではないので数えない）
  const dotHeads = [...templateHeads].filter(head => /^[a-zA-Z][\w.]*\.$/u.test(head) && keys.some(key => key.startsWith(head)));
  const unlisted = dotHeads.filter(head => !(head in DYNAMIC_PREFIXES));
  assert.deepEqual(unlisted, [], '前半だけで組み立てるキーが増えた。値の種類を確かめて、DYNAMIC_PREFIXES に理由つきで足す');
  const stale = Object.keys(DYNAMIC_PREFIXES).filter(prefix => !dotHeads.includes(prefix) || !keys.some(key => key.startsWith(prefix)));
  assert.deepEqual(stale, [], '書き留めた前半が、もう使われていない・もう辞書に無い');
  const unused = keys.filter(key => !literals.has(key) && !Object.keys(DYNAMIC_PREFIXES).some(prefix => key.startsWith(prefix)));
  assert.deepEqual(unused, []);
});
