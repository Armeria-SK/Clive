import { randomUUID } from 'node:crypto';
import { DEFAULT_LANGUAGE, type Language } from '../config/schema.ts';
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

interface FallbackText {
  heading: string;
  how: string;
  format: string;
  result: string;
  arguments: string;
  toolResult: (name: string, isError: boolean) => string;
}

const FALLBACK_TEXT: Record<Language, FallbackText> = {
  ja: {
    heading: '# 使える道具',
    how: '道具を使うときは、返事の中に次の形式で書いてください（1回の返事で1つまで）。',
    format: '<tool_call>{"name": "道具の名前", "arguments": { ... }}</tool_call>',
    result: '道具の結果は次のメッセージで渡します。道具を使わないときは、普通に返事を書いてください。',
    arguments: '引数（JSON Schema）',
    toolResult: (name, isError) => `[道具「${name}」の結果${isError ? '（エラー）' : ''}]`,
  },
  en: {
    heading: '# Available tools',
    how: 'When you use a tool, write it in your reply in the following format (at most one per reply).',
    format: '<tool_call>{"name": "tool name", "arguments": { ... }}</tool_call>',
    result: 'The result of the tool will be given in the next message. When you do not use a tool, just write a normal reply.',
    arguments: 'Arguments (JSON Schema)',
    toolResult: (name, isError) => `[Result of tool "${name}"${isError ? ' (error)' : ''}]`,
  },
};

export function jsonFallbackInstructions(tools: readonly ToolSpec[], language: Language = DEFAULT_LANGUAGE): string {
  if (!tools.length) return '';
  const text = FALLBACK_TEXT[language];
  const lines = tools.map(t => `- ${t.name}: ${t.description}\n  ${text.arguments}: ${JSON.stringify(t.inputSchema)}`);
  return [text.heading, text.how, text.format, text.result, ...lines].join('\n');
}

export function toJsonFallbackHistory(messages: readonly ChatMessage[], language: Language = DEFAULT_LANGUAGE): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const calls = m.toolCalls.map(c => `<tool_call>${JSON.stringify({ name: c.name, arguments: c.arguments ?? {} })}</tool_call>`).join('\n');
      out.push({ role: 'assistant', content: [m.content, calls].filter(Boolean).join('\n') });
    } else if (m.role === 'tool') {
      const content = `${FALLBACK_TEXT[language].toolResult(m.name, Boolean(m.isError))}\n${m.content}`;
      const images = m.images ?? [];
      const last = out.at(-1);
      if (last?.role === 'user') out[out.length - 1] = { ...last, content: `${last.content}\n\n${content}`, ...(images.length ? { images: [...(last.images ?? []), ...images] } : {}) };
      else out.push({ role: 'user', content, ...(images.length ? { images: [...images] } : {}) });
    } else out.push(m);
  }
  return out;
}
