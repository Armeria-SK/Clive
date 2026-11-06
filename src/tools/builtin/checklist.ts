import { Type } from '@sinclair/typebox';
import { KV } from '../../db/kv.ts';
import { languageOf } from '../../shared/language.ts';
import { toolText } from '../../shared/messages/tools.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';
import { writeChecklist } from './checklist-core.ts';

const fail = (error: unknown, ctx: ToolContext): ToolOutput => {
  const language = languageOf(ctx.config);
  return { content: error instanceof Error ? toolText(language, 'failed', { detail: error.message }) : toolText(language, 'failed', { detail: String(error) }), isError: true };
};

export const checklistWrite: ToolDef<{ items: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' }> }> = {
  name: 'checklist_write',
  description: '作業の手順の一覧を書く（前の一覧を丸ごと置き換える）。3 手順以上の作業の始めに書き、1 つ進むたびに status を直して書き直す。status: pending（まだ）/ in_progress（いま）/ done（済み）。items を空にすると消える。一覧は持ち主の画面に出る。',
  input: Type.Object({
    items: Type.Array(
      Type.Object({
        text: Type.String({ minLength: 1, maxLength: 200 }),
        status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('done')]),
      }, { additionalProperties: false }),
      { maxItems: 30 },
    ),
  }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat', 'task'],
  async execute(input, ctx) {
    try {
      const s = ctx.services;
      if (!s) {
        const language = languageOf(ctx.config);
        return { content: toolText(language, 'checklist.no_store'), isError: true };
      }
      const saved = writeChecklist(new KV(s.db), ctx.conversationId, input.items, ctx.taint.tainted, Date.now());
      const items = saved?.items ?? [];
      s.emit({ type: 'checklist.updated', runId: ctx.runId, conversationId: ctx.conversationId, items, tainted: ctx.taint.tainted });
      const language = languageOf(ctx.config);
      if (saved === undefined) return { content: toolText(language, 'checklist.cleared') };
      const done = items.filter(i => i.status === 'done').length;
      const active = items.filter(i => i.status === 'in_progress').length;
      return { content: toolText(language, 'checklist.saved', { total: items.length, done, active }) };
    } catch (error) { return fail(error, ctx); }
  },
};
