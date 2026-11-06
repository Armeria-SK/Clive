// API キーを画面から入れる（段 9f）ための、画面とサーバーが同じに使う決まり。node の部品は使わない

export const MAX_KEY_CHARS = 2048;

export type KeyProblem = 'empty' | 'chars' | 'padded' | 'too_long';

// 鍵に使える文字は、半角の印字できる文字（U+0020〜U+007E）だけ。改行・制御文字・全角の文字などを含むもの、前後に空白があるもの、空、長すぎるものは受けない（途中の空白と = は鍵の一部として許す）。
// 半角以外を断るのは、鍵はそのまま HTTP の見出しの値になり、使えない文字を含むと通信の部品の失敗の文に鍵の文字が入りうるため
export function keyProblem(key: string): KeyProblem | undefined {
  if (key.trim() === '') return 'empty';
  if (/[^\x20-\x7e]/u.test(key)) return 'chars';
  if (key !== key.trim()) return 'padded';
  if (key.length > MAX_KEY_CHARS) return 'too_long';
  return undefined;
}

// 鍵を入れる環境変数の名前。プロバイダに書かれていればその名前、Anthropic は ANTHROPIC_API_KEY（書いていなくても使う名前）、
// ほかは ID から CLIVE_<ID の大文字>_API_KEY を作る。taken（ほかのプロバイダがすでに使っている名前）と重なるときは _2 _3 … を足す
export function keyEnvName(provider: { id: string; kind: string; apiKeyEnv?: string | undefined }, taken: ReadonlySet<string> = new Set()): string {
  if (provider.apiKeyEnv) return provider.apiKeyEnv;
  if (provider.kind === 'anthropic') return 'ANTHROPIC_API_KEY';
  const base = `CLIVE_${provider.id.toUpperCase().replaceAll('-', '_')}_API_KEY`;
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}_${n}`;
  return name;
}

// 鍵を持つ名前（KEY・TOKEN・SECRET・PASSWORD・CREDENTIAL を含む）だけ、鍵の API が書く。PATH や NODE_OPTIONS のような、動き方を変える環境変数に、鍵として書き込めないようにする
// （シェルの子プロセスへ環境を渡すときに伏せる名前と同じ決まり。src/tools/shell/runner.ts の scrubEnv）
export function isSecretEnvName(name: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/u.test(name);
}
