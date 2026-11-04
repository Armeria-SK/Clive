# Clive 機能概要

フロント画面を作るための機能の資料です。画面ごとに、機能・出す情報・状態・操作をまとめ、画面が使う API とイベントを載せています。見た目やレイアウトの案は含めていません。

- 状態の印: **実装済み**（今の画面と API がある）／**予定**（まだ無い。形は変わりうる）
- 今の画面のコード: `web/src/`（React 19 ＋ Vite、TypeScript）。作り直して構いません。API とイベントは下の一覧が正です

---

## 1. Clive とは

常に何かをしている、1人用の AI エージェントです。ブラウザから使います。

- **話す**: チャットで話しかける。返事はストリーミングで少しずつ届く
- **覚える**: 会話の中で大事なことをその場で記憶する（ChatGPT / Claude のメモリのように）。記憶は一覧で見て直せる
- **動く**: やること（タスク）を自分でメモ帳に書き、自分で進める。繰り返しの予定も実行する
- **道具を使う**: ファイルの読み書き、シェルのコマンド。危ない操作の前は止まって、ユーザーの承認を待つ
- **いろいろなモデルを使える**: Claude（Anthropic API）、ローカル LLM（Ollama・LM Studio・llama.cpp・vLLM）、OpenRouter、OpenAI。設定した順に試し、使えなければ次へ

機能面での約束:

- **黙って失敗しない**: うまくいかないときは、理由と直し方を返す。ローカル LLM の「コンテキスト長が足りない」は、送る前に止めて数値と直し方を返す
- **勝手に危ないことをしない**: 外への送信・パッケージの導入・許可していないフォルダへの操作は、必ず承認を待つ
- **中身が見えて、直せる**: 記憶・タスク・実行の記録は、すべて見られて、編集・取り消しができる

## 2. 技術的な前提と制約

| 項目 | 内容 |
|---|---|
| 利用環境 | PC のブラウザと、スマートフォンのブラウザ（Tailscale 経由）。幅 360px でも使えること |
| 言語 | 日本語 |
| テーマ | ライトとダーク（OS の設定に合わせる） |
| 利用者 | 1人だけ。ログインは無い |
| 外部リソース | **使えない**。CSP が `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'` なので、CDN のフォント・アイコン・画像・スクリプトは読めない。必要なものは同梱する |
| Markdown | Clive の返事は Markdown。生の HTML は描画しない。画像は表示しない。リンクは別タブで開く |
| リアルタイム | サーバーからのイベントは SSE（`GET /api/events`）。切れたら自動で繋ぎ直し、取りこぼした分を受け取る |
| 日本語入力 | 入力欄では、変換確定の Enter で送信しないこと |
| 動き | 端末が「動きを減らす」設定（`prefers-reduced-motion`）なら、アニメーションを止める |

## 3. 画面とナビゲーション

| 画面 | 状態 | 主な機能 |
|---|---|---|
| きょう | 実装済み | Clive の今の様子と、今日の要点 |
| チャット | 実装済み | 会話一覧、会話、承認 |
| タスク | 実装済み | タスクの一覧・作成・詳細、ワーカーの状態 |
| 通知 | 実装済み | 通知の一覧、未読数 |
| 記憶 | 実装済み | 記憶の一覧・編集、過去の会話の検索 |
| 設定 | 実装済み | モデルとコンテキスト長、API キー、道具、ワーカー、記憶、Clive の見た目、サーバー |
| 実行ログ | 実装済み | すべての実行と道具の記録 |
| レビュー | 実装済み | スキルの下書き・自発タスクの提案の承認、振り返りの記録 |
| スキル | 実装済み | Clive の手順書の一覧・編集 |
| 好奇心 | 実装済み | Clive が気になっていることの一覧・追加・調べてもらう |

どの画面からでも分かる必要がある情報:

- サーバーと繋がっているか（SSE の接続状態）
- 承認待ちがあるか（どの会話か）
- 返事を作っている会話があるか
- 未読の通知の数
- Clive の今の様子（4.8 のアバター）

---

## 4. 画面ごとの機能

