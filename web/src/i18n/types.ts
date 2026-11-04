import type { ja } from './ja.ts';

export type Dict = {
  [K in keyof typeof ja]: (typeof ja)[K] extends (...args: infer A) => string ? (...args: A) => string : string;
};
export type DictKey = keyof Dict;
export type ArgsOf<K extends DictKey> = Dict[K] extends (...args: infer A) => string ? A : [];
