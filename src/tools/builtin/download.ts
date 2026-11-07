import { randomUUID } from 'node:crypto';
import { closeSync, constants, linkSync, lstatSync, mkdirSync, openSync, readdirSync, statfsSync, unlinkSync, write, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import type { Language } from '../../config/schema.ts';
import { languageOf } from '../../shared/language.ts';
import { guardText } from '../../shared/messages/guard.ts';
import type { MessageParams } from '../../shared/messages/define.ts';
import { toolText, type ToolMessageKey } from '../../shared/messages/tools.ts';
import { worst } from '../hooks/shell-guard.ts';
import type { PreCheck, ToolDef, ToolOutput } from '../types.ts';
import { clip, DOWNLOAD_LIMITS, downloadPublic, mediaTypeOf, pageUrl, RetrievalFailure, type DownloadSink } from '../web/public-page.ts';
import { contentDispositionName, DOWNLOADS_DIR, downloadsDir, numberedName, safeDownloadName, urlFileName, zoneIdentifier } from './downloads-core.ts';
import { checkFilePath } from './files.ts';
import { exfiltrationCheck, webFailure } from './web.ts';

const MAX_NUMBER = 999;

// このツール自身の書きかけの名前（.<uuid>.part）。ほかの名前は、持ち主のファイルかもしれないので触らない
const PART_NAME = /^\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.part$/u;
// いま書いている最中の書きかけ（同時に走る別のダウンロードのものを消さないため）
const activeParts = new Set<string>();

// 落ちたり止められたりして残った、前の実行の書きかけを消す
function removeStaleParts(dir: string): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const stale = join(dir, name);
    if (PART_NAME.test(name) && !activeParts.has(stale)) try { unlinkSync(stale); } catch { }
  }
}

const LINK_UNSUPPORTED = new Set(['EPERM', 'EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK', 'EINVAL']);