### 4.1 チャット（実装済み）

**会話一覧**: 新しい順。各会話のタイトル（最初の発言から自動で付く。変更できる）、返事を作っている最中か、承認待ちがあるか。新しい会話を始める。会話を片付ける（アーカイブ）。

**会話の中に出るもの**

| 種類 | 内容 |
|---|---|
| ユーザーの発言 | 平文。添付があれば、その名前と種類（ファイル・PDF・画像） |
| Clive の返事 | Markdown |
| 書きかけの返事 | ストリーミング中の返事。まだ文字が来ていないときは「考えています（モデル名）」 |
| 道具の実行中 | 「ツールを実行しています: shell_run」 |
| 道具の結果 | 道具の名前・成功か失敗（実行しなかった場合を含む）・結果の全文（長いので、普段は1行目だけ見せて開けるようにする） |
| 承認の依頼 | 4.2 |
| 注意書き | 再試行中（理由と何秒後か）、モデルを切り替えた（どれからどれへ・理由）、古い発言を要約した・外した、記憶した・書き直した・消した（取り消しの操作つき）、道具を実行しなかった（理由） |
| エラー | 返事を作れなかった理由・直し方・もう一度送る操作 |

**入力**: 文章を送る（Enter で送信、Shift+Enter で改行）。返事を作っている間は「止める」操作になる。

**添付**: ファイルを付けて送れる（1回に 5 件まで、1件 10MB まで）。

- 種類は中身で見分ける: テキスト（Markdown・CSV・JSON・ソースコードなど）／PDF（文字の入っているもの。スキャンした画像だけの PDF やパスワード付きは読めない）／画像（PNG・JPEG・GIF・WebP、5MB まで）
- テキストと PDF の文字は、発言の後ろに「外部の内容」として入る（1件 5 万字まで）。画像は、画像を読めるモデル（`models[].vision`）にだけ渡す。読めるモデルが無いと送れない（409）
- 添付を付けた返事では、シェルとファイルの書き込みが承認制になる（中身に書かれた指示で動かされないため）
- 送る前に、付けたファイルの名前・種類（PDF はページ数）を見せ、外せるようにする
- 添付できなかったとき（大きすぎる・読めない種類）は理由を見せる

**送信が受け付けられなかったとき**（使えるモデルが無い、コンテキスト長が足りない）: 理由と直し方を表示する。入力した文は消さない。設定画面へ移動できる。

**表示する必要がある状態**

1. 空の会話
2. ストリーミング中
3. 道具を使っている途中（結果が出て、次の返事を書いている）
4. 承認待ち
5. 失敗（もう一度送れる）
6. 送信前に止まった（コンテキスト長が足りない。数値と直し方を含む長い説明）
7. 記憶した直後（取り消しの操作つき）

### 4.2 承認（実装済み）

危ない操作の前に、Clive は止まって承認を待つ。チャットの中と、通知から見られるようにする。

**出す情報**

- 何をしようとしているか（例: 「コマンドを実行する」「ファイルに書き込む: SOUL.md」）
- 中身（コマンドや書き込む内容）。**Markdown として描画せず、改行を保ったそのままの文字で**見せる
- 作業フォルダ
- 承認が要る理由（複数あることがある）
- 見つけたパスと、その判定（許可フォルダの中・外・拒否・判定できない）
- 残り時間（過ぎると拒否になる）

**操作**: 今回だけ許可／この会話では許可（同じ内容なら次から聞かない）／拒否

**承認が要る理由の例**

- 許可フォルダの外に触れる
- 外への送信（git push、curl -X POST、ssh など）
- パッケージの導入（npm install など）
- インタプリタにコードを直接渡す（node -e、python -c）
- 人格・プロフィールのファイル（SOUL.md / USER.md）を書き換える
- Web や添付の内容を読んだ後の書き込み・実行

### 4.3 タスク（実装済み）

Clive が自分で書いて自分で進めるメモ帳。ユーザーが頼むこともできる。

**一覧の区分**

