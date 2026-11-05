import { deepEqual } from './merge.ts';
import type { Config } from './model.ts';
import { foldersFromConfig, wideningChanges, type Widening } from '../skills-meta.ts';

// 設定の保存で、Clive が触れられる範囲・動かせるもの・外から届く範囲が広がる変更を、そのまま並べるための部分。
// フォルダ（触れないパスを外す・フォルダを足す・読み書きにする）は、スキル・ツールの画面と同じ `wideningChanges` をそのまま使う。
// 狭くなる変更や、広がりに関わらない変更は含めない。

export type HookStage = 'preToolUse' | 'postToolUse';
export interface HookSummary { matcher: string; command: string[] }

export type Access =
  | Widening
  | { kind: 'shell-enabled' }
  | { kind: 'shell-allow-added'; command: string }
  | { kind: 'shell-ask-removed'; command: string }
  | { kind: 'shell-deny-removed'; command: string }
  | { kind: 'shell-env-added'; name: string }
  | { kind: 'outside-loosened' }
  | { kind: 'taint-off' }
  | { kind: 'web-fetch-on' }
  | { kind: 'web-search-on' }
  | { kind: 'self-tasks-unapproved' }
  | { kind: 'hook-added'; stage: HookStage; hook: HookSummary }
  | { kind: 'hook-edited'; stage: HookStage; hook: HookSummary }
  | { kind: 'hook-removed'; stage: HookStage; hook: HookSummary }
  | { kind: 'origin-added'; origin: string }
  | { kind: 'login-added'; login: string }
  | { kind: 'logins-cleared' }
  | { kind: 'host-exposed'; host: string };

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []);
const added = (before: readonly string[], after: readonly string[]): string[] => after.filter(x => !before.includes(x));
const removed = (before: readonly string[], after: readonly string[]): string[] => before.filter(x => !after.includes(x));
const obj = (value: unknown): Record<string, any> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : {});
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// フックは id が無いので、同じ中身のものは変わっていないとみなし、残りを前から順に組にして「編集」、余りを「追加」「削除」とする。
// 削除は、使う前（preToolUse = 実行を止められるほう）だけを広がりとして数える。
function hookChanges(before: Config, after: Config, stage: HookStage): Access[] {
  const rawOf = (config: Config) => (Array.isArray(obj(obj(config.tools).hooks)[stage]) ? obj(obj(config.tools).hooks)[stage] as unknown[] : []);
  const oldHooks = [...rawOf(before)];
  const newHooks: unknown[] = [];
  for (const hook of rawOf(after)) {
    const same = oldHooks.findIndex(h => deepEqual(h, hook));
    if (same >= 0) oldHooks.splice(same, 1); else newHooks.push(hook);
  }
  const summary = (hook: unknown): HookSummary => ({ matcher: String(obj(hook).matcher ?? ''), command: strings(obj(hook).command) });
  const out: Access[] = [];
  newHooks.forEach((hook, i) => {
    if (i < oldHooks.length) out.push({ kind: 'hook-edited', stage, hook: summary(hook) });
    else out.push({ kind: 'hook-added', stage, hook: summary(hook) });
  });
  if (stage === 'preToolUse') for (const hook of oldHooks.slice(newHooks.length)) out.push({ kind: 'hook-removed', stage, hook: summary(hook) });
  return out;
}

export function accessWidening(before: Config, after: Config): Access[] {
  const out: Access[] = [...wideningChanges(foldersFromConfig(before), foldersFromConfig(after))];
  const bt = obj(before.tools);
  const at = obj(after.tools);
  const bs = obj(bt.shell);
  const as = obj(at.shell);

  if ((bs.enabled ?? true) === false && (as.enabled ?? true) === true) out.push({ kind: 'shell-enabled' });
  for (const command of added(strings(bs.allow), strings(as.allow))) out.push({ kind: 'shell-allow-added', command });
  for (const command of removed(strings(bs.ask), strings(as.ask))) out.push({ kind: 'shell-ask-removed', command });
  for (const command of removed(strings(bs.deny), strings(as.deny))) out.push({ kind: 'shell-deny-removed', command });
  for (const name of added(strings(bs.envAllow), strings(as.envAllow))) out.push({ kind: 'shell-env-added', name });
  if ((bt.outsideRoots ?? 'ask') === 'deny' && (at.outsideRoots ?? 'ask') === 'ask') out.push({ kind: 'outside-loosened' });
  if ((bt.taintEscalation ?? true) === true && (at.taintEscalation ?? true) === false) out.push({ kind: 'taint-off' });
  if ((obj(bt.web).fetch ?? true) === false && (obj(at.web).fetch ?? true) === true) out.push({ kind: 'web-fetch-on' });
  if ((obj(bt.web).search ?? 'duckduckgo') === 'off' && (obj(at.web).search ?? 'duckduckgo') !== 'off') out.push({ kind: 'web-search-on' });
  if ((obj(before.worker).selfTasksNeedApproval ?? false) === true && (obj(after.worker).selfTasksNeedApproval ?? false) === false) out.push({ kind: 'self-tasks-unapproved' });
  out.push(...hookChanges(before, after, 'preToolUse'), ...hookChanges(before, after, 'postToolUse'));

  const bv = obj(before.server);
  const av = obj(after.server);
  for (const origin of added(strings(bv.origins), strings(av.origins))) out.push({ kind: 'origin-added', origin });
  const beforeLogins = strings(bv.tailscaleLogins);
  const afterLogins = strings(av.tailscaleLogins);
  if (beforeLogins.length > 0 && afterLogins.length === 0) out.push({ kind: 'logins-cleared' });
  else if (beforeLogins.length > 0) for (const login of added(beforeLogins, afterLogins)) out.push({ kind: 'login-added', login }); // 空のときは「同じ tailnet の誰でも」なので、足すと狭くなる
  const host = String(av.host ?? '127.0.0.1');
  if (host !== String(bv.host ?? '127.0.0.1') && !LOOPBACK.has(host)) out.push({ kind: 'host-exposed', host });
  return out;
}

// 同じ確認を、保存し直すときに数え直して見比べるための印。
export const accessKey = (items: readonly Access[]): string => JSON.stringify(items);

