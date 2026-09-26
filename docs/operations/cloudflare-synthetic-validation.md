# Cloudflare synthetic remote検証

対象はPlan 018 Step 6E / Issue #794。[ADR-010](../adr/ADR-010-cloudflare-staging-composition.md)の
認証付き専用compositionを使い、本番データ・実embedding API・GCPは使用しない。

## 再現手順

1. accountと既存プラン、承認範囲、残り予算を確認する。今回のFreeはユーザー申告であり、
   subscriptions APIは403のため独立確認できなかった。Paidへの変更や権限追加は行わない。
2. Wrangler `4.141.0`で認証先を照合し、専用Worker/D1/Vectorize名の衝突を確認する。
   OAuth tokenをログへ出さない。削除直後の同名再作成は避け、数値suffixを付ける。
3. 専用D1とcosine/1536次元Vectorizeを作成する。projectId/modelのstring metadata indexを作成し、
   管理APIのindex取得で`config.dimensions: 1536` / `config.metric: cosine`を照合する。
   作成mutation IDを保存する。作成受付は完了を意味しない。
   `GET /accounts/{account}/vectorize/v2/indexes/{name}/metadata_index/list`の
   `metadataIndexes`で両propertyName/indexTypeを確認してからvector投入へ進む。
   typeは公式schemaの`string`に加え、実応答の`String`を明示的に許容する。
   空一覧のままなら上限付きで待機し、期限内に反映しなければ停止・cleanupする。
4. 専用DBへ`packages/workers-spike/d1/0001_graph.sql`から`0004_composition.sql`まで順に適用する。
   migrationのrows_read/rows_writtenはrunner外利用として別途集計する。
5. workspace build後、`wrangler.staging.example.jsonc`を私有一時directoryへコピーして
   account/resource ID、期限、workers.dev公開設定を確定する。専用tokenとsecret JSONを0600で作成し、
   `wrangler deploy --dry-run --no-bundle`後に`--secrets-file`で投入する。
   認証付き`staging-worker.ts`以外は公開しない。observabilityは無効、期限は1時間以内とする。
6. 次のrunnerを明示実行し、終了結果に関わらず専用Worker、Vectorize、D1を削除する。
   各一覧を再取得して専用名の不在を確認し、一時secret/configを削除する。既存resourceは触らない。

```bash
node packages/workers-spike/remote-fixture.mjs \
  https://pufu-6e-composition-check-NUMBER.SUBDOMAIN.workers.dev \
  /private/path/eval-token /private/path/report.json
```

runnerはresourceを作成・削除しない。operatorがfinally cleanupを担保する。
HTTPSの専用名workers.dev originだけを許可し、redirectを拒否する。
tokenは引数の値として渡さず、私有fileから読む。reportに本文、vector、token、provider errorは保存しない。

## 計測と停止条件

認証後の応答にD1 rows read/written、最大database bytes、Vectorize query/upsert件数を付ける。
D1 metadataの欠落・不正・statement失敗は`complete: false`となり、runnerは停止する。
Worker requestは400、queryは200で停止し、承認済み500 request/300 query・pollの残りを
preflight/診断用に予約する。再試行分とmigrationも含めた総予算はoperatorが管理する。
承認上限はupsert 144 vector、D1 read 100,000/write 10,000、保存5 MB。
runnerはupsert 100/read 80,000/write 6,000で次のrequestを止め、過去の試行と次のrequest用の余裕を残す。
dispatch用に8 vectorを予約する。runnerの実行期限は15分。
fixtureは最大48のimmutable vector IDで、任意入力や自動write retryはない。

未認証401、scope外400の後、2 projectのGraph/keyword/semantic/hybrid、revision更新、逆順投入、
repair、tombstone後の不在を確認する。検索への反映待ちは各条件20回・10秒間隔まで。
未反映0件や503を成功にせず、削除は3回確認する。distanceとraw revisionも照合する。
`visibility.elapsedMs`は各query待機開始から観測までの時間であり、mutation受付からの遅延ではない。
CPU実測・請求額・自然言語品質・GCP parity・restore試験はこのreportでは証明しない。

## 2026-09-26の実施結果

Issue #794、PR #793 merge後のmain `7ac3cf4`から実施。accountはユーザー指定（末尾`cce0`）と
Wrangler認証先の一致を確認した。Free申告を前提とし、プラン・権限を変更していない。

| 試行 | 専用名suffix | UTC開始  | 結果                                                                            |
| ---- | ------------ | -------- | ------------------------------------------------------------------------------- |
| 1    | なし         | 04:49:14 | CLI表形式を機械判定できず停止。以後structured APIへ変更                         |
| 2    | なし         | 04:50:08 | metadata一覧が空で停止                                                          |
| 3    | なし         | 04:50:41 | 同名再作成後のmetadata取得が410/code 40027で停止                                |
| 4    | `-794`       | 04:51:13 | 2秒間隔20回で空一覧のまま期限超過                                               |
| 5    | `-7945`      | 04:54:29 | 30秒間隔10回で期限超過。最終応答に両indexあり、型名`String`との照合不一致を発見 |

