// ダウンロードの名前と置き場所の核。純粋な関数だけ（段 4-6）。
// 見えない文字（向きの印・幅の無い文字・制御文字）はエスケープで書く。実物の文字をソースに書かない。

import { join } from 'node:path';
import { isInside, realish } from '../hooks/scope.ts';
import { hasToolConfigName } from '../hooks/tool-config.ts';

export const DOWNLOADS_DIR = 'downloads';

export function downloadsDir(workspace: string): string {
  return join(workspace, DOWNLOADS_DIR);
}

export function isUnderDownloads(abs: string, workspace: string): boolean {
  return isInside(realish(downloadsDir(workspace)), realish(abs));
}

// 落とす文字: 制御文字・DEL・C1 制御・< > : " / バックスラッシュ | ? *・向きの印・幅の無い文字
const DROP_RE = /[\u0000-\u001F\u007F-\u009F<>"\/\\:|?*]|[\u200E\u200F\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/gu;

// 拡張子の前の部分が Windows の予約名（デバイス名）か。大文字小文字を問わない
const RESERVED_BASE = /^(?:con|prn|aux|nul|com(?:[0-9]|[\u00B9\u00B2\u00B3])|lpt(?:[0-9]|[\u00B9\u00B2\u00B3]))$/iu;

// 危険な名前（小文字にして全名で比べる）
const DANGEROUS_NAMES = new Set(['desktop.ini', 'autorun.inf', 'folder.htt']);
// 危険な拡張子（. を含む、小文字）
const DANGEROUS_EXTS = new Set(['.lnk', '.url', '.scf', '.library-ms', '.searchconnector-ms', '.appref-ms']);

const MAX_NAME = 150;
const MAX_EXT = 10;

export function safeDownloadName(candidate: string): { name: string; renamed: boolean } | undefined {
  let name = candidate.normalize('NFC');
  // 最後の / と バックスラッシュ の後ろだけ
  const lastSlash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (lastSlash >= 0) name = name.slice(lastSlash + 1);
  // 落とす文字
  name = name.replace(DROP_RE, '');
  // 前後の空白と . を落とす
  name = name.replace(/^[\s.]+/u, '').replace(/[\s.]+$/u, '');
  if (name === '') return undefined;
  // 拡張子の前の部分が予約名なら先頭に _
  const dot = name.lastIndexOf('.');
  const base = dot >= 0 ? name.slice(0, dot) : name;
  if (RESERVED_BASE.test(base)) name = '_' + name;
  // 長さは 150 文字まで（拡張子は最後の . から 10 文字まで。前を切る）
  const dot2 = name.lastIndexOf('.');
  if (dot2 > 0) {
    const ext = name.slice(dot2);
    if (ext.length <= MAX_EXT) {
      const b = name.slice(0, dot2);
      if (b.length + ext.length > MAX_NAME) name = b.slice(0, Math.max(0, MAX_NAME - ext.length)) + ext;
    }
  } else if (name.length > MAX_NAME) {
    name = name.slice(0, MAX_NAME);
  }
  // 危険な名前・拡張子・設定の名前なら .download を足す
  const lower = name.toLowerCase();
  const dot3 = lower.lastIndexOf('.');
  const extLower = dot3 >= 0 ? lower.slice(dot3) : '';
  const dangerous = DANGEROUS_NAMES.has(lower) || DANGEROUS_EXTS.has(extLower) || hasToolConfigName(name);
  if (dangerous) return { name: name + '.download', renamed: true };
  return { name, renamed: false };
}

// ヘッダーが 2,000 文字を超えたら undefined
const MAX_HEADER = 2000;

export function contentDispositionName(header: string | undefined): string | undefined {
  if (header === undefined || header.length > MAX_HEADER) return undefined;
  // filename*= を先に見る（UTF-8'' の後ろを decodeURIComponent。投げたら無視して filename= に戻る）
  const star = header.match(/filename\*\s*=\s*([^;]+)/iu);
  const starValue = star?.[1];
  if (starValue !== undefined) {
    const raw = starValue.trim();
    const eq = raw.lastIndexOf("'");
    if (eq >= 0) {
      const encoded = raw.slice(eq + 1);
      try { return decodeURIComponent(encoded); } catch { /* 壊れたパーセントは無視 */ }
    }
  }
  // filename=（" で囲んだ値は中の \" を " に。囲まない値は ; まで）
  const m = header.match(/filename\s*=\s*(.*)$/iu);
  const captured = m?.[1];
  if (captured === undefined) return undefined;
  let value = captured;
  if (value.startsWith('"')) {
    const close = value.indexOf('"', 1);
    if (close < 0) return undefined; // 閉じない引用符
    value = value.slice(1, close).replace(/\\(["\\])/gu, '$1');
  } else {
    value = value.split(';')[0] ?? '';
  }
  return value;
}

export function urlFileName(url: URL): string | undefined {
  const segments = url.pathname.split('/');
  const last = segments[segments.length - 1] ?? '';
  if (last === '') return undefined;
  try { return decodeURIComponent(last); } catch { return last; }
}

export function numberedName(name: string, n: number): string {
  const suffix = '-' + n;
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    // .download で終わる名前は .download の前の拡張子の前に
    if (name.toLowerCase().endsWith('.download')) {
      const inner = name.slice(0, dot);
      const innerDot = inner.lastIndexOf('.');
      if (innerDot > 0) return inner.slice(0, innerDot) + suffix + inner.slice(innerDot) + name.slice(dot);
      return inner + suffix + name.slice(dot);
    }
    return name.slice(0, dot) + suffix + name.slice(dot);
  }
  return name + suffix;
}

export function zoneIdentifier(hostUrl: string): string {
  const clean = hostUrl.replace(/[\r\n]/gu, '');
  return '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=' + clean + '\r\n';
}