| 区分 | 含む状態 | 説明 |
|---|---|---|
| 進行中 | 実行待ち（ready）・実行中（running）・返事待ち（waiting） | 返事待ちは、Clive がユーザーに質問していて止まっている |
| 予定 | 繰り返し（scheduled）・開始日時が先のもの | 繰り返しは「平日 09:00」のような説明がある |
| 提案 | 提案（inbox） | Clive が自分で作り、承認を待っているもの |
| 完了 | 完了・失敗・取り消し | 結果の要約がある |

**各タスクの情報**: タイトル、状態、出どころ（あなた・Clive・予定・好奇心）、優先度（1〜3、1 が高い）、次の一手、開始日時または繰り返し、最終更新、試行回数

**作成**（ユーザーが頼むとき）

- タイトル（必須）、詳細、優先度
- いつ: 今すぐ／日時を指定／繰り返し（毎日・平日・毎週・毎時・N分ごと と、時刻・曜日・分・間隔）

**詳細**

- タイトル・詳細・次の一手・完了の条件（編集できる）
- 経過の記録（作成、メモ、途中経過、質問、答え、完了、失敗、再試行、割り込み）
- 返事待ちのとき: Clive の質問と、答えを送る操作
- タスク専用の会話（Clive がこのタスクで何をしたかの全記録）への移動
- 操作: 今すぐ実行／完了にする／取り消す／（提案のとき）承認

**ワーカーの状態**（タスクを裏で実行する仕組み）

- 自発行動: オン／オフ（オフのとき、Clive が自分で作ったタスクは動かない。予定とユーザーが頼んだタスクは動く。費用に関わるので既定はオフ）
- 一時停止／再開（すべて止める）
- いま実行中のタスク（あれば）と、止める操作
- 次に動く時刻、この1時間の実行数と上限

### 4.4 通知（実装済み）

- 未読数
- 一覧: 種類・タイトル・本文・時刻・関連する画面への移動（タスクや会話）
- 種類: タスクが完了した／返事待ちになった／失敗した／承認が必要／調子が悪い（同じ失敗が続く）
- すべて既読にする
- ブラウザを開いているときは、ブラウザの通知も出す（承認が必要なとき・返事待ちのとき）

### 4.5 記憶（実装済み）

Clive が覚えていること。2冊のブックに分かれる。

- **ユーザーについての記憶**（名前・好み・状況・決めたこと）
- **Clive のメモと教訓**（やり方のコツ・失敗から学んだこと）

**出す情報**

- ブックごとの使用量と上限（例 1,240 / 2,000 文字）。上限に近いかどうか
- 記憶の一覧: ID（[u7] など）・内容・出どころ（会話の中で Clive が記憶／あなたが追加／振り返りで追加）・更新日時・元の会話への移動
- 記憶ごとの変更履歴（作成・書き直し（前の内容）・削除・復元、誰が・いつ）

**操作**: 追加・編集・削除、変更の取り消し、過去の会話の検索（当たった発言の抜粋・会話のタイトル・日時・会話への移動）

### 4.6 設定（実装済み・項目ごとの編集にしたい）

今は「モデルの状態の表」と「設定ファイル（JSON）をそのまま編集」の2つ。項目ごとに編集できるようにしたい。保存すると検証され、問題があれば場所つきで返る（`PUT /api/settings` の 400）。各項目の説明と既定値は `GET /api/settings/schema` から取れる。

**モデルとコンテキスト長**

- モデルごと: 名前、プロバイダ、状態（使えます・コンテキスト不足・モデル上限超え・長さ不明・接続できません・API キー未設定・モデルがありません・エラー）、**実際に使う長さ**、**必要な長さ**、設定値・実測値・モデルの上限、説明、**直し方**
- 確認し直す
- チャットで使う順番と、裏方の処理（タスクなど）で使う順番の並べ替え
- モデルの追加・編集: 名前、プロバイダ、モデル名、コンテキスト長、最小コンテキスト長、出力の上限、ツールの使い方（ネイティブ／本文に書かせる）、渡すツールの数の上限、画像を渡せるか

