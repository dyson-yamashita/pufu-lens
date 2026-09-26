# Backend parityのローカル評価契約

## 到達点と開始条件

Plan 018 Step 7A / Issue #796は、共通synthetic fixtureと採点ライブラリのローカル準備である。
Step 6全完了、Step 7の実評価開始gate達成、GCP / Cloudflareの品質同等性を意味しない。
7B / Issue #798でkeyword、Issue #800でGraph、Issue #802でsemantic/hybrid、Issue #804でChat/failureの限定ローカル証拠を追加した。
remote実行、実embedding生成、cloud resource作成、本番変更は含まない。
Issue #806でChat文書取得を実DBへ置換し、独立Graph接続fixtureを既存relating/coverageへ接続した。

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
余剰・欠損は不合格。Issue #800でbackend固有のnode生成・操作呼出しへのmappingをローカル実装した。

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

### 保存済みembedding artifact（Issue #810）

`parity:local [output-directory] --embedding-artifact /absolute/path/input.json` で、
同じ保存済みvectorをPostgreSQLとD1の既存collectorへ渡せる。DB URLの制限は下記と同じ。
artifactは最初に一度だけ読み、全検証完了後にDB処理を開始する。API生成やremote実行機能はない。
引数省略時は従来のsynthetic retrieval/Chat経路を維持する。

入力JSONの正本は `scripts/lib/parity-embedding-artifact.ts`。
rootには次のfieldだけを必須とする。

- `version`: `parity-embedding-artifact-v1`
- `fixtureVersion` / `fixtureHash` / `schemaVersion` / `mappingHash`: 固定v1 fixtureの値
- `schemaHash`: 同moduleの `parityEmbeddingSchemaHash`（artifact入力構造のSHA-256）
- `embedding`: `model: text-embedding-3-small`, `dimensions: 1536`, `metric: cosine`,
  `mode: synthetic | real`。modeは提供者の自己申告。
- `chunks`: 全37件の `{id, documentId, projectId, textHash, values}`
- `queries`: 共通3質問の `{caseIds, projectId, textHash, values}`。
  `caseIds` は同じ質問を使うsemantic/hybridの2 IDをfixture順で含める。

`parityEmbeddingInputs()` が本文/質問を含まない正確なidentity一覧を返す。
`textHash` はfixtureの本文/質問そのもののUTF-8 SHA-256（正規化なし）。各配列の行順は任意。
未知field、hash不一致、ID/project/documentの不一致、余剰・欠損・重複を拒否する。
vectorは1536数値、有限、float32変換でoverflowせず非ゼロであることを必須とする。
不正値を補完したり、hash vectorへfallbackしたりしない。入力エラーに本文/vectorを含めない。

reportの `localEvidence.artifactRetrieval` にchecksum（読み込んだUTF-8 JSONのSHA-256）、
入力元 `saved-artifact`、固定契約hash、`declaredEmbedding`、両backendの観測IDを保存する。
ファイルpath・質問・本文・vectorは保存しない。checksumは入力同一性だけを示し、生成元の証明ではない。
`originVerified=false` / `semanticQualityMeasured=false` / `qualityGate=false` を維持する。
`mode: real` と申告されても、実embedding生成元の検証や品質合格へ昇格しない。
Cloudflare側のVectorizeは引き続きexact-cosine fake、GCP側もlocal pgvector/PGroongaである。
通常の品質snapshotへ6行を追加せず、各39/52行・13件欠損を維持する。

retrieval v1 artifactはChatの派生検索語用vectorを含まないため、入力時は `syntheticChat=null` として
Chatをskipする。`chatArtifactSupport` に未対応を明示し、synthetic fallbackを混在させない。
共通Node障害試験は独立証拠として継続する。Chat対応には下記の別契約を明示指定する。実embedding品質、remoteは未測定。
テスト専用 `syntheticEmbeddingArtifactFixture()` は本文hashから独立合成vectorを作り、
明示的にsyntheticと申告する。実embedding artifactは未提供であり生成APIは呼ばない。

### Chat保存artifactと入力manifest（Issue #812）

`parity:local --chat-embedding-manifest /absolute/path/manifest.json` はDB/APIを呼ばず、
生成用入力manifestを新規ファイルへ書く（既存ファイルは上書きしない）。これは合成fixtureの本文・検索語を
含む**入力専用**ファイルであり、本文を含めない評価reportとは分離する。
`scripts/lib/parity-chat-inputs.ts` の固定 `chat-fixed-preparing-v1` が、既存preparingとcoverageのhelperから
3質問＋独立controlled 2シナリオの全20入力（異なる本文6種）を列挙する。
primary、条件付きsimplified retry、coverageのcase/project/phase/text/textHashを個別に固定する。
自然LLM planner、expanded-query、任意質問を受け付ける契約ではない。

