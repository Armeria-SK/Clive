import { DEFAULT_LANGUAGE, type HookConfig, type Language } from '../../config/schema.ts';
import { guardText } from '../../shared/messages/guard.ts';
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

export async function runCommandHook(hook: HookConfig, payload: HookPayload, signal: AbortSignal, language: Language = DEFAULT_LANGUAGE): Promise<HookResult> {
  const name = hook.command.join(' ');
  const onError = (reason: string): HookResult => ({ hook: name, decision: hook.onError, reason: guardText(language, 'hook.failed', { name, reason }) });
  const [file, ...args] = hook.command;
  const result = await runProcess(file!, args, {
    cwd: payload.cwd, env: scrubEnv(), timeoutMs: hook.timeoutMs, signal, maxBytes: 64 * 1024, input: JSON.stringify(payload),
  });
  if (result.spawnError) return onError(guardText(language, 'hook.spawn', { detail: result.spawnError }));
  if (result.timedOut) return onError(guardText(language, 'hook.timeout', { ms: hook.timeoutMs }));
  if (result.aborted) return { hook: name, decision: 'deny', reason: guardText(language, 'hook.aborted') };
  if (result.exitCode === 2) return { hook: name, decision: 'deny', reason: result.stderr.trim().slice(0, 500) || guardText(language, 'hook.denied', { name }) };
  if (result.exitCode !== 0) return onError(guardText(language, 'hook.exit_code', { code: result.exitCode ?? '' }));
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