**プロバイダ**: 種類（Anthropic・OpenAI 互換・Ollama）、URL、API キーの環境変数名、サーバーの種類（LM Studio・llama.cpp・vLLM・OpenRouter・OpenAI・その他）、同時リクエスト数、上限時間

**API キー**: 環境変数名ごとに「設定済み／未設定」だけ（値は出さない）。設定方法の案内（`.env` に書いて再起動）

**道具**

- 触れてよいフォルダ（パスと「読み書き／読むだけ」）の追加・削除
- 触れないパス
- 許可フォルダの外に触れるシェルのコマンド: 承認を求める／止める
- シェル: 使う／使わない、種類（自動・pwsh・PowerShell・bash）、上限時間、承認なしで実行してよいコマンド、承認を求めるコマンド、止めるコマンド、承認を待つ時間
- フック（外部コマンド）

**ワーカー**: 自発行動、1時間の上限、話しかけてから自発行動を始めるまでの時間、自発行動をしない時間帯、自分のタスクを提案にするか、返事待ちを知らせ直す間隔

**記憶**: ユーザーについての記憶の上限、メモと教訓の上限

**Clive の見た目**: 4.8

**サーバー**: ポート、ほかの端末から開く origin（Tailscale）、入れる Tailscale のアカウント。変えたときは再起動が必要（`restartRequired`）

**設定ファイルの状態**: ファイルが壊れていて、直前の正しい設定で動いているときは、その問題の一覧（`configError`）

### 4.7 実行ログ（実装済み）

すべての実行の記録。同じ失敗が続いていないかを確かめるためのもの。

- 実行ごと: 時刻、種類（チャット・タスク・振り返り）、モデル、結果（成功・エラーの種類）、試行回数、秒数、入力・出力・キャッシュのトークン数、見積もり、エラー文、フラグ（古い発言を要約した・サーバー側で切り捨てられた疑い・本文からツール呼び出しを拾った・呼び直しの上限 など）
- 道具の実行ごと: どのツールを、どの判定（許可・承認・拒否）で、誰が決めて（組み込み・フック・ユーザー）、成功したか

### 4.8 Clive の見た目（アバター）と動き（実装済み）

Clive の見た目を選べて、今の様子に合わせて動く。

**素材**: `web/src/avatars/avatar-*.svg`（20種類）

- 形: pebble（既定）・triangle・diamond・bean・cloud・droplet・heart・star・crescent・capsule・square・puddle・ghost・bunny・cat・bear・mushroom・bell・peanut・comet
- 各 SVG は `viewBox="0 0 100 100"` の1本のパスで、「体の輪郭 → 目 → 目」の順に入っている（目は体にあけた穴）。パスを `M` で区切ると体と目に分けられる。体を選んだ色で塗り、目は瞬きのために別に扱う（`web/src/avatar.ts` の `avatarParts`）

**ユーザーが選べるもの**: 名前、形、色（`#RRGGBB`。既定 `#61B8A5`）、動き（自動・なし・ふわふわ（float）・ゆらゆら（sway）・脈打つ（pulse））

**「自動」のときは、Clive の様子に合わせて動きが変わる**

| 様子 | いつ |
|---|---|
| 作業中（work） | 返事を作っている、タスクを実行している |
| 待っている（wait） | 承認待ち、タスクの返事待ち |
| 休眠（sleep。目を閉じる） | ワーカーが一時停止中、自発行動をしない時間帯 |
| ひと休み（idle） | 何もしていない |
| お祝い（celebrate。1回だけ） | タスクを完了したとき |

- 「なし」と「休眠」以外は、ときどき瞬きをする。瞬きの間合いは `web/src/avatar.ts` の `blinkTiming` で決める
- 動きの定義は `web/src/styles.css`（`.bot-avatar[data-motion=...]`）にある

### 4.9 きょう（実装済み）

Clive の今の様子と、今日の要点を1か所で見る画面。

- Clive のアバターと、今の様子の一言（「返事を考えています」「タスク『…』を進めています」「承認を待っています」「お休み中」など）
- 今日の要点: 進行中のタスク・返事待ち・承認待ち・未読の通知の数（それぞれの画面へ移動できる）、最近終わったタスク、次の予定

