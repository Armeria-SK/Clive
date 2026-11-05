import { format } from '../../src/shared/messages/define.ts';
import { engineText } from '../../src/shared/messages/engine.ts';
import { httpText } from '../../src/shared/messages/http.ts';
import { providerText } from '../../src/shared/messages/providers.ts';
import { storeText } from '../../src/shared/messages/stores.ts';
import { taskText } from '../../src/shared/messages/tasks.ts';
import type { Lang } from './i18n/state.ts';

// サーバーが画面に出す文のうち、変わらないコード（code）と差し込みの値（params）を添えているもの（API のエラー・返事の失敗・警告・
// モデルの確認）を、画面の言語で書き直す。文の表はサーバーが作る側（src/shared/messages）と同じものを使うので、コードの意味と
// 画面の訳が食い違わない。コードが表に無い・差し込みの値が足りないときは null を返し、呼ぶ側はサーバーが書いた文（message）を出す。

type Catalog = { readonly tables: Record<Lang, Record<string, string>> };
const DOMAINS: Record<string, Catalog> = { http: httpText, task: taskText, store: storeText, provider: providerText, engine: engineText };

export type Params = Record<string, unknown> | undefined | null;

// 文字列と数だけを差し込みに使う（入れ子の値は、呼ぶ側で取り出してから渡す）。
function simple(params: Params): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (params && typeof params === 'object') for (const [key, value] of Object.entries(params)) if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  return out;
}

const UNFILLED = /\{\w+\}/u;

function template(code: string | undefined | null, language: Lang): string | null {
  if (!code) return null;
  const dot = code.indexOf('.');
  if (dot <= 0) return null;
  return DOMAINS[code.slice(0, dot)]?.tables[language]?.[code.slice(dot + 1)] ?? null;
}

// `<領域>.<キー>` のコードを、画面の言語の文にする。表に無い・値が足りない（{名前} が残る）ときは null。
export function serverText(code: string | undefined | null, params: Params, language: Lang): string | null {
  const found = template(code, language);
  if (found === null) return null;
  const text = format(found, simple(params));
  return UNFILLED.test(text) ? null : text;
}

// API のエラー（{ code?, params? }）と、返事の失敗の 409（{ errorCode?, errorParams? }）の本文から、画面の言語の文を作る。
export function errorBodyText(body: unknown, language: Lang): string | null {
  if (body === null || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : typeof record.errorCode === 'string' ? record.errorCode : null;
  const params = (record.code !== undefined ? record.params : record.errorParams) as Params;
  return serverText(code, params, language);
}

const WARNING_KEY: Record<string, string> = {
  max_iterations: 'warn.max_iterations', context_trimmed: 'warn.context_trimmed', partial_discarded: 'warn.partial_discarded', retrying: 'warn.retrying',
  compacted: 'warn.compacted', compaction_failed: 'warn.compaction_failed', server_truncation_suspected: 'warn.server_truncation',
};

// 返事の途中の警告（SSE の warning）。再試行の理由は、理由のコードがあれば画面の言語に、無ければサーバーの詳しい文のまま。
export function warningText(warning: { code: string; message: string; params?: Params }, language: Lang): string {
  const key = WARNING_KEY[warning.code];
  if (!key) return warning.message;
  const params = warning.params && typeof warning.params === 'object' ? warning.params as Record<string, unknown> : {};
  if (warning.code === 'retrying') {
    const reason = serverText(typeof params.errorCode === 'string' ? params.errorCode : null, params.errorParams as Params, language) ?? (typeof params.detail === 'string' ? params.detail : null);
    return reason === null ? warning.message : serverText(`engine.${key}`, { ...simple(params), message: reason }, language) ?? warning.message;
  }
  return serverText(`engine.${key}`, params, language) ?? warning.message;
}

export interface ProbeLike { message: string; messageCode?: string | undefined; messageParams?: Params }

// モデルの確認の説明（probe.message）。too_small の出どころと、ok の注記は、コードから画面の言語で組み立てる。
// 直し方（hint）はサーバーの種類ごとの手順なので、ここでは扱わない（そのまま出す）。
export function probeMessage(probe: ProbeLike, language: Lang): string {
  const code = probe.messageCode;
  const params = probe.messageParams && typeof probe.messageParams === 'object' ? probe.messageParams as Record<string, unknown> : {};
  if (code === 'provider.probe.too_small') {
    const source = typeof params.sourceKind === 'string' ? serverText(`provider.probe.source.${params.sourceKind}`, { n: params.n as string | number }, language) : null;
    return (source !== null ? serverText(code, { ...simple(params), source }, language) : null) ?? probe.message;
  }
  if (code === 'provider.probe.ok') {
    const noteText = typeof params.noteCode === 'string' ? serverText(params.noteCode, {}, language) : null;
    const note = noteText === null ? '' : serverText('provider.probe.note', { note: noteText }, language) ?? '';
    return serverText(code, { ...simple(params), note }, language) ?? probe.message;
  }
  return serverText(code, probe.messageParams, language) ?? probe.message;
}
