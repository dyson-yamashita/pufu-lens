# ADR-009: Vectorize adapter / outbox / repair

- 日付: 2026-09-26
- 対象: Plan 018 Step 6D / [Issue #790](https://github.com/dyson-yamashita/pufu-lens/issues/790)
- 状態: ローカル実装・契約検証。実Vectorizeとremote品質gateは未確認

## 境界と再現

`packages/workers-spike/src/vectorize/`が既存`SemanticCandidateRepository`を実装する。
Vectorize/D1の構造型は同workspace内に閉じ、Core、GCP SQL、composition、設定を変更しない。
`semantic-worker.ts`は未認証のローカル試験専用入口であり、公開してはならない。
テストの`vectorize-fake.invalid`はbindingを模したHTTP fakeであり、Vectorize REST APIではない。
Miniflare `4.20260730.0` / workerd `1.20260730.1`、compatibility date `2026-07-30`、Node互換flagなし。
実D1 bindingとworkerdを使うが、Vectorizeにはローカル実サービスの代替がない。

```bash
pnpm install --frozen-lockfile
pnpm exec turbo run build typecheck test --filter=@pufu-lens/workers-spike
```

ingestion packageがfetch-only公開入口`@pufu-lens/ingestion/embedding-client`を所有する。
既存Gemini/OpenAI client、定数、型、config検証を切り出し、従来の`embedding`入口から再exportする。
GCPの正常系body、batch 100、HTTP retry、model/dimensions設定を維持する。
Worker bundleはこの入口と`http-retry.js`だけを許可し、`node:crypto`、deterministic provider、
ingestion fixture、Postgres driver、node_modules、外部importの混入を拒否する。
実workerdからfetchし、合成HTTP応答で両clientの101入力の分割・順序・1536次元・不正次元拒否を確認する。
実embedding API、認証、モデル品質を確認したとは扱わない。

## readの契約

- `describe()`の1536/cosineを検証し、model identityと`projectId`/`model`のmetadata index設定を必須化する。
  設定はdeployment側の証跡であり、bindingのdescribeでmetadata index実在やmodelを検証できるわけではない。
  remote開始前にlist-metadata-indexの結果と固定modelを照合する。
- 全queryにproject namespaceとindexed `projectId`/`model` filterを必須指定する。
  matchのnamespace/metadataも再検証し、D1のproject-scoped現行revisionだけからprovenanceをhydrateする。
  SQL rowはunknownからsnapshot・Core candidate guardを通し、payloadとrowのdocument/revisionも照合する。
- cosine similarityの降順、同点はvector ID順。`cosineDistance = 1 - score`で0–2へ変換する。
  選択chunkのtitle/rawDocumentId/snippetを保持し、document dedupe後1始まりrank、最後にlimitを適用する。
  provider score/metadataはCore DTOへ渡さない。
- `returnMetadata: all`、値なし。limit/preDedupLimitは1–50、後者があればquery topKに使う。
  51以上を黙って切り詰めず拒否する。1536次元・非零・有限float32-compatible vectorを要求する。
- 正常0件は空配列。transport、不正row、越境、欠落/旧revisionのmatchは固定unavailableにする。
  stale matchを捨てた短いtopKを完全な成功に見せない。書込み未反映でqueryが0件を返す場合までは
  検出できず、検索結果はeventual consistencyである。更新直後の完全性やread-your-writesは保証しない。

## D1 revision / outbox

`d1/0003_semantic.sql`を0001の後に適用する。GCP schema/migrationとは独立する。
`semantic_versions`は完全snapshot、`semantic_heads`は現行revision、`semantic_outbox`は配信状態を持つ。
snapshotはcandidateとvectorを保持し、最大16 chunk / UTF-8 100 KB。D1 JSON snapshot方式は小規模spike用で、
hydrateはproject内JSONを走査する。大規模負荷・capacity・CPU/latencyはユーザー指定で実施しない。

1. callerが文書ごとの正の単調増加revisionを供給する。reindexも新revision、削除は空chunkのtombstone。
   同一revisionの同一snapshot retryは許可し、異なるpayloadはNOT NULL制約でbatch全体をrollbackする。
2. immutable version、単調増加head、outbox insert、旧revision cleanup再投入は単一D1 batch。
   遅れて届いた古いrevisionはheadを戻さない。project FKを必須とし、100 bind制約内の固定SQLを使う。
3. vector IDはproject/document/revision/chunkのJSON tupleのSHA-256（64 ASCII bytes）。
   古いupsertやdeleteは新revision IDを破壊しない。namespaceだけにID衝突回避を依存しない。
4. consumerはメッセージのkeyでD1を引き直し、現行revisionはupsert、旧revisionはdeleteByIdsする。
   成功状態は`submitted`（API受付済み）であってindexed/visibleではない。mutation IDを記録する。
5. 失敗はD1へ1秒/2秒後の再実行時刻を保存し、3 attemptで`dead`。providerエラー本文は保存しない。
   `pending` / `submitted` / `dead`をinspectできる。3回目のclaim直後に停止したpendingもrepair対象。
6. repairは任意の既知revisionのattemptをresetし、pendingへ戻す。配信epochを増やし、古い処理の
   遅延ack/failureが新しいrepair/cleanup要求を上書きしないよう条件付きUPDATEする。
   文書の全保持revisionを処理すればheadの再upsertと旧ID削除を再実行できる。

D1とVectorize間にtransactionはない。重複consumerと外部の遅延反映は残り得る。
旧vectorが削除後に遅延upsertで再出現してもD1照合で返さず、反復repairで削除する。
配信完了だけを根拠に履歴/tombstoneを消してはならない。外部処理が落ち着くまでは収束を保証しない。
定期dispatcher、queue binding、DLQ resource、可視性確認・履歴GCは6E以降のcomposition/運用残件。
今回はD1のdead-letter状態と一件単位のconsumer/repairを実装し、実Queues/Workflowsは採用・接続しない。
queueへ接続する際はD1 intentを正本とし、戻り値がretryならdue時刻以降に再配信し、D1例外ではackしない。

6D時点では6C keyword snapshotとの共通ingestion transactionは未接続。6Dはsemantic revisionの順序を解決するが、
既存keywordのlast-commit-winsを自動で変えない。6Eの入口統合時に同じsource revisionの採番と
keyword更新/outboxの単一D1 batch化を検討し、Step 7のhybrid整合gateで確認する。
モデル変更は専用indexの再構築・固定設定変更を要し、同一indexへの混在を許可する移行は未実装。

後続6Eで認証付きcompositionのkeyword/shared revision原子更新とbounded dispatcherを実装した。
6D単独harnessの契約は維持する。到達点とremote未実施の範囲は
[ADR-010](ADR-010-cloudflare-staging-composition.md)を参照する。

## repair CLI

既存のローカルMiniflare D1 store（DB identity `semantic-local`、0003適用済み）を対象にする。
競合するlocal runtimeを停止してから実行する。migrationは自動適用せず、schema不足は失敗する。
指定directoryは既存のものに限るが、Miniflareの初期化ファイルが生成される場合はある。
inspectは100 revisionまでで、超過を明示拒否する。remote URL/credentialのoptionはない。

```bash
pnpm --filter @pufu-lens/workers-spike repair:local --state-dir /absolute/local-d1-store --project alpha --document doc
pnpm --filter @pufu-lens/workers-spike repair:local --state-dir /absolute/local-d1-store --project alpha --document doc --revision 1 --apply
```

既定は状態表示。`--apply`は指定一件の再投入のみで、vector配信やresource削除はしない。
合成永続storeを閉じて再openするCLI回帰で、dead→pending、attempt reset、project越境なしを確認する。

## 公式仕様の再確認

2026-09-26確認。採用時に再確認する。

- [Vectorize API](https://developers.cloudflare.com/vectorize/reference/client-api/): upsert/deleteは非同期でmutation IDを返す。
  query可能になるまで通常数秒かかる。describeはdimensions/metricを取得できる。
- [Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/): 1536次元/float32、ID/namespace 64 bytes、
  metadata 10 KiB、metadata index 10、Worker upsert batch 1000。metadata付きtopKは保守的に50までとする。
- [metadata filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/): namespace→metadata→topKの順。
  projectId/modelのstring indexを投入前に作成する。string indexは先頭64 bytesまでなのでidentity長も制限する。
- [distance metrics](https://developers.cloudflare.com/vectorize/best-practices/create-indexes/): cosineは1が最類似、-1が最不類似。
- [Queues delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)と
  [retries](https://developers.cloudflare.com/queues/configuration/batching-retries/): at-least-onceを前提とする。
  既定3 retry、失敗は削除または設定済みDLQへ移送。順序・exactly-onceを前提にしない。
  本実装の3 attemptとは異なる設定である。
- [Workflows retry](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)と
  [limits](https://developers.cloudflare.com/workflows/reference/limits/): step既定5 retry/10秒/exponential、
  既定timeout10分、CPU既定30秒/最大5分、既定10,000 steps。外部副作用の冪等性は別途必要。

## 検証範囲と残件

実D1/workerdでbatch rollback、immutable revision、逆順/重複/並行配信、配信中の新revision/repair、
scope、tombstone、retry/dead、repair永続化、不正rowを確認する。
Vectorizeの順位/score/filter/namespace/遅延旧vectorはfake契約試験であり、実サービス互換ではない。
embeddingも合成HTTP応答であり、import成功だけによる判定ではないがremote API品質は未確認。
Workers workspaceは51件成功（Core17、Graph13、keyword8、semantic12、repair CLI1）、skip 0。
root `pnpm test` / `pnpm typecheck` / `pnpm format:check` / `pnpm lint`、`pnpm db:migrate --check`が成功。
`pnpm db:schema-drift`も専用loopback一時PostgreSQLで成功し、検証containerは停止・削除済み。
root testの既存DB条件付きskipを実行済みとは扱わない。最初のroot testは並行Next build競合で失敗し、
競合解消後の再実行が成功した。UI変更はなく画面capture/E2Eは対象外。

大規模負荷はスキップ。6D remote gate、6E staging、Step 7 parity、既存Chat品質未達、本番shadow観測、
restore、Step 4削除gateを残す。PGroonga primary/pgroonga-shadow、Graph relational-only、AGE/PGroonga資産を維持する。
Issue #779を前提条件にせず、親Issue #704はclosedのままとする。

## remote確認案（未承認・未実行）

承認対象は専用の`pufu-6d-vectorize-check` index（cosine/1536）、同名の専用D1と認証付き検証Worker各1つ。
対象Cloudflare accountはユーザー指定が必要。既存本番resourceやGCPを変更しない。
本spikeの未認証harnessはdeployせず、承認後に認証付きremote runnerを別途準備する。
Queue/Workflow resource、embedding外部APIは使用しない。合成1536次元vectorのみで、model identityは`synthetic-v1`。

- 2 project、各4 document×2 chunkの16 vector。3 revision分で最大48 vector。
- 3周のwrite/query/delete/repair、upsert合計144 vector以下、query/visibility poll計300回以下、
  Worker 500 request以下、CPU合計50,000 ms、D1 read 100,000/write 10,000 rows、保存5 MBを予算上限とする。
- namespace/metadata index実在、同一ID upsert、mutation受付→query可視化、削除可視化、stale拒否とrepair収束、
  score方向/1536次元/topKを確認する。poll上限で未反映なら失敗として止め、閾値を緩めない。
- 保持は最長24時間。結果はID/aggregateのみ保存し、合成本文・vector・secretをログへ出さない。
  終了時に検証resourceの停止・削除を行うcleanupも承認対象に含める。現時点ではcleanupも未承認。

[Vectorize料金](https://developers.cloudflare.com/vectorize/platform/pricing/)はPaid超過query $0.01/百万dimensions、
保存$0.05/一億dimensions（無料枠は月50百万query/10百万保存、Freeは30百万/5百万）。
投入144＋query300を各1536次元として681,984 queried dimensions、最大73,728 stored dimensions。
無料枠を使えない保守的計算でもquery約$0.00682、保存を丸一か月計上して約$0.000037。
[Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)の超過単価$0.30/百万request、
$0.02/百万CPU msなら約$0.00115。
[D1料金](https://developers.cloudflare.com/d1/platform/pricing/)の超過read $0.001/百万、write $1/百万、
保存$0.75/GB-monthなら5 MBを一か月計上して約$0.01385。従量合計の計画値は$0.03未満。
既存無料枠内なら追加従量$0が見込めるが、account使用量は未確認。
Paidへの新規変更は月額最低$5が別途必要で、今回の承認に含めず、必要なら個別判断する。
上記は利用上限を守る計画値で請求保証ではない。quota/料金/同一accountの消費を実行前に再確認する。
