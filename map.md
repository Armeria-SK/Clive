# Clive の地図

製品の部品を一覧で見るための地図。関数ごとの中身はコードを読む。部品を足す・消す・名前を変える、役割や使うものが変わったときは、同じ変更の中でここも直す。使い方は [README.md](README.md)。

## 全体像

ブラウザから使う個人用の AI エージェント。1 つの Node プロセス（Node 24。`.ts` をビルドせずそのまま実行）の中に、次の 3 つが同居している。

- **Web サーバー**（`src/web`）: API、画面へ出来事を流し続ける SSE、ビルド済みの画面（`web/dist`）の配信。
- **会話のエンジン**（`src/engine`）: モデルを呼び、道具を使わせ、返事を保存する。
- **ワーカー**（`src/tasks/worker.ts`）: 画面を見ていなくても、タスクと記憶の振り返りを 1 件ずつ進める。

起動の流れ: `src/main.ts` が `.env` を読む → `src/app.ts` の `App` が全部品を組み立てる → モデルのコンテキスト長を確かめる → Web サーバーとワーカーを始める。部品どうしは `App` が組み立てて渡す形で、`db` `shared` `curiosity` `notify` は他の部品の実行コードを使わない土台。

画面（`web/src`）は別のビルドで、サーバーとは `/api/*` と `/api/events`（SSE）だけで話す。

実行時のデータは `data/`（git 対象外。`CLIVE_DATA_DIR` か `--data-dir` で変える）に置く。

- `config.json`: 設定
- `clive.db`: SQLite
- `backups/`: DB の更新前の控え
- `uploads/`: 添付ファイル
- `workspace/`: `SOUL.md` `USER.md` `CURIOSITY.md` と `skills/<名前>/SKILL.md`
- `tool_outputs/`: 長いシェル出力の全文

ルート直下: `package.json`（`npm run check` は型チェック + テスト + 画面のビルド）、`tsconfig.json`（`src` と `tests`）、`tsconfig.web.json`（`web/src`）、`.env.example`（`.env` の雛形）。開発の資料は `docs/`（git 対象外）。

## 部品

### 起動と組み立て — `src/main.ts` `src/app.ts` `src/paths.ts`
- `main.ts`: 引数（`doctor`、`--data-dir`）を読み、`App` を作り、Web サーバーとワーカーを始めて、終了の信号で後片付けする。`doctor` は設定と各モデルの接続を確かめて終了コードを返す。
- `app.ts`: `App` が DB・各ストア・エンジン・ワーカー・通知・不調の見張りを作ってつなぐ。設定ファイルの変更を拾って再読み込みする（`config()`）。組み込みの道具 24 個の一覧（`builtinTools()`）もここ。テストもこのクラスで組み立てる。
- `paths.ts`: `data/` の中や `templates/`・`web/dist` の場所（`resolvePaths`）と `.env` の読み込み。
- 入口: `src/main.ts`
- 使うもの: `config` `db` `engine` `providers` `memory` `tasks` `tools` `curiosity` `notify` `uploads` `web`

### 設定 — `src/config`
- 設定ファイルの形（`schema.ts`、TypeBox）と、読み書き（`store.ts`）。検証、書く前の `.bak`、壊れたときは直前の正しい設定で動き続ける仕組みを持つ。`server` の変更だけは再起動が要る（`RESTART_KEYS`）。`language`（`ja` | `en`）は書かなくてもよい項目で、書かないときの Clive は日本語（`DEFAULT_LANGUAGE`）。「選んでいない」と「ja を選んだ」を区別できるよう、既定値は設定ファイルに書き足さない。再起動は要らない。
- 入口: `src/config/store.ts`（`ConfigStore`）
- 使うもの: `src/shared`（`url.ts`）、`@sinclair/typebox`

### データベース — `src/db`
- `node:sqlite` を開き（`database.ts`）、テーブルの定義と更新手順を持つ（`migrations.ts`）。更新の前に `VACUUM INTO` で控えを取る。会話とメッセージ（`conversations.ts`）、実行の記録（`runs.ts`）、小さな key-value（`kv.ts`）はここ。記憶・タスク・通知などのテーブルを読み書きするコードは、それぞれの部品の `store.ts` などにある。
- 入口: `src/db/database.ts`（`openDatabase`）
- 使うもの: `node:sqlite` だけ（型として `engine/types.ts` を参照）

### 会話のエンジン — `src/engine`
- `chat.ts`: `ChatEngine`。送信・やり直し・タスクの実行・振り返りの実行を受け持つ。モデルの並びを順に試し、再試行、予備のモデルへの切り替え、コンテキストへの収め方（`fit.ts`）、古い発言の要約、サーバー側の切り捨ての疑いの検知、道具呼び出しの繰り返しをここで行う。
- 会話の system の文（ルール・SOUL・USER・記憶・スキル一覧）は、会話ごとに最初の 1 回で固定する。毎回変わる文（現在時刻・要約）は別に組み立てる（`workspace.ts` の `buildSnapshot` / `buildDynamic`）。`workspace.ts` は `SOUL.md` などの初期ファイルを置く役目も持つ。返事の言語の指示は、固定される system ではなく毎回組み立てる動的な部分（`buildDynamic`）に入れるので、すでにある会話にも言語を変えた次のリクエストから付く。それだけでは日本語で続く会話が英語に切り替わらなかったため、会話の始めに固定したときの言語（kv の `snapshot-language:<会話ID>`。記録が無い前からある会話は ja）と今の `language` が違う会話にだけ、送る写しの最後のユーザーの発言へ 1 行の注意を足す（`prompts.ts` の `withReplyReminder`。保存も表示もしない）。ルールと見出しは `language` に合う版で組み立てるが、固定されるのは新しい会話からだけ。
- `prompts.ts`: 会話の要約の指示と、要約の見出しの言語別の文、言語を変えた会話の最後の発言に足す 1 行の注意。ルールと人格の初期値の読み方（日本語は `templates/` の直下、英語は `templates/en/`、無ければ日本語に戻る）と、起動のときの「無いファイルにだけ写す」も `workspace.ts` にある。
- ほか: `bus.ts`（出来事の履歴と作成中の下書き。SSE が読む）、`status.ts`（モデルごとのコンテキスト長の確認結果と休ませる状態）、`health.ts`（失敗が続いたら通知して、しばらく予備のモデルを先に使わせる）、`tokens.ts`（量の見積もり）、`toolcall-parse.ts`（本文に書かれた道具呼び出しを拾う。`json_fallback` の道具の説明の文は言語別）、`types.ts`（メッセージ・出来事・結果の型）。
- 入口: `src/engine/chat.ts`
- 使うもの: `providers`（モデルの呼び出し）、`tools`（`pipeline` `registry` `policy`）、`memory`（`renderBooks`）、`uploads`（`stripAttachments`）、`db` `config` `tasks`（渡される）、`templates/`（`workspace.ts` 経由）、`src/shared`（`language.ts`）