### 4.10 レビュー（実装済み）

承認が要るものをまとめて扱う画面。

- **スキルの下書き**: Clive が作った・直したスキル。新規か修正か、理由、いまの内容と直したあとの内容（修正のとき）→ 承認して有効にする／却下。承認するまで Clive は使えない
- **自発タスクの提案**: `worker.selfTasksNeedApproval` がオンのとき、Clive が自分で作ったタスク（好奇心からのものも）→ 承認／断る。好奇心からの提案を断ると、その好奇心は「やめた」になる
- **振り返りの記録**: 会話やタスクの後に Clive が記憶を整理した記録。きっかけ（タスクが終わった・会話が途切れた・道具を多く使った・記憶が上限に近い・手動）、状態（待ち・実行中・済み・失敗）、Clive のまとめ、その振り返りで変えた記憶（足した・直した・消した）。取り消しは記憶の画面の変更履歴から
- SOUL.md の書き換えは、今は会話の中の承認カードで扱う（ここには出ない）

### 4.11 スキル（実装済み）

Clive の手順書（`data/workspace/skills/<名前>/SKILL.md`）。名前と説明は会話のはじめに Clive に渡り、本文は Clive が必要なときに読む。

- 一覧: 名前・説明・使った回数・最後に使った日時
- 中身の表示と編集（ユーザーが書くものは承認なしでそのまま有効）、新しく書く、削除
- 名前は英小文字・数字・ハイフン（63 文字まで）。説明は「いつ使うか」を 1 文で（300 文字まで）。本文は 20,000 文字まで

### 4.12 好奇心（実装済み）

Clive が気になっていること。自発行動がオンのとき、Clive が1日の上限（`worker.curiosityPerDay`）まで、古いものから自分で調べる。

- 一覧: 気になること・なぜ・状態（気になる・調べている・調べた・やめた）・誰が足したか・調べた結果・調べたタスクへの移動
- 足す（気になること・なぜ）
- 今すぐ調べてもらう（自発行動がオフでも動く）、やめる、また気にする
- 初回の起動時だけ、workspace の `CURIOSITY.md` の箇条書きを取り込む（以後はこの画面が正）

---

## 5. API 一覧

すべて同じ origin の `/api/...`。本文は JSON。書き込み（POST・PUT・PATCH・DELETE）には Origin ヘッダが必要（ブラウザの fetch なら自動で付く）。エラーは `{ error, message, ... }`。

### 会話とチャット（実装済み）

| メソッド・パス | 用途 | 主な返り値 |
|---|---|---|
| `GET /api/conversations` | 会話一覧 | `{ conversations: Conversation[] }` |
| `POST /api/conversations` | 新しい会話 | `{ conversation }` |
| `PATCH /api/conversations/:id` | 名前の変更・`{ archived: true }` で片付け | `{ conversation }` |
| `GET /api/conversations/:id/messages` | 発言と、実行中の返事・承認待ち | `{ conversation, messages: Message[], activeRun: { runId, draft } \| null, approvals: Approval[] }` |
| `POST /api/conversations/:id/messages` | 送信 `{ text, attachments?: string[] }`（attachments は添付の ID。添付があれば text は空でもよい） | 202 `{ runId }`／409 使えるモデルが無い（`errorKind`・`errorMessage`・`detail.hint`・`problems[]`）／409 返事を作っている最中／409 `no_vision` 画像を読めるモデルが無い／400 添付が見つからない |
| `POST /api/uploads?name=<ファイル名>` | 添付する。本文はファイルそのもの（`Content-Type` はファイルの種類） | 201 `{ upload: { id, name, mime, kind: 'text' \| 'pdf' \| 'image', size, chars, pages } }`／413 大きすぎる／415 読めない種類（`message` に理由） |
| `POST /api/conversations/:id/retry` | 失敗した発言をもう一度 | 202 `{ runId }` |
| `POST /api/runs/:id/stop` | 返事を止める | `{ stopped }` |
| `GET /api/runs/active` | 書きかけの返事（再読み込みのとき） | `{ drafts }` |
| `GET /api/runs?limit=` | 実行ログ | `{ runs: RunRow[] }` |
| `GET /api/tool-calls?limit=` | 道具の実行の記録 | `{ toolCalls }` |

