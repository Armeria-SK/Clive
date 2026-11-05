import type { ja } from './ja.ts';

export type Dict = {
  [K in keyof typeof ja]: (typeof ja)[K] extends (...args: infer A) => string ? (...args: A) => string : string;
};
export type DictKey = keyof Dict;
// 引数の要らない（文字列の）項目のキー。画面の名前の表など、キーを変数で持つところはこちらを使う。
export type PlainKey = { [K in DictKey]: Dict[K] extends string ? K : never }[DictKey];

type EntryArgs<K extends DictKey> = Dict[K] extends (...args: infer A) => string ? A : [];
type Intersect<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;

// キーが和集合のときは、全部のキーの引数を同時に満たすものだけを受ける。
// 引数が違うキー（文字列の項目と関数の項目など）の和集合は never になり、呼べなくなる。
export type ArgsOf<K extends DictKey> = Extract<Intersect<K extends DictKey ? EntryArgs<K> : never>, unknown[]>;