### モデルの提供元 — `src/providers`
- Anthropic・OpenAI 互換・Ollama の 3 つが、共通の窓口（`ProviderAdapter`、`types.ts`）を実装する（`anthropic.ts` `openai-compatible.ts` `ollama.ts`）。返事をストリーミングで受け取ることと、`probe`（サーバーから実際のコンテキスト長を確かめる）を受け持つ。
- ほか: `context.ts`（長さの判定と直し方の文）、`http.ts`（URL・API キー・エラーの分類）、`limiter.ts`（提供元ごとの同時実行の上限）、`registry.ts`（設定から窓口を作る）。
- 入口: `src/providers/registry.ts`（`ProviderRegistry`）
- 使うもの: `config`（型と `OLLAMA_DEFAULT_URL`）、`src/shared`（`url` `redaction`）、`@anthropic-ai/sdk`、`fetch`

### 記憶 — `src/memory`
- 記憶 2 冊（`user` と `notes`）の保存・文字数の上限・変更履歴と取り消し（`store.ts`）、過去の会話の検索（`history.ts`、FTS5 trigram）、振り返りの待ち行列とモデルへの指示文（`review.ts`。指示文は言語別）。
- 入口: `src/memory/store.ts`（`MemoryStore`）
- 使うもの: `db`（`transaction`）、`src/shared`（`redaction`）

### タスクとワーカー — `src/tasks`
- `store.ts`: タスクと経過の保存、状態の移り変わり、繰り返しの予定から実行用のタスクを作る。`schedule.ts`: 毎日・平日・毎週・毎時・N 分ごとの繰り返しを cron にして読み書きする（曜日の値は 月〜日）。
- `worker.ts`: `Worker`。タスクを 1 件ずつ選んで `engine` で実行し、なければ振り返り、次に好奇心を見る。失敗の再試行、1 時間あたりの上限、静かな時間帯、一時停止、会話を優先した中断、画面から「止めた」タスクを 20 秒ほどで実行待ちに戻すことを受け持つ。タスクの実行の指示（`taskPrompt`）は `language` に合わせて書く。
- 入口: `src/tasks/worker.ts`
- 使うもの: `memory`（振り返りの指示文）、`db`、`croner`。`engine`（`ChatEngine`）・`notify`・`curiosity`・`config` は `App` から渡される

### 道具 — `src/tools`
- `types.ts`（道具の型。効果は `read` `write` `exec` `network` `meta`、使える場面は `chat` `task` `review`）、`registry.ts`（登録）、`policy.ts`（触れてよいフォルダと禁止パス）、`approvals.ts`（承認待ちの管理）。
- `pipeline.ts`: 道具 1 回の流れ。引数の検査 → 事前の判定 → 外から読んだ内容のあとは確認を求める → 実行前フック → 承認 → 実行 → 実行後フック → `tool_calls` に記録。振り返りでは書き込み・実行・通信の道具を使わせない。
- 中の部品:
  - `builtin/`: 組み込みの道具 24 個（`files` `shell` `web` `memory` `tasks` `curiosity` `skills`）。
  - `hooks/`: 実行前の判定（`parse-cmd.ts` コマンドの分解、`scope.ts` フォルダの範囲、`shell-guard.ts` シェルの判定、`command-hook.ts` 自分で用意した外部コマンド）。
  - `shell/`: 子プロセスの実行（環境変数を絞る、プロセスツリーごと止める）。
  - `skills/`: スキル（`SKILL.md`）の読み書きと、下書き・承認。
  - `web/`: 公開ページの取得（`public-page.ts`、LAN の宛先は拒否）、本文の取り出し（`html-text.ts`）、検索（`search.ts`、DuckDuckGo か SearXNG）。
- 入口: `src/tools/pipeline.ts`（`runToolCall`）。道具の一覧は `src/app.ts` の `builtinTools()`。
- 使うもの: `config`、`memory`、`tasks`（`schedule`）、`curiosity`、`paths`、`src/shared`（`redaction` `url`）、`@sinclair/typebox`、`parse5`

### 好奇心 — `src/curiosity`
- 好奇心リストの保存と状態（`open` `researching` `done` `dropped`）、タスクにする、終わったタスクの結果を受け取る、`CURIOSITY.md` の一度だけの取り込み。
- `text.ts`: 好奇心から作るタスクの題・本文・完了の条件の言語別の文。
- 入口: `src/curiosity/store.ts`（`CuriosityStore`）
- 使うもの: `node:sqlite` だけ

### 通知 — `src/notify`
- 通知の保存・既読・未読数。同じ `dedupKey` は 24 時間重ねない。作られた通知は `onNotify` から SSE へ流れる。
- 入口: `src/notify/notifications.ts`（`Notifications`）
- 使うもの: `node:sqlite` だけ

### 添付ファイル — `src/uploads`
- テキスト・PDF・画像の保存（1 件 10MB まで、1 通に 5 件まで）と、本文に埋め込む添付ブロックの生成・取り除き。
- 入口: `src/uploads/store.ts`（`Uploads`）
- 使うもの: `src/shared`（`pdf-text`）、`node:fs`

### 共通の小道具 — `src/shared`
- `url.ts`（ループバックの判定、`baseUrl` の検査）、`redaction.ts`（秘密の伏せ字）、`pdf-text.ts`（PDF から本文を取り出す）、`http-json.ts`（JSON を取る小さな関数。今はどこからも使われていない）、`language.ts`（設定から Clive の言語を決める `languageOf`）。
- `messages/`: サーバーが作る文の、日本語と英語の対応表。`define.ts`（表の作り方と、コードと差し込みの値を持つ `LocalizedError`）、領域ごとの表（`tasks.ts`：タスクの経過・理由・通知・繰り返しの説明、`providers.ts`：モデルの確認の文・直し方・プロバイダのエラー、`engine.ts`：返事の失敗・警告・添付の目印、`guard.ts`：道具の実行前の判定の理由（フォルダの範囲・シェルのコマンド・フック）、`tools.ts`：道具の結果・承認の題・Web の取得と検索の失敗、`stores.ts`：記憶・スキル・好奇心・添付ファイルのエラーと添付の目印、`http.ts`：API のエラーの文）、`index.ts`（全部の表）。文は `{名前}` で値を差し込み、キーは画面が訳すときのコードにもなる。日本語の文を変えると `tests/fixtures/messages-ja.json` との照合が落ちる。画面が使うコードの一覧は、下の「サーバーが作る文の言語と、画面が使うコード」。
- 入口: 部品ごとに別（まとまった入口はない）
- 使うもの: Node の標準だけ