実順位はretryの実行有無、seed、Graph採否、最終sourceを変えるが、この固定計画の検索語集合は変えない。
retryはscore付き候補がない場合のみ、coverageはseedが非空かつGraph読取り成功時のみ実行される。
未実行分岐もmanifestの必須入力であり、実行されなかった行を「余剰」として削除しない。
未知派生queryは実行時に拒否し、manifest外の入力・欠損・余剰・重複・text/hash不一致はDB前に拒否する。

`parity:local [output-directory] --chat-embedding-artifact /absolute/path/bundle.json` で明示opt-inする。
`--embedding-artifact` との併用は拒否する。rootの必須fieldは次の5個のみ。

- `version`: `parity-chat-embedding-artifact-v1`
- `schemaHash`: `parityChatArtifactSchemaHash`
- `planVersion`: `chat-fixed-preparing-v1`
- `retrieval`: 既存 `parity-embedding-artifact-v1` JSON全体（37chunk/共通3質問）
- `queries`: manifestの20行それぞれへ `values` を追加した配列（行順は任意）

manifestの `retrievalContract` に既存v1の固定metadata、`retrievalInputs` に生成用本文付きidentityを置く。
retrieval側は各入力の `text` を除いて `values` を付け、embeddingへ生成者の申告modeを設定する。
Chat側は `text` を残す。全vectorの次元/有限/float32安全性/非ゼロを検証し、同じ本文hashには
retrieval/Chat/case/phaseを跨いで完全に同じvectorを要求する。期待値・候補・結果からvectorを作らない。

同じ検証済みchunk/vector入力を両DBのseedとChat collectorへ渡す。実candidate/RRF/selection、
実PostgreSQL文書repository・D1/workerd読取り、Graph/retry、response redaction、loopback HTTPを接続する。
`localEvidence.artifactChat` に限定して保存し、`syntheticChat` / `syntheticRetrieval` はnull。
本文・質問・vector・path・回答はreportへ出さず、`embeddingReads` はphaseと入力hashだけを保存する。
bundleのchecksumは元のUTF-8 JSON、`retrievalChecksum` は内包JSONの再serialize後のchecksumと区別する。
`source=saved-artifact`、申告mode、checksumを生成元証明と混同せず、`originVerified=false` /
`semanticQualityMeasured=false` を維持する。固定synthesis/loopback HTTPは実LLM評価ではない。
D1側は引き続きfake VectorizeとローカルChat bridgeであり、remote/backend本番完成の証拠ではない。

専用PostgreSQLと実D1/workerdで明示synthetic保存artifactを検証した。独立hash projectionでは両backendの
候補/最終sourceが一致し、3質問はretryなし、controlled 2件はretryあり、Graph採用0件だった。
`single-seed-graph-final` はd01が実primary候補にないため空になり、シナリオ名の期待を結果へ転記しない。
別の明示的な本文SHA-256 projection保存artifactでは既存controlledのSAME_AS d02最終採用と
simplified retry/RELATED_TO取得を確認した。これはテスト入力を明示して選ぶ独立回帰であり、
入力不足時のfallbackではない。両projectionとも実embedding・意味品質・生成元は未測定。

通常品質snapshotは各39/52行・13件欠損、qualityGate=false / step7Gate=not-evaluatedを維持する。
scope/mutation/rubricはnull、criticalErrorsMeasured=false。実artifactは未提供で、自然planner/実LLM/引用/
HTTP認可/remote/7C、Step 6/7開始gate、既存品質・restore・削除gateの未達を維持する。

### 実行方法

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

Graphは `scripts/lib/parity-graph.ts` で共通操作を実行する。D1は既存 `d1-worker` と実adapterを使用し、
DBから全node/edgeを読み取る。PostgreSQLは同じloopback URLからランダム名 `parity_graph_*` の
専用DBを新規作成し、既存migration 0026と実relational read/mutation adapterを使う。接続roleには
CREATEDBが必要。既存DBは再利用・削除せず、作成成功したDBだけをfinallyで削除する。
強制終了時は一時DBが残る可能性がある。元の `keyword_eval` 内のtableには触れない。
alpha/betaのprovider内project UUID変換はrunner境界のみで行い、canonical ID/hashは維持する。

