import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_SIDE,
  IMAGE_MEDIA,
  imageSize,
  sniffImage,
} from '../src/shared/image-info.ts';
import type { ImageType } from '../src/shared/image-info.ts';

// 見本のバイト。試験の中で作る（ファイルを置かない）。

// PNG 640×480（29 バイト）
const png640x480 = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // 署名
  0x00, 0x00, 0x00, 0x0d, // IHDR の長さ 13
  0x49, 0x48, 0x44, 0x52, // IHDR
  0x00, 0x00, 0x02, 0x80, // 幅 640（大きい桁が先）
  0x00, 0x00, 0x01, 0xe0, // 高さ 480
  0x08, 0x02, 0x00, 0x00, 0x00, // ビット深度・色タイプ等
]);

// GIF 3×5（10 バイト）
const gif3x5 = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
  0x03, 0x00, // 幅 3（小さい桁が先）
  0x05, 0x00, // 高さ 5
]);

// JPEG 1920×1080。詰め物の FF FF と APP0（E0）のあとに SOF0（C0）（31 バイト）
const jpeg1920x1080 = Uint8Array.from([
  0xff, 0xd8, // SOI
  0xff, 0xff, // 詰め物
  0xff, 0xe0, // APP0
  0x00, 0x10, // 長さ 16
  0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, // JFIF
  0xff, 0xc0, // SOF0
  0x00, 0x0b, // 長さ 11
  0x08, // 精度
  0x04, 0x38, // 高さ 1080
  0x07, 0x80, // 幅 1920
]);

// JPEG 1920×1080、プログレッシブ（C2）。C0 のところを C2 にした版
const jpeg1920x1080c2 = Uint8Array.from(jpeg1920x1080);
jpeg1920x1080c2[23] = 0xc2;

// WebP VP8（ロスあり）100×50（30 バイト）
const webpVp8 = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, // RIFF
  0x1e, 0x00, 0x00, 0x00, // ファイルサイズ
  0x57, 0x45, 0x42, 0x50, // WEBP
  0x56, 0x50, 0x38, 0x20, // VP8（最後は空白）
  0x10, 0x00, 0x00, 0x00, // チャンクサイズ
  0x00, 0x00, 0x00, // フレームタグ
  0x9d, 0x01, 0x2a, // 開始コード
  0x64, 0x00, // 幅 100（小さい桁が先、下 14 ビット）
  0x32, 0x00, // 高さ 50
]);

// WebP VP8L（ロスなし）100×53（25 バイト）
const webpVp8l = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, // RIFF
  0x19, 0x00, 0x00, 0x00, // ファイルサイズ
  0x57, 0x45, 0x42, 0x50, // WEBP
  0x56, 0x50, 0x38, 0x4c, // VP8L
  0x09, 0x00, 0x00, 0x00, // チャンクサイズ
  0x2f, // 署名
  0x63, 0x00, 0x0d, 0x00, // b1..b4（幅 100・高さ 53）
]);

// WebP VP8X（拡張）100×50（30 バイト）
const webpVp8x = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, // RIFF
  0x1e, 0x00, 0x00, 0x00, // ファイルサイズ
  0x57, 0x45, 0x42, 0x50, // WEBP
  0x56, 0x50, 0x38, 0x58, // VP8X
  0x0c, 0x00, 0x00, 0x00, // チャンクサイズ
  0x00, // フラグ
  0x00, 0x00, 0x00, // 予約
  0x63, 0x00, 0x00, // 幅-1 = 99（小さい桁が先）
  0x31, 0x00, 0x00, // 高さ-1 = 49
]);

// 見えない文字の確かめで使う、形の見分けの負例
const svgBytes = Uint8Array.from([0x3c, 0x73, 0x76, 0x67, 0x20, 0x78, 0x6d, 0x6c, 0x6e, 0x73, 0x3d, 0x22, 0x2e, 0x2e, 0x22, 0x3e]);
const pdfBytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const riffWave = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);

// 切れた見本の全長さを試す。投げず、undefined か正しい値（短い見本で縦横を返さない）
const assertTruncated = (sample: Uint8Array, type: ImageType, expected: { width: number; height: number }): void => {
  for (let len = 1; len < sample.length; len++) {
    const short = sample.subarray(0, len);
    let result: { width: number; height: number } | undefined;
    let threw = false;
    try {
      result = imageSize(short, type);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, `len=${len} で投げた`);
    if (result !== undefined) {
      assert.equal(result.width, expected.width, `len=${len} の幅`);
      assert.equal(result.height, expected.height, `len=${len} の高さ`);
    }
  }
};