### Web サーバー — `src/web`
- `createWebServer(app)` が `node:http` のサーバーを作る。認証（`auth.ts`、Host・Origin・`Sec-Fetch-Site`・Tailscale のログイン名）、経路の表（`http.ts`）、SSE（`sse.ts`）、静的配信と CSP（`static.ts`。外部のスクリプトと外部のフォントは許さない）。
- API の置き場所:
  - `server.ts`: 会話・メッセージ・添付・実行の記録・承認・道具の記録・記憶・履歴・設定・モデルの確認・言語ごとの初期値（`GET /api/templates/:language`。ルールと SOUL / USER / CURIOSITY を返すだけで、作業フォルダには写さない）。
  - `routes-tasks.ts`: タスク・ワーカー・通知・プロフィール（名前・形・色・動き）。
  - `routes-review.ts`: スキルとその下書き・好奇心・振り返りの記録。
- 入口: `src/web/server.ts`
- 使うもの: `App`、`config`、`memory`、`tasks`、`tools`（承認・スキル）、`curiosity`、`uploads`、`engine`（`bus`）、`src/shared`

### 初期ファイルとルール — `templates/`
- `rules.ja.md`: Clive の基本ルール（日本語）。新しい会話の最初に system へ入る。
- `SOUL.md` `USER.md` `CURIOSITY.md`: 人格・ユーザーの情報・気になることの初期値（日本語）。作業フォルダ（`data/workspace/`）に無いときだけ写される。すでにあるファイルは言語を変えても上書きしない。`CURIOSITY.md` は好奇心リストへ一度だけ取り込まれ、以後は画面で編集する。
- `en/`: 英語版（`rules.md` と、上と同じ 3 つ）。日本語版と同じ見出しの並びで、`language` が `en` のときに使う。ファイルが無ければ日本語の版に戻る。
- 入口: `templates/rules.ja.md`
- 使うもの: 読まれる側（`src/engine/workspace.ts` と `src/app.ts` が使う）

