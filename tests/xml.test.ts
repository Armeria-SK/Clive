import assert from 'node:assert/strict';
import { test } from 'node:test';
import { XML_LIMITS, localName, parseXml } from '../src/shared/xml.ts';
import type { XmlHandlers, XmlLimits, XmlResult } from '../src/shared/xml.ts';

function run(source: string, limits?: Partial<XmlLimits>, stopAt?: string): { result: XmlResult; events: string[] } {
  const events: string[] = [];
  const note = (event: string): void | 'stop' => {
    events.push(event);
    if (event === stopAt) return 'stop';
  };
  const handlers: XmlHandlers = {
    open: (name, attrs, selfClosing) => note(`open ${name}${selfClosing ? ' self' : ''}${Object.keys(attrs).length ? ' ' + JSON.stringify(attrs) : ''}`),
    close: (name) => note(`close ${name}`),
    text: (text) => note(`text ${text}`),
  };
  return { result: parseXml(source, handlers, limits), events };
}

const text = (source: string): string[] => run(source).events.filter((event) => event.startsWith('text ')).map((event) => event.slice(5));
const reason = (source: string, limits?: Partial<XmlLimits>): string => {
  const { result } = run(source, limits);
  return result.ok ? 'ok' : result.reason;
};
const nothingCalled = (source: string): void => {
  const { result, events } = run(source);
  assert.deepEqual(result, { ok: false, reason: 'dtd' });
  assert.deepEqual(events, []);
};
const within = (ms: number, work: () => void): void => {
  const started = performance.now();
  work();
  const took = performance.now() - started;
  assert.ok(took < ms, `${Math.round(took)} ms がかかった（${ms} ms 以内のはず）`);
};

test('parseXml: 呼び返しの順（open・text・close・自己終了）', () => {
  const { result, events } = run('<a x="1"><b>hi</b><c/></a>');
  assert.deepEqual(result, { ok: true, stopped: false });
  assert.deepEqual(events, ['open a {"x":"1"}', 'open b', 'text hi', 'close b', 'open c self', 'close c', 'close a']);
});

test('parseXml: 決まった 5 つと数の実体だけを文字にする', () => {
  assert.deepEqual(text('<a>&lt;&amp;&#x41;&#66;&apos;</a>'), ["<&AB'"]);
  assert.deepEqual(text('<a>&gt;&quot;&#x1F600;&#x10FFFF;</a>'), ['>"\u{1F600}\u{10FFFF}']);
  assert.deepEqual(text('<a>&#9;&#10;&#13;&#x9;</a>'), ['\t\n\r\t']);
});

test('parseXml: 知らない名前・; の無い & ・数字の無い数はそのまま残す', () => {
  assert.deepEqual(text('<a>&foo;</a>'), ['&foo;']);
  assert.deepEqual(text('<a>a & b</a>'), ['a & b']);
  assert.deepEqual(text('<a>&amp &lt &#65 &#x41 &# &#x; &#xZ; &#X41; &AMP; &;</a>'), ['&amp &lt &#65 &#x41 &# &#x; &#xZ; &#X41; &AMP; &;']);
  assert.deepEqual(text('<a>&&amp;&</a>'), ['&&&']);
});

test('parseXml: XML で使えない数は U+FFFD にする', () => {
  for (const ref of ['&#0;', '&#xD800;', '&#xDFFF;', '&#x110000;', '&#1;', '&#x1F;', '&#xFFFE;', '&#xFFFF;', '&#99999999999999999999;', '&#x' + 'F'.repeat(400) + ';']) {
    assert.deepEqual(text(`<a>${ref}</a>`), ['\uFFFD'], ref);
  }
  assert.deepEqual(text('<a>&#x0000000041;&#0000066;</a>'), ['AB']);
});

test('parseXml: 属性の値でも同じ実体だけを広げ、引用符は " と \' の両方', () => {
  const { events } = run(`<a x="&lt;&amp;&quot;&#65;&foo;" y='"' z="'"/>`);
  assert.deepEqual(events[0], `open a self ${JSON.stringify({ x: '<&"A&foo;', y: '"', z: "'" })}`);
});

