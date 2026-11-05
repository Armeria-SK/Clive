import { Type } from '@sinclair/typebox';
import { readHistory, searchHistory } from '../../memory/history.ts';
import { BOOK_LABELS, MemoryError, prefix, type Book } from '../../memory/store.ts';
import { errorText } from '../../shared/messages/define.ts';
import { languageOf } from '../../shared/language.ts';
import { toolText } from '../../shared/messages/tools.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';

const BookArg = Type.Union([Type.Literal('user'), Type.Literal('notes')], { description: 'user: ユーザーについての事実・好み／notes: Clive 自身のメモと教訓' });
const IdArg = Type.Union([Type.Integer({ minimum: 1 }), Type.String({ pattern: '^[unUN]?[0-9]+$' })], { description: '記憶の ID（[u7] なら "u7" か 7）' });

function services(ctx: ToolContext) {
  if (!ctx.services) throw new MemoryError('memory.unavailable');
  return ctx.services;
}
const parseId = (id: number | string) => (typeof id === 'number' ? id : Number(String(id).replace(/^[unUN]/u, '')));
const fail = (error: unknown, ctx: ToolContext): ToolOutput => {
  const language = languageOf(ctx.config);
  return { content: error instanceof MemoryError ? error.text(language) : toolText(language, 'failed', { detail: (error as Error).message }), isError: true };
};

function latestUserMessage(ctx: ToolContext): number | undefined {
  const row = services(ctx).db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(ctx.conversationId) as { id: number } | undefined;
  return row?.id;
}