### 画面 — `web/src`（React 19 + Vite）
- 経路は URL のハッシュ（`#/c/<id>` `#/tasks[/<id>]` `#/today` `#/notifications` `#/review` `#/memory` `#/skills[/<名前>|/draft/<名前>]` `#/curiosity` `#/settings` `#/runs[/tools|/reviews]`）。`#/runs/tools` は道具の表、`#/runs/reviews` は振り返りの記録で、実行中の振り返りのリンク（状態バー・タスクの帯）はここを開く。`#/skills/<名前>` はそのスキルの窓、`#/skills/draft/<名前>` はレビュー待ちの下書きの窓を開く。スキルの下書きの通知は `#/review` を保存しているので、通知を押したときは題の「…: <名前>」から下書きの窓へ移す（`skills-meta.ts` の `skillDraftLink`）。古い経路は通知のリンクに保存されているので、移した後もずっと受け付ける。`#/review` は、履歴を置き換えて `#/skills` へ転送するだけでタブにはならない（レビューの 3 つの中身は、スキルの下書き → スキル・ツール、自発タスクの提案 → タスクの「あなたの対応が必要」、振り返りの記録 → 実行ログへ移した）。`#/curiosity` はタスクのページの「気になること」の節を開く（`parseRoute` が `{ page: 'tasks', section: 'curiosity' }` にする）。`#/today` は、広い画面では右のパネルを開いて直前の会話に戻し、760px 未満では「いまの動き」のページになる。サーバーとは `api.ts`（HTTP）と `events.ts`（SSE。出来事の型はサーバーの `RunEvent` の手書きの写し）だけで話す。
- ファイル:
  - `main.tsx` `App.tsx`: 入口。`main.tsx` はテーマと言語を決め、サーバーの設定（`/api/settings`）からタイムゾーンと言語（`language`。無ければブラウザの言語）を読んでから最初の描画をする（最初の描画は 3 秒までしか待たない。遅れて届いた設定も捨てず、届いた時点で反映する。読めなければ一度だけやり直し、それまでは既定の Asia/Tokyo とブラウザの言語。読み込みは `i18n/load-settings.ts`）。`App.tsx` は全体の状態（作成中の返事・承認待ち・ワーカー・未読・実行の開始時刻・使うモデル・再起動の要否）、SSE の出来事の受け取り（トーストとブラウザ通知を含む）、幅の判定、全体のキー操作、下の枠の部品の組み立て。`LanguagePrompt.tsx` は、サーバーの設定を実際に読めたあと（`i18n/state.ts` の `getSettingsApplied`）で、設定に `language` が無いまま画面が日本語以外のときだけ、タブ列の下に「Clive の返事も英語にしますか」を 1 回出す（答えは `localStorage` の `clive.languagePrompt`、「はい」なら `language.ts` の `saveLanguage` で設定に保存）。
  - 全体の枠（デザインの寸法どおり。`styles/shell.css`）:
    - `Sidebar.tsx`: 左。姿と名前と様子の一言（姿を押すと右のパネルが開く）、ページの一覧（新しい会話・検索とコマンド・タスク・スキル・ツール・実行ログ・記憶・設定。狭い画面ではさらに「いまの動き」）、会話の一覧（相対時間・作成中の回転印・承認待ちの点）。狭い画面では引き出しになる。
    - `TabBar.tsx`: 上のタブ列。開いたページと会話、×、＋、検索（パレット）、右のパネルの開閉、選んだタブの下線。`NarrowHeader.tsx` は狭い画面の上の帯（メニュー・題・様子の一言・承認待ち・検索・通知）。
    - `StatusBar.tsx`: 下の状態バー。接続（押すと繋ぎ直す）、ワーカーの状態と 1 時間の実行数、実行中のタスクと経過時間、承認待ち、使うモデル（表示だけ）、未読の通知（押すと通知の吹き出し）、ライト/ダークの切り替え。狭い画面では出さない。
    - `Palette.tsx`: コマンドパレット（⌘K / Ctrl+K、左の「検索とコマンド」、タブ列の虫眼鏡）。操作・会話・タスク・スキルの 4 群を、開くたびに `api.tasks` `api.skills` を読んで作る（スキルは、そのスキルの窓 `#/skills/<名前>` を開く）。↑↓ で選び ↵ で開く（日本語の変換中の Enter は無視）。操作には新しいタスク（ダイアログを開く）、表示の言語の切り替え（`language.ts` の `saveLanguage` でサーバーの設定に保存する）、ワーカーの一時停止と再開（`api.setWorker`）が入る。絞り込みと並びの決まりは `palette.ts`（画面を使わない部分。全角の英数字も半角として探す）。
    - `NotificationBubble.tsx`: 右下のベルから開く通知の吹き出し（新しい 8 件、「すべて既読にする」、「すべて見る」）。`NotificationsPage.tsx`: 通知のタブ（全件）。`#/notifications` はここを開く。`NotificationRow.tsx` は 2 つで共通の 1 件の行。種類ごとの絵と名前、リンクの読み取り（画面の経路として読めるものだけ開く）は `notification-meta.ts`。通知の一覧と未読数は `App.tsx` が持つ。
    - `ActivityPanel.tsx`: 右のパネル「いまの動き」の枠（見出し・ワーカーの状態・閉じる）。760px 未満では同じ中身が、左のメニューの「いまの動き」のページになる。
    - `ActivityBody.tsx`: そのパネルの中身。いちばん上に「きょう」（姿・様子の一言・件数〔承認待ち・返事待ち・未読の通知。押すとその場所へ〕・今日終わったこと）、そのあとデザインの順に、ワーカー（自発行動のオン/オフと一時停止/再開は `api.setWorker`、次に動く時刻、この 1 時間の実行数）→ 実行中の実行（タスクも振り返りも。経過時間・最後のメモ・流れる線。題を押すとそのタスクへ、止めるボタンは `api.stop`）→ 次に動くタスク（4 件。サーバーの選び方 `pickNext` に合わせる: 出どころ → 優先度 → 日時。自発行動がオフなら Clive 自身のものは出さない）→ 最近の実行（5 件、「すべて見る」で実行ログ）。`api.tasks` `api.runs` `api.task` から組み立てる。並べ方・数え方は `activity.ts`（画面を使わない部分）。
    - `toast.tsx`: 右下のトースト（最大 3 件、ホバーで広がる、操作ボタン付き）。`Tooltip.tsx`: `data-tip` `data-kbd` を持つ要素の説明。
    - `routes.ts`（経路の読み取り）、`tabs.ts`（タブの開閉・保存の決まり。画面を使わない部分）、`useTabs.ts`（それを経路につなぐ。タブは「開いた経路の一覧」だけを持ち、今どれを開いているかは URL のハッシュが唯一の正。起動後、会話の一覧（サーバーは 100 件まで）に無い会話のタブは、サーバーに尋ねて 404 だったものだけ閉じる。確かめるついでに受け取った題は、一覧の外の会話のタブの名前になる）、`conversation-state.ts`（会話の横の印と、姿・一言の「返事を作っている最中」は、承認の待ちを優先する・件数は 100 件で「100+」・承認の行き先と、会話の返事かどうか（`classifyRun`）は「一覧に載っているか」でなく実行の種類で決め、どちらとも分からないときは会話の種類をサーバーに尋ねる。画面を使わない部分）、`layout.ts`（760px 未満が狭い・1180px 未満が中くらい、右のパネルの開き方の保存）、`keys.ts`（Esc で閉じる重なりの順番 — パレット・ダイアログ・通知・モデル・シート・引き出し、日本語の変換中の判定、キーの割り当て: ⌘/Ctrl+K・+/・+S）、`hooks.ts`（`useNow` `useTheme` `useEscapeLayer` `useSaveShortcut` `useExit`: 閉じる動きが終わるまで部品を残す）、`pages.ts`（ページごとの名前の辞書キーと絵、ワーカーの状態、状態バーに出すモデルの選び方）。
  - `Chat.tsx`: チャットの画面。会話の読み込み、送信・やり直し・止める、添付、スラッシュコマンド（`/new` `/task` `/tasks` `/skills` `/log` `/memory` `/stop` `/rename` `/archive`）、題の変更とアーカイブ（アーカイブは確認つき。API は `api.renameConversation` `api.archiveConversation`）。返事ごとのモデル名は、保存済みの返事は `api.runs(500)`（`/api/runs?limit=500`。サーバーの上限）の `model` を `runId` で引き、作成中の返事は下書きの `modelId` から設定の名前を引く（500 件より古い実行は出さない）。最初の発言で会話を作るときは、送れたあとに移る（失敗しても入力と札が残り、やり直しで会話を作り直さない）。`TaskSheet.tsx` が使う `ApprovalCard` と `ToolMessage` も、ここから出している。
  - `ChatMessages.tsx`: 会話の並びの部品（自分の発言・返事・考え中・実行中の道具・道具の行・注記・記憶の行・失敗の札・送る前に止めた札・空の会話）。`ApprovalCard.tsx`: 会話の入力欄の上に固定する承認の札（決定は `approval-decide.ts` を通し、同じ札には 1 回しか送らない。Enter と札のボタンで共有する。残り時間の線は `approvalTimeoutSec` を設定から読んで出す・詳細のダイアログ）と、`TaskSheet.tsx` が使う単体の札。`ChatDialog.tsx`: 承認の詳細とアーカイブの確認に使うダイアログ（Esc で閉じる・Tab は中に留める）。`Composer.tsx`: 入力欄（自動で伸びる・スラッシュの候補・使うモデルの札は表示だけ・添付）。
  - `chat-logic.ts`: チャットの画面を使わない部分（空の Enter で承認するのは、表示している札の id が合い、その札が出てから（画面やウィンドウに戻ったときも数え直す）1 秒あとだけ・送る前の 409 の `problems` と `api.models()` の確認結果をつないで数字を出す・途中の失敗の 2 つの数字・スラッシュコマンドの表・道具 24 個の絵の表・道具の入力の 1 行化・残り時間・時刻の整形）。`memory-undo.ts`: 「記憶を取り消す」の結果を、会話の中の行と右下のトーストで共有する。

  - タスク（`styles/tasks.css` に寸法と動き。新しいタスクのダイアログがどのページからも開くので、`main.tsx` が他のスタイルのあとに読み込む）:
    - `TasksPage.tsx`: 一覧。件数のまとめ・検索・「新しいタスク」、折りたためる 4 つの節（あなたの対応が必要 / 実行中・実行待ち / 予定 / 完了。空の節は出さない）と、最後の「気になること」。`#/tasks/<id>` は詳細のシートを重ねて開き、`#/curiosity` は最後の節を開く。広い幅では表の列（出どころ・優先度・いつ）を出し、列にするかどうかは画面全体の幅ではなく、このページ自身の幅（780px）で決める。
    - `TaskRow.tsx`: 1 行。状態の絵・題・補足・右のボタン（実行・今すぐ実行・止める・もう一度）。返事待ちにはその場の答えの欄、提案には承認・見送り、実行中には流れる線を出す。`TaskSection.tsx` は節の見出し。
    - `TaskSheet.tsx`: 右から出る詳細のシート。題の編集・出どころなど 4 つの項目・状態ごとの操作・実行中の札（止めても 20 秒ほどで再開する、止め続けるには「取り消す」か「一時停止」、と添える）・返事待ちの質問と答えの欄・このタスクの承認待ち・詳細と次の一手の編集（完了の条件は見るだけ）・結果の Markdown・この予定から作った実行・経過の記録・Clive の作業記録（折りたたみ）。
    - `NewTaskDialog.tsx`: 新しいタスクのダイアログ。`App.tsx` が持ち、タスクのページとコマンドパレットから開く。`CuriositySection.tsx`: 「気になること」（一覧・追加・今すぐ調べてもらう・やめる・また気にする・調べたものも表示）。
    - `task-meta.ts`（節への分け方・並べ方・件数・行の補足・出す操作・状態や経過の種類の辞書キー）、`task-form.ts`（新しいタスクの入力 → サーバーへ送る形、「〜に実行します」の元）、`task-actions.ts`（操作の呼び出しと通知。取り消しのトーストに「元に戻す」は付けない）。この 3 つは画面を使わない部分。`pending.ts`（送信中のものを覚えて、同じものの 2 回目の送信を止める。Enter の連打やクリックとの重なりで、答え・承認・作成・編集が 2 回送られないようにする。`usePending` で各部品が使う）。
  - `SkillsPage.tsx`: スキル・ツール。見出し + 切り替え（スキル / 道具 / フォルダ）。スキルは、レビュー待ちの下書きを先頭に、名前順で並べる（並びの決まりは `skills-meta.ts`）。道具は、画面に固定で持つ 24 個の名前・説明・効果（読む/書く/実行/通信/内部）を見るだけ（サーバーに道具の一覧の API と、道具ごとの方針が無いため）。フォルダは `FoldersPanel.tsx` で、`tools.roots`（読み書き / 読むだけ）と `tools.deny` を直して、保存のときに設定全体を取り直して差し替える（`PUT /api/settings`）。保存の前に、触れないパスを外す・フォルダを足す・読むだけを読み書きにする、といった範囲が広がる変更を並べて確かめ（`skills-meta.ts` の `wideningChanges`。ディスク全体やホームフォルダ全体の指定は強く警告する。ボタンも Ctrl/⌘S も同じ入口）、取り直した設定が開いたときと違えば（別の場所で変わっていれば）上書きせずに止める。保存していない変更があるまま再読み込みすると、ブラウザが確かめる。`SkillDialog.tsx` は、スキルの窓（見る・直す・消す・新しく書く）と、下書きの承認 / 却下（直す下書きは、いまの内容と並べて見せる）。画面全体に重ね、狭い幅では下から出るシートになる。編集中の Esc は、捨てる前に窓の中で確かめる。
  - `Memory.tsx`: 記憶のページ（左の一覧の「記憶」。`#/memory`）。デザインの「スキル・ツール」と同じ並び（題 + 説明 + 切り替え「ユーザーについて / Clive のメモと教訓 / 会話を探す」）で、2 冊それぞれの使用量の線・一覧・追加・編集・削除・履歴・取り消しと、過去の会話の検索を出す。会話の中で記憶が変わった（SSE の `memory.changed`）ときは、`App.tsx` の `memoryRevision` で読み直す。「上限を設定で変える」は設定の開く節を `sessionStorage` に書いてから `#/settings` へ移る。削除すると、すぐ「取り消す」のトースト（`api.forgetMemory` が返す `eventId` で `api.undoMemory`。API の取り消しは `memory.changed` を出さないので、取り消したあとにページ自身が読み直す）。`memory-page.ts`（画面を使わない部分: 出どころ・変更の種類・やった人・発言の役を辞書のキーに結びつける、取り消せる変更の判定、`[u12]` の呼び名）、`usage.ts`（使用量の線の割合と、8 割を超えたかの判定。設定の「記憶」と共通）、`styles/memory.css`。
  - `Runs.tsx`: 実行ログ。見出し + 切り替え（実行 / 道具 / 振り返り）。実行の表（時刻・種類・モデル・結果・秒数・トークンと詳細）、道具の表（時刻・道具・判定・決めたのは・結果。`/api/tool-calls`）、振り返りの記録（きっかけ・状態・メモ・変えた記憶。`/api/reviews`）。どの表も新しい順で 200 件まで。判定・決めた人・種類・きっかけ・状態はサーバーのコードを受けて、表示の文字だけを `runlog-meta.ts` が辞書から出す（知らない値はコードのまま出す）。実行が始まる・終わるたびに表を取り直す。
  - `Settings.tsx`: 設定の枠（デザインどおり。左に節の一覧 — モデルとコンテキスト長・プロバイダ・API キー・道具・ワーカー・記憶・見た目・サーバー・設定ファイル、右に中身）。設定全体を「編集中の設定」として持ち、変えた行と節に点、下に「保存していない変更が N 件」の帯（元に戻す・保存する。⌘/Ctrl+S でも保存）を出す。保存は、直前に `api.settings` で最新の設定を読み直し、画面を開いたときの設定から今の編集までの差（`settings/merge.ts` の `diffConfig`）を最新へ当てて（`applyEdits`）、設定全体を `api.saveSettings` で送る（名前・色・形・動きだけの変更は、触った項目だけを `api.saveProfile`）。ほかの場所が先に変えた値は巻き戻らず、触った所を先に変えられていたら何も書かずにその行に出して「最新を読み込む」を出す。保存していない編集があるあいだは `beforeunload` で確かめさせる。サーバーが断った理由（`/models/0/contextLength: …` のような場所つきの文）は `settings/model.ts` の `parseProblem` で行と節に結びつけ、上の一覧から押すとその行へ飛ぶ。サーバーの節を変えたときは再起動が要ると知らせ、設定ファイルが壊れているときの警告（`configError`）も出す。開いた節は `sessionStorage` に残す。設定を開いたままほかの場所（コマンドパレット・「Clive も英語にしますか」）で言語が保存されたときは、保存済みと編集中の `language` を合わせる（合わせないと次の保存で元に戻る）。
  - `settings/`: 節ごとの中身。`merge.ts`（画面を使わない部分: 保存の合流。差 → 編集の一覧、最新への当て方と衝突の判定、プロフィールだけの編集の判定）、`model.ts`（画面を使わない部分: 節の一覧・変更の数え方・サーバーの問題の読み取り・モデル / プロバイダ / 順番の書き換え・数とタグの入力）、`types.ts`（節に渡すもの・行ごとの変更の判定）、`fields.tsx`（1 行の枠と、数・文字・選択・範囲・タグ・使用量・色の入力）、`SectionView.tsx`（節 → 部品）、`ModelsSection.tsx`（モデルとコンテキスト長・プロバイダ・API キー）、`BehaviorSections.tsx`（道具・ワーカー・記憶。記憶は上限と使用量の目盛りだけで、中身は「記憶」のページ）、`LookSection.tsx`（姿・名前・色・動き・テーマ・表示の言語と、英語の初期値の表示 = `api.templates`）、`SystemSections.tsx`（サーバー・設定ファイル）。道具の許可フォルダ（`tools.roots`）はこの画面にはまだ無い。
  - `language.ts`: 言語の設定の読み書き。「Clive も英語にしますか」を聞くかの判定（`shouldAskLanguage`）と答えの保存、`language` を足す・消す（`configWithLanguage`。`auto` は消す）、設定を読み直して言語だけ変えて保存し画面に反映する `saveLanguage`、設定を開いたまま言語が変わったときの合わせ直し（`withAdoptedLanguage` `adoptLanguageInDraft`）。`clipboard.ts`: コピー（`navigator.clipboard` が使えない http の画面では選択してコピーに切り替え、できたかどうかを返す）。
  - `Avatar.tsx` `avatar.ts` `avatars/*.svg`: 姿（20 種）と動き、様子の一言（`presenceOf`。文は辞書）。
  - `Markdown.tsx`: 返事の Markdown 表示。
  - `styles/tokens.css`: デザインの色・字体・余白・角丸・影のトークン。`:root` がライト、`:root[data-theme="dark"]` がダークの上書き。文字用のアクセント色（`--color-accent-text`）と薄い文字の 3 段階（`--color-text-muted*`）は、ライトで WCAG AA（4.5:1）に届くようデザインより少し濃くしてある。
  - `styles/components.css`: デザインの部品クラス（`.btn*` `.input` `.field` `.radio` `.seg` `.card*` `.tag*` `.table` `.dialog*` `.hr`）、スクロールバー、keyframes、`prefers-reduced-motion`。
  - `styles/logs.css`: 実行ログの表（グリッド。狭い幅では横に送れる）と振り返りの記録の寸法。
  - `styles/skills.css`: スキル・ツールの一覧・道具・フォルダと、スキルの窓（画面全体に重なる窓の枠: 背景・Esc・Tab の巡回）の寸法と動き。
  - `styles/chat.css`: チャットの画面（会話の並び・承認の札と詳細・入力欄・スラッシュの候補）の寸法と動き。
  - `styles/shell.css`: 全体の枠（サイドバー・タブ列・状態バー・右のパネル・トースト・ツールチップ）と、通知の吹き出し・コマンドパレット、ページの並び（`.view*`: 大きな題 + 説明 + 中身。通知のタブが最初の使い手）の寸法と動き、登場のアニメーション。
  - `styles/settings.css`: 設定の画面（`.set-*`）と「Clive も英語にしますか」の帯（`.lang-prompt*`）。狭い画面では節の一覧が横に並ぶ。
  - `styles.css`: 全体の CSS（1 ファイル）。古いトークン名（`--bg` など）を新しいトークンへの別名にしてあり、既存の画面はこのまま新しい色と字体になる。ダークは `data-theme` だけで決まり、OS の設定には直接従わない。
  - `icon-paths.ts` `icons.tsx`: アイコン 49 個（Lucide、ISC。デザインの `ICON` と添付の `paperclip`）の形は `icon-paths.ts`（出どころとライセンス文はファイルの先頭）、`<Icon name>` で出す部品は `icons.tsx`。
  - `i18n/`: 画面の多言語化（日本語・英語。ライブラリは使わない）。
    - `ja.ts` が元の辞書（値は文字列か、差し込み用の関数）。`en.ts` は `types.ts` の型（ja から作る）で書くので、キーの漏れ・余り・引数の型の違いは `tsc` で落ちる。未訳を日本語で埋める仕組みは無い。
    - `index.ts`: `t(key, ...args)` と、言語やタイムゾーンが変わると描き直す `useT()`、サイドバー用の短い相対時刻 `formatRelativeCompact`（5分 / 2h）。`elapsed.ts` は実行中の経過時間（`04:07`）。
    - `state.ts`: 今の言語とタイムゾーンの保持（サーバーの設定を読めたかも覚える: `markSettingsApplied`）。言語はサーバーの設定の `language`（`ja` / `en`）→ 無ければ `navigator.languages` の主の部分（`en-GB` なら `en`）→ ja の順で決め、`<html lang>` を合わせる。ブラウザには保存しない（古い `clive.language` は読まない）。
    - `load-settings.ts`: 起動時にサーバーの `timezone` と `language` を読む `loadServerSettings`と、読めた設定を画面に反映する `applyServerSettings`（設定を開いたとき・保存したときも使う）。最初の描画は待ち時間（3 秒）までしか待たないが、遅れて届いた設定も捨てずに反映し、読めなければ一度だけやり直す（捨てると、日時の入力が違う時刻として読まれる）。
    - `format.ts`: 日時（`compact` `full` `precise` `time`）・相対時刻・数・並べる文を `Intl` で整える。日時はブラウザではなくサーバーの `timezone` で表示し、`datetime-local` の入力もその時刻として読む（`parseZonedInput`）。
    - 訳すのは表示の文字だけ。API に送る値（曜日の `月`〜`日` など）は訳さない。この時点で辞書に入っているのは、全体の枠（サイドバー・タブ・状態バー・右のパネル・トースト・様子の一言）の文字、経路名、画面が自分で組み立てる文、ブラウザ通知、曜日のラベル、テーマと言語の切り替えの文、設定の画面の文字（`settings.*` `probe.status.*` `langPrompt.*`）。引数の要らない項目のキーを変数で持つときは `PlainKey` 型を使う（関数の項目まで含む `DictKey` の和集合は、型で断られる）。各画面の文字は、その画面を作り直す段階で足す。サーバーから来る文字は訳していない。
  - `weekdays.ts`: 曜日の値（`月`〜`日`。サーバーの `src/tasks/schedule.ts` の `DAY_MAP` と対）と、ラベルの辞書キー。
  - `ZoneNote.tsx`: 日時を出す画面に添える、タイムゾーン名（例: `Asia/Tokyo (UTC+09:00)`）の小さな注記。
  - `theme.ts`: テーマ（`auto` `light` `dark`）の保存（`localStorage` の `clive.theme`）と `<html data-theme>` への反映、`auto` のときの OS の変化への追従、今のテーマを知らせる購読（`getEffectiveTheme` `subscribeTheme`）、ライト/ダークの入れ替え（`toggleTheme`。押すと明示した値として保存され、`auto` へ戻すのは設定の「テーマ」）。`main.tsx` が起動時に `initTheme()` を呼ぶ。
