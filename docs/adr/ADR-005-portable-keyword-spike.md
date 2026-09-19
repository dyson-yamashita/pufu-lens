# ADR-005: GCP portable keywordの評価spike

- 日付: 2026-09-17
- 状態: Step 3Bの採用提案とStep 3Dの切替準備。本番切替は未承認・未実施
- 対象: Plan 018 Step 3B / Issue #750

## 判断

GCPの次の実装候補として、NFKC＋小文字化した本文への**literal LIKE OR pg_trgm word similarity**を提案する。
固定合成corpusではGIN / GiSTの両方が全quality / safety gateを通過した。単一本文columnとpg_trgm indexで
日本語の部分一致とtypoを扱え、別のtoken table、token生成・更新・削除・backfill整合管理が不要になる。
indexは今回の小規模実測で小さかったGiSTをStep 3Cの出発点とするが、GINより高速とは結論しない。
大規模・同時write評価でindex方式を再判断する。Step 3Cの実装、本番接続、PGroonga削除はこのADRに含めない。

## 比較方法

Step 3Aの`keyword-synthetic-v1`、37 chunk / 36 document / 2 project / 22 query、judgment、gateを変更しない。
`fixtures/keyword/pgroonga-baseline-v1.json`を比較基準とし、各方式の全順位・latency・診断を
`fixtures/keyword/portable-spike-v1.json`へ保存した。判定は既存`evaluateKeywordRun`を再利用する。
同一containerのPGroonga再測定は`fixtures/keyword/pgroonga-spike-v1.json`に分け、元baselineを保持した。

- ローカルDocker / arm64、Node 22.16.0、PostgreSQL 18.1、pg_trgm 1.6、PGroonga 4.0.6。
- image ID: `sha256:63834c14fdcbf3430ffd218599852e7ca768e9bd219ddbe6f0e03038b5a6960c`。
- 専用loopback DB `keyword_eval`、方式ごとに単一transaction内でschema作成・削除。既存schemaは拒否。
- 候補は本文・queryをNFKC / lowercase / trim。原文UTF-16長1000超を拒否、空は0件。
- query全文をbind。FTSは`plainto_tsquery('simple', ...)`、LIKEは`%` / `_` / backslashをescape。
- project filter → score順 / chunk ID順 → chunk上限20 → document dedupe → 上限20を統一。
- 各queryのwarm-up 1回、測定3回、順位不一致はエラー。検索時間は正規化・SQL組立・roundtripを含み、row検証は含まない。
- baselineに合わせ`enable_seqscan=off`で計測。EXPLAINはoff / on両方を保存する。
- pg_trgmは既定相当の`similarity_threshold=0.3`、`word_similarity_threshold=0.6`をtransaction内で固定。
  corpusのcase別調整や期待値の緩和はしない。

## 品質の結果

| 方式                             | Recall@20 | MRR@20 | nDCG@20 | gate | 主な不足                                      |
| -------------------------------- | --------: | -----: | ------: | ---- | --------------------------------------------- |
| PGroonga baseline                |    0.9333 | 0.9333 |  0.9333 | FAIL | typo未検出、query構文case誤ヒット             |
| FTS simple                       |    0.4667 | 0.5333 |  0.4450 | FAIL | 日本語・混在・人名・計画名・部分一致等        |
| pg_trgm LIKE / GIN               |    0.9333 | 0.9333 |  0.9333 | FAIL | typo未検出                                    |
| pg_trgm similarity / GIN         |    0.2667 | 0.3333 |  0.2450 | FAIL | 長い本文との類似度低下、必須ID miss、誤ヒット |
| pg_trgm word similarity / GIN    |    0.8778 | 0.9333 |  0.8935 | FAIL | 日本語・人名・計画名の部分miss                |
| LIKE OR word similarity / GIN    |    1.0000 | 1.0000 |  1.0000 | PASS | このcorpus内ではなし                          |
| LIKE OR word similarity / GiST   |    1.0000 | 1.0000 |  1.0000 | PASS | このcorpus内ではなし                          |
| application bigram strict        |    0.9333 | 0.9333 |  0.9333 | FAIL | typo未検出                                    |
| application trigram strict       |    0.9333 | 0.9333 |  0.9333 | FAIL | typo未検出                                    |
| application bigram fuzzy         |    1.0000 | 1.0000 |  1.0000 | PASS | このcorpus内ではなし                          |
| application trigram fuzzy        |    1.0000 | 1.0000 |  1.0000 | PASS | このcorpus内ではなし                          |
| bigram strict OR word similarity |    1.0000 | 1.0000 |  1.0000 | PASS | このcorpus内ではなし                          |

PASS方式はいずれも全体Recall≥0.95、各有関連category Recall≥0.90、baseline比MRR差≥-0.05、
必須exact、escaping、project isolation、空 / 記号 / 長さ、document dedupeを満たした。
`absent OR ActivityPub`がpg_trgm similarityでヒットするのはSQL注入ではなくfuzzy一致のfalse positive。
不合格をそのまま残し、LIKE OR word similarityではこのcaseが0件であることを確認した。

