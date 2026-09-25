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
- Issue #772以降は回答本文の必須資料名・URI、実際のリンク要素のhref、内部診断表現の不在も検証する。
  時系列の「方式B」は同じ意味の「方式がAからBへ」という表記も受け入れ、元の事実要件は維持する。
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

v1 / v2の評価はprivate Chatの全workflowを通す代表ケースである。public Chatは次節のIssue #775で別途検証する。実raw / parsedファイル読込、
非空Graphの関係網、全質問分布、実ユーザーの履歴文脈、本番の認証・ネットワーク構成の網羅を意味しない。
大規模負荷はユーザー指定で未実施。production shadow観測・restore・本番primary切替は別工程とする。

## Public Chatの実経路（Issue #775）

public project Chatは公開レポートを入口の条件にし、privateと同じ実検索workflowで回答を生成する。
別の使い捨てDBで上記seedを実行するとき、環境ファイルへ`PUFU_LENS_LIVE_CHAT_PUBLIC=true`を追加する。
`STORAGE_DRIVER=local`と明示的な`STORAGE_ROOT`が必須。seedは`local-dev`と空projectだけを公開扱いにし、
合成資料6件を参照する公開レポート1件と未公開レポート1件を追加する。公開処理とmanifest生成は既存実装を使うが、
保存先はローカルのみで外部への公開は行わない。既存文書があるDBへの再seedは拒否する。

Web / Mastraを起動後、各providerで次を実行する。

```bash
PUFU_LENS_LIVE_CHAT_MODE=pgroonga-primary \
  PUFU_LENS_LIVE_CHAT_REPORT=/tmp/live-public-chat-pgroonga.json \
  pnpm --filter @pufu-lens/web exec playwright test --config playwright.live-chat.config.ts public-chat.spec.ts
```

未ログインのブラウザから4質問を送信し、実stream・事実・Sources表示・公開参照ID・内部IDフィールド不在・
他projectの合成機密コード不在を検証する。report指定JSON API、private project / 未公開report / project不一致の404、
公開reportなしの`no_public_report`、公開レポートの実artifact表示も確認する。
public Chatは履歴を保存する契約ではなく、privateの履歴再表示テストをpublicには適用しない。
公開レポート生成のLLM、PDF、公開取り消し、rate limit、同一project内の非Web資料を含む全データ種別はこのfixtureの対象外。
今回の合成資料はWeb資料のみで、公開レスポンス全般の機密保護を網羅的に証明するものではない。

### 実測（2026-09-25）

runtime `fabab63`、Chat `google/gemini-2.5-flash`、embedding `gemini-embedding-2` / 1536次元。
PGroongaは7件に公開artifact表示1件を追加実行して計8/8、portableは8/8成功した。
各providerで実LLMは4つのstream質問とreport指定JSON質問1件の計5回。必要な事実・公開source ID・画面表示を保持し、
内部IDフィールド・他projectの合成機密コード・内部診断の混入は観測しなかった。公開source集合のoverlapは全5回答で1.0。
portable keywordは63回success、fallback 0、候補非空2回であり、意味検索による補完を含む結果である。

証跡は`fixtures/chat/live-public-chat-e2e-v1.json`。合成回答・公開source・tool件数・進捗・各テストの結果とseedのSHA-256を保存した。
初回seedのreport期間metadata不足を補修し、合成データを入れ直してから実行した。runtime変更や期待値の緩和は行っていない。
各質問は単回観測であり、未確認範囲と従来の比較gateは維持する。専用プロセス・DBは停止し、APIキー入り一時ファイルは削除済み。

## 実測（2026-09-25）

以下はIssue #771のprivate Chat初回実測である。

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

## 回答表現の補修（Issue #772）

graph coverageの件数・除外理由を回答生成用contextから外し、workflow stateの診断は保持した。
GitHub資料が選定された場合だけlifecycle説明の指示を加える。Agentには内部診断を本文へ転記せず、
実際に根拠として使った資料を`[title](canonicalUri)`で引用するよう指示する。URIがない資料だけ資料名で示す。
検索順位、threshold、source選定、固定corpusの期待値は変更しない。

途中試行で時系列回答の同義表記を誤って不合格にしたため、事実を変えず表記判定を補修した。
また、資料名だけの引用とrenderer未対応の脚注構文が発生したため、指示を明確化し、本文文字列だけでなく
画面のリンク要素とhrefも検証するようにした。

最終版ではPGroonga / portable各7/7成功。4質問の必要な事実・資料名・本文リンクと履歴再表示を確認し、
内部診断混入は0件だった。source overlapは全ケース1.0。ただし検索実装は変更しておらず、
旧v1の0.5という観測や既存hybrid比較の未達を今回の単回観測で免除しない。
portableのkeyword観測58回はすべてsuccess / fallback 0、候補非空は1回で、意味検索による補完は継続している。