test('parseXml: billion laughs は dtd で、呼び返しが 1 つも呼ばれない', () => {
  nothingCalled('<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><a>&lol2;</a>');
});

test('parseXml: 外部実体は dtd で、text が一度も呼ばれない', () => {
  const { result, events } = run('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>');
  assert.deepEqual(result, { ok: false, reason: 'dtd' });
  assert.equal(events.filter((event) => event.startsWith('text')).length, 0);
  assert.deepEqual(events, []);
});

test('parseXml: DOCTYPE・ENTITY は、どこにあっても（後ろ・小文字・コメントや CDATA の中でも）dtd で何も呼ばない', () => {
  nothingCalled('<a>x</a><!DOCTYPE a>');
  nothingCalled('<a><!ENTITY x "y"></a>');
  nothingCalled('<!doctype html><a/>');
  nothingCalled('<a/><!EnTiTy x "y">');
  nothingCalled('<a><!-- <!DOCTYPE --></a>');
  nothingCalled('<a><![CDATA[<!ENTITY]]></a>');
  nothingCalled('<?xml version="1.0"?><!DOCTYPE a SYSTEM "a.dtd"><a/>');
  assert.equal(reason('<a>&lt;!DOCTYPE</a>'), 'ok');
  assert.equal(reason('<a>DOCTYPE ENTITY</a>'), 'ok');
});

test('parseXml: dtd は他の上限より先に決まる（読む前に断る）', () => {
  assert.equal(reason('<!DOCTYPE a><a/>', { maxDepth: 0 }), 'dtd');
  assert.equal(reason('<!DOCTYPE a><a/>', { maxChars: 1 }), 'too_large');
});

test('parseXml: CDATA は中身をそのまま文字にし、コメントと処理命令は何も呼ばない', () => {
  assert.deepEqual(run('<a><![CDATA[<b>&lt;</b>]]></a>').events, ['open a', 'text <b>&lt;</b>', 'close a']);
  assert.deepEqual(run('<!-- <x> --><a><!-- <y> --></a>').events, ['open a', 'close a']);
  assert.deepEqual(run('<?xml version="1.0"?><a><?pi data?></a>').events, ['open a', 'close a']);
  assert.deepEqual(run('<a><![CDATA[]]></a>').events, ['open a', 'close a']);
  assert.deepEqual(text('<a>x<![CDATA[y]]>z<!--c-->w</a>'), ['x', 'y', 'z', 'w']);
});

test('parseXml: 属性の値の > と / は値の一部', () => {
  assert.deepEqual(run('<a x="1>2"/>').events, ['open a self {"x":"1>2"}', 'close a']);
  assert.deepEqual(run(`<a x='a/>b' y = "c" ></a>`).events, ['open a {"x":"a/>b","y":"c"}', 'close a']);
});

test('parseXml: 壊れた入力は malformed', () => {
  for (const source of [
    '<a x=1/>',
    '<a x="1" x="2"/>',
    '<a><b></a>',
    '<a>',
    '<>',
    '<',
    '</a>',
    '<a></b>',
    '<a/></a>',
    '<a x/>',
    '<a =1/>',
    '<a x="1/>',
    '<a x="1"y="2"/>',
    '<a / >',
    '<a',
    '<a x',
    '<a x=',
    '<a x="',
    '<1a/>',
    '<a$b/>',
    '</>',
    '</a x="1">',
    '</a',
    '<a><!-- x </a>',
    '<a><![CDATA[ x </a>',
    '<a><? x </a>',
    '<a><!x></a>',
    '<a><![INCLUDE[x]]></a>',
    '<a><!-->x</a>',
    '<a<b/>',
  ]) {
    assert.equal(reason(source), 'malformed', source);
  }
});

test('parseXml: 空の入力と、要素の外の文字・複数の根は、決まりが無いので何も足さずにそのまま通す', () => {
  assert.deepEqual(run(''), { result: { ok: true, stopped: false }, events: [] });
  assert.deepEqual(run('t<a/><b/>').events, ['text t', 'open a self', 'close a', 'open b self', 'close b']);
});

