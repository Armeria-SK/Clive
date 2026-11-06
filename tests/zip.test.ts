import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import { ZIP_LIMITS, openZip, zipNameProblem, zipWrite } from '../src/shared/zip.ts';
import type { ZipFailure } from '../src/shared/zip.ts';

const text = (value: string): Buffer => Buffer.from(value, 'utf8');
const noise = (length: number): Buffer => Buffer.from(Array.from({ length }, (_, i) => (i * 31 + (i >> 8) + (i % 7) * 13) & 255));
const FAILURES: readonly string[] = ['not_zip', 'encrypted', 'unsupported', 'damaged', 'bad_name', 'too_many', 'too_large', 'ratio', 'crc', 'missing'] satisfies ReadonlyArray<ZipFailure | 'missing'>;

function sample(): Buffer {
  return zipWrite([
    { name: 'empty.txt', data: new Uint8Array(0) },
    { name: 'フォルダ/表.xml', data: text('<a>日本語</a>') },
    { name: 'big.bin', data: noise(100_000) },
  ]);
}

function eocdAt(zip: Buffer): number {
  for (let at = zip.length - 22; at >= 0; at--) if (zip.readUInt32LE(at) === 0x06054b50) return at;
  throw new Error('no EOCD');
}

function centralAt(zip: Buffer, n: number): number {
  let at = zip.readUInt32LE(eocdAt(zip) + 16);
  for (let i = 0; i < n; i++) at += 46 + zip.readUInt16LE(at + 28) + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  return at;
}

const CENTRAL = { flags: 8, method: 10, crc: 16, compressedSize: 20, size: 24, nameLength: 28, offset: 42, name: 46 } as const;

function patched(zip: Buffer, edits: ReadonlyArray<readonly [at: number, width: 1 | 2 | 4, value: number]>): Buffer {
  const out = Buffer.from(zip);
  for (const [at, width, value] of edits) {
    if (width === 1) out.writeUInt8(value, at);
    else if (width === 2) out.writeUInt16LE(value, at);
    else out.writeUInt32LE(value, at);
  }
  return out;
}

function central(zip: Buffer, n: number, field: keyof typeof CENTRAL, width: 1 | 2 | 4, value: number): Buffer {
  return patched(zip, [[centralAt(zip, n) + CENTRAL[field], width, value]]);
}

function renamed(zip: Buffer, n: number, name: string | Buffer): Buffer {
  const at = centralAt(zip, n);
  const bytes = typeof name === 'string' ? text(name) : name;
  assert.equal(bytes.length, zip.readUInt16LE(at + CENTRAL.nameLength), 'the replacement name must have the same byte length');
  const out = Buffer.from(zip);
  bytes.copy(out, at + CENTRAL.name);
  return out;
}

function withClone(zip: Buffer, n: number, name: string): Buffer {
  const count = zip.readUInt16LE(eocdAt(zip) + 10);
  const eocd = eocdAt(zip);
  const at = centralAt(zip, n);
  const entry = Buffer.from(zip.subarray(at, centralAt(zip, n + 1)));
  const out = Buffer.concat([zip.subarray(0, eocd), entry, zip.subarray(eocd)]);
  const end = eocd + entry.length;
  out.writeUInt16LE(count + 1, end + 8);
  out.writeUInt16LE(count + 1, end + 10);
  out.writeUInt32LE(out.readUInt32LE(end + 12) + entry.length, end + 12);
  return renamed(out, count, name);
}

function stored(files: ReadonlyArray<{ name: string; data?: Uint8Array }>): Buffer {
  const body: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const data = Buffer.from(file.data ?? new Uint8Array(0));
    const name = text(file.name);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    name.copy(entry, 46);
    body.push(local, data);
    centrals.push(entry);
    offset += local.length + data.length;
  }
  const size = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(size, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, ...centrals, eocd]);
}

function open(zip: Uint8Array, limits?: Parameters<typeof openZip>[1]) {
  const result = openZip(zip, limits);
  assert.equal(result.ok, true, result.ok ? undefined : `openZip failed: ${result.reason}`);
  if (!result.ok) throw new Error('unreachable');
  return result.zip;
}

