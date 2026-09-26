# Backend parityのローカル評価契約

## 到達点と開始条件

Plan 018 Step 7A / Issue #796は、共通synthetic fixtureと採点ライブラリのローカル準備である。
Step 6全完了、Step 7の実評価開始gate達成、GCP / Cloudflareの品質同等性を意味しない。
7B / Issue #798でkeywordのローカルrunnerを追加した。remote実行、実embedding生成、resource作成、本番変更は含まない。

Step 7B以降で、同一fixture・論理schema・ID mapping・embeddingを両backendへ投入する手順と、
Cloudflareのmetrics収集、absolute SLOを固定する。実GCP baseline、実embedding、CPU・請求・restore、
削除収束、全Chat品質は未確認。大規模負荷はユーザー指定でスキップする。
PGroonga primary / pgroonga-shadow、Graph relational-only、AGE / PGroonga資産保持、
既存Chat品質・本番shadow / restore・Step 4削除gateは変更しない。親Issue #704はclosedのまま、#779に依存しない。

## Fixtureと再利用

正本は `scripts/lib/parity-fixture.ts` の `parityFixture`。
`backend-parity-synthetic-v1` / schemaVersion 1を固定する。
既存 `scripts/lib/keyword-eval-corpus.ts` の全37 chunk / 36 document・22 queryとjudgmentを再利用し、
semantic / hybrid / Chat各3質問、Graph read 3種、mutation 5操作と9 edge type、expected failure 4種を追加する。
全52ケース。production由来の本文や個人情報は含まない。

`fixtures/chat/private-chat-eval.json` の必須 `hybrid-search` / `graph-query` / `document-fetch` と
project拒否の契約を採用する。既存のChat fixtureはsample project依存のため、そのまま入力にはしない。
keyword既存snapshotはmetadata・coverageが異なり、今回のGCP baselineとして流用しない。
採点式は既存 `rankMetrics` を再利用するが、既存keyword評価のbaseline省略時gateは引き継がない。

`chunks` のID・document ID・project IDをmapping hashで固定し、全fixtureをSHA-256で固定する。
document judgmentはgrade 1–3、`chunkJudgments` は同じdocumentに属するchunkへgradeを展開する。
複数chunkが同一documentを表す場合、document順位は最初に出たchunkで決め、重複を除く。
versionを維持したままhashが変わる変更は認めない（unit testでhashをpinする）。

semantic品質用embeddingはOpenAI `text-embedding-3-small` / 1536 / cosine / `mode: real` を
このfixtureの比較契約として選んだ。現在の本番embedding設定を変更するものではない。
実embedding APIを今回呼び出していない。別modelの評価はfixtureの新versionとして扱う。
Step 6の固定synthetic vectorはlifecycle動作試験用であり、このsemantic品質gateを通せない。
同じmodel名でも `mode: synthetic` のsnapshotは契約不一致となる。

Graph期待値は `[projectId, sourceNodeId, relation, targetNodeId, hop]` のcanonical tuple集合。
nodeはrelation `NODE`、source=target、hop=0で表現する。readはedge集合、mutationはnodeとedgeの
全snapshotを比較する。`graphInput` / `operation` が初期集合と操作を示す。SAME_ASを含め、
runnerはCoreのcanonical endpoint規約に正規化して渡す。nodeの所属は `graphNodes` とも照合し、
project IDだけの偽装で越境を隠せない。Actor mergeはaliasの統合・AUTHOREDの付替え・self-edge削除を期待する。
内部順序以外のhop・relation・重複・
余剰・欠損は不合格。backend固有のnode生成・操作呼出しへのmappingは7Bで実装する。

## Snapshot / report境界

`scripts/lib/parity-eval.ts` の `parseParityRun(unknown)` と `evaluateParity(candidate, baseline?)` は
ネットワーク・DB・ファイル書込みを行わない。戻り値を `JSON.stringify` できる。
入力契約の正本は同ファイルの `ParityRun` / `ParityRow`。

- metadata: run ID、40桁code commit、provider profile、region、fixture version / hash、
  schema version、mapping hash、embedding mode / model / dimensions / metric。
- rows: case ID、status / normalized error、順位付きchunk IDs、final document IDs、citation IDs、
  tool IDs、canonical Graph tuples、scope / mutation / rubricの明示観測、critical error件数。
- candidateはCloudflare、baselineはGCP。両者が固定契約に一致しなければ `contractPass: false`。
- 欠損caseは `measured: false`、baseline欠損は `comparisonComplete: false` として不合格。
  不正型・未知ID・重複ID・未記入観測fieldは例外で拒否し、成功reportを作らない。
  7Bで観測booleanに明示的なnull（未測定）を許容した。scope/mutation、Chatのrubricがnullならhard gateは不合格。
  false（観測した失敗）と未測定を区別する最小契約拡張であり、fixture/hash/閾値は変更しない。
- reportはmetadataとcase ID・分類・集計値・gateのみ。query / document本文、回答本文、raw error、
  secretを含めない。metadataはoperator用識別子だけを指定する。