Graph 17ケースごとに入力集合の保存を確認し、同名node keyを持つbetaの全保存フィールドが不変であること、
beta専用seedのalpha検索が空であることを検査する。mutationを2回実行し、propertiesを含む全保存フィールドの
再実行一致と、実測canonical集合の期待値一致を `mutationPass` に記録する。readのmutationPassは
入力保存と読取前後の不変性を表す。rubricPassはnull。HTTP成功だけではtrueにしない。
操作前後のcanonical集合、入力保存・sentinel存在/不変・foreign seed拒否・retry一致をreportへ保存する。
これはfixture内のscope/操作確認であり、HTTP認可や全mutation経路・障害後repairを証明しない。

`findRelatedDocuments` の既存契約はSAME_AS/RELATED_TOが1-hop、MENTIONSがTopic経由2-hopであり、
汎用maxHops引数を持たない。read mappingはfixtureのrelation別limit=1と重複seedを渡し、
実際のcandidateのrelation/hopをそのまま保存する。v1のMENTIONSは文書間の直接1-hopを期待するため、
両adapterは空集合を返し不合格となる。hopを1に書き換えたりoracleで補完しない。
fixture/hash/閾値・本番adapter契約は変更せず、将来のversioned fixture見直しの判断事項として残す。

| 能力                    | 7Bローカル到達点                                          | 残件                                                        |
| ----------------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| keyword                 | 両backend全22 queryを入力し順位・拒否・scopeを実測        | GCP remote baseline、remote性能                             |
| scope                   | 返却chunk IDのproject所属とD1のdocument provenanceを確認  | HTTP認可・cross-project write全経路                         |
| mutation / Graph        | read 3・mutation 14件を実測、全保存集合とretry/隔離を照合 | MENTIONS v1契約不一致、remoteと全経路検証                   |
| semantic / hybrid       | 別evidenceへsynthetic各3行、実adapter/RRF/selection接続   | 共通実embedding・実Vectorize・remote品質                    |
| Chat / expected failure | 別evidenceにChat 3行・限定4障害観測を保存                 | 全workflow・自然planner・実回答/引用・HTTP認可・stale正規化 |
| latency                 | keyword queryとGraphケース全操作のローカルmsを記録        | 同一remote workload、warmup/repetition統一、CPU/請求        |

`localEvidence` にcodeDirty（未コミット変更の有無）、能力欠損case ID・理由、未測定観測、latency、remoteMetrics=nullを付ける。
keywordのmutationPass/rubricPassはnull。scopePassは返却ID集合の所属確認であり、認可全体の成功を意味しない。
fixture/schema/mapping hashは7Aから維持する。品質snapshotのembedding metadataはsynthetic/not-executedで
意図的に契約不一致とする。既存のStep 6 compositionは別fixture専用のため、その成功を7Aの
semantic/hybrid/Chat行へ流用しない。既存keyword/chat eval資産も期待値と実測を分離する。

### Semantic / hybridのsynthetic接続試験

Issue #802で `scripts/lib/parity-retrieval.ts` に全37 chunk/36 documentと各3質問の共通mappingを追加。
本文/質問とblock番号のSHA-256を1536次元の単位vectorへ変換する。judgment、required source、oracle順位は
生成に使わず、意味的類似度を表さない。実embedding APIは呼ばない。
Issue #810で保存済みembedding artifact入力を別経路として追加した（上記参照）。

`report.json` の `localEvidence.syntheticRetrieval.{gcp,cloudflare}` に、実際に呼んだadapterの候補から
生成した6行の別snapshot、入力hash、embedding `synthetic/sha256-text-v1/1536/cosine`、adapter種別、
latencyと選択policyを保存する。ここも `qualityGate=false` 固定。通常のgcp/cloudflare snapshotには混ぜず、
採点器・fixture・閾値は変更しない。DB URL未指定ならsynthetic GCP evidenceもnull。
quality側は引き続きsemantic/hybridを含む13ケース欠損であり、local evidenceを実semantic品質と誤認しない。

PostgreSQLは専用loopback `keyword_eval` URLからランダム名 `parity_retrieval_*` DBを新規作成し、
vector/PGroonga extension、fixture用の最小documents/document_chunks tableを用意する。
既存Webのpgvector/PGroonga candidate adapterを直接呼ぶ。IDはfixtureのtextを使い、既存DB/tableを再利用しない。
CREATEDBとextension作成権限が必要で、作成したDBのみfinallyで削除する。強制終了時は一時DBが残り得る。
これは最小schema上の正確なcosine検索であり、本番schema全体・ANN index性能・GCP remoteは検証しない。