test('定数: メディアタイプ・上限', () => {
  assert.equal(IMAGE_MEDIA.png, 'image/png');
  assert.equal(IMAGE_MEDIA.jpeg, 'image/jpeg');
  assert.equal(IMAGE_MEDIA.gif, 'image/gif');
  assert.equal(IMAGE_MEDIA.webp, 'image/webp');
  assert.equal(IMAGE_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(IMAGE_MAX_SIDE, 8000);
});

test('sniffImage: 4 つの形を見分ける', () => {
  assert.equal(sniffImage(png640x480), 'png');
  assert.equal(sniffImage(jpeg1920x1080), 'jpeg');
  assert.equal(sniffImage(gif3x5), 'gif');
  assert.equal(sniffImage(webpVp8), 'webp');
});

test('sniffImage: GIF87a も gif', () => {
  const gif87 = Uint8Array.from(gif3x5);
  gif87[4] = 0x37; // GIF87a
  assert.equal(sniffImage(gif87), 'gif');
});

test('sniffImage: 画像でないものは undefined', () => {
  assert.equal(sniffImage(svgBytes), undefined);
  assert.equal(sniffImage(pdfBytes), undefined);
  assert.equal(sniffImage(new Uint8Array(0)), undefined);
  assert.equal(sniffImage(riffWave), undefined);
});

test('imageSize: PNG 640×480', () => {
  assert.deepEqual(imageSize(png640x480, 'png'), { width: 640, height: 480 });
});

test('imageSize: GIF 3×5', () => {
  assert.deepEqual(imageSize(gif3x5, 'gif'), { width: 3, height: 5 });
});

test('imageSize: JPEG 1920×1080（詰め物・APP0 のあと SOF0）', () => {
  assert.deepEqual(imageSize(jpeg1920x1080, 'jpeg'), { width: 1920, height: 1080 });
});

test('imageSize: JPEG 1920×1080（プログレッシブ C2）', () => {
  assert.deepEqual(imageSize(jpeg1920x1080c2, 'jpeg'), { width: 1920, height: 1080 });
});

test('imageSize: WebP VP8 100×50', () => {
  assert.deepEqual(imageSize(webpVp8, 'webp'), { width: 100, height: 50 });
});

test('imageSize: WebP VP8L 100×53', () => {
  assert.deepEqual(imageSize(webpVp8l, 'webp'), { width: 100, height: 53 });
});

test('imageSize: WebP VP8X 100×50', () => {
  assert.deepEqual(imageSize(webpVp8x, 'webp'), { width: 100, height: 50 });
});

test('切れた入力: 全長さを試しても投げず、短い見本で縦横を返さない', () => {
  assertTruncated(png640x480, 'png', { width: 640, height: 480 });
  assertTruncated(gif3x5, 'gif', { width: 3, height: 5 });
  assertTruncated(jpeg1920x1080, 'jpeg', { width: 1920, height: 1080 });
  assertTruncated(webpVp8, 'webp', { width: 100, height: 50 });
  assertTruncated(webpVp8l, 'webp', { width: 100, height: 53 });
  assertTruncated(webpVp8x, 'webp', { width: 100, height: 50 });
});

test('意地悪い JPEG: 長さが 0・1 の印は undefined', () => {
  const len0 = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x00]);
  const len1 = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x01]);
  assert.equal(imageSize(len0, 'jpeg'), undefined);
  assert.equal(imageSize(len1, 'jpeg'), undefined);
});

test('意地悪い JPEG: 長さがファイルの外を指す印は undefined', () => {
  const out = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00, 0x00]);
  assert.equal(imageSize(out, 'jpeg'), undefined);
});

test('意地悪い JPEG: FF だけ 100,000 個は 2 秒以内に undefined', () => {
  const ffs = new Uint8Array(100000).fill(0xff);
  const start = Date.now();
  assert.equal(imageSize(ffs, 'jpeg'), undefined);
  assert.ok(Date.now() - start < 2000, '2 秒以内');
});

test('意地悪い JPEG: C4 だけが続く並びは undefined', () => {
  const c4 = new Uint8Array(4000);
  for (let i = 0; i < 4000; i += 4) {
    c4[i] = 0xff;
    c4[i + 1] = 0xc4;
    c4[i + 2] = 0x00;
    c4[i + 3] = 0x02;
  }
  assert.equal(imageSize(c4, 'jpeg'), undefined);
});

test('意地悪い PNG: IHDR の名前が違うと undefined', () => {
  const bad = Uint8Array.from(png640x480);
  bad[15] = 0x51; // IHDR の最後の文字を崩す
  assert.equal(imageSize(bad, 'png'), undefined);
});

test('意地悪い PNG: 幅 0 は undefined', () => {
  const zero = Uint8Array.from(png640x480);
  zero[16] = 0x00;
  zero[17] = 0x00;
  zero[18] = 0x00;
  zero[19] = 0x00; // 幅 0
  assert.equal(imageSize(zero, 'png'), undefined);
});