### 承認（実装済み）

| メソッド・パス | 用途 |
|---|---|
| `GET /api/approvals` | 承認待ちの一覧 `{ approvals: Approval[] }` |
| `POST /api/approvals/:id` | 決める `{ decision: "once" \| "conversation" \| "deny" }`（404 なら時間切れ・中止済み） |

### 記憶と履歴（実装済み）

| メソッド・パス | 用途 |
|---|---|
| `GET /api/memories` | `{ books: { user: { used, max, items: MemoryItem[] }, notes: {...} } }` |
| `POST /api/memories` | 追加 `{ book, content }`（上限超え・重複・秘密情報は 400 と理由） |
| `PATCH /api/memories/:id` | 編集 `{ content }` |
| `DELETE /api/memories/:id` | 削除（返り値に `eventId`。取り消しに使う） |
| `GET /api/memories/:id/events` | 変更履歴 `{ events: MemoryEvent[] }` |
| `POST /api/memory-events/:id/undo` | 変更を取り消す |
| `GET /api/history?q=&days=` | 過去の会話の検索 `{ hits: HistoryHit[] }` |

### タスク・ワーカー・通知（実装済み）

| メソッド・パス | 用途 |
|---|---|
| `GET /api/tasks` | `{ active: Task[], finished: Task[] }` |
| `POST /api/tasks` | 作成 `{ title, body?, priority?, when?: ISO日時, repeat?: { freq, values } }`（freq は daily / weekday / weekly / hourly / interval。values は `{ time: "09:00", day: "月", minute: "0", interval: "30" }` のうち必要なもの） |
| `GET /api/tasks/:id` | `{ task, events: TaskEvent[]（新しい順）, approvals: Approval[]（このタスクの承認待ち）, runs: Task[]（繰り返しのとき、そこから作った実行） }` |
| `PATCH /api/tasks/:id` | 編集 `{ title?, body?, nextAction?, priority?, when? }`（`when: null` で開始日時を消す） |
| `POST /api/tasks/:id/answer` | 返事待ちに答える `{ text }` |
| `POST /api/tasks/:id/run-now` | 今すぐ実行（自発行動がオフでも、1時間の上限に達していても動く。繰り返しなら実行用のタスクを作って返す。終わったものはやり直す） |
| `POST /api/tasks/:id/approve` | 提案を承認 |
| `POST /api/tasks/:id/cancel` | 取り消す |
| `POST /api/tasks/:id/done` | 完了にする |
| `GET /api/worker` | `{ enabled, autonomy, paused, quiet, running: { kind: 'task' \| 'review', taskId: string \| null, runId, title } \| null, nextWakeAt, runsLastHour, maxRunsPerHour }`（kind が review のときは振り返りを実行中） |
| `POST /api/worker` | `{ paused?: boolean, autonomy?: boolean }` |
| `GET /api/notifications` | `{ notifications: Notification[], unread }` |
| `POST /api/notifications/read` | 既読にする `{ ids?: number[] }`（省略ですべて） |

### レビュー・スキル・好奇心・振り返り（実装済み）

| API | 内容 |
|---|---|
| `GET /api/review` | `{ skillDrafts: SkillDraft[], taskProposals: Task[] }` |
| `POST /api/skill-drafts/:id/approve` | 下書きを承認して有効にする → `{ skill }` |
| `POST /api/skill-drafts/:id/reject` | 却下 |
| `GET /api/skills` | `{ skills: Skill[]（本文なし）, dir }` |
| `GET /api/skills/:name` | `{ skill }`（本文あり） |
| `PUT /api/skills/:name` | 書く・直す `{ description, body }`（不正なら 400） |
| `DELETE /api/skills/:name` | 削除 |
| `GET /api/curiosity` | `{ items: CuriosityItem[] }`（`?all=1` で調べた・やめたものも） |
| `POST /api/curiosity` | 足す `{ topic, why? }`（同じものがあれば 400） |
| `PATCH /api/curiosity/:id` | 変える `{ topic?, why?, status?, result? }` |
| `POST /api/curiosity/:id/task` | 今すぐ調べてもらう → `{ task }` |
| `GET /api/reviews` | `{ jobs: ReviewJob[], pending }` |
| `POST /api/reviews` | この会話を振り返ってもらう `{ conversationId }`（同じ発言までで既に積んでいれば `{ queued: false }`） |