test('parseXml: 閉じタグの前の空白は許す', () => {
  assert.deepEqual(run('<a ></a ><b/>').events, ['open a', 'close a', 'open b self', 'close b']);
});

test('parseXml: 入れ子の上限（maxDepth）', () => {
  assert.equal(reason('<a><b><c></c></b></a>', { maxDepth: 3 }), 'ok');
  assert.equal(reason('<a><b><c><d></d></c></b></a>', { maxDepth: 3 }), 'too_deep');
  assert.equal(reason('<a><b><c><d/></c></b></a>', { maxDepth: 3 }), 'too_deep');
  assert.equal(reason('<a><b/><b/><b/></a>', { maxDepth: 2 }), 'ok');
  assert.equal(reason('<a/>', { maxDepth: 0 }), 'too_deep');
  const nested = (levels: number): string => '<a>'.repeat(levels) + '</a>'.repeat(levels);
  assert.equal(reason(nested(XML_LIMITS.maxDepth)), 'ok');
  assert.equal(reason(nested(XML_LIMITS.maxDepth + 1)), 'too_deep');
  assert.equal(run('<a>'.repeat(5), { maxDepth: 3 }).events.length, 3);
});

test('parseXml: 文字数の上限（maxChars）は読む前に断る', () => {
  assert.equal(reason('<a>123</a>', { maxChars: 10 }), 'ok');
  const over = run('<a>1234</a>', { maxChars: 10 });
  assert.deepEqual(over.result, { ok: false, reason: 'too_large' });
  assert.deepEqual(over.events, []);
  assert.equal(XML_LIMITS.maxChars, 32 * 1024 * 1024);
  assert.equal(reason('', { maxChars: 0 }), 'ok');
  assert.equal(reason('<', { maxChars: 0 }), 'too_large');
});

test('parseXml: 属性の数と名前の長さの上限は malformed', () => {
  assert.equal(reason('<a x="1" y="2"/>', { maxAttrs: 2 }), 'ok');
  assert.equal(reason('<a x="1" y="2" z="3"/>', { maxAttrs: 2 }), 'malformed');
  assert.equal(reason('<a x="1"/>', { maxAttrs: 0 }), 'malformed');
  assert.equal(reason('<abcde/>', { maxNameLength: 5 }), 'ok');
  assert.equal(reason('<abcdef/>', { maxNameLength: 5 }), 'malformed');
  assert.equal(reason('</abcdef>', { maxNameLength: 5 }), 'malformed');
  assert.equal(reason('<a abcde="1"/>', { maxNameLength: 5 }), 'ok');
  assert.equal(reason('<a abcdef="1"/>', { maxNameLength: 5 }), 'malformed');
  assert.deepEqual([XML_LIMITS.maxDepth, XML_LIMITS.maxAttrs, XML_LIMITS.maxNameLength], [256, 256, 256]);
  const attrs = (count: number): string => '<a ' + Array.from({ length: count }, (_, i) => `n${i}="v"`).join(' ') + '/>';
  assert.equal(reason(attrs(XML_LIMITS.maxAttrs)), 'ok');
  assert.equal(reason(attrs(XML_LIMITS.maxAttrs + 1)), 'malformed');
});

test('parseXml: 上限の指定が一部でも、残りは既定のまま', () => {
  assert.equal(reason('<a/>', { maxDepth: 5 }), 'ok');
  assert.equal(reason('<a>' + 'x'.repeat(1000) + '</a>', { maxNameLength: 1 }), 'ok');
});