試行5のmetadata作成受付IDは`f4b0fe3b-1223-4d16-8182-2b26f95d6090`（projectId）と
`bee25e4b-eb03-4f3e-a98b-ba30e05e43f8`（model）。最終応答は両indexを含み、
型名が公式schemaの`string`と異なる`String`だった。照合を修正し、残り予算内で再試行した。
最初の5試行のmetadata取得は33回。待機中の全応答は保存していないため、初回反映時刻は不明。

最初の5試行はfixture投入前に停止。Worker作成・HTTP評価request・vector upsert/queryは0、
D1 migration/fixture row操作も0。サービス利用・請求額0の証明とはしない。
試行5終了後04:59:52 UTCのAPI一覧で専用resource残存0を確認した。

試行6（`-7946`、05:00:06–05:00:51 UTC）はmetadata確認2回目で成功し、migrationとWorker deployまで完了した。
migration read 18/write 37 rows、最初のHTTP接続試行でtransport failureとなりfixture投入前に停止。
Worker/D1/Vectorizeとprivate一時directoryはfinallyで削除した。原因を断定せず、
次の試行に未認証healthによる上限付き公開入口の反映待ちを追加した。
既存Worker3件、D1 2件、Vectorize1件は変更していない。

試行7（`-7947`、05:01:21–05:03:10 UTC）はmetadata確認4回で成功。
公開直後の応答はJSONではなく、未認証health再試行2回目で401となった。
runnerは未認証401/scope外400に成功し、health 503で停止した（3 request、D1 read 1/write 0、122,880 bytes）。
現行[V2 binding型](https://github.com/cloudflare/workerd/blob/main/types/defines/vectorize.d.ts)を調べ、
describeにmetricがないことを確認。1536の検査は維持し、cosineは管理APIで事前確認するよう修正した。
local fakeもV2のshapeへ合わせた。migrationはread 18/write 37 rows、vector投入/queryは0。
専用Worker/D1/Vectorizeは削除済み。

試行8（`-7948`、05:04:56–05:08:30 UTC）は管理APIでcosine/1536を照合し、metadata確認5回で成功。
未認証health確認4回目で公開入口が利用可能となった。runnerは35 request、Vectorize query 20回、
upsert 16 vector、D1 read 3,897/write 1,162 rows、最大225,280 bytes、64,165 msで終了した。
mutation受付とGraph fixture投入は成功したが、2秒間隔20回でsemantic期待結果を観測できず`visibility_timeout`。
503は0回。migrationのread 18/write 37は別枠。Worker/D1/Vectorizeは削除済み。
この失敗を残し、試行9は同じ20回・同じ期待値で間隔を10秒に広げた。
再試行分を含む予算の余裕を増やすため、runnerのrequest/query/row/upsert停止閾値も引き下げた。

試行9（`-7949`、05:09:03 UTC開始）はmetadata確認5回で成功し、05:11:14 UTCにdeployした。
未認証health確認3回目で401を確認。fixture-alphaは検索・revision更新・逆順・repair・tombstone後の不在3回を完了し、
その時点で63 request/query 40回。fixture-betaも成功し、05:21:22 UTCにcleanup完了。

| 最終試行の実測                   | 値            |
| -------------------------------- | ------------- |
| outcome / project                | passed / 2    |
| Worker request / Vectorize query | 105 / 74      |
| upsert vector                    | 24            |
| D1 read / write rows             | 9,950 / 1,692 |
| 最大DB bytes                     | 245,760       |
| runner経過                       | 597,560 ms    |
| visibility待機中の503            | 29回          |

alpha初回の検索観測は12 poll/117,372 ms、revision 2は10 poll/96,045 ms、
削除の最初の不在は9 poll/84,886 ms。beta revision 2は14 poll/138,098 ms、
削除の最初の不在は11 poll/105,630 msだった。いずれもquery待機開始基準で、mutation受付基準のSLOではない。
両projectで削除後の不在を3回観測したが、alphaでは最初の成功後に503が1回あり、
次の不在観測まで2 poll/11,106 msかかった。3回連続成功や恒久的な削除収束を証明したとは扱わない。
残存staleは503で拒否し、古いrevisionを最新として返さないことを確認した。

全試行合計はHTTP接続試行153回（公開確認9回込み）、Vectorize query 94回、metadata確認49回、
query/poll計143回、upsert 40 vector、D1 read 13,920/write 3,002 rows（migration込み）。
各resourceは逐次作成・削除され、同時存在は専用各1つ。固定immutable IDは48以内。
CPU時間・請求額は実測していない。Freeは申告のままでPaid変更なし。
05:21:59 UTCのAPI一覧で専用Worker/D1/Vectorize残存0、既存件数3/2/1を確認。
private一時directoryは削除済み。原文・vector・tokenを証跡に含めていない。

ローカル検証はroot `pnpm test`成功（既存条件付きskip維持）、対象workspace63件成功後、
503利用量欠落とmetadata型名の回帰を追加してrunner6件成功。
`pnpm typecheck`、`pnpm format:check`、`pnpm lint`成功。
schema/UI変更はなく、DB drift・画面E2Eは今回対象外。
固定synthetic remote lifecycleは成功。全体のremote semantic gate・Step 7・CPU/負荷・restore・
既存Chat品質/本番shadow/資産削除gateは未達のまま。
