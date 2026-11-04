# Clive

いつも動いている、あなた専用の AI エージェントです。ブラウザから話しかけて使います。
会話の中で覚えたことを次の会話で活かし、頼まれたことや自分で気になったことを、裏で少しずつ進めます。
Windows と Linux で動き、クラウドの API（Anthropic など）とローカル LLM のどちらでも使えます。

## できること

### 会話

- 返事はストリーミングで表示され、途中で止めたり、失敗したら送り直したりできる
- 使うモデルを複数並べておくと、つながらないときに次のモデルへ自動で切り替える
- 長くなった会話は、古い部分を要約に置き換えて続ける（元の発言は残る）
- テキスト・PDF・画像（画像を読めるモデルのとき）を添付できる

### 記憶

- Clive は会話の中で大事なことをその場で覚え、次の会話から使う。覚えたことは画面の「記憶」で見て、直して、消して、取り消せる
- 記憶は「ユーザーについて」と「Clive のメモと教訓」の 2 冊に分かれ、それぞれ量に上限がある。いっぱいになりそうなときは、似た記憶をまとめさせる
- 「前に話したあれ」は、過去の会話から探して答える（日本語の 1〜2 文字でも探せる）
- タスクが終わったときや会話が途切れたときに、Clive が記憶を振り返って整える（拾い漏れを足し、重なりをまとめる）。振り返りでは、シェルやファイル、Web は使えない。変えた記憶は画面の「レビュー」で見られる
- Clive の人格（SOUL.md）とユーザーのプロフィール（USER.md）は手で書ける。Clive が書き換えるときは承認が要る

### タスクと自分で動くこと

- やること（タスク）を、Clive が会話の中で書き留めたり、画面から頼んだりできる。毎日・平日・毎週・毎時・N 分ごとの繰り返しも書ける
- 裏で動く「ワーカー」が、タスクを 1 件ずつ進める。終わったら報告し、分からないことがあれば質問して返事を待つ。途中までなら経過を残して、時間をおいて続きをする
- 話しかけると、進めていたタスクを中断して会話を優先し、あとで続きから再開する
- やることが無いときは、モデルを呼ばずに休む。失敗は間をおいて試し直し、続けば知らせる
- 自発行動（Clive が自分で決めたタスクや、気になったことを調べること）は、オン／オフ・静かにする時間帯・1 時間あたりの上限で抑えられる。既定はオフ
- 繰り返し使える手順は「スキル」（手順書）として残せる。Clive が書いたスキルは、画面の「レビュー」で承認するまで使われない

### 道具と安全

