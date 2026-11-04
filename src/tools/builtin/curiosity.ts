import { Type } from '@sinclair/typebox';
import { CuriosityError, type CuriosityItem, type CuriosityStore } from '../../curiosity/store.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';

function store(ctx: ToolContext): CuriosityStore {
  const curiosity = ctx.services?.curiosity;
  if (!curiosity) throw new CuriosityError('好奇心リストが使えません');
  return curiosity;
}
const fail = (error: unknown): ToolOutput => ({ content: error instanceof CuriosityError ? error.message : `失敗しました: ${(error as Error).message}`, isError: true });
const STATUS: Record<CuriosityItem['status'], string> = { open: '気になる', researching: '調べている', done: '調べた', dropped: 'やめた' };
const line = (i: CuriosityItem) => `- #${i.id} ${STATUS[i.status]}「${i.topic}」${i.why ? `（${i.why}）` : ''}${i.result ? ` → ${i.result.slice(0, 200)}` : ''}`;

export const curiosityAdd: ToolDef<{ topic: string; why?: string }> = {
  name: 'curiosity_add',
  description: '気になったが今は調べないことを、好奇心リストに書く（自発行動がオンなら、あとで自分で調べる）。topic は短く具体的に、why はなぜ気になったか。',
  input: Type.Object({
    topic: Type.String({ minLength: 1, maxLength: 200 }),
    why: Type.Optional(Type.String({ maxLength: 500 })),
  }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat', 'task', 'review'],
  async execute(input, ctx) {
    try {
      const item = store(ctx).add({ topic: input.topic, why: input.why, source: 'clive' });
      return { content: `好奇心リストに足しました ${line(item)}` };
    } catch (error) { return fail(error); }
  },
};

export const curiosityList: ToolDef<{ include_closed?: boolean }> = {
  name: 'curiosity_list',
  description: '好奇心リストを見る（気になる・調べている）。include_closed=true で調べ終えたもの・やめたものも。',
  input: Type.Object({ include_closed: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'review'],
  async execute(input, ctx) {
    try {
      const items = store(ctx).list({ includeClosed: Boolean(input.include_closed), limit: 50 });
      return { content: items.length ? items.map(line).join('\n') : '好奇心リストは空です' };
    } catch (error) { return fail(error); }
  },
};

export const curiosityUpdate: ToolDef<{ id: number; status?: 'open' | 'done' | 'dropped'; result?: string }> = {
  name: 'curiosity_update',
  description: '好奇心リストの項目を更新する。調べて分かったことは result に書いて status=done、興味が無くなったら status=dropped。',
  input: Type.Object({
    id: Type.Integer({ minimum: 1 }),
    status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('done'), Type.Literal('dropped')])),
    result: Type.Optional(Type.String({ maxLength: 4000 })),
  }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat', 'task'],
  async execute(input, ctx) {
    try {
      const item = store(ctx).update(input.id, { ...(input.status ? { status: input.status } : {}), ...(input.result !== undefined ? { result: input.result } : {}) });
      return { content: `更新しました ${line(item)}` };
    } catch (error) { return fail(error); }
  },
};