- `qualityGate` は入力snapshotの品質・hard gateだけを表す。`step7Gate` は常に `not-evaluated`。
  remote evidence、absolute SLO、cost / budget判断は `pending` に明示する。

`scopePass` / `mutationPass` / `rubricPass` はrunnerが観測して記録するもので、単にHTTP成功から
推測してtrueにしない。採点ライブラリは観測の真偽を実環境へ照会できない。
unit testのoracle snapshotは採点器を検証する期待値であり、backend実測として保存・報告しない。

## 指標と閾値

query単位を同じ重みで平均する。Recallは取得したrelevant document数 / 全relevant document数、
MRRはK内の最初のrelevant rankの逆数、nDCGはgain `2^grade - 1` / `log2(rank + 1)` による
DCGを理想順位のDCGで割る。MRRもKで打ち切る。relevantなしはnullで平均対象外とし、
keywordの空・拒否・隔離ケースは空結果をhard gateで確認する。
overlapはTop-K unique集合の共通要素数 / 両集合の大きい方の要素数。空/空はnullで、品質の証拠にしない。

| 対象                     | 固定条件                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| Semantic                 | Recall@10 ≥ 0.95、nDCG@10 / MRR@10のGCP差 ≥ -0.05、Top-10 overlap ≥ 0.80                         |
| Keyword                  | category Recall@20 ≥ 0.90、全体 ≥ 0.95、MRR@20差 ≥ -0.05、必須exact sourceをTop-20内に全件取得   |
| Hybrid                   | RRF後Top-5 overlap ≥ 0.80、nDCG@10差 ≥ -0.05、final selectionの必須source欠落なし                |
| Chat                     | final source overlap ≥ 0.80、required source / citation / tool全件、rubric成功、critical error 0 |
| Graph / scope / mutation | 両backendの期待集合・scope・操作観測が100%一致。1件でも違反すれば不合格                          |

Chatのcitation overlapもreportするが、planにない追加の数値閾値は設けずrequired citationをhard gateにする。
providerのraw scoreや自然言語回答の完全一致は比較しない。全hard gateはcandidateだけでなくbaselineにも適用する。
expected failureは正規化errorの完全一致と、候補・source・citation・Graphが空であることを要求する。

## ローカル検証

```bash
pnpm --filter @pufu-lens/graph... build
node --experimental-strip-types --test scripts/lib/parity-eval.test.ts
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

手計算可能なgraded ranking、K境界、overlap 0.80、空集合、欠損baseline、契約不一致、
synthetic embedding、両側の越境、必須source / citation / tool欠落、Graph hop / relation / 重複、
異常入力、意図的な順位劣化を検証する。UI変更がないためWeb E2E試験は対象外。

## 7B ローカルrunner

```bash
pnpm --filter @pufu-lens/ingestion... build
pnpm --filter @pufu-lens/retrieval build
pnpm --filter @pufu-lens/workers-spike parity:local
# PGroonga導入済みの専用loopback DB keyword_evalがある場合のみ両側を収集する。
KEYWORD_EVAL_DATABASE_URL=postgres://postgres@127.0.0.1:55438/keyword_eval \
  pnpm --filter @pufu-lens/workers-spike parity:local