function openFailure(zip: Uint8Array, limits?: Parameters<typeof openZip>[1]): string {
  const result = openZip(zip, limits);
  assert.equal(result.ok, false, 'openZip should have refused');
  return result.ok ? 'ok' : result.reason;
}

function readFailure(zip: Uint8Array, name: string, limits?: Parameters<typeof openZip>[1]): string {
  const result = open(zip, limits).read(name);
  assert.equal(result.ok, false, 'read should have refused');
  assert.equal('data' in result, false, 'no data may come back with a failure');
  return result.ok ? 'ok' : result.reason;
}

test('往復: 空・日本語の名前・100KB の 3 項目を書いて読むと同じバイトになり、一覧は書いた順', () => {
  const zip = open(sample());
  assert.deepEqual([...zip.entries.keys()], ['empty.txt', 'フォルダ/表.xml', 'big.bin']);
  const empty = zip.read('empty.txt');
  assert.ok(empty.ok && empty.data.length === 0);
  const xml = zip.read('フォルダ/表.xml');
  assert.ok(xml.ok && xml.data.equals(text('<a>日本語</a>')));
  const big = zip.read('big.bin');
  assert.ok(big.ok && big.data.equals(noise(100_000)));
  assert.deepEqual(zip.entries.get('big.bin'), { name: 'big.bin', method: 8, crc: crc32(noise(100_000)), compressedSize: zip.entries.get('big.bin')!.compressedSize, size: 100_000, offset: zip.entries.get('big.bin')!.offset });
  assert.equal(zip.entries.get('empty.txt')!.offset, 0);
});

test('往復: 同じ入力の zipWrite は 2 回とも同じバイトで、時刻は 1980-01-01 00:00・名前は UTF-8 の印', () => {
  const one = sample();
  assert.equal(one.equals(sample()), true);
  assert.equal(one.readUInt16LE(6), 0x0800);
  assert.equal(one.readUInt16LE(8), 8);
  assert.equal(one.readUInt16LE(10), 0);
  assert.equal(one.readUInt16LE(12), (1 << 5) | 1);
  const at = centralAt(one, 0);
  assert.equal(one.readUInt16LE(at + CENTRAL.flags), 0x0800);
  assert.equal(one.readUInt16LE(at + 12), 0);
  assert.equal(one.readUInt16LE(at + 14), (1 << 5) | 1);
});

test('往復: 別の書き手が作った無圧縮（方式 0）の ZIP も読める。フォルダの項目は一覧に入らない', () => {
  const zip = open(stored([{ name: 'dir/' }, { name: 'dir/a.txt', data: text('abc') }, { name: 'b.txt', data: text('') }]));
  assert.deepEqual([...zip.entries.keys()], ['dir/a.txt', 'b.txt']);
  assert.equal(zip.entries.get('dir/a.txt')!.method, 0);
  const a = zip.read('dir/a.txt');
  assert.ok(a.ok && a.data.toString() === 'abc');
  assert.equal(zip.read('dir/').ok, false);
});

test('往復: 先頭が 0 でない位置の Uint8Array（Buffer の一部）からも読める', () => {
  const host = Buffer.concat([Buffer.alloc(7, 0x55), sample(), Buffer.alloc(5, 0x55)]);
  const zip = open(new Uint8Array(host.buffer, host.byteOffset + 7, host.length - 12));
  assert.equal(zip.entries.size, 3);
  const big = zip.read('big.bin');
  assert.ok(big.ok && big.data.equals(noise(100_000)));
});

test('形: ZIP でないもの・空・短いもの・別の署名は not_zip', () => {
  assert.equal(openFailure(text('hello')), 'not_zip');
  assert.equal(openFailure(new Uint8Array(0)), 'not_zip');
  assert.equal(openFailure(Buffer.from('PK')), 'not_zip');
  assert.equal(openFailure(Buffer.from([0x50, 0x4b, 0x07, 0x08, 0, 0, 0, 0])), 'not_zip');
});