Cloudflareは実D1/workerdと既存keyword/Vectorize adapter、semantic outboxのenqueue/deliverを使用する。
新しいローカルrouting harnessから同一D1へ投入し、Vectorizeだけを保存vectorのexact cosineで並べるfakeにする。
fakeはnamespace/project/modelで絞り、順位を固定応答しない。外部通信は全拒否する。
全37 vectorの保存と36回upsert、6回queryを観測する。実VectorizeのANN、整合性待ち、quotaを証明しない。

semanticはlimit=10/preDedupLimit=37、hybridのkeywordはlimit=20で候補を取得し、Core RRFのTop-10と
既存 `selectChatSourcesByScoreProfile` / `selectDiverseChatSources` による最大5 sourceを保存する。
2ランキングのRRF最大値で正規化し、固定policyはkMin=3/kMax=10/relativeWindow=0.15。
Core RRFとselectionの実行場所は両側ともNodeローカルであり、自然planner・Chat workflow・LLMは通さない。
返却chunk/document provenance、順位、document重複を検査し、project所属をscopePassに記録する。
mutation/rubricはnull。HTTP成功から未測定能力をtrueにしない。

2026-09-26、Issue #802: 専用Docker PostgreSQL/pgvector/PGroongaと実D1/workerd＋fake Vectorizeで
各6行のsynthetic evidenceを収集。両側の候補順とfinal sourceは一致したが、意味的品質の証拠ではない。
自然文をそのまま正規化した3質問では両側のkeyword候補が空で、今回のhybrid実観測はsemantic候補だけのRRFとなった。
空結果も観測に保持し、検索語の捏造やoracle補完はしない。両ランキングが非空の接続はunit testで確認する。
品質snapshotは各39/52行、MENTIONS不一致、qualityGate=false / step7Gate=not-evaluatedを維持。
7B全能力・7C実評価・Step 6/7開始gateは未達。実Chat/failure 7ケース、実embeddingとremoteは未対応。

2026-09-26、Issue #798: ローカルDocker PostgreSQL/PGroongaと実D1/workerdで各22件を収集。
各30件欠損、comparisonComplete=false / contractPass=false / qualityGate=false、step7Gate=not-evaluatedを確認した。
今回の結果でStep 6全完了・7B全能力完成・7C実評価開始を宣言しない。

2026-09-26、Issue #800: 専用Docker PostgreSQL/PGroongaと実D1/workerdで各39/52行を収集。
Graph 17行は両側一致、mutation 14件は期待集合・retry・scope成功、readは2/3件が期待集合一致。
MENTIONSの欠損1 edgeを両側の実測不一致として保持する。semantic/hybrid/Chat/failureの13件は欠損。
comparisonComplete=false / contractPass=false / qualityGate=false、step7Gate=not-evaluatedを維持する。
orphanケースはv1入力内のdocument全削除を検査し、任意の孤立Actor/Topic回収まで成功とは扱わない。

### Chat / expected-failureの限定接続試験

#### Issue #808: retry判定とGraph最終sourceの接続

共通3質問を既存 `shouldRunPrivateChatRetryStep` / `resolvePrivateChatRetryQueries` で判定し、
必要な場合だけ `runPrivateChatRetryingStep` を実行する。各observationの `retry` に判定・実行有無・
検索語hash・前後IDを、`hybridReads` にprimary/retry/coverage別のRRF結果と返却IDを記録する。
質問・本文・検索語そのものはreportへ保存しない。自然3質問では両backendとも判定false、retry呼出し0回。
各質問のhybrid-search 3回はprimary 1回＋coverage 2回であり、retry実行と数えない。

未発火の分岐は `parity-chat-controls.ts` の独立入力 `chat-controlled-connection-v1` を使い、
`localEvidence.syntheticChat.{gcp,cloudflare}.controlled` にversion/inputHashと観測を別保存する。
v1 snapshotへ行を追加しない。両シナリオは明示した同一合成質問を使い、初回の実adapter＋RRF結果だけを
allowlistで除外する。DBの候補、関係、順位、score、retry/coverage結果を生成・補完しない。
control境界・allowlist・入力hash・除外前後IDを残す。既存Graph接続fixtureは変更しない。

