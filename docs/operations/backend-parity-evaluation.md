# Backend parityのローカル評価契約

## 到達点と開始条件

Plan 018 Step 7A / Issue #796は、共通synthetic fixtureと採点ライブラリのローカル準備である。
Step 6全完了、Step 7の実評価開始gate達成、GCP / Cloudflareの品質同等性を意味しない。
backend runner、remote実行、実embedding生成、resource作成、本番変更は含まない。

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
異常入力、意図的な順位劣化を検証する。DB schema / UI変更がないため追加DB / E2E試験は対象外。