- ビルド:
  - `web/index.html`: `<head>` で `web/public/theme-init.js` を同期で読む。最初の描画の前に `data-theme` を決め、再読み込みで違うテーマが一瞬出るのを防ぐ（CSP が `script-src 'self'` なので外部ファイル）。`<html lang>` は初期値が ja で、起動時に `i18n/state.ts` が決めた言語へ書き換える。
  - `web/vite.config.mjs`: 出力は `web/dist`、小さなファイルも埋め込まない `assetsInlineLimit: 0`、開発時は `/api` を `npm start` のサーバーへ転送。プラグイン `clive-woff2-only` は @fontsource の CSS から woff の指定を外し、woff2 だけを `web/dist/assets/` に出す（外さないと出力が倍になる）。
  - フォント: `@fontsource/cormorant-garamond` `@fontsource/lora` `@fontsource/noto-serif-jp`（版を固定、`main.tsx` で必要な太さだけ読む）。外部へは取りに行かない。SIL OFL 1.1 のライセンス文は `web/fonts-LICENSE.md`（配信物には入れない）。
  - `web/public/icon.svg`。
- 入口: `web/src/main.tsx`
- 使うもの: `/api/*` と `/api/events`、`react` `react-dom` `react-markdown` `remark-gfm`、`@fontsource/*`

