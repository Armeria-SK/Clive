import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DOWNLOADS_DIR,
  contentDispositionName,
  downloadsDir,
  isUnderDownloads,
  numberedName,
  safeDownloadName,
  urlFileName,
  zoneIdentifier,
} from '../src/tools/builtin/downloads-core.ts';

test('ダウンロード: downloadsDir は作業フォルダの下', () => {
  assert.equal(DOWNLOADS_DIR, 'downloads');
  assert.equal(downloadsDir('/work'), join('/work', 'downloads'));
});

test('ダウンロード: safeDownloadName は最後の区切りの後ろだけを取る', () => {
  assert.deepEqual(safeDownloadName('../../etc/passwd'), { name: 'passwd', renamed: false });
  assert.deepEqual(safeDownloadName('C:\\Windows\\x.exe'), { name: 'x.exe', renamed: false });
});

test('ダウンロード: safeDownloadName はコロンを落とす', () => {
  assert.deepEqual(safeDownloadName('a:b.txt'), { name: 'ab.txt', renamed: false });
});

test('ダウンロード: safeDownloadName は予約名に _ を付ける', () => {
  assert.deepEqual(safeDownloadName('CON.txt'), { name: '_CON.txt', renamed: false });
  assert.deepEqual(safeDownloadName('com1'), { name: '_com1', renamed: false });
  assert.deepEqual(safeDownloadName('LPT\u00B9.log'), { name: '_LPT\u00B9.log', renamed: false });
});

test('ダウンロード: safeDownloadName は最初の . の前の部分（末尾の空白と . を除く）で予約名を見つける', () => {
  assert.deepEqual(safeDownloadName('nul.tar.gz'), { name: '_nul.tar.gz', renamed: false });
  assert.deepEqual(safeDownloadName('CON .txt'), { name: '_CON .txt', renamed: false });
  assert.deepEqual(safeDownloadName('CONIN$'), { name: '_CONIN$', renamed: false });
  assert.deepEqual(safeDownloadName('conin$.log'), { name: '_conin$.log', renamed: false });
  assert.deepEqual(safeDownloadName('CONOUT$.txt'), { name: '_CONOUT$.txt', renamed: false });
  assert.deepEqual(safeDownloadName('com1.log'), { name: '_com1.log', renamed: false });
  assert.deepEqual(safeDownloadName('Lpt².tar.gz'), { name: '_Lpt².tar.gz', renamed: false });
});

test('ダウンロード: safeDownloadName は予約名に似ているだけの名前には _ を付けない', () => {
  assert.deepEqual(safeDownloadName('console.txt'), { name: 'console.txt', renamed: false });
  assert.deepEqual(safeDownloadName('a.nul'), { name: 'a.nul', renamed: false });
  assert.deepEqual(safeDownloadName('conin.txt'), { name: 'conin.txt', renamed: false });
  assert.deepEqual(safeDownloadName('com10.txt'), { name: 'com10.txt', renamed: false });
});

test('ダウンロード: safeDownloadName は前後の空白とドットを落とす', () => {
  assert.deepEqual(safeDownloadName('report.txt.'), { name: 'report.txt', renamed: false });
  assert.deepEqual(safeDownloadName('report.txt   '), { name: 'report.txt', renamed: false });
  assert.deepEqual(safeDownloadName('.bashrc'), { name: 'bashrc', renamed: false });
});

test('ダウンロード: safeDownloadName は向きの印と幅の無い文字を落とす', () => {
  assert.deepEqual(safeDownloadName('invoice\u202Efdp.exe'), { name: 'invoicefdp.exe', renamed: false });
  assert.deepEqual(safeDownloadName('a\u200Bb.txt'), { name: 'ab.txt', renamed: false });
});

test('ダウンロード: safeDownloadName は空なら undefined', () => {
  assert.equal(safeDownloadName('\u0000'), undefined);
  assert.equal(safeDownloadName('...'), undefined);
  assert.equal(safeDownloadName('   '), undefined);
});

test('ダウンロード: safeDownloadName は危険な名前に .download を付ける', () => {
  assert.deepEqual(safeDownloadName('Desktop.INI'), { name: 'Desktop.INI.download', renamed: true });
  assert.deepEqual(safeDownloadName('x.LNK'), { name: 'x.LNK.download', renamed: true });
  assert.deepEqual(safeDownloadName('_curlrc'), { name: '_curlrc.download', renamed: true });
  assert.deepEqual(safeDownloadName('sitecustomize.py'), { name: 'sitecustomize.py.download', renamed: true });
  assert.deepEqual(safeDownloadName('Microsoft.PowerShell_profile.ps1'), { name: 'Microsoft.PowerShell_profile.ps1.download', renamed: true });
});

test('ダウンロード: safeDownloadName は 150 文字まで切る', () => {
  const long = 'a'.repeat(300) + '.pdf';
  const r = safeDownloadName(long);
  assert.ok(r !== undefined);
  assert.ok(r!.name.length <= 150);
  assert.ok(r!.name.endsWith('.pdf'));
});

test('ダウンロード: safeDownloadName は拡張子が長すぎるときは名前全体を切り、.download と -999 を足しても 255 文字を超えない', () => {
  const r = safeDownloadName('a'.repeat(10) + '.' + 'b'.repeat(240));
  assert.ok(r !== undefined);
  assert.ok(r!.name.length <= 150, String(r!.name.length));
  assert.ok(r!.name.startsWith('aaaaaaaaaa.bbb'));
  assert.ok(numberedName(r!.name, 999).length <= 255);
  assert.ok((r!.name + '.download').length <= 255);
  assert.ok(numberedName(r!.name + '.download', 999).length <= 255);
});