test("parseXml: 'stop' でそこで止まり、あとの呼び返しは無い", () => {
  const a = run('<a><b>hi</b><c/></a>', undefined, 'text hi');
  assert.deepEqual(a.result, { ok: true, stopped: true });
  assert.deepEqual(a.events, ['open a', 'open b', 'text hi']);
  const b = run('<a><b/></a>', undefined, 'open b self');
  assert.deepEqual(b.result, { ok: true, stopped: true });
  assert.deepEqual(b.events, ['open a', 'open b self']);
  const c = run('<a><b/>', undefined, 'close b');
  assert.deepEqual(c.result, { ok: true, stopped: true });
  assert.deepEqual(c.events, ['open a', 'open b self', 'close b']);
  const d = run('<a>x</a>', undefined, 'close a');
  assert.deepEqual(d.result, { ok: true, stopped: true });
  const e = run('<a><![CDATA[x]]><b/></a>', undefined, 'text x');
  assert.deepEqual(e.events, ['open a', 'text x']);
});

test("parseXml: 'stop' 以外の返り値では止まらない", () => {
  const events: string[] = [];
  const result = parseXml('<a>x</a>', { open: () => undefined, text: (t) => { events.push(t); } });
  assert.deepEqual(result, { ok: true, stopped: false });
  assert.deepEqual(events, ['x']);
});

test('parseXml: 止めたあとの壊れた部分は読まない（dtd だけは先に断る）', () => {
  assert.deepEqual(run('<a>x</b>', undefined, 'text x').result, { ok: true, stopped: true });
  assert.deepEqual(run('<a>x</a><!DOCTYPE a>', undefined, 'text x').result, { ok: false, reason: 'dtd' });
});

test('parseXml: 属性は __proto__ や constructor という名前でも普通の項目で、同名の 2 つ目は malformed', () => {
  let seen: Record<string, string> = {};
  parseXml('<a __proto__="1" constructor="2" toString="3"/>', { open: (_name, attrs) => { seen = { ...attrs }; } });
  assert.deepEqual(Object.keys(seen), ['__proto__', 'constructor', 'toString']);
  assert.equal(Object.getOwnPropertyDescriptor(seen, '__proto__')?.value, '1');
  assert.equal(reason('<a __proto__="1" __proto__="2"/>'), 'malformed');
  assert.equal(reason('<a constructor="1" constructor="2"/>'), 'malformed');
});

test('parseXml: 名前空間つきの名前をそのまま渡す', () => {
  assert.deepEqual(run('<w:p xml:space="preserve"><w:t>x</w:t></w:p>').events, ['open w:p {"xml:space":"preserve"}', 'open w:t', 'text x', 'close w:t', 'close w:p']);
});

test('localName: 接頭辞を落とす', () => {
  assert.equal(localName('w:t'), 't');
  assert.equal(localName('t'), 't');
  assert.equal(localName('a:b:c'), 'c');
  assert.equal(localName(''), '');
});

test('parseXml: 時間 — & が 200 万個続いても 2 秒以内（実体を探して後戻りしない）', () => {
  const source = '<a>' + '&'.repeat(2_000_000) + '</a>';
  let got = '';
  within(2000, () => { parseXml(source, { text: (t) => { got += t; } }); });
  assert.equal(got.length, 2_000_000);
  assert.equal(got, '&'.repeat(2_000_000));
});

test('parseXml: 時間 — 属性 200 個・閉じないコメント・閉じない CDATA・閉じない処理命令が、それぞれ 2 秒以内', () => {
  within(2000, () => {
    assert.deepEqual(parseXml('<a ' + 'b="x" '.repeat(200) + '/>', {}), { ok: false, reason: 'malformed' });
  });
  const distinct = '<a ' + Array.from({ length: 200 }, (_, i) => `b${i}="x"`).join(' ') + '/>';
  within(2000, () => { assert.deepEqual(parseXml(distinct, {}), { ok: true, stopped: false }); });
  within(2000, () => {
    assert.deepEqual(parseXml('<!--'.repeat(500_000), {}), { ok: false, reason: 'malformed' });
  });
  within(2000, () => {
    assert.deepEqual(parseXml('<![CDATA['.repeat(300_000), {}), { ok: false, reason: 'malformed' });
  });
  within(2000, () => {
    assert.deepEqual(parseXml('<?'.repeat(1_000_000), {}), { ok: false, reason: 'malformed' });
  });
});

