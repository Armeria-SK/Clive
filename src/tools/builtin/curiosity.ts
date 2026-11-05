import { Type } from '@sinclair/typebox';
import { CuriosityError, type CuriosityItem, type CuriosityStore } from '../../curiosity/store.ts';
import type { Language } from '../../config/schema.ts';
import { languageOf } from '../../shared/language.ts';
import { toolText } from '../../shared/messages/tools.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';

function store(ctx: ToolContext): CuriosityStore {
  const curiosity = ctx.services?.curiosity;
  if (!curiosity) throw new CuriosityError('curiosity.unavailable');
  return curiosity;
}
const fail = (error: unknown, ctx: ToolContext): ToolOutput => {
  const language = languageOf(ctx.config);
  return { content: error instanceof CuriosityError ? error.text(language) : toolText(language, 'failed', { detail: (error as Error).message }), isError: true };
};
const line = (i: CuriosityItem, language: Language) => toolText(language, 'curiosity.line', {
  id: i.id, status: toolText(language, `curiosity.status.${i.status}`), topic: i.topic,
  why: i.why ? toolText(language, 'curiosity.why', { why: i.why }) : '', result: i.result ? toolText(language, 'curiosity.result', { result: i.result.slice(0, 200) }) : '',
});

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
      return { content: toolText(languageOf(ctx.config), 'curiosity.added', { line: line(item, languageOf(ctx.config)) }) };
    } catch (error) { return fail(error, ctx); }
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
      const language = languageOf(ctx.config);
      return { content: items.length ? items.map(i => line(i, language)).join('\n') : toolText(language, 'curiosity.empty') };
    } catch (error) { return fail(error, ctx); }
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
      return { content: toolText(languageOf(ctx.config), 'curiosity.updated', { line: line(item, languageOf(ctx.config)) }) };
    } catch (error) { return fail(error, ctx); }
  },
};