test('形: EOCD だけの空の ZIP は項目 0 個で読める', () => {
  const empty = zipWrite([]);
  assert.equal(empty.length, 22);
  assert.equal(open(empty).entries.size, 0);
});

test('形: 後ろを 10 バイト切った ZIP は damaged、EOCD の後ろの注釈のゴミ 100 バイトは読める', () => {
  const zip = sample();
  assert.equal(openFailure(zip.subarray(0, zip.length - 10)), 'damaged');
  const garbage = Buffer.concat([zip, Buffer.alloc(100, 0x41)]);
  assert.equal(open(garbage).entries.size, 3);
  const commented = Buffer.concat([zip, text('x'.repeat(100))]);
  commented.writeUInt16LE(100, eocdAt(commented) + 20);
  assert.equal(open(commented).entries.size, 3);
});

test('形: EOCD の注釈の長さが実際より長いときは、その EOCD を採らない', () => {
  const zip = Buffer.from(sample());
  zip.writeUInt16LE(500, eocdAt(zip) + 20);
  assert.equal(openFailure(zip), 'damaged');
});

test('CRC: 圧縮された中身の 1 バイトを書き換えると、crc・damaged・ratio（宣言より広がった）のどれかで、データは返らない', () => {
  const zip = sample();
  const entry = open(zip).entries.get('フォルダ/表.xml')!;
  const start = entry.offset + 30 + zip.readUInt16LE(entry.offset + 26) + zip.readUInt16LE(entry.offset + 28);
  const reason = readFailure(patched(zip, [[start + 3, 1, zip[start + 3]! ^ 0x55]]), 'フォルダ/表.xml');
  assert.ok(['crc', 'damaged', 'ratio'].includes(reason), reason);
});

test('CRC: 無圧縮の中身の 1 バイトを書き換えると crc', () => {
  const zip = stored([{ name: 'a.txt', data: text('abcdef') }]);
  const at = 30 + 'a.txt'.length + 2;
  assert.equal(readFailure(patched(zip, [[at, 1, zip[at]! ^ 1]]), 'a.txt'), 'crc');
});

test('CRC: 中央の一覧の CRC だけを書き換えると crc', () => {
  const zip = sample();
  assert.equal(readFailure(central(zip, 2, 'crc', 4, (crc32(noise(100_000)) ^ 1) >>> 0), 'big.bin'), 'crc');
});

test('宣言のうそ: 1MB の 0 の項目の size を 10 に書き換えると ratio（10 バイトより多いデータは返らない）', () => {
  const zip = zipWrite([{ name: 'zeros.bin', data: new Uint8Array(1024 * 1024) }]);
  assert.equal(readFailure(central(zip, 0, 'size', 4, 10), 'zeros.bin'), 'ratio');
  assert.equal(readFailure(central(zip, 0, 'size', 4, 1024 * 1024 - 1), 'zeros.bin'), 'ratio');
});

test('宣言のうそ: size が実際より大きいと damaged', () => {
  const zip = zipWrite([{ name: 'a.bin', data: noise(1000) }]);
  assert.equal(readFailure(central(zip, 0, 'size', 4, 1500), 'a.bin'), 'damaged');
  assert.equal(readFailure(central(zip, 0, 'size', 4, 0), 'a.bin'), 'ratio');
});

test('宣言のうそ: 場所の頭にある大きさ・CRC・フラグ（データ記述子）は信じず、中央の一覧の値で読む', () => {
  const zip = sample();
  const at = open(zip).entries.get('big.bin')!.offset;
  const lied = patched(zip, [[at + 6, 2, 0x0808], [at + 14, 4, 0], [at + 18, 4, 0], [at + 22, 4, 0]]);
  const big = open(lied).read('big.bin');
  assert.ok(big.ok && big.data.equals(noise(100_000)));
});

test('圧縮率: 2MB の 0 は openZip が ratio。ratioFloor を 4MiB にすれば読める', () => {
  const zip = zipWrite([{ name: 'zeros.bin', data: new Uint8Array(2 * 1024 * 1024) }]);
  assert.equal(openFailure(zip), 'ratio');
  const ok = open(zip, { ratioFloor: 4 * 1024 * 1024 }).read('zeros.bin');
  assert.ok(ok.ok && ok.data.length === 2 * 1024 * 1024);
});

