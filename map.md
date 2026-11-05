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
- 経路は URL のハッシュ（`#/c/<id>` `#/tasks[/<id>]` `#/today` `#/notifications` `#/review` `#/memory` `#/skills` `#/curiosity` `#/settings` `#/runs`）。古い経路は通知のリンクに保存されているので、移した後もずっと受け付ける。`#/today` は、広い画面では右のパネルを開いて直前の会話に戻し、760px 未満では「いまの動き」のページになる。サーバーとは `api.ts`（HTTP）と `events.ts`（SSE。出来事の型はサーバーの `RunEvent` の手書きの写し）だけで話す。
- ファイル:
  - `main.tsx` `App.tsx`: 入口。`main.tsx` はテーマと言語を決め、サーバーの設定（`/api/settings`）からタイムゾーンを読んでから最初の描画をする（最初の描画は 3 秒までしか待たない。遅れて届いた設定も捨てず、届いた時点で反映する。読めなければ一度だけやり直し、それまでは既定の Asia/Tokyo。読み込みは `i18n/load-timezone.ts`）。`App.tsx` は全体の状態（作成中の返事・承認待ち・ワーカー・未読・実行の開始時刻・使うモデル・再起動の要否）、SSE の出来事の受け取り（トーストとブラウザ通知を含む）、幅の判定、全体のキー操作、下の枠の部品の組み立て。
  - 全体の枠（デザインの寸法どおり。`styles/shell.css`）:
    - `Sidebar.tsx`: 左。姿と名前と様子の一言（姿を押すと右のパネルが開く）、ページの一覧（新しい会話・検索とコマンド・タスク・スキル・ツール・実行ログ・記憶・設定。狭い画面ではさらに「いまの動き」）、まだ新しい場所へ移していない画面（レビュー・好奇心）の小さな入口、会話の一覧（相対時間・作成中の回転印・承認待ちの点）。狭い画面では引き出しになる。
    - `TabBar.tsx`: 上のタブ列。開いたページと会話、×、＋、検索（パレット）、右のパネルの開閉、選んだタブの下線。`NarrowHeader.tsx` は狭い画面の上の帯（メニュー・題・様子の一言・承認待ち・検索・通知）。
    - `StatusBar.tsx`: 下の状態バー。接続（押すと繋ぎ直す）、ワーカーの状態と 1 時間の実行数、実行中のタスクと経過時間、承認待ち、使うモデル（表示だけ）、未読の通知（押すと通知の吹き出し）、ライト/ダークの切り替え。狭い画面では出さない。
    - `Palette.tsx`: コマンドパレット（⌘K / Ctrl+K、左の「検索とコマンド」、タブ列の虫眼鏡）。操作・会話・タスク・スキルの 4 群を、開くたびに `api.tasks` `api.skills` を読んで作る。↑↓ で選び ↵ で開く（日本語の変換中の Enter は無視）。操作には表示の言語の切り替え、ワーカーの一時停止と再開（`api.setWorker`）が入る。絞り込みと並びの決まりは `palette.ts`（画面を使わない部分。全角の英数字も半角として探す）。
    - `NotificationBubble.tsx`: 右下のベルから開く通知の吹き出し（新しい 8 件、「すべて既読にする」、「すべて見る」）。`NotificationsPage.tsx`: 通知のタブ（全件）。`#/notifications` はここを開く。`NotificationRow.tsx` は 2 つで共通の 1 件の行。種類ごとの絵と名前、リンクの読み取り（画面の経路として読めるものだけ開く）は `notification-meta.ts`。通知の一覧と未読数は `App.tsx` が持つ。
    - `ActivityPanel.tsx`: 右のパネル「いまの動き」の枠。中身は段階 6 で作り直すまで `Today.tsx`。
    - `toast.tsx`: 右下のトースト（最大 3 件、ホバーで広がる、操作ボタン付き）。`Tooltip.tsx`: `data-tip` `data-kbd` を持つ要素の説明。
    - `routes.ts`（経路の読み取り）、`tabs.ts`（タブの開閉・保存の決まり。画面を使わない部分）、`useTabs.ts`（それを経路につなぐ。タブは「開いた経路の一覧」だけを持ち、今どれを開いているかは URL のハッシュが唯一の正。起動後、会話の一覧（サーバーは 100 件まで）に無い会話のタブは、サーバーに尋ねて 404 だったものだけ閉じる。確かめるついでに受け取った題は、一覧の外の会話のタブの名前になる）、`conversation-state.ts`（会話の横の印と、姿・一言の「返事を作っている最中」は、承認の待ちを優先する・件数は 100 件で「100+」・承認の行き先と、会話の返事かどうか（`classifyRun`）は「一覧に載っているか」でなく実行の種類で決め、どちらとも分からないときは会話の種類をサーバーに尋ねる。画面を使わない部分）、`layout.ts`（760px 未満が狭い・1180px 未満が中くらい、右のパネルの開き方の保存）、`keys.ts`（Esc で閉じる重なりの順番 — パレット・ダイアログ・通知・モデル・シート・引き出し、日本語の変換中の判定、キーの割り当て: ⌘/Ctrl+K・+/・+S）、`hooks.ts`（`useNow` `useTheme` `useEscapeLayer` `useSaveShortcut` `useExit`: 閉じる動きが終わるまで部品を残す）、`pages.ts`（ページごとの名前の辞書キーと絵、ワーカーの状態、状態バーに出すモデルの選び方）。
  - `Chat.tsx`: 会話、承認の札、道具の行（この 2 つは `Tasks.tsx` も使う）、添付、入力欄。
  - `Tasks.tsx`: タスクの一覧・新規・詳細とワーカーの操作。ほかの画面が使う `STATUS_LABEL` `WorkerBar` もここにある。新規の「日時を指定」は、サーバーのタイムゾーンの時刻として読んでから送る。
  - `Today.tsx`（きょう。今は右のパネルの中身）。
  - `Review.tsx`: 3 つのページ。`ReviewPage`（スキルの下書き・自発タスクの提案・振り返りの記録）、`SkillsPage`、`CuriosityPage`。
  - `Memory.tsx`: 記憶 2 冊の一覧・追加・編集・削除・履歴・取り消しと、過去の会話の検索。
  - `Runs.tsx`: 実行の表。道具の記録（`/api/tool-calls`）は画面から使っていない。
  - `Settings.tsx`（テーマと表示の言語・モデルの確認・API キーの有無・設定ファイルの JSON 編集）と `Profile.tsx`（名前・色・動き・形）。
  - `Avatar.tsx` `avatar.ts` `avatars/*.svg`: 姿（20 種）と動き、様子の一言（`presenceOf`。文は辞書）。
  - `Markdown.tsx`: 返事の Markdown 表示。
  - `styles/tokens.css`: デザインの色・字体・余白・角丸・影のトークン。`:root` がライト、`:root[data-theme="dark"]` がダークの上書き。文字用のアクセント色（`--color-accent-text`）と薄い文字の 3 段階（`--color-text-muted*`）は、ライトで WCAG AA（4.5:1）に届くようデザインより少し濃くしてある。
  - `styles/components.css`: デザインの部品クラス（`.btn*` `.input` `.field` `.radio` `.seg` `.card*` `.tag*` `.table` `.dialog*` `.hr`）、スクロールバー、keyframes、`prefers-reduced-motion`。
  - `styles/shell.css`: 全体の枠（サイドバー・タブ列・状態バー・右のパネル・トースト・ツールチップ）と、通知の吹き出し・コマンドパレット、ページの並び（`.view*`: 大きな題 + 説明 + 中身。通知のタブが最初の使い手）の寸法と動き、登場のアニメーション。
  - `styles.css`: 全体の CSS（1 ファイル）。古いトークン名（`--bg` など）を新しいトークンへの別名にしてあり、既存の画面はこのまま新しい色と字体になる。ダークは `data-theme` だけで決まり、OS の設定には直接従わない。
  - `icon-paths.ts` `icons.tsx`: アイコン 49 個（Lucide、ISC。デザインの `ICON` と添付の `paperclip`）の形は `icon-paths.ts`（出どころとライセンス文はファイルの先頭）、`<Icon name>` で出す部品は `icons.tsx`。
  - `i18n/`: 画面の多言語化（日本語・英語。ライブラリは使わない）。
    - `ja.ts` が元の辞書（値は文字列か、差し込み用の関数）。`en.ts` は `types.ts` の型（ja から作る）で書くので、キーの漏れ・余り・引数の型の違いは `tsc` で落ちる。未訳を日本語で埋める仕組みは無い。
    - `index.ts`: `t(key, ...args)` と、言語やタイムゾーンが変わると描き直す `useT()`、サイドバー用の短い相対時刻 `formatRelativeCompact`（5分 / 2h）。`elapsed.ts` は実行中の経過時間（`04:07`）。
    - `state.ts`: 今の言語とタイムゾーンの保持。言語は 保存した設定（`localStorage` の `clive.language`）→ `navigator.languages` の主の部分（`en-GB` なら `en`）→ ja の順で決め、`<html lang>` を合わせる。
    - `load-timezone.ts`: 起動時にサーバーの `timezone` を読む `loadTimezone`。最初の描画は待ち時間（3 秒）までしか待たないが、遅れて届いた設定も捨てずに反映し、読めなければ一度だけやり直す（捨てると、日時の入力が違う時刻として読まれる）。
    - `format.ts`: 日時・相対時刻・数・並べる文を `Intl` で整える。日時はブラウザではなくサーバーの `timezone` で表示し、`datetime-local` の入力もその時刻として読む（`parseZonedInput`）。
    - 訳すのは表示の文字だけ。API に送る値（曜日の `月`〜`日` など）は訳さない。この時点で辞書に入っているのは、全体の枠（サイドバー・タブ・状態バー・右のパネル・トースト・様子の一言）の文字、経路名、画面が自分で組み立てる文、ブラウザ通知、曜日のラベル、テーマと言語の切り替えの文。引数の要らない項目のキーを変数で持つときは `PlainKey` 型を使う（関数の項目まで含む `DictKey` の和集合は、型で断られる）。各画面の文字は、その画面を作り直す段階で足す。サーバーから来る文字は訳していない。
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