### Clive の見た目（実装済み）

| メソッド・パス | 用途 |
|---|---|
| `GET /api/profile` | `{ name, shape, color, motion, shapes: string[], motions: string[] }`（shapes と motions は選べる値の一覧） |
| `PATCH /api/profile` | 変更 `{ name?, shape?, color?, motion? }`（shape は 4.8 の20種類、color は `#RRGGBB`、motion は auto / none / float / sway / pulse） |

「作業中・待っている・休眠」などの様子はサーバーからは送らない。画面が SSE のイベントと `GET /api/worker` から決める（返事を作っている → 作業中、承認待ちや返事待ちのタスクがある → 待っている、ワーカーが一時停止中か、自発行動がオンで静かな時間帯 → 休眠、`task.changed` で完了になった → お祝い）。

### 設定とモデル（実装済み）

| メソッド・パス | 用途 |
|---|---|
| `GET /api/settings` | `{ config, apiKeys: { [環境変数名]: boolean }, configError, restartRequired, configPath }` |
| `GET /api/settings/schema` | 設定の JSON Schema（各項目に `description` と `default`） |
| `PUT /api/settings` | 保存 `{ config }`（不正なら 400 `{ problems: ["/server/port: ...", "routing.chat: ..."] }`） |
| `GET /api/models` | `{ routing, models: ModelView[] }`（各モデルに `probe`、続けて失敗しているときは `cooldown: { until, reason }` と `recentFailures`） |
| `POST /api/models/probe` | 確認し直す |
| `GET /api/health` | `{ ok, bootId, activeRuns, configError, restartRequired }` |

## 6. SSE イベント（`GET /api/events`）

| event 名 | 中身 |
|---|---|
| `hello` | `{ bootId, lastSeq, drafts }`。bootId が前と違えば、サーバーが再起動したので状態を取り直す |
| `resync` | 取りこぼしが多すぎるので、状態を取り直す |
| `run` | 下の `RunEvent`（`id:` に通し番号。再接続のときはブラウザが Last-Event-ID で続きから受け取る） |

`RunEvent` の `type`:

| type | 意味 | 主な中身 |
|---|---|---|
| `run.start` | 返事を作り始めた | `runId, conversationId, modelId` |
| `text.delta` | 返事の続きの文字 | `text` |
| `model.switch` | 別のモデルに切り替えた | `from, to, reason` |
| `warning` | 注意書き | `code`（retrying / context_trimmed / compacted / compaction_failed / partial_discarded / server_truncation_suspected / max_iterations など）, `message` |
| `tool.call` | 道具を呼んだ | `callId, name, input` |
| `tool.result` | 道具の結果 | `callId, name, ok, decision（allow / ask / deny）, preview` |
| `approval.requested` | 承認が必要 | `approval: { id, tool, title, body, cwd, reasons, details, expiresAt }` |
| `approval.resolved` | 承認が決まった・時間切れ | `approvalId, outcome` |
| `memory.changed` | 記憶が変わった | `memoryId, book, action（create / update / forget）, content, eventId` |
| `compaction` | 古い発言を要約した | `summarized` |
| `message.saved` | 発言が保存された（履歴を読み直す合図） | `messageId, role` |
| `run.end` | 終わった | `ok, errorKind, errorMessage, detail: { reason, hint, measured, required }` |
| `task.changed` | タスクが変わった | `task` |
| `notification` | 通知が来た | `notification` |

## 7. 主なデータの形

