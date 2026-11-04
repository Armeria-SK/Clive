import type { ProbeResult } from './types.ts';

export interface ContextFacts {
  modelId: string;
  server: string;
  required: number;
  declared?: number | undefined;
  measured?: number | undefined;
  modelMax?: number | undefined;
  hint?: string | undefined;
  unmeasuredNote?: string | undefined;
  capabilities?: string[] | undefined;
  now?: number;
}

const fmt = (n: number) => n.toLocaleString('en-US');

export function evaluateContext(f: ContextFacts): ProbeResult {
  const base = {
    modelId: f.modelId, server: f.server, required: f.required, checkedAt: f.now ?? Date.now(),
    ...(f.declared === undefined ? {} : { declared: f.declared }),
    ...(f.measured === undefined ? {} : { measured: f.measured }),
    ...(f.modelMax === undefined ? {} : { modelMax: f.modelMax }),
    ...(f.capabilities === undefined ? {} : { capabilities: f.capabilities }),
  };
  if (f.declared !== undefined && f.modelMax !== undefined && f.declared > f.modelMax) {
    return {
      ...base, status: 'exceeds_model', effective: f.modelMax,
      message: `設定の contextLength（${fmt(f.declared)}）がモデルの上限（${fmt(f.modelMax)}）を超えています`,
      hint: `contextLength を ${fmt(f.modelMax)} 以下にしてください`,
    };
  }
  const candidates = [f.declared, f.measured, f.modelMax].filter((n): n is number => typeof n === 'number' && n > 0);
  if (!candidates.length) {
    return {
      ...base, status: 'unknown',
      message: 'コンテキスト長が分かりません（サーバーから取得できず、設定にもありません）',
      hint: 'config の models[].contextLength に、サーバー側で設定した長さを書いてください',
    };
  }
  const effective = Math.min(...candidates);
  if (effective < f.required) {
    const measuredPart = f.measured !== undefined ? `実測 ${fmt(f.measured)}` : f.declared !== undefined ? `設定 ${fmt(f.declared)}` : `上限 ${fmt(effective)}`;
    return {
      ...base, status: 'too_small', effective,
      message: `コンテキスト長が足りません: measured ${fmt(effective)} < required ${fmt(f.required)}（${measuredPart}）`,
      ...(f.hint === undefined ? {} : { hint: f.hint }),
    };
  }
  const note = f.measured === undefined && f.unmeasuredNote ? `（${f.unmeasuredNote}）` : '';
  return { ...base, status: 'ok', effective, message: `使用できます: ${fmt(effective)} トークン${note}` };
}

export const CONTEXT_HINTS = {
  ollama: (required: number) => `config の contextLength を ${fmt(required)} 以上にしてください（Clive は毎回 num_ctx として送ります）。VRAM が足りないと遅くなるか読み込みに失敗します`,
  lmstudio: (required: number) => `LM Studio でモデルを読み込むときの Context Length を ${fmt(required)} 以上にして読み込み直し、contextLength も合わせてください`,
  llamacpp: (required: number) => `llama-server を -c で起動し、スロットあたり ${fmt(required)} 以上にしてください（-np でスロットを増やすと -c が分割されます）`,
  vllm: (required: number) => `vLLM を --max-model-len ${fmt(required)} 以上で起動してください`,
  tabbyapi: (required: number) => `TabbyAPI の config.yml（model の max_seq_len）を ${fmt(required)} 以上にしてモデルを読み込み直し、contextLength も合わせてください（cache_size も同じ以上に）`,
  generic: (required: number) => `サーバー側のコンテキスト長を ${fmt(required)} 以上にして、config の contextLength も合わせてください`,
  hosted: (required: number) => `コンテキスト長が ${fmt(required)} 以上のモデルを選んでください`,
} as const;