### 常駐の設定 — `deploy/`
- `clive.service`: Linux の systemd の設定。Clive が書ける場所をデータのフォルダ（`/var/lib/clive`）だけに絞り、シェルの道具に対する OS 側の閉じ込めにもなる。
- 入口: `deploy/clive.service`
- 使うもの: `node src/main.ts`、環境変数 `CLIVE_DATA_DIR`、`/etc/clive/env`

### サーバーが作る文の言語と、画面が使うコード — `src/shared/messages`
- 考え方: サーバーが作る文は、作るときの `language` で書く（未選択は日本語）。画面に出すだけの文には、文のほかに**変わらないコード（`code`）と差し込みの値（`params`）**を添える。画面は自分の辞書でコードを引いて訳し、辞書に無いコードは `message` をそのまま出す。今ある項目（`error`・`field`・`message`・`errorKind`・`warning` の `code`）は変えていない。言語を変える前に作られた通知・経過・実行の記録は、作ったときの言語のまま残る。
- コードは `<領域>.<キー>` の形で、キーは `src/shared/messages/<領域>.ts` の表のキーそのもの。`{名前}` が `params` の名前になる。領域は `http`（`http.ts`）、`task`（`tasks.ts`）、`store`（`stores.ts`）、`provider`（`providers.ts`）、`engine`（`engine.ts`）。
- **API のエラー（HTTP 4xx/5xx の JSON）**: `{ error, field?, message, code?, params? }`。
  - `code` が `http.*`: 入力の誤り・見つからない・形式。`http.required{field}` `http.too_long{field,max}` `http.bad_enum{field,values}` `http.bad_bool{field}` `http.bad_attachments{max}` `http.too_large_body{kb}` `http.too_large_file{mb}` `http.unknown_language{language,values}`。値の無いもの: `unsupported_media_type` `invalid_json` `invalid_body` `invalid_id` `skill_missing` `item_missing` `already_researching` `conversation_missing` `bad_priority` `bad_when` `bad_repeat` `task_missing` `not_waiting` `already_finished` `bad_ids` `empty_name` `bad_color` `attachment_missing` `no_vision` `approval_gone` `bad_book` `internal`（500）。
  - `code` が `task.error.*`（`error` は `task`）: `empty_title` `bad_cron{cron}` `not_found{id}` `not_proposal` `not_schedule` `running` `schedule_cannot_run` `waiting_answer` `previous_unfinished` `bad_when{when}` `bad_repeat{repeat}`。
  - `code` が `store.*`: 記憶（`error` は `memory`）`store.memory.{empty,too_long{length,max},secret,over_cap.user{cap,used},over_cap.notes{cap,used},duplicate{ref},not_found{id},unchanged,no_event,already_undone,gone,cannot_undo}`、スキルとその下書き・好奇心（`error` は `invalid`）`store.skill.{bad_name,empty_description,long_description{max},empty_body,long_body{max},not_found{name},too_many_drafts,not_pending}` `store.curiosity.{empty_topic,too_long,duplicate{id},too_many{max},not_found{id}}`、添付ファイル（`error` は `upload`）`store.upload.{empty,too_large{mb},image_too_large{mb},unsupported,pdf_not_pdf,pdf_encrypted,pdf_no_text,pdf_damaged}`。