const codeOf = (thrown: unknown): string | undefined => {
  const code = (thrown as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

function safeDetail(thrown: unknown): string {
  const code = codeOf(thrown);
  if (code && /^[A-Z0-9_]{1,40}$/u.test(code)) return code;
  return thrown instanceof Error && /^[A-Za-z]{1,40}$/u.test(thrown.name) ? thrown.name : 'unknown';
}

function freeBytesOf(dir: string): number {
  const stat = statfsSync(dir);
  return stat.bavail * stat.bsize;
}

function writeOnce(fd: number, chunk: Uint8Array, offset: number): Promise<number> {
  return new Promise((resolve, reject) => {
    write(fd, chunk, offset, chunk.length - offset, null, (error, written) => (error ? reject(error) : resolve(written)));
  });
}

function partSink(fd: number, dir: string): DownloadSink {
  return {
    async write(chunk) {
      for (let offset = 0; offset < chunk.length;) offset += await writeOnce(fd, chunk, offset);
    },
    freeBytes: () => freeBytesOf(dir),
  };
}

async function place(part: string, dir: string, name: string): Promise<string | undefined> {
  let linkable = true;
  for (let n = 0; n <= MAX_NUMBER; n++) {
    const candidate = n === 0 ? name : numberedName(name, n);
    const target = join(dir, candidate);
    try {
      if (linkable) {
        try { linkSync(part, target); return candidate; } catch (error) {
          const code = codeOf(error);
          if (code === undefined || !LINK_UNSUPPORTED.has(code)) throw error;
          linkable = false;
        }
      }
      try {
        await copyFile(part, target, constants.COPYFILE_EXCL);
        return candidate;
      } catch (error) {
        // EEXIST 以外で失敗したときは、target は自分が（排他で）作った書きかけ。持ち主のファイルではないので消す
        if (codeOf(error) !== 'EEXIST') try { unlinkSync(target); } catch { }
        throw error;
      }
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error;
    }
  }
  return undefined;
}

function local(language: Language, key: ToolMessageKey, params?: MessageParams): ToolOutput & { isError: true } {
  return { content: toolText(language, key, params), isError: true, noRemoteContent: true };
}

function mergeChecks(first: PreCheck, second: PreCheck): PreCheck {
  const details = [...(first.details ?? []), ...(second.details ?? [])];
  const askKinds = [...(first.askKinds ?? []), ...(second.askKinds ?? [])];
  return {
    decision: worst(first.decision, second.decision),
    reasons: [...first.reasons, ...second.reasons],
    ...(details.length ? { details } : {}),
    ...(second.paths ? { paths: second.paths } : {}),
    ...(first.onceOnly || second.onceOnly ? { onceOnly: true } : {}),
    ...(askKinds.length ? { askKinds } : {}),
  };
}

export const webDownload: ToolDef<{ url: string; name?: string }> = {
  name: 'web_download',
  description: '公開の Web のファイルをダウンロードして、作業フォルダの downloads/ に保存する（場所は選べない。name は名前の候補で、安全な形に直される。同じ名前があれば -1 などを付け、上書きしない）。保存したファイルは外部のデータ。ローカルや LAN の宛先は取れない。',
  input: Type.Object({
    url: Type.String({ minLength: 1, maxLength: 4096 }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 255, description: '保存する名前の候補' })),
  }, { additionalProperties: false }),
  effect: 'network',
  writesFiles: true,
  allowedIn: ['chat', 'task'],
  preCheck(input, ctx) {
    const language = languageOf(ctx.config);
    if (!ctx.config.tools.web.fetch) return { decision: 'deny', reasons: [guardText(language, 'web.fetch_off')] };
    let url: URL;
    try { url = pageUrl(input.url); } catch (error) { return { decision: 'deny', reasons: [error instanceof RetrievalFailure ? error.text(language) : (error as Error).message] }; }
    const web = exfiltrationCheck(input.url, language, url.search.length > 300 ? [guardText(language, 'web.long_query')] : []);
    return mergeChecks(web, checkFilePath(DOWNLOADS_DIR, 'write', ctx).check);
  },
  summarize: (input, language) => ({ title: toolText(language, 'summary.web_download'), body: input.name === undefined ? input.url : `${input.url}\n${input.name}` }),
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    const dir = downloadsDir(ctx.workspace);
    let part: string | undefined;
    let fd: number | undefined;
    try {
      mkdirSync(dir, { recursive: true });
      if (lstatSync(dir).isSymbolicLink()) return local(language, 'download.dir_link');
      if (checkFilePath(DOWNLOADS_DIR, 'write', ctx).check.decision === 'deny') return local(language, 'file.recheck_failed', { detail: DOWNLOADS_DIR });
      const free = freeBytesOf(dir);
      if (free < DOWNLOAD_LIMITS.minFreeBytes) return local(language, 'download.disk_low', { free });

      removeStaleParts(dir);
      part = join(dir, `.${randomUUID()}.part`);
      activeParts.add(part);
      fd = openSync(part, 'wx');
      const network = ctx.services?.web?.download;
      const downloaded = await downloadPublic(input.url, ctx.signal, partSink(fd, dir), network ? { network } : {});
      closeSync(fd);
      fd = undefined;

      let picked: { name: string; renamed: boolean } | undefined;
      for (const candidate of [input.name, contentDispositionName(downloaded.contentDisposition), urlFileName(new URL(downloaded.url))]) {
        picked = candidate === undefined ? undefined : safeDownloadName(candidate);
        if (picked) break;
      }
      picked ??= { name: 'download', renamed: false };

      const placed = await place(part, dir, picked.name);
      if (placed === undefined) return { content: toolText(language, 'download.name_taken', { name: picked.name }), isError: true };

      let zoneFailed: string | undefined;
      if (process.platform === 'win32') {
        try { writeFileSync(`${join(dir, placed)}:Zone.Identifier`, zoneIdentifier(downloaded.url)); } catch (error) { zoneFailed = safeDetail(error); }
      }
      return {
        content: [
          toolText(language, 'download.saved', { path: `${DOWNLOADS_DIR}/${placed}`, size: downloaded.bytes.toLocaleString('en-US'), type: mediaTypeOf(downloaded.contentType) ?? '?', url: clip(downloaded.url, 200) }),
          toolText(language, 'download.external'),
          picked.renamed ? toolText(language, 'download.renamed') : '',
          zoneFailed === undefined ? '' : toolText(language, 'download.zone_failed', { detail: zoneFailed }),
        ].filter(Boolean).join('\n'),
      };
    } catch (error) {
      return error instanceof RetrievalFailure ? webFailure(error, language) : local(language, 'failed', { detail: safeDetail(error) });
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { }
      if (part !== undefined) { activeParts.delete(part); try { unlinkSync(part); } catch { } }
    }
  },
};
