# ADR-010: Cloudflare synthetic staging composition

- 日付: 2026-09-26
- 対象: Plan 018 Step 6E / [Issue #792](https://github.com/dyson-yamashita/pufu-lens/issues/792)
- 状態: ローカルcomposition/fixtureを実装。remote deploy・実Vectorize・Step 7は未実施

## 判断と境界

`packages/workers-spike`に既存Graph、keyword、semantic、Core RRFを組み合わせる検証compositionを追加する。
Core/GCPの型・SQL・設定・アプリの認証/Chat APIは変更しない。全アプリ移植や汎用DB abstractionは追加しない。
`staging-worker.ts`だけが将来の承認済みremote検証用入口の候補である。
`worker.ts`、`d1-worker.ts`、`keyword-worker.ts`、`semantic-worker.ts`、`staging-local-worker.ts`はdeploy禁止。
最後の入口は同じ認証付きWorkerへfake Vectorizeを注入するローカルharnessであり、実サービスではない。

### 起動・認証・scope

`POST /evaluate`だけを受け付け、次のdeployment設定を必須とする。requestによるprovider選択はできない。

| 設定                                       | 必須値                                           |
| ------------------------------------------ | ------------------------------------------------ |
| `PUFU_LENS_DATA_PROFILE`                   | `cloudflare`                                     |
| `STAGE`                                    | `synthetic-staging`                              |
| `FIXTURE_VERSION`                          | `cloudflare-composition-v1`                      |
| `SCHEMA_VERSION`                           | `0004_composition`                               |
| `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` | `synthetic-v1` / `1536`                          |
| `INDEXED_METADATA`                         | `projectId,model`                                |
| `EXPIRES_AT`                               | 現在より後、24時間以内の時刻                     |
| `EVAL_TOKEN`                               | 専用secret、32–128文字のURL-safe英数字・`_`・`-` |
| `DB` / `VECTORIZE`                         | 専用D1 / Vectorize binding                       |

設定とbinding methodの存在を検査した後、Bearer tokenをSHA-256の固定長比較で検証する。
未認証は401で、D1/Vectorizeへのアクセスは0。認証後もmessageをstreamingで1,024 bytesまでに制限し、
JSON不正、余分なfield、未知operation、fixture外project/document/revisionは400で拒否する。
schema markerと全必要table/column、Vectorize describeの1536/cosineをrequest開始時に検査し、不一致は503。
起動検査をcacheしないのでschema/設定の劣化も後続requestで拒否する。エラー詳細・本文・tokenを返さず、応答はno-store。
metadata index実在/model identityはdescribeでは証明できないため、remote preflightで独立した証跡を要する。
schema検査はversion/column検査であり、手動で壊した全constraintの完全drift検知とは主張しない。

operatorは二つの合成projectを検証する権限を持つ。このtokenはユーザー認証やproduction認可を代替しない。
requestは`operation`、`projectId`、`document`（0–3）、`revision`（1–3）のみ。
全操作で同じscope検査を通し、本文、vector、SQL、任意URLを入力できない。
`health`、`seed`、`graph`、`dispatch`、`repair`、`inspect`、`query`以外の入口は設けない。
返す検索結果はID/順位/Graph DTOのみ。fixture本文・vectorはログやrunner reportへ含めない。

## 同一revisionの原子更新

`commitIndexedSnapshot`は既存semantic snapshotと同じchunkのsnippet全体をkeyword本文に使う。
ここでsnippetは短い固定合成本文そのものであり、実文書のtruncated snippetを一般ingestionとして使ってはならない。
chunk間の文書metadata一致と既存の16 chunk/100 KB、keyword 8 KB/content・100 KB制約を事前検査する。

1. 既存semanticのversion/head/outbox/旧revision cleanup再投入4 statementを準備する。
2. 同じbatchにkeywordのmetadata/chunk/posting 4 statementを追加する。
3. keyword側の全statementは同じproject/documentのsemantic headが入力revisionと一致するときだけ実行する。
4. 同一revisionの異なるpayloadはimmutable constraintで失敗し、keywordもrollbackする。
5. tombstoneはhead/outbox更新とkeyword document削除の5 statement batch。FK cascadeでchunk/postingを除く。

古いrevisionの逆順・並行到着でもkeywordのheadは戻らない。最終posting失敗でsemantic/outboxもrollbackする。
旧keyword harnessの単独置換は従来のlast-commit-winsを維持するが、このstaging入口には接続しない。
DB rowはunknown→field/Core guardを維持し、prepared statement作成helperはCloudflare package内部に閉じる。
revisionは正のsafe integer検査後のSQL literalとして条件へ入れ、ユーザー文字列はbindする。

hybrid queryはprojectの単調増加head集合（最大4文書）を検索前後で比較し、同時更新なら503にする。
D1 keywordとのrevision混在を検出するが、Vectorizeの未反映0件は検出できない。
`submitted`はAPI受付だけで検索可視性ではない。stale matchは既存adapterでunavailableのまま。
Graph fixture setupは別の冪等操作であり、retrieval ingestionとのatomic transactionは主張しない。
Graphのdoc-0/doc-1はtombstone後もGraph capability試験用として保持する。

## dispatcher / repair

Queues/Workflowsを追加せず、認証付き`dispatch`が指定projectのdue pending intentを最大4件、逐次配信する。
正常配信のD1 statementは起動検査10＋pending選択1＋4件×claim/read/ackの3＝23。
各ackが失敗してfailure state更新へ進む場合は最大27となる。
既存3 attempt/1秒・2秒backoff/deadとepoch条件を維持する。時刻はWorker側で採番し、requestでは指定できない。
外部受付後のD1失敗・重複配信は既存immutable vector IDとrepairで扱い、exactly-onceは主張しない。
`repair`は既知revision一件のpending再投入、配信は別request。
自動cron、Queue、Workflow、DLQ resource、履歴GC、remote cleanupは追加しない。
`inspect`は配信stateを返す。mutation IDも可視化完了証拠ではない。

## 固定fixtureと再現

`src/staging/fixture.ts`がversion、model、schema、ID mappingを固定する。
2 project（fixture-alpha/beta）×4 document×2 chunk。全projectで同じdocument/chunk IDを使いscopeを検査する。
1536次元の決定論的非零vectorであり、自然言語embedding品質やGCP embeddingとの同等性を示さない。
revision 1/2は本文更新、3はtombstone。実embedding API・OAuth・本番データを使用しない。

```bash
pnpm exec turbo run build typecheck test --filter=@pufu-lens/workers-spike
pnpm --filter @pufu-lens/workers-spike fixture:local
```

Miniflare `4.20260730.0` / workerd `1.20260730.1` / compatibility date `2026-07-30`、Node互換flagなし。
runnerは40 HTTP往復でGraph/keyword/semantic/hybrid、更新、逆順、repair、削除を確認し、150 requestで打ち切る。
outboundはfake hostnameのinterceptだけを許し、それ以外を拒否する。remote URL/credential optionは持たない。
JSON reportはversion/model/件数/aggregate latencyと`remoteGate: not-run`、`parityGate: not-run`を明示する。
ローカルp50/p95は再現補助だけであり、CPU/quota/SLOやremote性能の判定には使わない。

## 公式仕様と費用の再確認

2026-09-26に以下の公式資料を再確認した。remote実施直前にも料金/当該account使用量を確認する。

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/): memory 128 MB、同時接続6、
  Free CPU 10 ms。小fixture成功はremote CPU上限への適合を保証しない。
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)と[batch](https://developers.cloudflare.com/d1/worker-api/d1-database/):
  Free 50/Paid 1000 queries/invocation、100 bind、30秒query/batch、single-threaded DB。
  このcompositionは通常primary bindingを使い、Session/bookmark/read replica試験は行わない。
- [migrations](https://developers.cloudflare.com/d1/reference/migrations/)と[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/):
  専用空DBへ0001–0004を順に適用。Time TravelはFree 7日/Paid 30日。
  D1 restoreだけでは外部Vectorizeは戻らず、保持revisionからのrepair/rebuildと再評価が必要。
  remote restore・Vectorize再構築は未実施。今回のD1にGCP schemaを適用しない。
- [Vectorize API](https://developers.cloudflare.com/vectorize/reference/client-api/)と[limits](https://developers.cloudflare.com/vectorize/platform/limits/):
  upsert/deleteは非同期受付。1536次元、metadata付きtopKは本実装で保守的に50まで。
  namespaceとindexed projectId/modelを併用する。実indexのfilter・反映遅延はremote gateに残す。
- [Queues delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)と[pricing](https://developers.cloudflare.com/queues/platform/pricing/):
  at-least-once、Paid超過$0.40/百万operations、通常write/read/deleteの3操作とretry分。
  今回は利用しないのでQueue費用0。
- [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)と[pricing](https://developers.cloudflare.com/workflows/reference/pricing/):
  step/retry/CPU/state制約に加え、2026-08-10からsteps/storageも課金対象。
  今回は利用しないのでWorkflow費用0。単なる無料のretry機構として採用しない。
- [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/)、[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)、
  [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)の超過単価はADR-009の計算と一致。
  下記上限なら従量計画値$0.03未満。Paid新規変更の月額最低$5は別途。今回remote利用は0。

## remote承認用の具体案（未承認・未実行）

ADR-009案を本composition向けに具体化する。対象account ID、既存Free/Paidプラン、承認済み実施時刻が未確定。
専用Worker/D1/Vectorize各1つ、名称案は`pufu-6e-composition-check`。indexはcosine/1536、
metadata string indexをprojectId/modelで作り、投入前に一覧と照合する。本番/GCPは変更しない。
`wrangler.staging.example.jsonc`は未確定ID・期限を持つ審査用templateで、自動deployや公開routeを持たない。
承認後に専用tokenとHTTPS入口、選択account/resourceの証跡、remote計測runnerを準備・照合する。
ローカルfakeをremoteへ接続しない。remote runnerのvisibility poll/利用量計測は未実装・未実行である。

- fixture最大48 vector、upsert合計144 vector、query/visibility poll合計300回、Worker 500 request以下。
- CPU合計50,000 ms、D1 read 100,000/write 10,000 rows、保存5 MB、最長24時間。
- 超過単価による計画値: Vectorize約$0.00686、Workers約$0.00115、D1約$0.01385、合計約$0.02186。
  無料枠を前提とせず保存は丸一か月で計算。請求保証ではなく、Paidへの新規変更は別承認。
- remote runnerは上限到達時に失敗終了し、未反映を成功へ変更しない。CPU/rows実測が予算に達したら中断する。
- mutation受付→query反映、旧vector/削除可視化、filter、score、repair収束を実測する。
  GCP snapshotとの同一実embedding/modelによる比較はStep 7であり、このsynthetic-v1結果で代用しない。
- 終了時にWorker停止と専用resource削除を行う案。cleanupも承認対象であり、現在は実行しない。
  期限切れguardはrequestを拒否するだけで、resourceを削除せず保管課金を止めない。

承認はaccount/resource作成・deploy・専用secret設定・限定検証・保持・cleanupを一括で具体的に確認する。
本番データコピー、実embedding API、GCP変更、権限追加、Paid変更はこの案に含めない。

## 到達点と残件

ローカル59件（既存51＋composition8）成功、skip 0。固定fixture40往復成功。
root `pnpm test` / `pnpm typecheck` / `pnpm format:check` / `pnpm lint`、workspace build、
`pnpm db:migrate --check`と専用loopback一時PostgreSQLによる`pnpm db:schema-drift`が成功。
drift初回はローカルimageのPGroonga不足で失敗し、拡張を備えたimageで再実行して成功した。
一時containerは停止・削除済み。GCP schema変更はなく、PostgreSQL driftはD1検証の代用ではない。
root testの既存条件付きskipは維持し、外部DB等の未実行検証を成功扱いしない。UI変更はなく画面capture/E2Eは対象外。
認証・設定・schema拒否、shared revisionのrollback/逆順/並行/tombstone、dispatcher予算/due/dead/repair、
stale/越境vectorとhybrid中のrevision変化を検証した。
remote semantic gate、staging実測、Step 7全backend/Chat parity、CPU/容量/負荷、運用restoreは未確認。
大規模負荷はユーザー指定でスキップ。PGroonga primary/pgroonga-shadow、Graph relational-only、
AGE/PGroonga資産保持、既存Chat品質未達、本番shadow観測、Step 4削除gateを維持する。
Issue #779を前提条件にせず、親Issue #704はclosedのまま。Step 6全完了とは扱わない。
