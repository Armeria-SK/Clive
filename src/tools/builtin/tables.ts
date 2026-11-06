import { mkdirSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative } from 'node:path';
import { Type } from '@sinclair/typebox';
import type { Language } from '../../config/schema.ts';
import { atomicWriteFile } from '../../config/store.ts';
import { languageOf } from '../../shared/language.ts';
import { toolText } from '../../shared/messages/tools.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';
import { checkFilePath } from './files.ts';
import { TABLE_MAX_CELLS, TABLE_MAX_CELL_CHARS, csvText, xlsxBytes } from './table-core.ts';
import type { Cell } from './table-core.ts';

export const TABLE_MAX_TOTAL_CHARS = 5_000_000;
const TABLE_MAX_ROWS = 100_000;
const TABLE_MAX_COLUMNS = 16_384;
const SUMMARY_ROWS = 20;
const SUMMARY_CHARS = 4000;

const FORMATS = new Set(['.csv', '.xlsx']);

const shown = (abs: string, ctx: ToolContext) => {
  const rel = relative(ctx.workspace, abs);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replaceAll('\\', '/') : abs;
};

const PathArg = Type.String({ minLength: 1, maxLength: 1024, description: '作業フォルダからの相対パス、または許可フォルダ内の絶対パス' });
const CellArg = Type.Union([Type.String({ maxLength: TABLE_MAX_CELL_CHARS }), Type.Number(), Type.Null()]);

const error = (content: string): ToolOutput => ({ content, isError: true });

function safeDetail(thrown: unknown): string {
  const code = (thrown as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
  return thrown instanceof Error && /^[A-Za-z]{1,40}$/.test(thrown.name) ? thrown.name : 'unknown';
}

const formatOf = (abs: string): string | undefined => {
  const ext = extname(abs).toLowerCase();
  return FORMATS.has(ext) ? ext : undefined;
};

function sizeProblem(rows: ReadonlyArray<ReadonlyArray<Cell>>, language: Language): string | undefined {
  let cells = 0;
  let chars = 0;
  for (const row of rows) {
    cells += row.length;
    for (const cell of row) if (typeof cell === 'string') chars += cell.length;
  }
  if (cells > TABLE_MAX_CELLS) return toolText(language, 'table.too_many', { count: cells.toLocaleString('en-US'), max: TABLE_MAX_CELLS.toLocaleString('en-US') });
  if (chars > TABLE_MAX_TOTAL_CHARS) return toolText(language, 'failed', { detail: `characters ${chars.toLocaleString('en-US')} > ${TABLE_MAX_TOTAL_CHARS.toLocaleString('en-US')}` });
  return undefined;
}

export const tableWrite: ToolDef<{ path: string; rows: Array<Array<string | number | null>>; overwrite?: boolean }> = {
  name: 'table_write',
  description: '表のファイル（.csv か .xlsx。拡張子で決まる）を書く。rows は行の並びで、各行はセルの並び（文字・数・null）。数は数として渡す（"-5" のような文字は、式にならないよう先頭に \' が付く）。式は書けない。既にあるファイルは overwrite: true のときだけ上書きする。',
  input: Type.Object({
    path: PathArg,
    rows: Type.Array(Type.Array(CellArg, { maxItems: TABLE_MAX_COLUMNS }), { minItems: 1, maxItems: TABLE_MAX_ROWS }),
    overwrite: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }),
  effect: 'write',
  folderGrant: true,
  allowedIn: ['chat', 'task'],
  preCheck(input, ctx) {
    const language = languageOf(ctx.config);
    const { abs, check } = checkFilePath(input.path, 'write', ctx);
    if (check.decision === 'deny') return check;
    if (!formatOf(abs)) return { decision: 'deny', reasons: [toolText(language, 'table.bad_ext', { path: input.path })] };
    const problem = sizeProblem(input.rows, language);
    return problem ? { decision: 'deny', reasons: [problem] } : check;
  },
  summarize: (input, language) => ({
    title: toolText(language, 'summary.table_write', { path: input.path, rows: input.rows.length }),
    body: csvText(input.rows.slice(0, SUMMARY_ROWS)).text.slice(1, 1 + SUMMARY_CHARS),
  }),
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    const { abs, check } = checkFilePath(input.path, 'write', ctx);
    if (check.decision === 'deny') return error(check.reasons.join(' / '));
    const format = formatOf(abs);
    if (!format) return error(toolText(language, 'table.bad_ext', { path: input.path }));
    const problem = sizeProblem(input.rows, language);
    if (problem) return error(problem);
    const path = shown(abs, ctx);
    try {
      mkdirSync(dirname(abs), { recursive: true });
      const recheck = checkFilePath(abs, 'write', ctx).check;
      if (recheck.decision === 'deny') return error(toolText(language, 'file.recheck_failed', { detail: recheck.reasons.join(' / ') }));
      const stat = statSync(abs, { throwIfNoEntry: false });
      if (stat?.isDirectory()) return error(toolText(language, 'file.is_dir', { path }));
      if (stat && input.overwrite !== true) return error(toolText(language, 'file.exists', { path }));
      let neutralized: number;
      if (format === '.csv') {
        const made = csvText(input.rows);
        atomicWriteFile(abs, made.text);
        neutralized = made.neutralized;
      } else {
        const made = xlsxBytes(input.rows);
        atomicWriteFile(abs, made.bytes);
        neutralized = made.neutralized;
      }
      const cols = input.rows.reduce((max, row) => Math.max(max, row.length), 0);
      const wrote = toolText(language, 'table.wrote', { path, rows: input.rows.length, cols });
      return { content: neutralized > 0 ? `${wrote}\n${toolText(language, 'table.neutralized', { count: neutralized })}` : wrote };
    } catch (thrown) {
      return error(toolText(language, 'failed', { detail: safeDetail(thrown) }));
    }
  },
};