test('圧縮率: 境目 — size が ratioFloor ちょうどなら見ず、超えれば見る。比が maxRatio ちょうどなら通り、わずかでも超えれば ratio', () => {
  const zip = zipWrite([{ name: 'zeros.bin', data: new Uint8Array(2000) }]);
  const entry = open(zip).entries.get('zeros.bin')!;
  const ratio = entry.size / entry.compressedSize;
  assert.ok(ratio > 50);
  assert.equal(open(zip, { ratioFloor: 2000, maxRatio: 50 }).entries.size, 1);
  assert.equal(openFailure(zip, { ratioFloor: 1999, maxRatio: 50 }), 'ratio');
  assert.equal(open(zip, { ratioFloor: 0, maxRatio: ratio }).entries.size, 1);
  assert.equal(openFailure(zip, { ratioFloor: 0, maxRatio: ratio - 0.001 }), 'ratio');
});

test('数: maxEntries を超える項目数は、中を 1 つも読まずに too_many（ちょうどなら読める）', () => {
  const files = Array.from({ length: 11 }, (_, i) => ({ name: `n${String(i).padStart(2, '0')}`, data: text('x') }));
  const zip = zipWrite(files);
  assert.equal(openFailure(zip, { maxEntries: 10 }), 'too_many');
  assert.equal(open(zip, { maxEntries: 11 }).entries.size, 11);
  const broken = patched(zip, [[centralAt(zip, 0), 4, 0]]);
  assert.equal(openFailure(broken, { maxEntries: 10 }), 'too_many');
  assert.equal(openFailure(broken, { maxEntries: 11 }), 'damaged');
  const eocd = eocdAt(zip);
  const inflated = patched(zip, [[eocd + 8, 2, 60], [eocd + 10, 2, 60]]);
  assert.equal(openFailure(inflated, { maxEntries: 10 }), 'too_many');
  assert.equal(openFailure(inflated, { maxEntries: 100 }), 'damaged');
});

test('数: maxEntry を超える 1 項目は too_large（ちょうどなら読める）', () => {
  const zip = zipWrite([{ name: 'a.bin', data: noise(1001) }]);
  assert.equal(openFailure(zip, { maxEntry: 1000 }), 'too_large');
  assert.equal(open(zip, { maxEntry: 1001 }).entries.size, 1);
});

test('数: 宣言の合計が maxTotal を超えれば too_large（ちょうどなら開ける）', () => {
  const zip = zipWrite([1, 2, 3].map((i) => ({ name: `f${i}`, data: noise(1000) })));
  assert.equal(openFailure(zip, { maxTotal: 2999 }), 'too_large');
  assert.equal(open(zip, { maxTotal: 3000 }).entries.size, 3);
});

test('数: maxTotal 3000 で 1000 バイトの項目 3 つは読めて、同じ項目の 4 回目の read が too_large', () => {
  const zip = open(zipWrite([1, 2, 3].map((i) => ({ name: `f${i}`, data: noise(1000 + i - 1) }))), { maxTotal: 3003 });
  for (const name of ['f1', 'f2', 'f3']) assert.equal(zip.read(name).ok, true);
  assert.deepEqual(zip.read('f1'), { ok: false, reason: 'too_large' });
  const same = open(zipWrite([1, 2, 3].map((i) => ({ name: `f${i}`, data: noise(1000) }))), { maxTotal: 3000 });
  for (const name of ['f1', 'f2', 'f3']) assert.equal(same.read(name).ok, true);
  assert.deepEqual(same.read('f1'), { ok: false, reason: 'too_large' });
});

test('数: 同じ項目を何度も読ませても、読み出しの合計は maxTotal で止まる', () => {
  const zip = open(zipWrite([{ name: 'a', data: noise(1000) }]), { maxTotal: 2500 });
  assert.equal(zip.read('a').ok, true);
  assert.equal(zip.read('a').ok, true);
  assert.deepEqual(zip.read('a'), { ok: false, reason: 'too_large' });
  assert.deepEqual(zip.read('a'), { ok: false, reason: 'too_large' });
});

