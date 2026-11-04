import { randomUUID } from 'node:crypto';
import type { RunEvent } from './types.ts';

export interface BusEvent {
  seq: number;
  event: RunEvent;
}

export interface ActiveDraft {
  runId: string;
  conversationId: string;
  modelId: string;
  text: string;
  startedAt: number;
}

const RING_SIZE = 5000;

export class RunBus {
  readonly bootId = randomUUID();
  #seq = 0;
  #ring: BusEvent[] = [];
  #listeners = new Set<(e: BusEvent) => void>();
  #drafts = new Map<string, ActiveDraft>();

  publish(event: RunEvent): void {
    this.#track(event);
    const entry = { seq: ++this.#seq, event };
    this.#ring.push(entry);
    if (this.#ring.length > RING_SIZE) this.#ring.splice(0, this.#ring.length - RING_SIZE);
    for (const listener of [...this.#listeners]) {
      try { listener(entry); } catch { }
    }
  }

  subscribe(listener: (e: BusEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  since(after: number): BusEvent[] | undefined {
    if (after >= this.#seq) return [];
    const first = this.#ring[0];
    if (!first || first.seq > after + 1) return undefined;
    return this.#ring.filter(e => e.seq > after);
  }

  get lastSeq(): number { return this.#seq; }

  drafts(): ActiveDraft[] { return [...this.#drafts.values()]; }

  #track(event: RunEvent): void {
    if (event.type === 'run.start') {
      this.#drafts.set(event.runId, { runId: event.runId, conversationId: event.conversationId, modelId: event.modelId, text: '', startedAt: Date.now() });
    } else if (event.type === 'model.switch') {
      const draft = this.#drafts.get(event.runId);
      if (draft) { draft.modelId = event.to; draft.text = ''; }
    } else if (event.type === 'text.delta') {
      const draft = this.#drafts.get(event.runId);
      if (draft) draft.text += event.text;
    } else if (event.type === 'message.saved' && event.role === 'assistant') {
      // ツールを使う返事は何回かに分かれる。保存した分は履歴に出るので、書きかけは空に戻す
      const draft = this.#drafts.get(event.runId);
      if (draft) draft.text = '';
    } else if (event.type === 'run.end') {
      this.#drafts.delete(event.runId);
    }
  }
}