```ts
interface Message {
  id: number; role: 'user' | 'assistant' | 'tool'; text: string; createdAt: number;
  attachments?: { id: string; name: string; kind: 'text' | 'pdf' | 'image' }[];   // user のとき（text には添付の中身を含めない）
  toolCalls?: { id: string; name: string; input: string }[];   // assistant が道具を呼んだとき
  toolName?: string; isError?: boolean;                          // role: 'tool' のとき
}

interface Approval {
  id: string; conversationId: string; tool: string; title: string;
  body: string;            // そのままの文字で見せる（Markdown として描画しない）
  cwd?: string; reasons: string[]; details: string[]; expiresAt: number;
}

interface MemoryItem { id: number; book: 'user' | 'notes'; content: string; origin: 'chat' | 'user' | 'review'; source_conversation_id: string | null; created_at: number; updated_at: number }

interface Task {
  id: string; title: string; body: string; next_action: string | null; done_criteria: string | null;
  status: 'inbox' | 'ready' | 'running' | 'waiting' | 'scheduled' | 'done' | 'failed' | 'cancelled';
  origin: 'user' | 'self' | 'curiosity' | 'schedule'; priority: 1 | 2 | 3;
  cron: string | null; cron_text: string | null;   // cron_text は「平日 09:00」のような説明
  run_at: number | null; parent_id: string | null;   // parent_id は、繰り返しから作った実行のときの元
  waiting_text: string | null;
  conversation_id: string | null; result_summary: string | null; attempts: number; max_attempts: number;
  created_at: number; updated_at: number; completed_at: number | null;
}

interface TaskEvent {   // タスクの経過
  id: number;
  kind: 'created' | 'note' | 'run' | 'requeued' | 'question' | 'approval' | 'answer' | 'approved' | 'reopened' | 'edited' | 'skipped' | 'context' | 'done' | 'failed' | 'cancelled';
  actor: 'user' | 'clive' | 'worker' | 'system' | 'schedule';
  content: string | null; run_id: string | null; created_at: number;
}

interface Notification { id: number; kind: 'task_done' | 'task_waiting' | 'task_failed' | 'approval_needed' | 'health_alert' | 'info'; title: string; body: string | null; link: string | null; read_at: number | null; created_at: number }

interface Profile { name: string; shape: string; color: string; motion: 'auto' | 'none' | 'float' | 'sway' | 'pulse' }

interface Skill { name: string; description: string; body?: string; uses: number; lastUsedAt: number | null; updatedAt: number }

interface SkillDraft {
  id: number; name: string; description: string; body: string; reason: string | null; status: 'pending' | 'approved' | 'rejected'; created_at: number;
  current: { description: string; body: string } | null;   // 既にあるスキルを直す下書きなら、いまの内容
}

interface CuriosityItem {
  id: number; topic: string; why: string | null; status: 'open' | 'researching' | 'done' | 'dropped';
  result: string | null; task_id: string | null; source: 'clive' | 'user' | 'file'; created_at: number; updated_at: number;
}

interface ReviewJob {
  id: number; trigger: 'task' | 'idle' | 'heavy_run' | 'book_full' | 'manual'; triggerLabel: string;
  status: 'pending' | 'running' | 'done' | 'failed'; note: string | null;   // note は Clive のまとめ、または失敗の理由
  conversation_id: string | null; task_id: string | null; run_id: string | null; created_at: number; finished_at: number | null;
  changes: MemoryEvent[];   // この振り返りで変えた記憶
}

interface MemoryEvent { id: number; memory_id: number; action: 'create' | 'update' | 'forget' | 'restore'; before: string | null; after: string | null; actor: 'clive' | 'user' | 'review'; reason: string | null; undone_at: number | null; created_at: number }

interface Probe {   // モデルのコンテキスト長の確認結果
  status: 'ok' | 'too_small' | 'exceeds_model' | 'unknown' | 'unreachable' | 'no_api_key' | 'not_found' | 'error';
  effective?: number; required: number; declared?: number; measured?: number; modelMax?: number;
  message: string; hint?: string;
}
```

時刻はすべてミリ秒（UTC）。表示は設定の `timezone`（既定 Asia/Tokyo）で。