- ファイルの読み書きとシェルの実行ができる。触れてよいフォルダを決めておき、その外や危ない操作（消す・秘密を読む・外へ送るなど）は、実行の前に止めるか、画面で承認を求める
- 承認は「今回だけ許可／この会話では許可／拒否」から選ぶ
- シェルの判定はコマンドの文字列を見て止める仕組みで、完全な閉じ込めではない（許可したフォルダにスクリプトを書いてから実行する、などで回り道できる）。守りたいものがある環境では、OS の側でも閉じ込める（Linux は下の systemd の設定、Windows は権限の低い別のユーザーで動かす）
- 実行の前に、自分で用意したコマンドで判定を足せる（下の「[実行前のフック](#実行前のフック)」）
- Web の検索（DuckDuckGo か自分で立てた SearXNG。API キーは要らない）と、公開されているページの読み取りができる。ローカルや LAN の宛先は読まない。Web や添付の内容を読んだ後は、シェルと書き込みが承認制になる
- API キーは設定ファイルにも画面にも出さない

### 見た目と通知

- Clive の名前・形（20 種類）・色・動きを選べる。「自動」にすると、返事を考えている・承認や返事を待っている・お休み中・タスクを終えた、といった様子に合わせて動く
- 「きょう」の画面で、今の様子と、進行中のタスク・返事待ち・承認待ち・今日終わったこと・次の予定をまとめて見られる
- タスクの完了・返事待ち・失敗・承認が必要・モデルの不調を、画面の通知で知らせる。承認が必要なときと返事待ちのときは、ブラウザの通知も出す

### ローカル LLM を使うとき

- 起動時と設定を変えたときに、サーバーから実際のコンテキスト長を確かめ、足りなければ送らずに、数値と直し方を表示する（黙って切り捨てない）
- 実行中も、収まらなければ止め、サーバー側での切り捨ての疑いを見つけたら知らせる
- ツール呼び出しが苦手なモデルのために、本文に書かれたツール呼び出しも拾う

## 必要なもの

- Node.js 24.16 以上（`.ts` をビルドせずにそのまま実行します）
- 使うモデルのどれか
  - Anthropic の API キー
  - ローカル LLM（Ollama・LM Studio・llama.cpp・vLLM など）
  - OpenRouter・OpenAI などの OpenAI 互換 API

## はじめかた

```bash
npm install
npm run build:web           # 画面をビルド（web/dist）
cp .env.example .env        # API キーを書く（Windows は copy）
npm start                   # http://127.0.0.1:4777/ を開く
```

初回の起動で `data/config.json` が作られます。画面の「設定」で、モデルのコンテキスト長の確認結果と直し方が見られます。
ローカル LLM を使うときは、先に下の「[ローカル LLM のコンテキスト長](#ローカル-llm-のコンテキスト長)」を読んでください。

| コマンド | 内容 |
|---|---|
| `npm start` | 起動（`-- --data-dir <dir>` でデータの置き場所を変えられる） |
| `npm run dev` | ファイルを変えると再起動する |
| `npm run dev:web` | 画面だけを開発する（Vite。API は `npm start` のサーバーへ転送） |
| `npm run doctor` | 設定と各モデルの接続を確かめる（問題がなければ終了コード 0） |
| `npm test` | テスト（`node:test`） |
| `npm run typecheck` | 型チェック（サーバーと画面） |
| `npm run check` | 型チェック＋テスト＋画面のビルド |

### ほかの端末から使う

Clive は 127.0.0.1 でだけ待ち受けます。スマートフォンなどから使うときは Tailscale Serve を通します。

```bash
tailscale serve --bg 4777
```

表示された `https://<machine>.<tailnet>.ts.net` を `config.json` の `server.origins` に足し、再起動してください。使える人を絞るときは、その人の Tailscale のログイン名を `server.tailscaleLogins` に足します（空なら、同じ tailnet の人なら誰でも使えます）。

### Linux で常駐させる

[deploy/clive.service](deploy/clive.service) が systemd の設定です（先頭に手順があります）。Clive が書き込める場所をデータのフォルダだけに絞ってあるので、シェルの道具に対する OS 側の閉じ込めにもなります。

## ローカル LLM のコンテキスト長

Clive は毎回、system（ルール・人格・記憶の枠・道具の説明）と会話をまとめて送ります。モデルのコンテキスト長が足りないと、送らずにエラーにします。
必要な長さは、画面の「設定」の「必要」の列に出ます（`minContext`（既定 65,536）と、system＋道具の説明＋会話の最低量 8,192＋出力の上限、の大きいほう）。目安は最低 32k、道具や記憶を使うなら 64k 以上です。

| サーバー | `providers[].server` | 長さの直し方 | Clive が確かめる場所 |
|---|---|---|---|
| Ollama | （`kind: "ollama"`） | `models[].contextLength` を必要量以上にする（毎回 `num_ctx` として送る） | `/api/show` |
| LM Studio | `lmstudio` | モデルを読み込むときの Context Length を必要量以上にして読み込み直す | `/api/v0/models` |
| llama.cpp | `llamacpp` | `llama-server -c <長さ>`（`-np` でスロットを増やすと、`-c` が分割される） | `/props` |
| vLLM | `vllm` | `--max-model-len <長さ>` で起動する | `/v1/models` |
| TabbyAPI | `tabbyapi` | `config.yml` の `max_seq_len`（と `cache_size`）を必要量以上にして読み込み直す | `/v1/model` |
| そのほか | `generic` | サーバー側で長さを設定する | `/v1/models` に長さが載っていれば使う |

どのサーバーでも、`models[].contextLength` はサーバー側の長さに合わせて書いてください。実際に使うのは「設定値」と「サーバーが報告した長さ」の小さいほうです。

```json
"providers": [
  { "id": "local", "kind": "openai_compatible", "server": "generic", "baseUrl": "http://127.0.0.1:8080/v1", "apiKeyEnv": "LOCAL_LLM_API_KEY", "maxParallel": 1, "timeoutMs": 600000 }
],
"models": [
  { "id": "local-model", "provider": "local", "model": "<サーバーでのモデル名>", "contextLength": 65536, "minContext": 32768, "maxOutputTokens": 8192, "toolMode": "native", "vision": false }
],
"routing": { "chat": ["local-model"], "background": ["local-model"], "retriesPerModel": 2 }
```

- キーが要らないサーバーなら `apiKeyEnv` は書かない。要るなら `.env` に `LOCAL_LLM_API_KEY=...` のように書く
- ツール呼び出しが苦手なモデルは、`toolMode` を `json_fallback` にするか、`maxTools` で渡す道具の数を絞る

## 実行前のフック

道具を実行する前に、自分で用意したコマンドに判定させられます（Claude Code の PreToolUse フックと同じ約束なので、Claude Code 用のフックもそのまま使えます）。`config.json` に書きます。

```json
"tools": {
  "hooks": {
    "preToolUse": [
      { "matcher": "shell_run|file_.*", "command": ["node", "/path/to/my-hook.js"], "timeoutMs": 30000, "onError": "deny" }
    ]
  }
}
```

- `matcher` は道具の名前の正規表現。`command` はシェルを通さずに起動する
- 標準入力に `{ "hook_event_name": "PreToolUse", "tool_name", "tool_input", "cwd", "run_id", "conversation_id" }` の JSON が渡る
- 終了コード 2 で拒否（標準エラーの文が理由になる）。0 で終わり、標準出力に `{ "decision": "allow" | "ask" | "deny" | "block", "reason": "..." }`（または Claude Code の `hookSpecificOutput.permissionDecision`）を返すと、その判定になる
- 時間切れ・起動の失敗・ほかの終了コードは `onError`（既定は拒否）。いちばん厳しい判定が使われるので、フックで組み込みの判定（拒否・承認）を緩めることはできない

## 仕組み

| 項目 | 使っているもの |
|---|---|
| 実行環境 | Node 24（ESM）＋ TypeScript。型除去でビルドなしに実行し、`tsc --noEmit` は型チェックだけに使う |
| HTTP とライブ配信 | `node:http` と SSE |
| DB | `node:sqlite`（ネイティブ依存なし。FTS5 trigram で日本語を検索） |
| 入力検証 | TypeBox |
| 画面 | React 19 ＋ Vite |
| テスト | `node:test` |
| 依存 | `@anthropic-ai/sdk`、TypeBox、`croner`（タイムゾーン対応の cron）、`parse5`（HTML の解析）、React 一式、`react-markdown` |

```
src/
  main.ts          起動（環境変数 → 設定 → DB → コンテキストの確認 → Web）と doctor
  app.ts           部品の組み立て（起動とテストで共通）
  config/          設定のスキーマと読み書き（検証・.bak・壊れたときは直前の正しい設定で動く）
  db/              node:sqlite、マイグレーション、会話・実行記録・KV
  providers/       anthropic / openai-compatible / ollama、コンテキストの確認、エラーの分類
  engine/          会話の実行（再試行・予備のモデル・コンテキストへの収め方）、見積もり、イベント、不調の見張り
  memory/          記憶（ブック・上限・変更履歴）、過去の会話の検索、振り返り
  curiosity/       好奇心リスト
  tasks/           タスクの保存、繰り返しの予定、ワーカー
  notify/          通知
  uploads/         添付ファイル
  tools/           道具の登録と実行の流れ、承認、組み込みの道具
    web/           公開ページの取得・本文の取り出し・検索
    hooks/         実行前の判定（コマンドの分解・フォルダの範囲・シェル・外部コマンド）
    shell/         子プロセスの実行（環境変数を絞る・プロセスツリーごと止める）
    skills/        スキル（SKILL.md の読み書き・下書きと承認）
  web/             API、SSE、認証、静的配信
web/src/           画面
templates/         ルール（rules.ja.md）と SOUL / USER / CURIOSITY の初期値
deploy/            systemd の設定
tests/
data/              実行時データ（.gitignore 対象）
```

### 大事にしていること

- **エラー文を返事として残さない**: 返事を作れなかったときは、本文を空のまま失敗として扱い、エラー文が記憶や会話に紛れ込まないようにする
- **黙って切り捨てない**: コンテキストが足りなければ送らずに止め、理由と直し方を出す
- **会話中は system を変えない**: 会話の始めにルール・SOUL・USER・記憶を固定し（プロンプトキャッシュが効き続ける）、書き換えは次の会話から反映する
- **API キーは設定ファイルにも画面にも出さない**: 設定には環境変数の名前だけを書く
- **127.0.0.1 でだけ待ち受ける**: Host・Origin・`Sec-Fetch-Site` を確かめて、ほかのサイトからの操作を断る。この PC の外からは Tailscale Serve のヘッダを求める
- **やることが無ければモデルを呼ばない**: 裏で動く判断はコードで行い、費用がかからないようにする
