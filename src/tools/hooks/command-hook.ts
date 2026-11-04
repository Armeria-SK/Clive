import type { HookConfig } from '../../config/schema.ts';
import { runProcess, scrubEnv } from '../shell/runner.ts';
import type { Decision } from './shell-guard.ts';

export interface HookPayload {
  hook_event_name: 'PreToolUse' | 'PostToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_output?: string;
  cwd: string;
  run_id: string;
  conversation_id: string;
}

export interface HookResult { hook: string; decision: Decision | undefined; reason: string }

export async function runCommandHook(hook: HookConfig, payload: HookPayload, signal: AbortSignal): Promise<HookResult> {
  const name = hook.command.join(' ');
  const onError = (reason: string): HookResult => ({ hook: name, decision: hook.onError, reason: `フック「${name}」が失敗しました（${reason}）` });
  const [file, ...args] = hook.command;
  const result = await runProcess(file!, args, {
    cwd: payload.cwd, env: scrubEnv(), timeoutMs: hook.timeoutMs, signal, maxBytes: 64 * 1024, input: JSON.stringify(payload),
  });
  if (result.spawnError) return onError(`起動できません: ${result.spawnError}`);
  if (result.timedOut) return onError(`${hook.timeoutMs}ms でタイムアウト`);
  if (result.aborted) return { hook: name, decision: 'deny', reason: '中止しました' };
  if (result.exitCode === 2) return { hook: name, decision: 'deny', reason: result.stderr.trim().slice(0, 500) || `フック「${name}」が拒否しました` };
  if (result.exitCode !== 0) return onError(`終了コード ${result.exitCode}`);
  const out = result.stdout.trim();
  if (!out) return { hook: name, decision: undefined, reason: '' };
  try {
    const json = JSON.parse(out) as Record<string, any>;
    const specific = json.hookSpecificOutput;
    const decision = (specific?.permissionDecision ?? json.decision) as unknown;
    const reason = String(specific?.permissionDecisionReason ?? json.reason ?? '');
    if (decision === 'allow' || decision === 'deny' || decision === 'ask') return { hook: name, decision, reason };
    if (decision === 'block') return { hook: name, decision: 'deny', reason };
    return { hook: name, decision: undefined, reason };
  } catch {
    return { hook: name, decision: undefined, reason: '' };
  }
}