- **返事の失敗**: SSE の `run.end` と、会話への送信の 409（`SendOutcome`）に `errorCode?`・`errorParams?` を添える（`errorKind`・`errorMessage` は今のまま。`errorMessage` は詳しい説明として小さく添える）。
  - プロバイダ由来は `provider.*`: `key.missing{env}` `http.{context_overflow,auth,rate_limit,not_found,server,rejected}`（`{status,suffix}`）`cancelled` `timeout` `connect` `connect.code{code}` `anthropic.{timeout,connect,busy}` `unexpected{detail}` `ollama.context_unset`。
  - エンジン由来は `engine.*`: `send.{busy_chat,busy,nothing_to_retry}` `no_usable` `run.{internal{detail},no_model,no_provider{id}}` `tool.invalid_streak{count}` `fit.overflow{required,available}`。
- **警告**: SSE の `warning` は今までの `code` に `params?` を足した。`max_iterations{max}` `context_trimmed{count}` `partial_discarded` `retrying{seconds,attempt,retries,errorCode?,errorParams?,detail?}`（理由にコードがあれば `errorCode` と `errorParams`、無ければ詳しい文を `detail` に） `compacted{count}` `compaction_failed` `server_truncation_suspected{actual,estimate}`。
- **モデルの確認**（`/api/models` と設定の `probe`）: `message` と `hint` は language で書く。`messageCode`（`provider.probe.*` と、プロバイダのエラーと同じ `provider.*`）と `messageParams` を添える。`messageParams` には言語で書いた文を入れない（`too_small` の `sourceKind` は `measured` / `declared` / `limit` で、`n` がその数。`ok` の `noteCode` は数が実測でないときの注記のコードで、`provider.probe.note.{max_unavailable,not_loaded,use_config}`）。`probe.{exceeds_model{declared,modelMax},unknown,too_small{effective,required,sourceKind,n},ok{effective,noteCode?},ollama_not_found{model},ollama_unset,ollama_unreachable{base},tabby_other{current,model},vllm_missing{model},openrouter_missing{model},check_failed{detail},no_provider{id}}`。数字は `Probe` の `declared` `measured` `modelMax` `effective` `required` にも入っているので、画面は `status` と数字から自分で組み立ててもよい。`hint`（直し方）はサーバーの種類ごとの手順なので、画面は訳さずそのまま出す。
- **通知のリンク**（`link`。通知と一緒にデータベースに残る）: 今あるのは `#/tasks/<タスクの ID>`（完了・質問・相談・失敗・返事待ちの知らせ直し・承認が必要）、`#/tasks`（1 時間の実行の上限）、`#/settings`（モデルの不調・使えるモデルが無い）、`#/skills/draft/<スキルの名前>`（スキルの下書き。名前は `encodeURIComponent` で符号化）。`#/review` `#/today` `#/curiosity` `#/notifications` `#/memory` へはもう向けない（`tests/notification-links.test.ts` で固定）。それ以前に保存された通知は `#/review` のままなので、画面の古い経路の転送は残す。
- **コードを添えず、language で書くだけのもの**（画面は訳さない）: 通知の題と本文、タスクの経過の文とタスクの題・本文（好奇心から作るもの）、`cron_text`、実行や振り返りの会話の題、`triggerLabel`（`trigger` のコードも今までどおり付く）、道具の結果（`tool.result` の `preview`）と承認の依頼の題・理由・細目、再起動で中断した実行の記録、添付だけの発言の目印、記憶を画面から消したときの理由。
- **まだ日本語のまま**（段階 12b の残り）: 道具の説明と引数の説明（モデルに渡す仕様）、設定の問題の一覧（`config/store.ts`・`shared/url.ts`。画面が文の先頭の場所を読み取る）、起動時のエラーとログの行（`[INFO]` など）、設定が壊れたときの文、アダプタが空の発言に入れる穴埋め（`（空のメッセージ）`）、画面がまだビルドされていないときの案内ページ。

