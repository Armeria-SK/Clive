// 道具ごとの方針（設定の tools.policies）。画面（web/src）からも読むので、Node の部品は使わない。
//
// 決まり（いちばん大事な点）: 方針は、今の判定に「厳しさを足す」ことしかできない。
//   allow（既定。書かないときもこれ）: 何も足さない。事前の判定・外から読んだ内容のあとの確かめ・実行前フック・振り返りでの禁止は、どれも外れない
//   ask: 毎回、承認を求める（拒否はそのまま拒否。「この会話では許可」では済まない）
//   block: 使わせない（モデルに渡す一覧から外し、パイプラインでも拒否する）
// 段 8b の会話ごとのモード（計画など）は、道具の一覧とパイプラインの二重の拒否を、ここと同じ形（chat.ts の #toolsFor と pipeline.ts の runToolCall）で足す。

export type ToolPolicy = 'allow' | 'ask' | 'block';

export const TOOL_POLICIES: readonly ToolPolicy[] = ['allow', 'ask', 'block'];

// 設定の鍵として書ける道具の名前の形（組み込みの道具はすべてこの形）
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

// 方針を持てない道具: タスクの進め方の道具。止めるとワーカーが終われなくなる。設定に書かれていても無視する
export const POLICYLESS_TOOLS: ReadonlySet<string> = new Set(['task_complete', 'task_checkpoint', 'ask_user']);

export const isPolicyable = (name: string): boolean => !POLICYLESS_TOOLS.has(name);

const STRICTNESS: Record<ToolPolicy, number> = { allow: 0, ask: 1, block: 2 };

export const isToolPolicy = (value: unknown): value is ToolPolicy => typeof value === 'string' && Object.hasOwn(STRICTNESS, value);

// どちらか厳しい方
export const stricterPolicy = (a: ToolPolicy, b: ToolPolicy): ToolPolicy => (STRICTNESS[b] > STRICTNESS[a] ? b : a);

// a より b のほうが緩い（広がる）か
export const isLooser = (from: ToolPolicy, to: ToolPolicy): boolean => STRICTNESS[to] < STRICTNESS[from];

interface HasPolicies { tools: { policies?: Record<string, string> | undefined } }

// 設定に書かれた、その道具の方針。書いていない・読めない値・方針を持てない道具は allow
export function toolPolicy(config: HasPolicies, name: string): ToolPolicy {
  const policies = config.tools.policies;
  if (!policies || !isPolicyable(name) || !Object.hasOwn(policies, name)) return 'allow';
  const value = policies[name];
  return isToolPolicy(value) ? value : 'allow';
}

// 設定に block・ask と書かれているのに、方針を持てない道具のため無視する名前（ログに出す）
export function ignoredPolicyNames(config: HasPolicies): string[] {
  const policies = config.tools.policies ?? {};
  return Object.keys(policies).filter(name => !isPolicyable(name) && policies[name] !== 'allow');
}
