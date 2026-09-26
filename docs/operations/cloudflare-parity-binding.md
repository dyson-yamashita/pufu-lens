# 共通fixtureのbinding評価準備

Plan 018 Step 7B / Issue #818。共通37chunk/36document・3質問を、認証付き実D1/Vectorize
binding入口へ接続するローカル準備。remote実行、実embedding生成、デプロイは未実施。
通常品質各39/52行・13件欠損、qualityGate=false、Step 6/7開始gateと7C未達は変更しない。

## 実行可能な入口

```bash
node --experimental-strip-types packages/workers-spike/parity-binding.mjs prepare ARTIFACT OUTPUT_DIRECTORY
node --experimental-strip-types packages/workers-spike/parity-binding.mjs local ARTIFACT OUTPUT_DIRECTORY
```

`ARTIFACT`は既存retrieval v1 JSON。4 MB上限、全入力/fixture/mapping/schema/text hash/vectorを
既存parserで検査し、同textHashのvector一致も検査する。欠損をsyntheticへfallbackしない。
`prepare`は本文とvectorを固定したnative `worker.js`と本文なし`manifest.json`を書くだけである。
本番本文/任意URL/SQLを取り込む入口ではない。Chat artifactはこの入口では未対応。
`mode=real`自己申告は生成元・品質の証明ではない。bundleは評価資産として管理し、ログへ出さない。

`local`は実workerd/D1と明示cosine fakeを起動し、111 HTTP requestでseed、dispatch、3 query、
36文書cleanupを検査し、finallyでruntimeを破棄する。150 request上限、未完了delivery/usage欠損は失敗。
検索失敗時も全固定文書のcleanupを試みる。remoteを呼ぶoptionはない。fake成功をANN品質へ昇格しない。
Issue #818では新規5件とCLI prepare/localが成功。111往復のローカル観測はD1 read6,117/write4,300 rows、
最大1,425,408 bytes、Vectorize fake query3/upsert37、cleanup後vector0/keyword chunk0。
これらはremote費用/CPU/可視化収束の測定ではない。

native Workerの設定はADR-010と同じprofile/stage/token/24時間以内TTL/metadata/dimensionに加え、
FIXTURE_VERSION=`parity-binding-v1`、FIXTURE_HASH/ARTIFACT_HASH/modelを生成manifestと一致させる。
DBは専用空D1へ0001–0004、Vectorizeは専用cosine/1536、projectId/model metadata indexが必要。
POST /evaluateのみ、Bearer認証後のcontrolは1,024 byte以下の`{operation,index}`だけ。
operationはhealth/seed/dispatch/repair/inspect/query/cleanup、indexは文書0–35または質問0–2。
任意project/revision/vectorを受け付けない。schema検査とD1/Vectorize利用量計測は既存helperを使う。
dispatch/repairは1文書revision 1に限定。cleanupはrevision 2 tombstone＋旧vector削除再配信で、
履歴を残す。受付成功はremote削除収束を意味せず、TTL拒否もresource削除を代替しない。
queryは実semantic/keyword/Core RRFを通しIDだけを返す。検索前後のD1 head一致も検査する。
既存Chat selection、Graph、LLM、引用、HTTPユーザー認可の評価を意味しない。

## 移行完了への最短経路

1. **比較に必要な接続を完成**: 今回のretrieval入口へ、既存Graph17/keyword22ケースの固定ID操作mapping、
   Chat/failureの実能力mappingと同一snapshotへのcollectorを追加する。分類stubの追加を前提にしない。
2. **限定実測を承認して実施**: 共通入力の実embeddingを一度生成し、同じartifactをGCPとCloudflareで使う。
   provenance、remote metadata、反映/削除収束、restore後repair、品質・latency・CPU・費用を収集する。
   MENTIONS契約不一致、未測定13件を隠さず補修し、採用/継続検証/不採用を判断する（7C/7D）。
3. **本番移行の別計画を承認**: Web/Next認証、Mastra/LLM、ingestion/jobs/scheduler、全relational data、
   GCS相当storage、OAuth/secret/PII、DNS/traffic、バックアップ/restoreの移行先・責任境界を決定する。
   現行Workers spikeはアプリ本番compositionではない。全機能E2E、データ移送/差分同期、rollbackを
   準備し、承認済み段階切替と観測を経て本番移行完了とする。具体的な全面移行アーキテクチャは未決定。

Plan 018完了と本番cutover完了は別。GCP拡張撤去/旧image削除はCloudflare評価の前提ではない。
既存PGroonga primary/pgroonga-shadow、relational-only、AGE/PGroonga保持、Chat品質、本番shadow、
restore、Step 4削除gateは維持する。大規模負荷はユーザー指定skip、#779非依存。

## 次の外部実行で一括提示する承認対象

現状はnative bundle準備まで。#794の承認は再利用しない。次のremote実行前に以下をmanifestへ固定し、
未確定項目を埋めて承認を受ける。今回のmanifestのremoteApproved=falseは承認記録の代用ではない。

| 対象            | 固定する内容・停止条件                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 実embedding     | provider/model/1536、固定40入力（37chunk＋3質問）、生成元証跡、API request/token/費用上限。Chatは別入力契約として追加承認                       |
| resource        | account ID、Worker/D1/Vectorize各1、専用名称/ID、code/bundle/artifact hash、metadata index証跡。既存本番credential使用なし                      |
| workload予算案  | Worker最大500 request（cleanup枠を確保）、Vectorize query最大300/upsert最大111 vector、D1 read100,000/write10,000 rows/保存5 MB、TTL最大24時間  |
| SLO案           | query p95 2秒以内、可視化/削除収束60秒以内、CPU総量50,000 ms以内。事前固定し超過/欠測は不合格。Free上限をCPU実測の代用にしない                  |
| 費用            | provider公式料金/選択account使用量を実行直前に再確認し、embeddingを含むUSD総額上限を確定。新規Paid変更は別承認。今回金額見積り/請求検証は未実施 |
| 実行runner残件  | 集計利用量の予算停止、remote許可先/manifest照合、poll上限、CPU取得、GCP同時入力比較、failure/Graph/Chat mappingを実装してローカル検証           |
| cleanup/restore | 成否にかかわらずWorker停止→専用resource削除→不存在確認。削除失敗の再試行/手動担当を指定。別枠でD1復元→Vectorize repair/rebuild→再比較を実測     |

この予算/SLOは次回承認用の案であり、実行許可や達成証拠ではない。まだremote runner残件があるため、
現時点で外部実行の許可だけを求めても実評価は完了しない。