test('parseXml: 時間 — 数の参照の細工（&# の繰り返し・桁の長い数・; の無い列）が 2 秒以内で、文字は欠けない', () => {
  for (const body of ['&#'.repeat(1_000_000), '&#x'.repeat(700_000), '&#' + '1'.repeat(2_000_000), '&#x' + '0'.repeat(2_000_000), '&#1'.repeat(700_000), '&amp'.repeat(400_000), '&lt;&'.repeat(300_000)]) {
    let got = '';
    within(2000, () => { assert.deepEqual(parseXml(`<a>${body}</a>`, { text: (t) => { got += t; } }), { ok: true, stopped: false }); });
    assert.equal(got.length > 0, true);
  }
  let long = '';
  within(2000, () => { parseXml('<a>&#' + '0'.repeat(2_000_000) + '65;</a>', { text: (t) => { long = t; } }); });
  assert.equal(long, 'A');
  let huge = '';
  within(2000, () => { parseXml('<a>&#' + '9'.repeat(2_000_000) + ';</a>', { text: (t) => { huge = t; } }); });
  assert.equal(huge, '\uFFFD');
});

test('parseXml: 時間 — 深すぎる入れ子・開きっぱなし・名前の長すぎ・属性の値の & が 2 秒以内', () => {
  within(2000, () => { assert.deepEqual(parseXml('<a>'.repeat(1_000_000), {}), { ok: false, reason: 'too_deep' }); });
  within(2000, () => { assert.deepEqual(parseXml('<a'.repeat(1_000_000), {}), { ok: false, reason: 'malformed' }); });
  within(2000, () => { assert.deepEqual(parseXml('<' + 'a'.repeat(5_000_000), {}), { ok: false, reason: 'malformed' }); });
  within(2000, () => { assert.deepEqual(parseXml('</a>'.repeat(1_000_000), {}), { ok: false, reason: 'malformed' }); });
  within(2000, () => { assert.deepEqual(parseXml('<a x="' + '&'.repeat(2_000_000) + '"/>', {}), { ok: true, stopped: false }); });
  within(2000, () => { assert.deepEqual(parseXml('<a x="' + '&'.repeat(2_000_000), {}), { ok: false, reason: 'malformed' }); });
  within(2000, () => { assert.deepEqual(parseXml('<a>' + '<!--x-->'.repeat(500_000) + '</a>', {}), { ok: true, stopped: false }); });
});

test('parseXml: 時間 — 要素が 70 万個ある大きな文書も 2 秒以内で、開閉の数が合う', () => {
  let opens = 0, closes = 0;
  within(2000, () => {
    assert.deepEqual(parseXml('<a>' + '<b x="1">t</b>'.repeat(200_000) + '<c/>'.repeat(500_000) + '</a>', { open: () => { opens++; }, close: () => { closes++; } }), { ok: true, stopped: false });
  });
  assert.equal(opens, 700_001);
  assert.equal(closes, 700_001);
});

test('parseXml: どんな入力でも投げず、ok なら開閉の数が合う（ランダムな列）', () => {
  const alphabet = ['<', '>', '/', '!', '-', '?', '[', ']', '"', "'", '=', '&', ';', '#', 'x', 'a', 'b', ' ', '\n', 'CDATA', '<a>', '</a>', '<b/>', '&lt;', '&#65;', '<!--', '-->', '<![CDATA[', ']]>', '<?', '?>', 'z="1"', '\uFFFF', '\u{1F600}', '\uD800'];
  let seed = 12345;
  const next = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  let oks = 0;
  for (let n = 0; n < 20000; n++) {
    let source = '';
    for (let k = Math.floor(next() * 14); k > 0; k--) source += alphabet[Math.floor(next() * alphabet.length)];
    let balance = 0, lowest = 0;
    const result = parseXml(source, { open: () => { balance++; }, close: () => { balance--; lowest = Math.min(lowest, balance); } });
    assert.equal(typeof result.ok, 'boolean');
    if (result.ok) {
      oks++;
      assert.equal(balance, 0, source);
      assert.equal(lowest, 0, source);
    }
  }
  assert.ok(oks > 100, `ok になった入力が少なすぎる（${oks}）`);
});
