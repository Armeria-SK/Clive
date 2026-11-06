// 題・一覧の項目（plainLine）と、知らせの本文（plainBlock）を無害な形に整える。
// 向きを変える文字・幅の無い文字を消し、制御文字を空白 1 つにして、空白を詰めて、max 文字に切る。

const BIDI = /[‎‏‪-‮⁦-⁩]/gu;
const ZERO_WIDTH = /[​-‍⁠﻿]/gu;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;

const cleanLine = (line: string): string =>
  line
    .replace(BIDI, '')
    .replace(ZERO_WIDTH, '')
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