| シナリオ                | 制御                               | 両backendのローカル実観測                                                                                                    |
| ----------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| primary-empty-retry     | 初回RRF結果を空にする              | 既存simplified retryが1回発火、実candidate 10件取得、最終5資料。RELATED_TOとMENTIONSでd03取得、hybrid evidence不足で両方除外 |
| single-seed-graph-final | 初回RRF結果に実在するd01だけを残す | retryなし。SAME_AS d02を採用、MENTIONS d03はevidence不足で除外。実文書取得後の最終sourceはd01/d02                            |

自然3質問のfinal sourceは従来どおり各5資料で両側一致。design/ownerで採用されたd02は最終上限外、
timeoutはGraph空。`graphExcludedFromFinalDocumentIds` に実際の欠落を記録する。
既存diagnosticsの `sourceLimitExcluded` は全ての最終欠落を数える契約ではなく、このケースでも0を保つため、
runnerで改変しない。coverage時点とdetail後のdiagnosticsを両方保存する。
`finalGraphDocumentIds` はGraph採用IDからhybrid採用IDを除き、最終IDとの共通集合で追跡する。
既存detail mergeがDB文書でGraph objectを置換するため、Graph属性の有無だけでは取得元を判定できない。
controlled d02ではdetail後にGraph属性が既に無く、残る内部score/chunk属性をresponse整形で除去し、
許可した6属性以外がないことと実workflow HTTP clientの2要求往復を確認した。
Graph属性を保持したままresponse整形へ渡す別経路やGraph優先枠の置換分岐まで網羅したものではない。

この検証は既存Node stepとDB/adapterの限定接続試験であり、自然LLM planner、expanded-query retry、
実回答/引用、Next/HTTP認可、本番E2Eは未測定。hash embedding、fake Vectorize、固定synthesisを維持する。
scope/mutation/rubricはnull、criticalErrorsMeasured=false。controlled側もqualityGate=false。
品質snapshot各39/52行・13件欠損、MENTIONS v1不一致、qualityGate=false / step7Gate=not-evaluatedと
7B全能力/7C・Step 6/7開始gate未達を維持する。専用PGと実D1/workerdの回帰試験で確認し、remote/APIは未使用。

#### Issue #806: DB文書取得とGraph接続

`fixture-document-fetch` stubを廃止し、PostgreSQLは既存 `createPostgresChatRepository` の
`documentFetch` / `graphCoverageQuery`、D1は同じdisposable DBの `keyword_documents` /
`keyword_chunks` を実workerdで読むローカル専用readerへ接続する。D1には本番Chat文書repositoryが
ないため、このreaderを本番adapter完成とは扱わない。SQL結果は既存 `parseChatSourceRow` で検証する。
最初のchunkを700文字まで取得し、本文はreportへ保存しない。PostgreSQLの最小tableには既存readerが
必要とするmetadata/occurred_at/updated_atのみ追加し、本番schema/migrationは変更しない。

v1 Chat入力にはGraph関係がないため、`parity-chat-graph.ts` の独立fixture
`chat-graph-connection-v1` を `syntheticChat.connectionFixture` に保存する。
alphaのd01/d02/d03とTopic 1個、SAME_AS 1辺・RELATED_TO 1辺・TopicへのMENTIONS 2辺を
既存mutation adapterで投入する。本文/質問/意味的関係を再現するfixtureではなく、judgmentやoracleから
生成しない接続入力である。元のGraph v1/hash/閾値・MENTIONSの1-hop不一致は変更しない。
既存PostgreSQL relational / D1 Graph readとDB hydrationから、既存Nodeの
`runPrivateChatRelatingStep` / coverage evidence re-check / detail / redaction / loopback HTTPへ通す。
D1のGraph候補と文書取得を結ぶ薄いbridgeもローカル専用で、relation pool上限は既存定数を再利用する。

各3質問について `observations.documentReads` に要求/返却ID、`graphReads` にseed/返却IDと
relation/hop、`graphDiagnostics` と `graphAdoptedDocumentIds` にcoverageの実採否を保存する。
`calls` はworkflowが実際に呼ぶrepository能力を記録する。Graph内部のhydrationはGraph候補返却に含まれ、
独立したdocument-fetch tool呼出しには数えない。snapshotのgraph空配列はv1品質未測定のschema値のままとし、
独立fixtureの関係をv1 Graph測定へ転記しない。candidate IDsにはcoverage再検索で観測した候補も含まれる。