```

出力は `packages/workers-spike/dist/parity-local/{gcp,cloudflare,report}.json` と `summary.md`。
コマンド末尾のdirectory引数で保存先を変更できる。process成功は収集成功を示し、採用可否はJSONのgateで確認する。
毎回共通fixtureから収集し、過去のkeyword baseline JSONを実測として読み込まない。
GCP profileは**GCP相当のローカルPGroonga**であり、GCP環境での実測ではない（region=local）。
既存 `collectPgroongaBaseline` の本番ranking policyを再現する隔離schema/transactionを再利用する。
専用DB以外・remote URLを拒否し、DATABASE_URLやクラウドcredentialsは読まない。既存schemaとの衝突時は失敗する。
D1は既存keyword-workerとadapterを使い、Miniflareの実workerd/D1を毎回作成・破棄する。outbound通信は禁止する。
PGroonga URL未指定はGCP全52件欠損、指定したDBに接続できない場合はコマンド失敗とし、黙って欠損へ置き換えない。

| 能力                    | 7Bローカル到達点                                         | 残件                                                 |
| ----------------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| keyword                 | 両backend全22 queryを入力し順位・拒否・scopeを実測       | GCP remote baseline、remote性能                      |
| scope                   | 返却chunk IDのproject所属とD1のdocument provenanceを確認 | HTTP認可・cross-project write全経路                  |
| mutation / Graph        | snapshot行を生成せず欠損                                 | 共通fixtureの操作mapping、全snapshot照合             |
| semantic / hybrid       | snapshot行を生成せず欠損                                 | 共通実embedding・pgvector / Vectorize・実selection   |
| Chat / expected failure | snapshot行を生成せず欠損                                 | 実Chat tool/source/citation/rubric・fault injection  |
| latency                 | keyword各queryのローカルmsを記録                         | 同一remote workload、warmup/repetition統一、CPU/請求 |

`localEvidence` にcodeDirty（未コミット変更の有無）、能力欠損case ID・理由、未測定観測、latency、remoteMetrics=nullを付ける。
keywordのmutationPass/rubricPassはnull。scopePassは返却ID集合の所属確認であり、認可全体の成功を意味しない。
fixture/schema/mapping hashは7Aから維持する。embedding metadataはsynthetic/not-executedで意図的に契約不一致とする。
synthetic vector自体もこのrunnerでは生成しない。既存のStep 6 composition / Vectorize fakeは別fixture専用のため、
その成功を7Aのsemantic/hybrid/Chat行へ流用しない。既存keyword/chat eval資産も期待値と実測を分離する。

2026-09-26、Issue #798: ローカルDocker PostgreSQL/PGroongaと実D1/workerdで各22件を収集。
各30件欠損、comparisonComplete=false / contractPass=false / qualityGate=false、step7Gate=not-evaluatedを確認した。
今回の結果でStep 6全完了・7B全能力完成・7C実評価開始を宣言しない。

## Remote evaluation workflow（準備のみ・実行不可）

現行CLIにはremote modeを設けない。以下は後続Issueで実装・承認する実行契約であり、
GitHub Actionsの自動remote jobやresource作成を今回追加しない。PR/CIではローカル試験だけを実行する。

1. 7Bの残り能力mappingを完成させ、Step 6次Step gateを再確認する。欠損があれば7Cを開始しない。
2. 専用stagingのGCP project/region/DB/schema、Cloudflare account/Worker/D1/Vectorize名・ID、
   resource TTLとcleanup責任者をmanifestへ固定する。本番resourceと実OAuth/本文は対象外。
3. fixture/schema/mapping hash、code commitとclean checkout、両provider region/profile、
   `text-embedding-3-small/1536/cosine/real`、embedding artifact hashをpinする。
   同じ37 chunkと3つの質問のembeddingを両backendで共有し、生成回数・tokens・費用を記録する。
4. approval Issue、budget owner、上限USD、期限、最大request/retry数、対象resource ID、
   `allowRemote=true` の明示opt-inを承認manifestに必須とする。未指定・期限切れ・対象不一致なら停止する。
   secretは実行環境からのみ渡し、snapshot/logへ記録しない。承認はresource作成/API課金/cleanup範囲ごとに明記する。
5. 同一fixtureを投入し、index visibilityをpollする。上限時間/回数到達はstale_readとして記録する。
   fault injectionは専用stagingのみ。成功するまで無制限にretryしたり、失敗試行を削除したりしない。
6. 非負荷の固定52ケースをwarmup 1回、測定5回（各run保存）で実行する案を承認時に固定する。
   query/ingestion/visibility/Chatの各latency、エラー率、approximate順位変動を分離する。
   大規模負荷はユーザー指定でスキップし、この小規模反復から負荷耐性を推定しない。
7. snapshotとreport、metrics取得時刻・集計window・単位・resource ID・取得元を保存する。
   query/本文・raw error・secretは保存しない。未取得metricsはnull、推計はestimatedと明示する。
8. 成功/失敗にかかわらず承認済みcleanupを実行し、不在確認を連続観測する。503を不在成功と数えない。
   evidenceと請求確認に必要な識別子を保持し、restore結果・残差・採用判断は7C/7Dへ渡す。

### Remote metrics / SLO / 費用の承認対象

実行前manifestには数値のabsolute SLOが必須。提案値はkeyword/semantic/hybrid/Graph p95各2,000ms、
Chat p95 60,000ms、write acknowledgement p95 5,000ms、index/delete visibility上限120,000msとする。
これは**未承認の案**であり、既存閾値や本番SLOを変更しない。budget ownerと運用担当が実行前に値を承認・pinする。
GCP replacementのbaseline p95 +25%条件は維持する。local timingはremote SLO合否へ使わない。

必須metricsはD1 rows read/written・storage、Vectorize stored/queried dimensions・query件数、
Workers request/CPU/error、Queue delivery/retry/dead-letter、Workflow実行/step、
GCP DB CPU/接続/IO/storage/VM時間、embedding/LLM tokens/回数、各resourceの実請求と取得window。
未使用Queue/Workflowはnot-usedと根拠を記録し、未取得を0にしない。月間想定workloadと単価取得日を添えて
推定費用と実請求を分離し、上限USDを承認するまではremoteを開始しない。

将来承認する具体的な影響は、専用staging resourceの一時作成、合成37 chunk/36 documentの保存、
実embedding/LLM呼出し、上記の固定反復とmetrics取得、期限内cleanupである。
現時点で対象resource ID・budget・SLOの承認は未取得であり、実行可能なremote環境は作成していない。
Step 6の105 request成功は限定synthetic lifecycleのみ。CPU・実請求・restore・全semantic品質・GCP parity、
削除不在成功間の503による連続成功/恒久削除収束の未証明を維持する。