FTSの`ts_debug`では「星舟計画の仕様変更」が1 tokenになり、「仕様変更」を検索できない。
単なるUnicode正規化ではword boundaryを補えない。custom tokenizerを加える案は運用要素が増えるため採用しない。
pg_trgm word similarityだけでも語の境界paddingに依存して日本語caseが欠け、literal LIKE併用で補えた。

application n-gramは正規化文字列のcode point単位の連続2 / 3文字、重複なし・paddingなし、句読点を保持する。
strict方式は全query gramの存在とliteral本文一致を両方要求する。fuzzy方式はquery gramの60%以上が存在するchunkを
候補にする（順序・距離の保証なし）。literal一致をscore 2、その他をcoverageとする。pg_trgm併用もliteral一致を
score 2、その他をword similarityとする。strict / LIKE単体は同点としてID順。gradeをrankingに使わない。

## 小規模コスト計測

単位はms。loadは正規化・token生成・batch INSERT、buildはproject / search index作成。
writeは37 chunkすべてを1件ずつ再書込みした3回の中央値。n-gramは全token削除とchunkごとの再INSERTを含む。
commit / fsyncは含まず、実運用のbatch最適化やWAL write amplificationの値ではない。

同じcontainerで再収集したPGroongaはp50 0.329 ms / p95 0.585 ms、順位は元baselineと同じだった。
PGroonga collectorは再書込みなし・trimのみなので、候補とのlatency差を方式だけの因果効果とはみなさない。
PGroongaのindex容量・write時間は既存collectorの収集対象外で、今回の方式間コスト比較には含めていない。

| 方式                |   p50 |   p95 |  load | build | write中央値 | 補助token数 | index KiB |
| ------------------- | ----: | ----: | ----: | ----: | ----------: | ----------: | --------: |
| FTS simple          | 0.256 | 0.727 |  2.53 |  2.03 |       11.35 |           0 |        48 |
| LIKE / GIN          | 0.253 | 0.943 |  0.98 |  1.19 |        9.74 |           0 |        72 |
| similarity / GIN    | 0.316 | 0.832 |  0.58 |  0.83 |       10.09 |           0 |        72 |
| word / GIN          | 0.333 | 1.000 |  0.44 |  0.81 |       10.78 |           0 |        72 |
| LIKE OR word / GIN  | 0.343 | 0.774 |  0.41 |  0.83 |        9.06 |           0 |        72 |
| LIKE OR word / GiST | 0.297 | 0.951 |  0.48 |  0.93 |        8.91 |           0 |        24 |
| bigram strict       | 0.250 | 0.633 |  6.96 |  0.44 |       28.97 |         932 |       112 |
| trigram strict      | 0.240 | 0.466 |  5.26 |  0.45 |       29.40 |         903 |       104 |
| bigram fuzzy        | 0.258 | 0.629 |  5.12 |  0.47 |       28.39 |         932 |       112 |
| trigram fuzzy       | 0.284 | 0.736 |  5.16 |  0.47 |       27.85 |         903 |       104 |
| bigram OR word      | 0.355 | 1.059 | 10.56 |  2.07 |       25.73 |         932 |       168 |

index KiBは3回の再書込み後、共通chunk PK 16 KiBを除くproject index・search index・token PKの合計。
token PKはload前に作るため、その構築費用はload側。n-gramのtoken heapはさらに160–168 KiB必要。
各relationの実測bytesはsnapshotを正本とする。未VACUUM・未commitのdead tuple / GIN pending listを含み、
page単位の丸めが支配的な小規模値なのでproduction容量へ線形換算しない。

EXPLAINでは通常plannerは小規模tableのSeq Scanを選ぶ。seqscan offでもGIN複合方式の日本語queryは
project index＋本文filterだった。GiSTでは本文indexのBitmapOrを確認した。
したがって「seqscan offだから全検索がkeyword indexで高速化された」とは扱わない。
GiSTの小さい容量は出発点の選択材料に留め、性能gateやproduction SLOの合格根拠にはしない。

## 採用しない方式と次のgate

FTS simple、LIKE単体、全体similarity、word similarity単体、strict n-gramは品質gate未達。
fuzzy n-gramは合格したが、GCPではpg_trgmの導入1件に対し補助tableとtoken整合管理を増やす理由がない。
bigram OR wordはpg_trgmとtoken tableの両方を要し、同品質で複雑になる。Cloudflare側はStep 6で別途判断する。

このcorpusにはtypo 1件、Unicodeは全角英字1件しかない。全方式のPASSはproduction採用許可ではない。
次の実装・切替gateとして以下を残す。

1. 新versionの合成holdoutで日本語typo、1–2文字query、数字の近似誤ヒット、否定例、句読点、結合文字、emoji、
   複数語、NFKCで意味の異なる文字を評価する。v1のjudgmentを緩めず、新baselineも取得する。
