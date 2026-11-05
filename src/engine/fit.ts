import { engineText } from '../shared/messages/engine.ts';
import type { ChatMessage, ToolSpec } from './types.ts';
import { estimateRequest, type Estimate } from './tokens.ts';

export class ContextOverflow extends Error {
  readonly required: number;
  readonly available: number;
  constructor(required: number, available: number) {
    super(engineText('ja', 'fit.overflow', { required: required.toLocaleString('en-US'), available: available.toLocaleString('en-US') }));
    this.required = required;
    this.available = available;
  }
}

export function groupExchanges(messages: readonly ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user' && current.length) { groups.push(current); current = []; }
    current.push(m);
  }
  if (current.length) groups.push(current);
  return groups;
}

export interface Fitted {
  messages: ChatMessage[];
  removed: number;
  estimate: Estimate;
}

export function fitMessages(input: {
  system: string; messages: readonly ChatMessage[]; tools: readonly ToolSpec[]; available: number; factor?: number;
}): Fitted {
  const factor = input.factor ?? 1;
  let groups = groupExchanges(input.messages);
  const total = input.messages.length;
  for (;;) {
    const messages = groups.flat();
    const estimate = estimateRequest(input.system, messages, input.tools, factor);
    if (estimate.tokens <= input.available) return { messages, removed: total - messages.length, estimate };
    if (groups.length <= 1) throw new ContextOverflow(estimate.tokens, input.available);
    groups = groups.slice(1);
  }
}
