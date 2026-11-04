import { Type } from '@sinclair/typebox';
import { SkillError, type SkillStore } from '../skills/store.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';

function store(ctx: ToolContext): SkillStore {
  const skills = ctx.services?.skills;
  if (!skills) throw new SkillError('スキルが使えません');
  return skills;
}
const fail = (error: unknown): ToolOutput => ({ content: error instanceof SkillError ? error.message : `失敗しました: ${(error as Error).message}`, isError: true });

export const skillView: ToolDef<{ name: string }> = {
  name: 'skill_view',
  description: 'スキル（手順書）の本文を読む。system の「スキル」の一覧にある作業をするときは、先にこれで手順を確かめる。',
  input: Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'review'],
  async execute(input, ctx) {
    try {
      const s = store(ctx);
      const skill = s.get(input.name);
      if (!skill) {
        const names = s.list().map(k => k.name);
        return { content: `スキル「${input.name}」はありません。${names.length ? `あるもの: ${names.join(', ')}` : 'スキルはまだありません'}`, isError: true };
      }
      // 振り返りで読んだだけでは「使った」に数えない
      if (ctx.kind !== 'review') s.recordUse(skill.name);
      return { content: `# ${skill.name}\n${skill.description}\n\n${skill.body}` };
    } catch (error) { return fail(error); }
  },
};

export const skillDraft: ToolDef<{ name: string; description: string; body: string; reason: string }> = {
  name: 'skill_draft',
  description: [
    '繰り返し使える手順を、スキル（手順書）の下書きとして書く。ユーザーが承認するまで有効にならない。',
    '既にあるスキルを直すときは同じ name で全文を書く（新しく作るより、既存のスキルを直すほうを優先する）。',
    'name は英小文字・数字・ハイフン。description は「いつ使うか」を1文で。body は手順を具体的に。reason はなぜ作る・直すのか。',
  ].join(''),
  input: Type.Object({
    name: Type.String({ minLength: 1, maxLength: 63, pattern: '^[a-z0-9][a-z0-9-]*$' }),
    description: Type.String({ minLength: 1, maxLength: 300 }),
    body: Type.String({ minLength: 1, maxLength: 20_000 }),
    reason: Type.String({ minLength: 1, maxLength: 1000 }),
  }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat', 'task', 'review'],
  async execute(input, ctx) {
    try {
      const s = store(ctx);
      const existing = s.get(input.name);
      const draft = s.draft({ ...input, conversationId: ctx.conversationId, runId: ctx.runId });
      return { content: `スキル「${draft.name}」の${existing ? '修正' : '新規作成'}の下書きを作りました（#${draft.id}）。ユーザーが画面で承認すると有効になります` };
    } catch (error) { return fail(error); }
  },
};