test('数: 失敗した読み出しも予算を使う（壊れた項目を繰り返し読ませて展開させ続けられない）', () => {
  const zip = central(zipWrite([{ name: 'a', data: noise(1000) }]), 0, 'crc', 4, 1);
  const archive = open(zip, { maxTotal: 2500 });
  assert.deepEqual(archive.read('a'), { ok: false, reason: 'crc' });
  assert.deepEqual(archive.read('a'), { ok: false, reason: 'crc' });
  assert.deepEqual(archive.read('a'), { ok: false, reason: 'too_large' });
});

test('数: 中身の場所が重なった項目（同じ場所を指す 2 つの項目）でも、読み出しの合計は予算で止まる', () => {
  const base = zipWrite([{ name: 'a', data: noise(1000) }]);
  const overlapped = withClone(base, 0, 'b');
  const zip = open(overlapped, { maxTotal: 2500 });
  assert.equal(zip.entries.get('a')!.offset, zip.entries.get('b')!.offset);
  assert.equal(zip.read('a').ok, true);
  assert.equal(zip.read('b').ok, true);
  assert.deepEqual(zip.read('a'), { ok: false, reason: 'too_large' });
  assert.deepEqual(zip.read('b'), { ok: false, reason: 'too_large' });
  assert.equal(openFailure(overlapped, { maxTotal: 1999 }), 'too_large');
});

test('名前: 上に抜ける・絶対・ドライブ・バックスラッシュ・NUL・「.」の区切りは bad_name', () => {
  for (const bad of ['../x', 'a/../b', '/abs', 'C:x', 'a\\b', 'a\u0000b', './a', 'a/./b', 'a//b', 'a\nb', 'a\u007fb']) {
    const zip = renamed(zipWrite([{ name: 'q'.repeat(text(bad).length), data: text('x') }]), 0, bad);
    assert.equal(openFailure(zip), 'bad_name', JSON.stringify(bad));
  }
});

test('名前: 同じ名前が 2 つあれば bad_name（a と b で作り b を a に書き換え）', () => {
  const zip = renamed(zipWrite([{ name: 'a', data: text('1') }, { name: 'b', data: text('2') }]), 1, 'a');
  assert.equal(openFailure(zip), 'bad_name');
});

test('名前: UTF-8 として読めない名前は bad_name、maxNameLength を超える名前も bad_name', () => {
  const zip = zipWrite([{ name: 'ab', data: text('x') }]);
  assert.equal(openFailure(renamed(zip, 0, Buffer.from([0xff, 0xfe]))), 'bad_name');
  assert.equal(openFailure(renamed(zip, 0, Buffer.alloc(2, 0))), 'bad_name');
  assert.equal(openFailure(zipWrite([{ name: 'abcd', data: text('x') }]), { maxNameLength: 3 }), 'bad_name');
  assert.equal(open(zipWrite([{ name: 'abc', data: text('x') }]), { maxNameLength: 3 }).entries.size, 1);
  assert.equal(openFailure(stored([{ name: '' }])), 'bad_name');
});

test('名前: 名前の先頭の BOM（U+FEFF）は落とさずそのまま名前として読む', () => {
  const zip = open(stored([{ name: '\uFEFFa', data: text('x') }]));
  assert.deepEqual([...zip.entries.keys()], ['\uFEFFa']);
});

test('名前: フォルダの項目（/ で終わる）にも名前の決まりと重複の確かめがかかる', () => {
  assert.equal(openFailure(stored([{ name: '../' }])), 'bad_name');
  assert.equal(openFailure(stored([{ name: 'a//' }])), 'bad_name');
  assert.equal(openFailure(stored([{ name: 'd/' }, { name: 'd/' }])), 'bad_name');
});

