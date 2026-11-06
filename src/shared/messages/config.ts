import { defineMessages } from './define.ts';

// 設定の形（パターン・長さ・数の範囲・型）に合わないときの、項目ごとの文。正規表現や、形の検査の英語の文はそのまま見せない。
// 設定の保存の 400 と壊れた設定の読み込みが、場所（path）といっしょにコード（config.<キー>）と差し込みの値を返し、画面が画面の言語で書き直す。
// pattern の文は項目ごと（src/config/friendly.ts の PATTERN_MESSAGES）。足した pattern に文が無いと、tests/config-friendly.test.ts が落ちる

const ja = {
  'pattern.provider_id': 'ID は、小文字・数字・_・- で、小文字か数字から始め、40 文字までにしてください',
  'pattern.model_id': 'ID は、小文字・数字・_・.・- で、小文字か数字から始め、64 文字までにしてください',
  'pattern.key_env': 'ここには、キーそのものではなく、環境変数の「名前」を書きます（英大文字で始め、大文字・数字・_ で、64 文字まで）。キーは「API キー」の欄に入れてください',
  'pattern.effort': '考える深さの名前は、英数字・_・.・- で、英数字から始め、32 文字までにしてください',
  'pattern.color': '色は #RRGGBB の形（例: #61B8A5）にしてください',
  'pattern.time': '時刻は HH:MM（24 時間。例: 22:30）の形にするか、空にしてください',
  'pattern.other': '決まった書き方に合っていません',
  'string.required': '入力してください',
  'string.min_length': '{min} 文字以上にしてください',
  'string.max_length': '{max} 文字までにしてください',
  'number.range': '{min} から {max} までの数にしてください',
  'number.min': '{min} 以上の数にしてください',
  'number.max': '{max} 以下の数にしてください',
  'array.min_items': '{min} 個以上にしてください',
  'array.max_items': '{max} 個までにしてください',
  'type.string': '文字で入力してください',
  'type.integer': '整数で入力してください',
  'type.number': '数で入力してください',
  'type.boolean': 'オンかオフ（true か false）にしてください',
  'type.array': '一覧の形にしてください',
  'type.object': 'まとまり（オブジェクト）の形にしてください',
  'type.union': '選べる値のどれかにしてください',
  'type.choice': '次のどれかにしてください: {values}',
  'type.literal': '{value} にしてください',
  'required': 'この項目が必要です',
  'unexpected': 'この名前の項目は、設定にありません',
} as const;

const en: Record<keyof typeof ja, string> = {
  'pattern.provider_id': 'An ID uses lowercase letters, digits, _ and -, starts with a letter or digit, and is up to 40 characters',
  'pattern.model_id': 'An ID uses lowercase letters, digits, _, . and -, starts with a letter or digit, and is up to 64 characters',
  'pattern.key_env': 'Write the NAME of an environment variable here, not the key itself (start with a capital letter; capitals, digits and _ only; up to 64 characters). Enter the key in the "API key" field',
  'pattern.effort': 'A thinking-effort name uses letters, digits, _, . and -, starts with a letter or digit, and is up to 32 characters',
  'pattern.color': 'Use the form #RRGGBB (for example #61B8A5)',
  'pattern.time': 'Use the form HH:MM (24-hour, for example 22:30), or leave it empty',
  'pattern.other': 'This is not in the required form',
  'string.required': 'Enter a value',
  'string.min_length': 'Use at least {min} characters',
  'string.max_length': 'Use up to {max} characters',
  'number.range': 'Use a number from {min} to {max}',
  'number.min': 'Use a number that is {min} or more',
  'number.max': 'Use a number that is {max} or less',
  'array.min_items': 'Add at least {min} items',
  'array.max_items': 'Use up to {max} items',
  'type.string': 'Enter text',
  'type.integer': 'Enter a whole number',
  'type.number': 'Enter a number',
  'type.boolean': 'Use on or off (true or false)',
  'type.array': 'Use a list',
  'type.object': 'Use a group of settings (an object)',
  'type.union': 'Use one of the allowed values',
  'type.choice': 'Use one of these: {values}',
  'type.literal': 'Use {value}',
  'required': 'This item is required',
  'unexpected': 'There is no setting with this name',
};

export const configText = defineMessages('config', ja, en);
export type ConfigMessageKey = keyof typeof ja;