### テスト — `tests/`
- `node:test`（`npm test`）。サーバー側のテストが中心で、画面の部品の自動テストは無い。ただし画面の中の「画面を開かずに確かめられる部分」だけは、ここから直接読んで試す: `theme`（`web/src/theme.ts` と `web/public/theme-init.js`）、`contrast`（`web/src/styles/tokens.css` の値から文字の濃さを計算して 4.5:1 を割ったら落ちる）、`i18n`（`web/src/i18n/` の辞書・言語の決め方・タイムゾーンの変換・曜日の値・設定の遅れた読み込み）、`shell`（全体の枠の、画面を使わない部分: `routes` `tabs` `layout` `keys` `pages` `conversation-state` `palette` `notification-meta` `avatar` の様子の一言と、枠の辞書）。`language` はサーバーの言語（設定の既定値、テンプレートの読み分けと写し、返事の言語の指示、決まり文の英語に日本語が混ざらないこと）。分野ごとに 1 ファイル: `config` `contrast` `db` `engine` `engine-tools` `health` `i18n` `language` `memory` `providers` `review` `schedule` `shell` `shell-guard` `tasks` `theme` `toolcall-parse` `tools` `uploads` `web-tools` `web`。
- `helpers.ts`: 一時フォルダ（`tempDir`）、偽のサーバー（`fakeServer`）、偽のモデル窓口（`FakeAdapter`）と返事の台本（`reply` `fail`）。
- 入口: `tests/helpers.ts`
- 使うもの: `src/` の各部品（`App` で組み立てるものが多い）
