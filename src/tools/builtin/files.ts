import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Type } from '@sinclair/typebox';
import { atomicWriteFile } from '../../config/store.ts';
import { expandPath, needsWriteApproval, placePath } from '../hooks/scope.ts';
import type { PreCheck, ToolContext, ToolDef } from '../types.ts';

const MAX_READ_BYTES = 512 * 1024;
const MAX_WRITE_CHARS = 1_000_000;

type Need = 'read' | 'write';

export function checkFilePath(input: string, need: Need, ctx: ToolContext): { abs: string; check: PreCheck } {
  const expanded = expandPath(input, ctx.workspace);
  if ('unresolved' in expanded) return { abs: '', check: { decision: 'deny', reasons: [`パスが判定できません（${input}）: ${expanded.unresolved}`] } };
  const abs = expanded.path;
  const placement = placePath(abs, ctx.policy);
  if (placement.kind === 'deny') return { abs, check: { decision: 'deny', reasons: [placement.reason] } };
  if (placement.kind === 'outside') {
    return { abs, check: { decision: 'deny', reasons: [`許可フォルダの外です（${abs}）。使えるフォルダ: ${ctx.policy.roots.map(r => `${r.path}（${r.mode === 'write' ? '読み書き' : '読むだけ'}）`).join('、')}`] } };
  }
  if (need === 'write' && placement.mode === 'read') return { abs, check: { decision: 'deny', reasons: [`読み取り専用のフォルダです（${placement.root}）`] } };
  if (need === 'write' && existsSync(abs) && lstatSync(abs).isSymbolicLink()) return { abs, check: { decision: 'deny', reasons: ['シンボリックリンクには書き込みません'] } };
  if (need === 'write' && needsWriteApproval(abs, ctx.policy)) {
    return { abs, check: { decision: 'ask', reasons: ['人格・プロフィールのファイル（SOUL.md / USER.md）なので、書き換える前に確認します'] } };
  }
  return { abs, check: { decision: 'allow', reasons: [] } };
}

const shown = (abs: string, ctx: ToolContext) => {
  const rel = relative(ctx.workspace, abs);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replaceAll('\\', '/') : abs;
};

const PathArg = Type.String({ minLength: 1, maxLength: 1024, description: '作業フォルダからの相対パス、または許可フォルダ内の絶対パス' });

export const fileRead: ToolDef<{ path: string; offset?: number; limit?: number }> = {
  name: 'file_read',
  description: 'テキストファイルを読む。offset（何行目から、1始まり）と limit（何行）で一部だけ読める。',
  input: Type.Object({ path: PathArg, offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })) }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task'],
  preCheck: (input, ctx) => checkFilePath(input.path, 'read', ctx).check,
  async execute(input, ctx) {
    const { abs } = checkFilePath(input.path, 'read', ctx);
    const stat = statSync(abs, { throwIfNoEntry: false });
    if (!stat) return { content: `ファイルがありません: ${shown(abs, ctx)}`, isError: true };
    if (stat.isDirectory()) return { content: `フォルダです。file_list を使ってください: ${shown(abs, ctx)}`, isError: true };
    if (stat.size > MAX_READ_BYTES && !input.limit) return { content: `大きいファイルです（${stat.size.toLocaleString('en-US')} バイト）。offset と limit で一部ずつ読んでください`, isError: true };
    const text = readFileSync(abs, 'utf8');
    if (text.includes('\u0000')) return { content: 'バイナリファイルのようなので読みません', isError: true };
    const lines = text.split(/\r?\n/u);
    const start = (input.offset ?? 1) - 1;
    const end = input.limit ? start + input.limit : lines.length;
    const body = lines.slice(start, end).join('\n');
    const more = end < lines.length ? `\n\n[${lines.length} 行中 ${start + 1}〜${end} 行目。続きは offset=${end + 1} で読めます]` : '';
    return { content: body + more };
  },
};

