import { ValueErrorType, type ValueError } from '@sinclair/typebox/errors';
import type { MessageParams } from '../shared/messages/define.ts';
import type { ConfigMessageKey } from '../shared/messages/config.ts';
import { AppConfig, ModelConfig, ProviderConfig } from './schema.ts';

// 設定の形の検査（TypeBox）の誤りを、項目ごとの文のコード（src/shared/messages/config.ts）と差し込みの値に直す。
// 正規表現や「Expected string to match …」はそのまま見せない。ここに無い種類の誤りは undefined（呼ぶ側は検査の文のまま出す）

// pattern ごとの文。pattern はスキーマから取るので、スキーマの正規表現を直しても、この表と食い違わない。
// スキーマに pattern を足したのにここへ足し忘れると、tests/config-friendly.test.ts が落ちる（pattern を持つ項目すべてに文があることを確かめる）
const PATTERN_ENTRIES: ReadonlyArray<readonly [string | undefined, ConfigMessageKey]> = [
  [ProviderConfig.properties.id.pattern, 'pattern.provider_id'],
  [ProviderConfig.properties.apiKeyEnv.pattern, 'pattern.key_env'],
  [ModelConfig.properties.id.pattern, 'pattern.model_id'],
  [ModelConfig.properties.efforts.items.pattern, 'pattern.effort'],
  [AppConfig.properties.profile.properties.color.pattern, 'pattern.color'],
  [AppConfig.properties.worker.properties.quietStart.pattern, 'pattern.time'],
  [AppConfig.properties.worker.properties.quietEnd.pattern, 'pattern.time'],
];
export const PATTERN_MESSAGES: ReadonlyMap<string, ConfigMessageKey> = new Map(PATTERN_ENTRIES.flatMap(([pattern, key]) => (pattern === undefined ? [] : [[pattern, key] as const])));

// 選べる値の一覧に出す数（スキーマの選択肢が多いとき、文が長くなりすぎないように）
const MAX_CHOICES = 10;

export interface FriendlyIssue { code: ConfigMessageKey; params: MessageParams }

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function friendlyIssue(error: ValueError): FriendlyIssue | undefined {
  const schema = error.schema as Record<string, unknown>;
  switch (error.type) {
    case ValueErrorType.StringPattern: return { code: PATTERN_MESSAGES.get(String(schema.pattern)) ?? 'pattern.other', params: {} };
    case ValueErrorType.StringMinLength: return finite(schema.minLength) && schema.minLength > 1 ? { code: 'string.min_length', params: { min: schema.minLength } } : { code: 'string.required', params: {} };
    case ValueErrorType.StringMaxLength: return finite(schema.maxLength) ? { code: 'string.max_length', params: { max: schema.maxLength } } : undefined;
    case ValueErrorType.IntegerMinimum: case ValueErrorType.IntegerMaximum: case ValueErrorType.NumberMinimum: case ValueErrorType.NumberMaximum: {
      const { minimum: min, maximum: max } = schema;
      if (finite(min) && finite(max)) return { code: 'number.range', params: { min, max } };
      if (finite(min)) return { code: 'number.min', params: { min } };
      return finite(max) ? { code: 'number.max', params: { max } } : undefined;
    }
    case ValueErrorType.ArrayMinItems: return finite(schema.minItems) ? { code: 'array.min_items', params: { min: schema.minItems } } : undefined;
    case ValueErrorType.ArrayMaxItems: return finite(schema.maxItems) ? { code: 'array.max_items', params: { max: schema.maxItems } } : undefined;
    case ValueErrorType.String: return { code: 'type.string', params: {} };
    case ValueErrorType.Integer: return { code: 'type.integer', params: {} };
    case ValueErrorType.Number: return { code: 'type.number', params: {} };
    case ValueErrorType.Boolean: return { code: 'type.boolean', params: {} };
    case ValueErrorType.Array: return { code: 'type.array', params: {} };
    case ValueErrorType.Object: return { code: 'type.object', params: {} };
    case ValueErrorType.Literal: return schema.const === undefined ? undefined : { code: 'type.literal', params: { value: String(schema.const) } };
    case ValueErrorType.Union: {
      const choices = Array.isArray(schema.anyOf) ? (schema.anyOf as Array<Record<string, unknown>>).map(c => c.const) : [];
      if (!choices.length || choices.some(c => c === undefined)) return { code: 'type.union', params: {} };
      const shown = choices.slice(0, MAX_CHOICES).map(String).join(' / ');
      return { code: 'type.choice', params: { values: choices.length > MAX_CHOICES ? `${shown} …` : shown } };
    }
    case ValueErrorType.ObjectRequiredProperty: return { code: 'required', params: {} };
    case ValueErrorType.ObjectAdditionalProperties: return { code: 'unexpected', params: {} };
    default: return undefined;
  }
}