2. n-gramのwidth未満queryは既存token集合でmissし得る。採用する場合は短query fallbackを別途設計する。
   LIKEも抽出可能trigramのない短queryでfull index scanになり得るため、入力長・timeoutを検証する。
3. 大規模合成corpus、長文chunk、project偏り、duplicate chunkでtop-20飽和、期間filter、同時ingest、
   warm / cold cache、自然plannerでGIN / GiSTを比較する。row-by-row再書込みではなく実write pathとWAL量も測る。
4. Step 3Cでnormalization共有契約、generated / materialized column、index、adapter、backfill、更新・削除原子性を実装する。
   閾値0.6は接続poolのsession状態に依存させない。現在のCore RRF / production adapterを変更していない。
5. hybrid最終document・RRF後採用差・Chat HTTP評価、shadow / primary switch、fallback 0・7日soak・復元を後続で確認する。
   Step 2本番は全8 unit relational-onlyの記録を維持。AGE / 旧image / backup保持、extension削除gateは未達。

## Step 3Cの実装検証追記（2026-09-17、Issue #752）

LIKE OR word similarity / GiSTを明示DI用adapterとして実装し、nullableなmaterialized本文、共有DB正規化関数、
更新trigger、concurrent index migration、bounded backfillを追加した。PGroonga primaryは維持する。
query・write・backfillは同じNFKC / Unicode full lowercase / ECMAScript trimを使い、threshold 0.6と5秒timeoutは
検索transactionに限定する。実装・検証手順は[backfill運用](../operations/keyword-backfill.md)を参照する。

実schema上でv1の固定judgment・既存PGroonga baselineを維持して全gate通過。追加6文書による短query、結合文字、emoji、
literal metacharacter等の境界例を確認した。ただし関連なしの数字query `31417`が`invoice 31415` / `invoice 31416`に
近似一致した（2件のfalse positive）。これはquality不合格残件であり、閾値・v1期待値を緩めて吸収しない。
体系的holdoutの新baseline、日本語typo・否定・複数語、大規模負荷、hybrid / Chat、production soak / restoreは未確認。
本番切替許可・性能gate合格・extension削除の根拠にはしない。Step 2の本番状態・残件は変更しない。

## Step 3Dのshadow / primary切替準備（Issue #754）

Step 3Cのcandidate adapterをprovider-neutralなtransition wrapperへ接続し、deployment-level modeを次の3値に固定する。

- `pgroonga-primary`: 既定。既存PGroongaだけを呼び、portable queryを発生させない。
- `pgroonga-shadow`: PGroongaの順位付き結果を返し、portable結果をbounded shadow比較する。shadowのerror、timeout、mismatchはprimary結果を変えない。
- `portable-primary`: portable結果を返す。成功0件は空の成功として採用し、portable error / timeoutのときだけPGroongaへ一度fallbackする。
  fallbackも失敗した場合は固定unavailable errorとする。入力rejectedはfallbackしない。

Coreの候補DTO、project scope、chunk上限→document dedupe→1始まりrank、選択chunkの原文snippet、RRF `k=60`は変更しない。
観測は`keyword_transition_observation`としてprovider、mode、outcome、candidate count、latency、有限の
`candidate_count` / `candidate_set` / `rank` / `snippet_provenance`だけを出力する。query本文、snippet、raw score、identity、
error本文、secretは出力しない。session-local `word_similarity_threshold=0.6`と5秒statement timeoutの契約も維持する。

### Step 3D品質結果と未達gate

固定v1は既存baseline比較でcandidateの全gateを維持した。追加holdoutには日本語typo、短query、数字 / 識別子、否定 / 複数語、
Unicode / escapingを含め、`invoice 31415`への関連queryの近似overmatchと、`31417`の関連なしnumeric queryがinvoice 2件へ近似一致する
不合格を再現・記録する。baselineは全holdoutを満たし、candidateは明示したnumeric known failureだけを許可する。thresholdやv1 judgmentは緩めない。large / long / project-skewed corpus、自然plannerでのGIN/GiST、WAL / capacity / write amplification / latency
SLO、同時ingest、hybrid / RRF final selection、Chat HTTP、production shadow / primary、全chunk backfill、fallback 0、7日soak、
restoreは未検証である。Step 2の全8 unit relational-only、AGE / backup / 旧image保持、自然mutation全経路・長期観測・復元試験の残件は維持する。

## 参考・再現

- [実行手順とgate](../operations/keyword-evaluation.md)
- [PostgreSQL 18 pg_trgm](https://www.postgresql.org/docs/18/pgtrgm.html): similarity / word similarity、GIN / GiST、短patternの制約。
- [PostgreSQL 18 Text Search controls](https://www.postgresql.org/docs/18/textsearch-controls.html): plain queryとrank。

公式仕様は方式の説明に使い、上の品質・コスト判断は保存済みsnapshotの実測に基づく。