export const fileWrite: ToolDef<{ path: string; content: string; mode?: 'overwrite' | 'append' | 'create' }> = {
  name: 'file_write',
  description: 'テキストファイルを書く。mode: overwrite（上書き・既定）/ append（末尾に追記）/ create（無いときだけ作る）。フォルダは自動で作る。',
  input: Type.Object({
    path: PathArg, content: Type.String({ maxLength: MAX_WRITE_CHARS }),
    mode: Type.Optional(Type.Union([Type.Literal('overwrite'), Type.Literal('append'), Type.Literal('create')])),
  }, { additionalProperties: false }),
  effect: 'write',
  allowedIn: ['chat', 'task'],
  preCheck: (input, ctx) => checkFilePath(input.path, 'write', ctx).check,
  summarize: input => ({ title: `ファイルに書き込む: ${input.path}`, body: input.content.slice(0, 4000) }),
  async execute(input, ctx) {
    const { abs } = checkFilePath(input.path, 'write', ctx);
    const exists = existsSync(abs);
    if (input.mode === 'create' && exists) return { content: `既にあります: ${shown(abs, ctx)}`, isError: true };
    if (exists && statSync(abs).isDirectory()) return { content: `フォルダです: ${shown(abs, ctx)}`, isError: true };
    mkdirSync(dirname(abs), { recursive: true });
    // フォルダを作った後は realpath が実体を指すので、シンボリックリンク経由で外に出ていないかをもう一度確かめる
    // （ask は実行前に承認済みなので、ここでは deny だけを止める）
    const recheck = checkFilePath(abs, 'write', ctx).check;
    if (recheck.decision === 'deny') return { content: `書き込み先の確認に失敗しました: ${recheck.reasons.join(' / ')}`, isError: true };
    const next = input.mode === 'append' && exists ? readFileSync(abs, 'utf8') + input.content : input.content;
    atomicWriteFile(abs, next);
    return { content: `${exists ? (input.mode === 'append' ? '追記しました' : '上書きしました') : '作成しました'}: ${shown(abs, ctx)}（${next.length.toLocaleString('en-US')} 文字）` };
  },
};

export const fileEdit: ToolDef<{ path: string; old: string; new: string; all?: boolean }> = {
  name: 'file_edit',
  description: 'ファイルの一部を置き換える。old はファイル内でちょうど1回だけ現れる文字列にする（all=true なら全部置き換える）。',
  input: Type.Object({ path: PathArg, old: Type.String({ minLength: 1 }), new: Type.String(), all: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  effect: 'write',
  allowedIn: ['chat', 'task'],
  preCheck: (input, ctx) => checkFilePath(input.path, 'write', ctx).check,
  summarize: input => ({ title: `ファイルを編集する: ${input.path}`, body: `- ${input.old.slice(0, 2000)}\n+ ${input.new.slice(0, 2000)}` }),
  async execute(input, ctx) {
    const { abs } = checkFilePath(input.path, 'write', ctx);
    if (!existsSync(abs)) return { content: `ファイルがありません: ${shown(abs, ctx)}`, isError: true };
    const text = readFileSync(abs, 'utf8');
    const count = text.split(input.old).length - 1;
    if (count === 0) return { content: '置き換える文字列が見つかりません。file_read で今の中身を確かめてください', isError: true };
    if (count > 1 && !input.all) return { content: `置き換える文字列が ${count} か所あります。前後を含めて1か所に絞るか、all=true にしてください`, isError: true };
    atomicWriteFile(abs, input.all ? text.split(input.old).join(input.new) : text.replace(input.old, () => input.new));
    return { content: `${count} か所を置き換えました: ${shown(abs, ctx)}` };
  },
};

export const fileList: ToolDef<{ path?: string; depth?: number }> = {
  name: 'file_list',
  description: 'フォルダの中身を一覧する。path を省略すると作業フォルダ。depth で何階層下まで見るか（既定 1、最大 4）。',
  input: Type.Object({ path: Type.Optional(PathArg), depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })) }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task'],
  preCheck: (input, ctx) => checkFilePath(input.path ?? '.', 'read', ctx).check,
  async execute(input, ctx) {
    const { abs } = checkFilePath(input.path ?? '.', 'read', ctx);
    if (!statSync(abs, { throwIfNoEntry: false })?.isDirectory()) return { content: `フォルダがありません: ${shown(abs, ctx)}`, isError: true };
    const lines: string[] = [];
    const walk = (dir: string, depth: number, indent: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
        if (lines.length >= 500) return;
        const full = resolve(dir, entry.name);
        if (placePath(full, ctx.policy).kind === 'deny') continue; // 秘密情報や保護対象は一覧にも出さない
        lines.push(`${indent}${entry.name}${entry.isDirectory() ? '/' : ''}`);
        if (entry.isDirectory() && depth > 1) walk(full, depth - 1, `${indent}  `);
      }
    };
    walk(abs, input.depth ?? 1, '');
    return { content: lines.length ? `${shown(abs, ctx)}/\n${lines.join('\n')}${lines.length >= 500 ? '\n[500 件で打ち切りました]' : ''}` : `${shown(abs, ctx)}/ は空です` };
  },
};