export const memorySave: ToolDef<{ book: Book; content: string }> = {
  name: 'memory_save',
  description: [
    '次の会話でも覚えておくべきことを、その場で記憶する（ChatGPT のメモリのように）。',
    'user: ユーザーの名前・好み・状況・決めたこと。notes: 自分の教訓・やり方のコツ。',
    '1件は短く1つの事実にする。その場限りの経緯や、もう分かっていることは書かない。',
  ].join(''),
  input: Type.Object({ book: BookArg, content: Type.String({ minLength: 1, maxLength: 600 }) }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat', 'task', 'review'],
  escalateOnTaint: true,
  summarize: (input, language) => ({ title: toolText(language, 'summary.memory_save', { label: BOOK_LABELS[language][input.book] }), body: input.content }),
  async execute(input, ctx) {
    try {
      const s = services(ctx);
      const messageId = latestUserMessage(ctx);
      const { memory, eventId } = s.memory.save({ book: input.book, content: input.content, actor: ctx.kind === 'review' ? 'review' : 'clive', conversationId: ctx.conversationId, ...(messageId === undefined ? {} : { messageId }), runId: ctx.runId });
      s.emit({ type: 'memory.changed', runId: ctx.runId, conversationId: ctx.conversationId, memoryId: memory.id, book: memory.book, action: 'create', content: memory.content, eventId });
      const language = languageOf(ctx.config);
      return { content: toolText(language, 'memory.saved', { id: `${prefix(memory.book)}${memory.id}`, label: BOOK_LABELS[language][memory.book], used: s.memory.used(memory.book) }) };
    } catch (error) { return fail(error, ctx); }
  },
};

export const memoryUpdate: ToolDef<{ id: number | string; content: string }> = {
  name: 'memory_update',
  description: '記憶を書き直す（古くなった・間違っていた・似た記憶をまとめるとき）。',
  input: Type.Object({ id: IdArg, content: Type.String({ minLength: 1, maxLength: 600 }) }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat', 'task', 'review'],
  async execute(input, ctx) {
    try {
      const s = services(ctx);
      const { memory, eventId } = s.memory.update(parseId(input.id), input.content, ctx.kind === 'review' ? 'review' : 'clive', ctx.runId);
      s.emit({ type: 'memory.changed', runId: ctx.runId, conversationId: ctx.conversationId, memoryId: memory.id, book: memory.book, action: 'update', content: memory.content, eventId });
      return { content: toolText(languageOf(ctx.config), 'memory.updated', { id: `${prefix(memory.book)}${memory.id}` }) };
    } catch (error) { return fail(error, ctx); }
  },
};

export const memoryForget: ToolDef<{ id: number | string; reason: string }> = {
  name: 'memory_forget',
  description: 'もう要らない・間違っていた記憶を消す。ユーザーに「忘れて」と言われたときも使う。',
  input: Type.Object({ id: IdArg, reason: Type.String({ minLength: 1, maxLength: 300 }) }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat', 'task', 'review'],
  async execute(input, ctx) {
    try {
      const s = services(ctx);
      const { memory, eventId } = s.memory.forget(parseId(input.id), ctx.kind === 'review' ? 'review' : 'clive', input.reason, ctx.runId);
      s.emit({ type: 'memory.changed', runId: ctx.runId, conversationId: ctx.conversationId, memoryId: memory.id, book: memory.book, action: 'forget', content: memory.content, eventId });
      return { content: toolText(languageOf(ctx.config), 'memory.forgotten', { id: `${prefix(memory.book)}${memory.id}` }) };
    } catch (error) { return fail(error, ctx); }
  },
};

export const memorySearch: ToolDef<{ query: string; limit?: number }> = {
  name: 'memory_search',
  description: '記憶を検索する（会話の最初に渡した記憶に無いときや、ID を確かめたいとき）。',
  input: Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'review'],
  async execute(input, ctx) {
    try {
      const hits = services(ctx).memory.search(input.query, input.limit ?? 20);
      if (!hits.length) return { content: toolText(languageOf(ctx.config), 'memory.no_hit', { query: input.query }) };
      return { content: hits.map(m => `- [${prefix(m.book)}${m.id}] ${m.content}`).join('\n') };
    } catch (error) { return fail(error, ctx); }
  },
};

const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

export const historySearch: ToolDef<{ query: string; days?: number; limit?: number }> = {
  name: 'history_search',
  description: '過去の会話を検索する。「前に話したあれ」「いつだっけ」と聞かれたら、推測で答えずにまず検索する。days で直近 N 日に絞れる。',
  input: Type.Object({
    query: Type.String({ minLength: 1, maxLength: 200 }),
    days: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'review'],
  async execute(input, ctx) {
    try {
      const hits = searchHistory(services(ctx).db, input.query, { days: input.days, limit: input.limit ?? 12, excludeConversationId: ctx.conversationId });
      const language = languageOf(ctx.config);
      if (!hits.length) return { content: toolText(language, 'history.no_hit', { query: input.query, days: input.days ? toolText(language, 'history.days', { days: input.days }) : '' }) };
      return { content: hits.map(h => toolText(language, 'history.line', { date: fmtDate(h.createdAt), title: h.title ?? toolText(language, 'history.untitled'), cid: h.conversationId, mid: h.messageId, role: h.role, snippet: h.snippet })).join('\n') };
    } catch (error) { return fail(error, ctx); }
  },
};

export const historyRead: ToolDef<{ conversation_id: string; around_message_id?: number; limit?: number }> = {
  name: 'history_read',
  description: '過去の会話の一部を読む。history_search で見つけた message_id の前後を読むときに使う。',
  input: Type.Object({
    conversation_id: Type.String({ minLength: 1, maxLength: 100 }),
    around_message_id: Type.Optional(Type.Integer({ minimum: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
  }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'review'],
  async execute(input, ctx) {
    try {
      const rows = readHistory(services(ctx).db, input.conversation_id, { aroundMessageId: input.around_message_id, limit: input.limit ?? 20 });
      if (!rows.length) return { content: toolText(languageOf(ctx.config), 'history.not_found'), isError: true };
      return { content: rows.map(r => `[${r.id}] ${fmtDate(r.createdAt)} ${r.role}: ${r.text.slice(0, 1500)}`).join('\n\n') };
    } catch (error) { return fail(error, ctx); }
  },
};
