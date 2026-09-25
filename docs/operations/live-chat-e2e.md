# 実Chat経路のE2E評価

Plan 018 Step 3D / Issue #771の任意実行評価。Nextの実Auth.jsログイン、private Chat route、実Mastra workflow、
Geminiの分類・query展開・回答生成、実embedding、PostgreSQL検索、画面表示、履歴保存を接続する。
通常CIの模擬Mastra・API mockを使うテストとは分離し、外部API料金が発生するため通常`pnpm test:e2e`では実行しない。
ユーザー指定により大規模負荷検証はスキップする。

## 対象と判定

- `scripts/lib/live-chat-corpus.ts`の合成資料6件と、別projectの機密検出用合成資料1件を使う。
- 数字、カタカナtypo、literal percent、時系列の4質問は必要な資料・事実を実行前に固定する。
- ブラウザから質問し、実streamのcloneを観測する。HTTP 200、回答成功、reasoning進捗、必須source / fact、
  hybrid-search、別project情報の不在、Sources表示、再読込後に履歴を開いた本文を検証する。
- 未ログイン401、非memberの実在projectへの403、空projectでsource 0・合成コードの捏造なしを確認する。
- 専用Mastra停止時のエラー表示と、失敗回答が履歴へ保存されないことを別実行で確認する。
- 生成文は非決定的。回答中の引用表現、内部診断の混入、source overlapも保存した結果から確認する。
  fact一致とSources表示だけで、回答文の引用品質や全Chat機能の合格とは判定しない。

## 再現手順

専用Docker DBとportを使う。既存の開発DB・本番DBには接続しない。以下は他プロセスが使用していない場合の例。

```bash
docker run --rm -d --name pufu-live-chat-eval \
  -p 127.0.0.1:5771:5432 -e POSTGRES_USER=pufu_lens \
  -e POSTGRES_DB=chat_e2e_eval -e POSTGRES_HOST_AUTH_METHOD=trust \
  pufu-lens-postgres:latest

# pg_isreadyが成功してから実行する
sed 's/ALTER DATABASE pufu_lens /ALTER DATABASE chat_e2e_eval /' infra/docker/postgres/init.sql \
  | docker exec -i pufu-live-chat-eval psql -v ON_ERROR_STOP=1 -U pufu_lens -d chat_e2e_eval

DATABASE_URL=postgres://pufu_lens@127.0.0.1:5771/chat_e2e_eval pnpm test:e2e:seed-chat
pnpm --filter @pufu-lens/ingestion... build
```

リポジトリ外の権限0600の環境ファイルを用意し、`LIVE_CHAT_ENV_FILE`にそのパスを設定する。
キーの値はログ・PR・レポートに含めない。必要な設定は次のとおり。

```dotenv
DATABASE_URL=postgres://pufu_lens@127.0.0.1:5771/chat_e2e_eval
GEMINI_API_KEY=<authorized-key>
GOOGLE_API_KEY=<same-key>
GOOGLE_GENERATIVE_AI_API_KEY=<same-key>
PUFU_LENS_EMBEDDING_PROVIDER=gemini
PUFU_LENS_GRAPH_TRANSITION_MODE=relational-only
STORAGE_DRIVER=local
STORAGE_ROOT=/tmp/pufu-live-chat-storage
```

```bash
node --env-file="$LIVE_CHAT_ENV_FILE" --experimental-strip-types scripts/seed-live-chat-e2e.ts
NODE_OPTIONS=--experimental-strip-types pnpm --filter @pufu-lens/mastra mastra:build

# 別ターミナルで起動。両providerで同じbuildとDBを使用する
PORT=4771 NODE_ENV=production PUFU_LENS_KEYWORD_TRANSITION_MODE=pgroonga-primary \
  node --env-file="$LIVE_CHAT_ENV_FILE" apps/mastra/.mastra/output/index.mjs

# 別ターミナルでWeb起動。実LLMキーはWeb側へ渡さない
DATABASE_URL=postgres://pufu_lens@127.0.0.1:5771/chat_e2e_eval \
  AUTH_URL=http://localhost:3771 MASTRA_SERVER_URL=http://127.0.0.1:4771 \
  STORAGE_DRIVER=local STORAGE_ROOT=/tmp/pufu-live-chat-storage \
  PUFU_LENS_GRAPH_TRANSITION_MODE=relational-only \
  pnpm --filter @pufu-lens/web exec next dev -p 3771

PUFU_LENS_LIVE_CHAT_MODE=pgroonga-primary \
  PUFU_LENS_LIVE_CHAT_REPORT=/tmp/live-chat-pgroonga.json \
  pnpm --filter @pufu-lens/web exec playwright test --config playwright.live-chat.config.ts chat.spec.ts
```