### テスト — `tests/`
- `node:test`（`npm test`）。サーバー側のテストが中心で、画面の部品の自動テストは無い。ただし画面の中の「画面を開かずに確かめられる部分」だけは、ここから直接読んで試す: `theme`（`web/src/theme.ts` と `web/public/theme-init.js`）、`contrast`（`web/src/styles/tokens.css` の値から文字の濃さを計算して 4.5:1 を割ったら落ちる）、`i18n`（`web/src/i18n/` の辞書・言語の決め方・タイムゾーンの変換・曜日の値・設定（タイムゾーンと言語）の遅れた読み込み）、`activity`（右のパネルの並べ方・数え方: 次に動くタスク・今日終わったこと・最後のメモ・最近の実行）、`memory-page`（記憶のページの、画面を使わない部分: `memory-page.ts` `usage.ts`、辞書）、`settings-merge`（設定の保存の合流: `settings/merge.ts`）、`settings`（設定の画面の、画面を使わない部分: `settings/model.ts` の変更の数え方・問題の読み取り・書き換え、`language.ts`、`clipboard.ts`、設定の辞書）、`chat`（チャットの画面を使わない部分: `chat-logic` `memory-undo`、チャットの辞書）、`runlog`（実行ログ: 結果・詳細・判定・きっかけのコードの訳と、サーバーが作るコードの種類との突き合わせ、経路 `#/runs/...`、サーバーの API の組み合わせ）、`tasks-screen`（タスク画面の、画面を使わない部分: `task-meta` `task-form` と、`#/curiosity` の経路、辞書の英語に日本語が混ざらないこと）、`skills`（スキル・ツール: 経路・一覧の並び・下書きの通知の行き先・道具の一覧とサーバーの突き合わせ・フォルダの編集・サーバーの API の組み合わせ）、`shell`（全体の枠の、画面を使わない部分: `routes` `tabs` `layout` `keys` `pages` `conversation-state` `palette` `notification-meta` `avatar` の様子の一言と、枠の辞書）。`language` はサーバーの言語（設定の既定値、テンプレートの読み分けと写し、返事の言語の指示、決まり文の英語に日本語が混ざらないこと）。分野ごとに 1 ファイル: `activity` `chat` `config` `contrast` `db` `engine` `engine-tools` `health` `i18n` `language` `language-server` `language-tools` `memory` `memory-page` `messages` `notification-links` `providers` `review` `runlog` `schedule` `settings` `settings-merge` `shell` `shell-guard` `skills` `tasks` `tasks-screen` `theme` `toolcall-parse` `tools` `uploads` `web-tools` `web`。
- `screen-server.ts`: 画面が読む API を確かめるための、本物の Web サーバーの起動（`skills` と `runlog` のテストが使う。モデルは使わない）。
- `helpers.ts`: 一時フォルダ（`tempDir`）、偽のサーバー（`fakeServer`）、偽のモデル窓口（`FakeAdapter`）と返事の台本（`reply` `fail`）。
- 入口: `tests/helpers.ts`
- 使うもの: `src/` の各部品（`App` で組み立てるものが多い）
