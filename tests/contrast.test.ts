import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

const read = (path: string) => readFileSync(new URL(`../web/src/${path}`, import.meta.url), 'utf8').replace(/\r/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const tokensCss = read('styles/tokens.css');

function tokensOf(selector: string): Map<string, string> {
  const start = tokensCss.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `tokens.css に ${selector} が無い`);
  const body = tokensCss.slice(tokensCss.indexOf('{', start) + 1, tokensCss.indexOf('\n}', start));
  return new Map([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(m => [m[1]!, m[2]!.trim()]));
}
const light = tokensOf(':root');
const dark = new Map([...light, ...tokensOf(':root[data-theme="dark"]')]);

function parse(tokens: Map<string, string>, expr: string, depth = 0): Rgba {
  assert.ok(depth < 10, `循環している: ${expr}`);
  let m: RegExpExecArray | null;
  if ((m = /^#([0-9a-f]{6})$/i.exec(expr))) return [0, 2, 4].map(i => parseInt(m![1]!.slice(i, i + 2), 16)).concat(1) as Rgba;
  if ((m = /^var\((--[a-z0-9-]+)\)$/.exec(expr))) {
    const value = tokens.get(m[1]!);
    assert.ok(value, `${m[1]} が定義されていない`);
    return parse(tokens, value, depth + 1);
  }
  if ((m = /^color-mix\(in srgb, (.+) (\d+(?:\.\d+)?)%, transparent\)$/.exec(expr))) {
    const c = parse(tokens, m[1]!, depth + 1);
    return [c[0], c[1], c[2], c[3] * Number(m[2]) / 100];
  }
  throw new Error(`読めない値: ${expr}`);
}
const token = (tokens: Map<string, string>, name: string) => parse(tokens, `var(${name})`);

const over = (fg: Rgba, ground: Rgb): Rgb => [0, 1, 2].map(i => fg[i]! * fg[3] + ground[i]! * (1 - fg[3])) as Rgb;
const luminance = (c: Rgb) => { const [r, g, b] = c.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }) as Rgb; return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a: Rgb, b: Rgb) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]; return (hi + 0.05) / (lo + 0.05); };

function grounds(tokens: Map<string, string>): Record<string, Rgb> {
  const bg = token(tokens, '--color-bg').slice(0, 3) as Rgb;
  const surface = token(tokens, '--color-surface').slice(0, 3) as Rgb;
  const ink = token(tokens, '--color-text');
  const wash = (g: Rgb, a: number): Rgb => over([ink[0], ink[1], ink[2], a], g);
  return { 背景: bg, 面: surface, '背景+文字色7%（選択・ホバーの面）': wash(bg, 0.07), '面+文字色7%': wash(surface, 0.07) };
}

function assertAA(tokens: Map<string, string>, name: string, on: Record<string, Rgb>, min = 4.5) {
  const fg = token(tokens, name);
  for (const [label, ground] of Object.entries(on)) {
    const r = ratio(over(fg, ground), ground);
    assert.ok(r >= min, `${name} が ${label} の上で ${r.toFixed(2)}:1（${min}:1 未満）`);
  }
}

test('ライト: アクセント色の文字（リンク・主ボタン・ghost・枠だけの札）は、背景・面・押したときの色の上で 4.5:1 以上', () => {
  const g = grounds(light);
  const accent = token(light, '--color-accent').slice(0, 3) as Rgb;
  const tinted = Object.fromEntries([['主ボタンのホバー（accent 12%）', 0.12], ['主ボタンの押下（accent 22%）', 0.22], ['ghost の押下（accent 18%）', 0.18]]
    .map(([label, a]) => [label as string, over([...accent, a as number] as Rgba, g['背景']!)]));
  assertAA(light, '--color-accent-text', { ...g, ...tinted });
  assertAA(light, '--color-accent-text-hover', { 背景: g['背景']!, 面: g['面']! });
});

test('ライト: 薄い文字の 3 段階は、背景・面・選択の面の上で 4.5:1 以上', () => {
  const g = grounds(light);
  for (const name of ['--color-text-muted', '--color-text-muted-soft', '--color-text-muted-faint']) assertAA(light, name, g);
});

test('ライト: 塗りのアクセント色（--color-accent）は変えていない（金色のまま）', () => {
  assert.deepEqual(token(light, '--color-accent'), [0xb6, 0x82, 0x35, 1]);
});

test('ダーク: 文字の色はデザインの値のまま（アクセントは --color-accent、薄い文字は 60 / 55 / 50%）', () => {
  assert.deepEqual(token(dark, '--color-accent-text'), token(dark, '--color-accent'));
  assert.deepEqual(token(dark, '--color-accent-text-hover'), token(dark, '--color-accent-600'));
  const ink = token(dark, '--color-text');
  const at = (a: number): Rgba => [ink[0], ink[1], ink[2], a];
  assert.deepEqual(token(dark, '--color-text-muted'), at(0.6));
  assert.deepEqual(token(dark, '--color-text-muted-soft'), at(0.55));
  assert.deepEqual(token(dark, '--color-text-muted-faint'), at(0.5));
  assertAA(dark, '--color-accent-text', grounds(dark));
});

function textColorDeclarations(path: string) {
  const out: Array<{ selector: string; value: string }> = [];
  for (const m of read(path).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const decl of m[2]!.split(';')) {
      const i = decl.indexOf(':');
      if (i !== -1 && decl.slice(0, i).trim() === 'color') out.push({ selector: m[1]!.trim().replace(/\s+/g, ' '), value: decl.slice(i + 1).trim() });
    }
  }
  return out;
}

test('CSS: 文字色にアクセントの塗りの色を直接使わず、薄い文字は 67% 未満の直書きをしない', () => {
  const all = ['styles.css', 'styles/components.css'].flatMap(p => textColorDeclarations(p).map(d => ({ ...d, file: p })));
  assert.ok(all.length > 20, `文字色の宣言が ${all.length} 件しか読めていない`);
  const rawAccent = all.filter(d => /^var\(--(color-)?accent\)$/.test(d.value));
  assert.deepEqual(rawAccent, [], '文字色は --color-accent-text を使う');
  const thin = all.filter(d => {
    const m = /^color-mix\(in srgb, var\(--color-text\) (\d+(?:\.\d+)?)%, transparent\)$/.exec(d.value);
    return m && Number(m[1]) < 67 && !d.selector.includes('::placeholder');
  });
  assert.deepEqual(thin, [], '薄い文字は --color-text-muted 系のトークンを使う（placeholder だけは対象外）');
});
