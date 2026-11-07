// 題・一覧の項目（plainLine）と、知らせの本文（plainBlock）を無害な形に整える。
// 向きを変える文字・幅の無い文字・見えにくい文字を消し、制御文字を空白 1 つにして、空白を詰めて、max 文字に切る。

const BIDI = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/gu;
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180D\u180E\u2061-\u2064\u2800\u3164\uFE00-\uFE0E\uFFA0\uFFF9-\uFFFB]/gu;
export const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;
// \u30BF\u30B0\u306E\u6587\u5B57\uFF08U+E0000\u301CU+E007F\uFF09\u306F\u898B\u3048\u306A\u3044\u307E\u307E\u6587\u3092\u904B\u3079\u308B\u306E\u3067\u6D88\u3059\u3002\u6B8B\u3059\u306E\u306F\u3001\u7D75\u6587\u5B57\u3068\u3057\u3066\u6C7A\u307E\u3063\u3066\u3044\u308B
// 3 \u3064\u306E\u65D7\uFF08\u30A4\u30F3\u30B0\u30E9\u30F3\u30C9 gbeng\u30FB\u30B9\u30B3\u30C3\u30C8\u30E9\u30F3\u30C9 gbsct\u30FB\u30A6\u30A7\u30FC\u30EB\u30BA gbwls\uFF09\u3060\u3051\u3002\u4EFB\u610F\u306E\u30BF\u30B0\u5217\u3092\u65D7\u3068\u3057\u3066\u6B8B\u3059\u3068\u3001\u305D\u3053\u306B\u6587\u3092\u96A0\u305B\u308B
const TAGS = /(\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F})|([\u{E0000}-\u{E007F}])/gu;

// 向きを変える文字・幅の無い文字・見えにくい文字・タグの文字を消す（制御文字と空白は触らない）。ファイル名など、別の整え方をする所も同じ文字を落とせるよう出している
export const stripHidden = (text: string): string =>
  text
    .replace(BIDI, '')
    .replace(ZERO_WIDTH, '')
    .replace(INVISIBLE, '')
    .replace(TAGS, (m, flag) => flag ?? '');

const cleanLine = (line: string): string =>
  stripHidden(line)
    .replace(CONTROL, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

const cut = (text: string, max: number): string => Array.from(text).slice(0, max).join('');

// 題・一覧の項目。改行も空白として扱う
export function plainLine(text: string, max: number): string {
  return cut(cleanLine(text), max);
}

// 知らせの本文。改行は残し、3 つ以上続く改行は 2 つにする
export function plainBlock(text: string, max: number): string {
  const normalized = text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
  const joined = normalized.split('\n').map(cleanLine).join('\n').replace(/\n{3,}/gu, '\n\n');
  return cut(joined, max);
}