証跡は`fixtures/chat/live-chat-e2e-v2.json`。base commitと変更runtimeファイルのSHA-256、合成回答、
source、tool件数、進捗、検証結果を保存した。最終指示に変更後の各provider 1回ずつの結果であり、
同じ指示を成功まで再試行した結果ではない。旧v1は保持した。
portableの時系列回答では脚注記号が残ったが、資料名のMarkdownリンクは実画面で機能した。
引用の欠落は再観測しなかったものの、指示への完全な書式遵守や本番での再現性は保証しない。
障害時テストは回答表現に関係しないため今回再実行せず、v1の実測を参照する。
大規模負荷はスキップを維持し、public Chat・非空Graph・実raw / parsed・本番shadow・restore・primary切替は未実施。

## 非空Graphと原文・解析済みmetadata（Issue #777）

使い捨てDBのseed時に`PUFU_LENS_LIVE_CHAT_DETAILS=true`を指定し、`STORAGE_DRIVER=local`と
明示的な`STORAGE_ROOT`を設定する。既存の合成資料6件へ実raw HTML、schema検証済みparsed JSON、
GraphのRELATED_TO / SAME_AS / 共通Topic MENTIONSを追加する。関係はfixtureで定義した合成の接続であり、
関係抽出LLMの品質を測るものではない。原文だけに点検曜日と`SYNTH-RAW-GLASS-91`を置き、DBのsummary / chunkには入れない。

実認証後のprivate Chat JSON APIでraw / Graphを質問し、必要事実とtoolの非空取得、保存後の履歴表示を確認する。
`parsed-doc-fetch`はparsedファイル本文を読む契約ではなく、`parsed_uri`がある資料のDB metadataを取得する。
このtoolはローカルMastraの実HTTP execute APIからproject指定で呼び、6件の取得と他projectでの0件を確認する。
LLMが選択したtoolの検証と、toolを直接呼ぶ接続検証を区別する。

```bash
# IDは専用DBのprojectsから取得する。既存の開発DB・本番DBは使用しない。
PUFU_LENS_LIVE_CHAT_MODE=pgroonga-primary \
  PUFU_LENS_LIVE_CHAT_PROJECT_ID='<local-devのUUID>' \
  PUFU_LENS_LIVE_CHAT_FOREIGN_PROJECT_ID='<chat-e2e-foreignのUUID>' \
  PUFU_LENS_LIVE_CHAT_REPORT=/tmp/live-chat-details-pgroonga.json \
  pnpm --filter @pufu-lens/web exec playwright test --config playwright.live-chat.config.ts details.spec.ts
```

初回の通常質問とtool名を指定した質問では、LLMは`parsed-doc-fetch`を呼ばず検索結果から回答した。
この2回は専用tool利用の確認に失敗した観測として保存する。parsedの自動選択やparsed本文読込の成功には数えない。
初回回答では80%設定の識別コードを「保管庫識別番号」と呼ぶ誤った説明もあり、一般的な回答品質の合格とはしない。
今回の対象は非空Graphとrawの実Chat、およびparsed metadata toolの実接続である。

### 実測（2026-09-25、runtime `6ddede1`）

最終構成はPGroonga / portableそれぞれ3/3成功（実LLM Chat 2件 + Mastra tool直接接続1件）。
両方式でraw取得1件、各Chatのgraph取得2件を確認し、原文限定の点検曜日・コードと関連資料の通知先を回答・履歴で保持した。
GraphのDB直接読取でもRELATED_TO 1-hop / SAME_AS 1-hop / MENTIONS 2-hopとproject越境防止を確認した。
原文限定コードはDB summary / chunk内に0件であり、raw読込の成功を既存検索だけで代替していない。
parsedのHTTP取得は対象projectで6件、別projectで0件。parsed本文読込を確認したという意味ではない。

証跡は`fixtures/chat/live-chat-details-e2e-v1.json`。最終成功と、解析済みtoolを選ばなかった2回の探索結果を別に保存した。
portable keywordは24回success / fallback 0だが候補非空0回で、意味検索とGraphによる取得である。
初回seedのJSONB parameter指定を補修後にfixtureを入れ直し、parsed artifactを既存schemaで検証して最終確認した。
LLMは非決定的で、原文は小さいWeb HTMLのみ。全source種別・ページング・上限到達の品質は未検証。
大規模負荷スキップと既存品質gateは維持する。専用server / DBは停止し、APIキー入り一時ファイルは削除した。
