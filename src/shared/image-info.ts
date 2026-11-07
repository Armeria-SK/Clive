// 画像の中身の頭から、形（PNG・JPEG・GIF・WebP）と縦横を読む。
// 拡張子・Content-Type は信じず、頭バイトだけで決める。読む位置が bytes.length を
// 超えたら undefined を返すだけで、決して投げない。Buffer ではなく Uint8Array と
// DataView で読む。

export type ImageType = 'png' | 'jpeg' | 'gif' | 'webp';

export const IMAGE_MEDIA: Readonly<Record<ImageType, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

// uploads/store.ts の MAX_IMAGE_BYTES と同じ
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
// Anthropic の 1 辺の上限
export const IMAGE_MAX_SIDE = 8000;

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// 頭バイトで形を見分ける。一致しなければ undefined
export function sniffImage(bytes: Uint8Array): ImageType | undefined {
  const dv = view(bytes);
  const n = bytes.length;
  if (
    n >= 8 &&
    dv.getUint8(0) === 0x89 && dv.getUint8(1) === 0x50 && dv.getUint8(2) === 0x4e && dv.getUint8(3) === 0x47 &&
    dv.getUint8(4) === 0x0d && dv.getUint8(5) === 0x0a && dv.getUint8(6) === 0x1a && dv.getUint8(7) === 0x0a
  ) {
    return 'png';
  }
  if (n >= 3 && dv.getUint8(0) === 0xff && dv.getUint8(1) === 0xd8 && dv.getUint8(2) === 0xff) {
    return 'jpeg';
  }
  if (
    n >= 6 &&
    dv.getUint8(0) === 0x47 && dv.getUint8(1) === 0x49 && dv.getUint8(2) === 0x46 && dv.getUint8(3) === 0x38 &&
    (dv.getUint8(4) === 0x37 || dv.getUint8(4) === 0x39) && dv.getUint8(5) === 0x61
  ) {
    return 'gif';
  }
  if (
    n >= 12 &&
    dv.getUint8(0) === 0x52 && dv.getUint8(1) === 0x49 && dv.getUint8(2) === 0x46 && dv.getUint8(3) === 0x46 &&
    dv.getUint8(8) === 0x57 && dv.getUint8(9) === 0x45 && dv.getUint8(10) === 0x42 && dv.getUint8(11) === 0x50
  ) {
    return 'webp';
  }
  return undefined;
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined;
  const dv = view(bytes);
  // 12〜15 が IHDR
  if (dv.getUint8(12) !== 0x49 || dv.getUint8(13) !== 0x48 || dv.getUint8(14) !== 0x44 || dv.getUint8(15) !== 0x52) {
    return undefined;
  }
  const width = dv.getUint32(16, false); // 大きい桁が先
  const height = dv.getUint32(20, false);
  if (width === 0 || height === 0) return undefined;
  return { width, height };
}

function gifSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 10) return undefined;
  const dv = view(bytes);
  const width = dv.getUint8(6) | (dv.getUint8(7) << 8); // 小さい桁が先
  const height = dv.getUint8(8) | (dv.getUint8(9) << 8);
  if (width === 0 || height === 0) return undefined;
  return { width, height };
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 16) return undefined;
  const dv = view(bytes);
  // 12〜15 のかたまりの名前（V P 8 ?）
  const name = dv.getUint8(12) | (dv.getUint8(13) << 8) | (dv.getUint8(14) << 16) | (dv.getUint8(15) << 24);
  if (name === 0x20385056) {
    // VP8（最後は空白）。23〜25 が 9D 01 2A
    if (bytes.length < 30) return undefined;
    if (dv.getUint8(23) !== 0x9d || dv.getUint8(24) !== 0x01 || dv.getUint8(25) !== 0x2a) return undefined;
    const width = (dv.getUint8(26) | (dv.getUint8(27) << 8)) & 0x3fff;
    const height = (dv.getUint8(28) | (dv.getUint8(29) << 8)) & 0x3fff;
    if (width === 0 || height === 0) return undefined;
    return { width, height };
  }
  if (name === 0x4c385056) {
    // VP8L。20 が 0x2F、b1..b4 を 21..24
    if (bytes.length < 25) return undefined;
    if (dv.getUint8(20) !== 0x2f) return undefined;
    const b1 = dv.getUint8(21);
    const b2 = dv.getUint8(22);
    const b3 = dv.getUint8(23);
    const b4 = dv.getUint8(24);
    const width = 1 + (b1 | ((b2 & 0x3f) << 8));
    const height = 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10));
    if (width === 0 || height === 0) return undefined;
    return { width, height };
  }
  if (name === 0x58385056) {
    // VP8X。幅 = 1 + 24 からの 3 バイト、高さ = 1 + 27 から同じ（小さい桁が先）
    if (bytes.length < 30) return undefined;
    const width = 1 + (dv.getUint8(24) | (dv.getUint8(25) << 8) | (dv.getUint8(26) << 16));
    const height = 1 + (dv.getUint8(27) | (dv.getUint8(28) << 8) | (dv.getUint8(29) << 16));
    if (width === 0 || height === 0) return undefined;
    return { width, height };
  }
  return undefined;
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const n = bytes.length;
  const dv = view(bytes);
  let pos = 2;
  for (let count = 0; count < 10000; count++) {
    if (pos + 1 >= n) return undefined;
    if (dv.getUint8(pos) !== 0xff) return undefined;
    // 印は FF で始まり、続く FF は詰め物として飛ばす
    let m = pos + 1;
    while (m < n && dv.getUint8(m) === 0xff) m++;
    if (m >= n) return undefined;
    const code = dv.getUint8(m);
    // 画像データの始まり（DA）か EOI（D9）に着いたら終わり
    if (code === 0xda || code === 0xd9) return undefined;
    // D0〜D9 と 01 は長さを持たない（次へ）
    if (code === 0x01 || (code >= 0xd0 && code <= 0xd9)) {
      pos = m + 1;
      continue;
    }
    // ほかは次の 2 バイトが長さ（大きい桁が先、2 以上）
    if (m + 3 > n) return undefined;
    const length = (dv.getUint8(m + 1) << 8) | dv.getUint8(m + 2);
    if (length < 2) return undefined;
    // SOF（C0〜CF のうち C4・C8・CC を除く）なら縦横を読む
    if (code >= 0xc0 && code <= 0xcf && code !== 0xc4 && code !== 0xc8 && code !== 0xcc) {
      if (m + 8 > n) return undefined;
      const height = (dv.getUint8(m + 4) << 8) | dv.getUint8(m + 5);
      const width = (dv.getUint8(m + 6) << 8) | dv.getUint8(m + 7);
      if (width === 0 || height === 0) return undefined;
      return { width, height };
    }
    pos = m + 1 + length;
    if (pos > n) return undefined;
  }
  return undefined;
}

export function imageSize(bytes: Uint8Array, type: ImageType): { width: number; height: number } | undefined {
  switch (type) {
    case 'png':
      return pngSize(bytes);
    case 'gif':
      return gifSize(bytes);
    case 'webp':
      return webpSize(bytes);
    case 'jpeg':
      return jpegSize(bytes);
  }
}