Mastraだけを停止し、同じ起動commandの`PUFU_LENS_KEYWORD_TRANSITION_MODE`を`portable-primary`へ変更する。
test側のmodeとreport出力先も変更して再実行する。testのmodeは記録用で、serverの方式を切り替えない。
portableのサーバーログで`keyword_transition_observation`を確認し、PGroongaへのfallbackによる成功を除外する。

最後に専用Mastraを停止したまま次を実行する。

```bash
PUFU_LENS_LIVE_CHAT_FAILURE_CHECK=true \
  PUFU_LENS_LIVE_CHAT_REPORT=/tmp/live-chat-failure.json \
  pnpm --filter @pufu-lens/web exec playwright test --config playwright.live-chat.config.ts failure.spec.ts
```

テスト終了後は専用サーバー・コンテナを停止し、APIキー入り一時ファイルを削除する。
Playwright traceにはローカルsession cookieも入り得るため、生traceをGitへ追加しない。
JSON reporterの`live-chat-evidence` attachmentには合成回答・progress・sourceを保存する。
再実行時のseedは文書が存在すると停止するため、使い捨てDBを作り直す。

## 範囲の限界

この評価はprivate Chatの全workflowを通す代表ケースである。public report Chat、実raw / parsedファイル読込、
非空Graphの関係網、全質問分布、実ユーザーの履歴文脈、本番の認証・ネットワーク構成の網羅を意味しない。
大規模負荷はユーザー指定で未実施。production shadow観測・restore・本番primary切替は別工程とする。

## 実測（2026-09-25）

runtime commit `681dab1`、Chat `google/gemini-2.5-flash`、embedding `gemini-embedding-2` / 1536次元。
証跡は`fixtures/chat/live-chat-e2e-v1.json`。合成回答とsource title / URIを保存し、cookie・APIキー・実データは保存しない。
PGroonga / portableそれぞれ7/7、Mastra停止時1/1が成功した。空projectも両方式でsource 0・根拠の捏造なし。
必須の5資料（4質問）と回答事実を両方式で確認し、各回答の表示と履歴再表示が成功した。

| 質問            | 最終source overlap | 必須資料・事実   | 回答本文の明示的引用                    |
| --------------- | ------------------ | ---------------- | --------------------------------------- |
| 数字            | 1.0                | 両方式で保持     | 両方式であり                            |
| 日本語typo      | 1.0                | 両方式で保持     | portable本文では欠落、Sources欄にはあり |
| literal percent | 0.5                | 両方式で保持     | 両方式であり                            |
| 時系列          | 1.0                | 両方式で保持     | 両方式であり                            |
| 空project       | 1.0                | 両方式でsource 0 | 対象外                                  |

overlapは共通source数 / 両方式のsource数の大きい方。literal percentはPGroongaが無関係なガラス資料も採用し、
portableは必要な1資料のみとなった差である。改善方向でも既存0.80条件を免除せず、比較gateは未達を維持する。
PGroongaの時系列回答に質問と無関係なGitHub lifecycle診断が混入し、初回試行の数字質問ではgraph診断の混入も確認した。
portableの日本語typo回答では本文内の引用が省かれた。
[Issue #772](https://github.com/dyson-yamashita/pufu-lens/issues/772)で回答表現の課題として管理する。
**機能テスト成功と、全品質gate合格を区別し、後者は未達とする。**

portable keywordは59回すべてsuccess / fallbackなし。ただし候補が非空なのは1回だけで、実質問・展開語の多くでは
意味検索が資料取得を補っている。4質問の回答成功をkeyword単独の網羅的品質証明にはしない。
非空のGraph関係は投入しておらず、graph-queryは0件、時系列ケースのtimeline-searchも0件で、必要な日付資料は
hybrid側から取得した。Graph / timeline固有の取得品質は残る。

`mastra dev`ではworkspace共有chunkのエラーが出たため、`mastra:build`後の実serverを使用した。
初回のPlaywright stream本文読込エラーと履歴プレビュー長によるassert不備を修正後、上記15テストを実行した。
LLM出力は再実行で変化するため、これは固定質問の1回ずつの観測であり、再現性や本番品質の保証ではない。