test('zipNameProblem: 使えない名前と使える名前', () => {
  for (const bad of ['', 'x'.repeat(1025), 'a\u0000b', '\u0085', 'a\\b', '/a', 'C:x', 'z:', '.', '..', './a', 'a/..', 'a/../b', 'a//b', '//', '/', 'a/./', 'a\uD800b']) {
    assert.equal(zipNameProblem(bad, 1024), true, JSON.stringify(bad));
  }
  for (const good of ['a', 'word/document.xml', '[Content_Types].xml', '_rels/.rels', 'フォルダ/表.xml', '..a', 'a..', '.hidden', 'a.b/c', 'dir/', 'ab:c', 'x'.repeat(1024)]) {
    assert.equal(zipNameProblem(good, 1024), false, JSON.stringify(good));
  }
});

test('zipWrite: 使えない名前・同じ名前・フォルダの名前は投げる', () => {
  const data = text('x');
  assert.throws(() => zipWrite([{ name: '../x', data }]));
  assert.throws(() => zipWrite([{ name: 'a\\b', data }]));
  assert.throws(() => zipWrite([{ name: '', data }]));
  assert.throws(() => zipWrite([{ name: 'a\uD800', data }]));
  assert.throws(() => zipWrite([{ name: 'dir/', data }]));
  assert.throws(() => zipWrite([{ name: 'a', data }, { name: 'a', data }]));
  assert.doesNotThrow(() => zipWrite([{ name: 'a', data }, { name: 'b', data }]));
});

test('zipWrite: Buffer の一部（byteOffset が 0 でない）を渡しても、その範囲だけを書く', () => {
  const host = Buffer.from('xxhelloyy');
  const zip = open(zipWrite([{ name: 'a', data: host.subarray(2, 7) }]));
  const a = zip.read('a');
  assert.ok(a.ok && a.data.toString() === 'hello');
});

test('方式・暗号・ZIP64: 方式 12 は unsupported、暗号の印は encrypted（方式より先）、項目数 0xFFFF は unsupported', () => {
  const zip = sample();
  assert.equal(openFailure(central(zip, 0, 'method', 2, 12)), 'unsupported');
  assert.equal(openFailure(central(zip, 0, 'flags', 2, 0x0801)), 'encrypted');
  assert.equal(openFailure(central(zip, 0, 'flags', 2, 0x0840)), 'encrypted');
  assert.equal(openFailure(patched(central(zip, 0, 'flags', 2, 0x0801), [[centralAt(zip, 0) + CENTRAL.method, 2, 99]])), 'encrypted');
  const eocd = eocdAt(zip);
  assert.equal(openFailure(patched(zip, [[eocd + 8, 2, 0xffff], [eocd + 10, 2, 0xffff]])), 'unsupported');
  assert.equal(openFailure(patched(zip, [[eocd + 10, 2, 0xffff]])), 'unsupported');
});

test('方式・暗号・ZIP64: 複数のディスク・ZIP64 の位置の記録・0xFFFFFFFF の値は unsupported', () => {
  const zip = sample();
  const eocd = eocdAt(zip);
  assert.equal(openFailure(patched(zip, [[eocd + 4, 2, 1]])), 'unsupported');
  assert.equal(openFailure(patched(zip, [[eocd + 6, 2, 1]])), 'unsupported');
  assert.equal(openFailure(patched(zip, [[eocd + 8, 2, 2]])), 'unsupported');
  assert.equal(openFailure(patched(zip, [[eocd + 12, 4, 0xffffffff]])), 'unsupported');
  assert.equal(openFailure(patched(zip, [[eocd + 16, 4, 0xffffffff]])), 'unsupported');
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  assert.equal(openFailure(Buffer.concat([zip.subarray(0, eocd), locator, zip.subarray(eocd)])), 'unsupported');
  assert.equal(openFailure(central(zip, 0, 'size', 4, 0xffffffff)), 'unsupported');
  assert.equal(openFailure(central(zip, 0, 'compressedSize', 4, 0xffffffff)), 'unsupported');
  assert.equal(openFailure(central(zip, 0, 'offset', 4, 0xffffffff)), 'unsupported');
  assert.equal(openFailure(patched(zip, [[centralAt(zip, 0) + 34, 2, 1]])), 'unsupported');
});

