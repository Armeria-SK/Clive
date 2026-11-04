import { randomUUID } from 'node:crypto';
import type { ChatMessage, ToolCall, ToolSpec } from './types.ts';

export function extractToolCalls(text: string, toolNames: ReadonlySet<string>): { calls: ToolCall[]; text: string } {
  const calls: ToolCall[] = [];
  let rest = text;

  const take = (raw: string): boolean => {
    let value: unknown;
    try { value = JSON.parse(raw.trim()); } catch { return false; }
    const items = Array.isArray(value) ? value : [value];
    let found = false;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const fn = (obj.function && typeof obj.function === 'object' ? obj.function : obj) as Record<string, unknown>;
      const name = fn.name;
      if (typeof name !== 'string' || !toolNames.has(name)) continue;
      let args: unknown = fn.arguments ?? fn.parameters ?? fn.args ?? {};
      let rawArgs: string | undefined;
      if (typeof args === 'string') { rawArgs = args; try { args = JSON.parse(args); } catch { args = undefined; } }
      calls.push({ id: `call_${randomUUID()}`, name, arguments: args, raw: rawArgs ?? JSON.stringify(args) });
      found = true;
    }
    return found;
  };

  rest = rest.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gu, (whole, body: string) => (take(body) ? '' : whole));
  rest = rest.replace(/\[TOOL_CALLS\]\s*(\[[\s\S]*\])/u, (whole, body: string) => (take(body) ? '' : whole));
  if (!calls.length) {
    rest = rest.replace(/```(?:json|tool_call)?\s*\n([\s\S]*?)\n```/gu, (whole, body: string) => (/"name"\s*:/u.test(body) && take(body) ? '' : whole));
  }
  if (!calls.length) {
    const trimmed = rest.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}') && take(trimmed)) rest = '';
  }
  return { calls, text: rest.replace(/\n{3,}/gu, '\n\n').trim() };
}

export function looksLikeTextToolCall(text: string): boolean {
  return /<tool_call>|\[TOOL_CALLS\]|"name"\s*:\s*"[a-z_]+"\s*,\s*"(?:arguments|parameters)"/u.test(text);
}

export function jsonFallbackInstructions(tools: readonly ToolSpec[]): string {
  if (!tools.length) return '';
  const lines = tools.map(t => `- ${t.name}: ${t.description}\n  引数（JSON Schema）: ${JSON.stringify(t.inputSchema)}`);
  return [
    '# 使える道具',
    '道具を使うときは、返事の中に次の形式で書いてください（1回の返事で1つまで）。',
    '<tool_call>{"name": "道具の名前", "arguments": { ... }}</tool_call>',
    '道具の結果は次のメッセージで渡します。道具を使わないときは、普通に返事を書いてください。',
    ...lines,
  ].join('\n');
}

export function toJsonFallbackHistory(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const calls = m.toolCalls.map(c => `<tool_call>${JSON.stringify({ name: c.name, arguments: c.arguments ?? {} })}</tool_call>`).join('\n');
      out.push({ role: 'assistant', content: [m.content, calls].filter(Boolean).join('\n') });
    } else if (m.role === 'tool') {
      const content = `[道具「${m.name}」の結果${m.isError ? '（エラー）' : ''}]\n${m.content}`;
      const last = out.at(-1);
      if (last?.role === 'user') last.content += `\n\n${content}`;
      else out.push({ role: 'user', content });
    } else out.push(m);
  }
  return out;
}
