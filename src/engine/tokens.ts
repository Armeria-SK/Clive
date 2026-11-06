import type { ChatMessage, ToolSpec } from './types.ts';

export const SAFETY_MARGIN = 1.15;
export const IMAGE_TOKENS = 1600;

const CJK = /[　-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯]/u;

export function estimateTextTokens(text: string): number {
  let cjk = 0; let other = 0;
  for (const ch of text) { if (CJK.test(ch)) cjk++; else other++; }
  return Math.ceil(cjk + other / 3.5);
}

// text の先頭から、estimateTextTokens が maxTokens 以下で、かつ maxChars 以下になる長さ（UTF-16 の単位。文字の途中では切らない）。
// 日本語は 1 文字 1 トークン、それ以外は 3.5 文字 1 トークンと見積もるので、同じ文字数でも日本語の方がずっと早く尽きる
export function prefixLength(text: string, maxChars: number, maxTokens: number): number {
  let cjk = 0; let other = 0; let length = 0;
  for (const ch of text) {
    if (length + ch.length > maxChars) break;
    if (CJK.test(ch)) cjk++; else other++;
    if (cjk + other / 3.5 > maxTokens) break;
    length += ch.length;
  }
  return length;
}

export function estimateMessageTokens(message: ChatMessage): number {
  let tokens = 4;
  if (message.role === 'user') {
    tokens += estimateTextTokens(message.content) + (message.images?.length ?? 0) * IMAGE_TOKENS;
  } else if (message.role === 'assistant') {
    tokens += estimateTextTokens(message.content);
    for (const call of message.toolCalls ?? []) tokens += 8 + estimateTextTokens(call.name) + estimateTextTokens(call.raw ?? JSON.stringify(call.arguments ?? {}));
  } else {
    tokens += 8 + estimateTextTokens(message.content);
  }
  return tokens;
}

export function estimateToolTokens(tools: readonly ToolSpec[]): number {
  return tools.reduce((sum, t) => sum + 12 + Math.ceil(JSON.stringify(t).length / 3.5), 0);
}

export interface Estimate {
  raw: number;
  tokens: number;
}

export function estimateRequest(system: string, messages: readonly ChatMessage[], tools: readonly ToolSpec[], factor = 1): Estimate {
  const raw = 16 + estimateTextTokens(system) + messages.reduce((s, m) => s + estimateMessageTokens(m), 0) + estimateToolTokens(tools);
  return { raw, tokens: Math.ceil(raw * factor * SAFETY_MARGIN) };
}