test('壊れ方: 場所の頭の署名を壊すと read が damaged（開くのは通る）', () => {
  const zip = sample();
  const at = open(zip).entries.get('big.bin')!.offset;
  assert.equal(readFailure(patched(zip, [[at, 4, 0]]), 'big.bin'), 'damaged');
});

test('壊れ方: 中央の一覧の場所・署名・名前の長さがファイルの外・食い違いなら damaged', () => {
  const zip = sample();
  const eocd = eocdAt(zip);
  assert.equal(openFailure(patched(zip, [[eocd + 16, 4, zip.length + 100]])), 'damaged');
  assert.equal(openFailure(patched(zip, [[eocd + 12, 4, zip.length]])), 'damaged');
  assert.equal(openFailure(patched(zip, [[centralAt(zip, 1), 4, 0x12345678]])), 'damaged');
  assert.equal(openFailure(central(zip, 2, 'nameLength', 2, 60000)), 'damaged');
  assert.equal(openFailure(patched(zip, [[eocd + 10, 2, 50], [eocd + 8, 2, 50]])), 'damaged');
});

test('壊れ方: 場所の頭がファイルの外・中身がファイルの外にはみ出す・方式 0 の大きさの食い違いは damaged', () => {
  const zip = sample();
  assert.equal(readFailure(central(zip, 2, 'offset', 4, zip.length - 5), 'big.bin'), 'damaged');
  assert.equal(readFailure(central(zip, 2, 'offset', 4, zip.length + 5), 'big.bin'), 'damaged');
  assert.equal(readFailure(central(zip, 2, 'compressedSize', 4, zip.length), 'big.bin'), 'damaged');
  const plain = stored([{ name: 'a.txt', data: text('abc') }]);
  assert.equal(openFailure(central(plain, 0, 'size', 4, 4)), 'damaged');
  assert.equal(openFailure(central(plain, 0, 'compressedSize', 4, 2)), 'damaged');
});

test('一覧に無い名前の read は missing', () => {
  assert.deepEqual(open(sample()).read('nope'), { ok: false, reason: 'missing' });
});

test('壊れた入力: 無作為にバイトを書き換えても投げず、結果の型で返す', () => {
  let state = 0x9e3779b9;
  const next = (): number => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state;
  };
  const base = zipWrite([{ name: 'a.xml', data: text('<a>hello</a>'.repeat(40)) }, { name: 'フォルダ/b.bin', data: noise(3000) }, { name: 'c', data: new Uint8Array(0) }]);
  const limits = { maxEntries: 50, maxTotal: 1 << 20, maxEntry: 1 << 20, maxNameLength: 64 };
  let opened = 0;
  let refused = 0;
  for (let round = 0; round < 4000; round++) {
    let zip = Buffer.from(base);
    const edits = 1 + (next() % 6);
    for (let i = 0; i < edits; i++) {
      const tail = next() % 2 === 0;
      const at = tail ? zip.length - 1 - (next() % Math.min(zip.length, 200)) : next() % zip.length;
      zip[at] = next() & 255;
    }
    if (next() % 5 === 0) zip = zip.subarray(0, next() % zip.length);
    const result = openZip(zip, limits);
    if (!result.ok) { assert.ok(FAILURES.includes(result.reason)); refused++; continue; }
    opened++;
    for (const name of result.zip.entries.keys()) {
      const read = result.zip.read(name);
      if (read.ok) assert.ok(Buffer.isBuffer(read.data));
      else assert.ok(FAILURES.includes(read.reason));
    }
  }
  assert.ok(opened > 100 && refused > 100, `opened ${opened}, refused ${refused}`);
});

test('既定の上限: 計画どおりの値', () => {
  assert.deepEqual(ZIP_LIMITS, { maxEntries: 5_000, maxTotal: 64 * 1024 * 1024, maxEntry: 32 * 1024 * 1024, maxRatio: 200, ratioFloor: 1024 * 1024, maxNameLength: 1024 });
});