test('ダウンロード: safeDownloadName は切ったあとの末尾の . と空白を落とし、拡張子が危険なら .download を足しても 150 + 9 文字', () => {
  const dotted = safeDownloadName('a'.repeat(149) + '.' + 'b'.repeat(20));
  assert.deepEqual(dotted, { name: 'a'.repeat(149), renamed: false });
  const spaced = safeDownloadName('a'.repeat(149) + ' ' + 'b'.repeat(20));
  assert.deepEqual(spaced, { name: 'a'.repeat(149), renamed: false });
  const lnk = safeDownloadName('a'.repeat(300) + '.LNK');
  assert.ok(lnk !== undefined);
  assert.equal(lnk!.renamed, true);
  assert.equal(lnk!.name.length, 150 + '.download'.length);
  assert.ok(lnk!.name.endsWith('.LNK.download'));
});

test('ダウンロード: safeDownloadName はエクスプローラーが開くと動く拡張子（大文字小文字を問わない）に .download を付ける', () => {
  const exts = ['.lnk', '.url', '.scf', '.appref-ms', '.library-ms', '.searchconnector-ms', '.search-ms', '.theme', '.themepack', '.desktopthemepackfile', '.settingcontent-ms', '.website'];
  for (const ext of exts) {
    assert.deepEqual(safeDownloadName(`x${ext}`), { name: `x${ext}.download`, renamed: true }, ext);
    const upper = ext.toUpperCase();
    assert.deepEqual(safeDownloadName(`Y${upper}`), { name: `Y${upper}.download`, renamed: true }, upper);
  }
  assert.deepEqual(safeDownloadName('report.theme.txt'), { name: 'report.theme.txt', renamed: false });
  assert.deepEqual(safeDownloadName('mywebsite'), { name: 'mywebsite', renamed: false });
});

test('ダウンロード: safeDownloadName は NFD を NFC にする', () => {
  const nfd = '\u304B\u3099';
  const r = safeDownloadName(nfd);
  assert.ok(r !== undefined);
  assert.equal(r!.name.length, 1);
});

test('ダウンロード: contentDispositionName は filename= を取る', () => {
  assert.equal(contentDispositionName('attachment; filename="a b.pdf"'), 'a b.pdf');
});

test('ダウンロード: contentDispositionName は filename*= を優先する', () => {
  assert.equal(contentDispositionName("attachment; filename*=UTF-8''%E8%A1%A8.xlsx; filename=\"x.xlsx\""), '表.xlsx');
});

test('ダウンロード: contentDispositionName は壊れた filename*= を無視して filename= に戻る', () => {
  assert.equal(contentDispositionName("attachment; filename*=UTF-8''%E8%A1; filename=\"x.xlsx\""), 'x.xlsx');
});

test('ダウンロード: contentDispositionName は長いヘッダーを undefined', () => {
  assert.equal(contentDispositionName('x'.repeat(2001)), undefined);
});

test('ダウンロード: contentDispositionName は閉じない引用符を undefined', () => {
  const start = Date.now();
  assert.equal(contentDispositionName('filename="' + 'a'.repeat(100_000)), undefined);
  assert.ok(Date.now() - start < 2000);
});

test('ダウンロード: urlFileName は最後の部分を取る', () => {
  assert.equal(urlFileName(new URL('https://example.com/a/b/file.pdf')), 'file.pdf');
  assert.equal(urlFileName(new URL('https://example.com/')), undefined);
});

test('ダウンロード: numberedName は -n を付ける', () => {
  assert.equal(numberedName('a.txt', 1), 'a-1.txt');
  assert.equal(numberedName('a', 1), 'a-1');
  assert.equal(numberedName('a.tar.gz', 1), 'a.tar-1.gz');
  assert.equal(numberedName('x.lnk.download', 1), 'x-1.lnk.download');
});

test('ダウンロード: zoneIdentifier は ZoneId=3 と HostUrl を書く', () => {
  assert.equal(zoneIdentifier('https://example.com/x'), '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://example.com/x\r\n');
});

test('ダウンロード: zoneIdentifier は HostUrl の改行を落とす', () => {
  assert.equal(zoneIdentifier('https://example.com/\r\nx'), '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://example.com/x\r\n');
});

test('ダウンロード: isUnderDownloads は downloads/ の下を見る', () => {
  const ws = mkdtempSync(join(tmpdir(), 'clive-dl-'));
  try {
    const dl = join(ws, 'downloads');
    mkdirSync(dl, { recursive: true });
    assert.equal(isUnderDownloads(join(dl, 'a.png'), ws), true);
    assert.equal(isUnderDownloads(join(ws, 'downloads2', 'a.png'), ws), false);
    assert.equal(isUnderDownloads(join(dl, '..', 'x'), ws), false);
    assert.equal(isUnderDownloads(dl, ws), true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('ダウンロード: isUnderDownloads はリンク先も見る', (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'clive-dl-'));
  const target = mkdtempSync(join(tmpdir(), 'clive-dl-target-'));
  try {
    writeFileSync(join(target, 'a.png'), 'x');
    const dl = join(ws, 'downloads');
    try {
      if (process.platform === 'win32') {
        symlinkSync(target, dl, 'junction');
      } else {
        symlinkSync(target, dl);
      }
    } catch (e) {
      // この環境ではリンクを作れない（権限・開発者モード）。コードのせいではないのでスキップ
      t.skip('リンクを作れない（' + (e as NodeJS.ErrnoException).code + '）');
      return;
    }
    assert.equal(isUnderDownloads(join(dl, 'a.png'), ws), true);
  } finally {
    try { rmSync(join(ws, 'downloads'), { force: true }); } catch { }
    rmSync(ws, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