両backendでChat 3質問を収集した。各質問でhybrid-search 3回、graph-query 1回、detailのdocument-fetch 1回、
workflow HTTP 2往復を観測。design/ownerはSAME_ASのd02と2-hop MENTIONSのd03を取得し、
coverageはd02を採用、d03はhybrid evidence不足で除外した。timeoutのGraph候補は空のまま。
RELATED_TOはこの3質問のseedでは返却されず、coverage採用の証拠はない。
最終5資料は両側一致し、Graphのd02は最終上限内には入らなかった。detail返却順はDB間で異なるが、
既存selection後の順序は一致した。source内部属性除去も確認した。

PostgreSQLの実文書取得・project隔離・missing ID・Topic 2-hopと、D1の本文更新/削除反映・first chunk・
project隔離・missing/空IDを回帰試験で確認する。これらはHTTP認可全体の証拠ではない。
hash embedding / fake Vectorize / 固定synthesisは維持し、自然planner、実LLM回答/引用、retry全経路、
HTTP認可は未測定。scope/mutation/rubricはnull、criticalErrorsMeasured=falseを維持。
通常品質各39/52行・13件欠損、qualityGate=false、step7Gate=not-evaluated、7B全能力/7CとStep 6/7開始gateは未達。

#### Issue #804時点の限定観測（文書stub/Graph未接続は#806で更新）

2026-09-26、Issue #804で共通fixtureのChat 3質問とfailure 4入力をmappingした。
`parityChatInputs`は入力ID/project/質問だけを読み、judgment/required/expectedFailureはrunnerへ渡さない。
両backendの実candidate adapterとCore RRFから、既存のpreparing/retrieving/detail step、
`privateChatSourcesForResponse`、既存loopback stubとworkflow HTTPクライアントへ接続する。
本文/質問のhash vector、fixtureをproject/document IDで絞るdetail lookup、固定文のsynthesisだけをstubにする。
Graph、retry、自然planner、実LLM回答/引用は実行せず、tool一覧には実呼出しだけを記録する。
detail stepが生成するtool summaryと、実際のdocumentFetch呼出しは異なり得るため後者を観測する。

`localEvidence.syntheticChat.{gcp,cloudflare}.snapshot`に各3行を保存する。
今回の両側candidate順/final sourceは一致、各5資料、hybrid-search/document-fetchを実呼出しした。
HTTP往復は各2回、内部source属性の除去を確認した。資料取得はfixture内lookupでありDB detail adapterではない。
scope/mutation/rubric、planner/citation観測はnull。citation IDsの空配列とcriticalErrors=0は
synthetic snapshot契約上の値であり、引用/事実誤り未測定（criticalErrorsMeasured=false）を明記する。
通常品質snapshotは各39/52行、13ケース欠損のまま。qualityGate=false、step7Gate=not-evaluatedを維持する。

障害は期待値を返すrunnerを作らず、実経路にfaultを入れた。共通のNode境界はprovider実測へ複製せず
`localEvidence.sharedChatFailures`へ一度だけ保存する。

| 入力                  | 注入境界                                                  | 実観測                                                          | 未測定・残差                                      |
| --------------------- | --------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| project_access_denied | legacy runPrivateChatのmembership lookupをundefinedにする | ProjectAccessDeniedErrorを正規化、lookup 1回・embedding/LLM 0回 | 実認可SQL/Next HTTP認可/現行workflow入口          |
| timeout               | loopback stream応答を遅延し受信後deadlineでabort          | 実workflow clientのTimeoutError、2 HTTP要求                     | remote provider timeout                           |
| overloaded            | loopback streamが429を返す                                | 実workflow clientのstatus=429を正規化、2 HTTP要求               | 実provider quota/adapter overload                 |
| stale_read            | fake Vectorizeの返却revisionだけを+1                      | 実D1/workerd adapterが503 unavailable、前後controlは各10候補    | v1 expected stale_readと不一致、GCP stale検証なし |

staleは`syntheticChat.cloudflare.staleRead`へ保存する。adapterはstaleを検出後unavailableへ集約し、
local harnessもそれを保存する。期待値からstale_readへ改名せず、本番error契約も変更しない。
専用Docker DBとD1/workerdで収集し、一時DB残存0を確認。remote/API/本番アクセスなし。
7B全能力、7C実評価、Step 6/7開始gateは未達。既存MENTIONS残差と品質・restore・削除gateを保持する。

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
