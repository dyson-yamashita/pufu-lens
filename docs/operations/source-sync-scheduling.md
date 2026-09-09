# Source Sync Scheduling 運用手順

GitHub / Drive / Gmail の日次差分同期と、Web の手動差分同期を安全に確認・復旧するための手順をまとめる。dispatcher は DB 上の due schedule を1件ずつ claim し、対象 data source の collect と ingest を直列実行する。1回の起動では最大10件または開始から45分まで連続処理する。

## キック経路

| 環境     | 起動経路                                                              | 実行単位       |
| -------- | --------------------------------------------------------------------- | -------------- |
| 本番     | Cloud Scheduler（5分間隔）→ OIDC 付き Mastra 内部 API → Cloud Run Job | 最大10件・45分 |
| ローカル | `pnpm schedule:dispatch --once`                                       | 最大10件・45分 |

source ごとの Cloud Scheduler resource は作らない。Web source は自動 schedule を持たず、管理画面または既存の collect / ingest 導線から手動実行する。新規 GitHub / Drive / Gmail data source の既定日次時刻は 06:00 `Asia/Tokyo` であり、定期 report schedule の既定 10:00 とは独立している。Synthetic Monitor は `POST /internal/monitoring/v1/observations` で project 配下の source schedule 状態を読み取り専用で確認でき、`last_error` 本文や worker token は返さない。詳細は [Synthetic Monitor 運用手順](synthetic-monitoring.md) を参照。

## 既存 schedule の移行

`0014_data_source_schedule_default_0600` は `daily_time` の DB default だけを 06:00 へ変更し、既存 row の `daily_time` / `next_run_at` は更新しない。旧既定の 10:00 と利用者が明示設定した 10:00 を現行 schema から判別できないため、一括更新は禁止する。

Synthetic Monitor 用 project など、既存 source を 06:00 へ移す場合は Data Sources 詳細の Schedule で対象 source を1件ずつ 06:00 に保存する。保存後は project / data source scope を固定した query で `daily_time` と `next_run_at` を確認し、他 project の schedule が変わっていないことも確認する。

## ローカル確認

### 前提

- `DATABASE_URL` はローカル PostgreSQL を指す。
- Object Storage、connection secret 復号鍵、provider credentials はローカル検証専用値を使う。
- 対象の GitHub / Drive / Gmail data source と有効な connection が存在する。
- 本番 DB、Object Storage、credentials をローカル dispatcher から参照しない。

通常の `pnpm dev` と `docker compose up` はdispatcherを自動起動しない。外部 API へのアクセスを意図したときだけ次を明示実行する。

```bash
pnpm schedule:dispatch --once
```

due schedule が無い場合は外部 provider を呼ばず正常終了する。継続確認では `cron` / `launchd` などのhost schedulerから5分ごとにone-shotを呼び、CLIを常駐させない。

45分到達後は新しいscheduleをclaimしない。処理中に45分へ到達した場合はchild processを中断し、leaseが有効なら失敗として記録して通常の再試行間隔へ送る。Cloud Run Jobのtask timeoutは55分とし、dispatcherの後処理時間を確保する。

## 正常性の確認

機密値を表示しない集計だけを確認する。

```sql
SELECT enabled, retry_count, next_run_at, last_started_at,
       last_succeeded_at, last_failed_at, last_error
FROM data_source_schedules
ORDER BY next_run_at;
```

更新版の同期後は次を確認する。

1. 同じ `logical_source_id` に異なる `source_version` の `raw_documents` が残る。
2. `documents.id` は維持され、`raw_document_id` が最新版へ切り替わる。
3. 現在の `document_chunks` は最新版だけを参照し、旧chunkは `document_chunk_history` に退避される。
4. 変更なしの再実行ではraw、queue、chunkを増やさない。
5. 検索・チャットsmokeでは更新後だけに含まれる固有語を問い合わせ、旧本文ではなく最新版が候補になる。

## 障害・再試行

- collect / ingest失敗時は `retry_count` と `last_failed_at` を更新し、15分、1時間、6時間の順で再試行した後、通常の日次周期へ戻る。
- ingest drain が `max_runtime` / `max_batches` に達し、最新版の実処理対象が残っている場合も失敗として同じ再試行経路へ進む。旧版rawが最新版に置き換わっているだけの場合は残件に数えない。
- `last_error` は `collect` / `ingest` とexit codeだけを含む安全な要約とする。provider response、raw本文、token、secret、メール本文や宛先を保存しない。
- heartbeat失敗またはlease喪失時は実行中childを停止し、旧workerは成功・失敗を確定しない。lease期限後の別workerによる再claimに任せる。
- disabled schedule / disabled source はclaimされない。意図的な停止かを管理画面で確認してから再有効化する。
- connection失効・scope不足はconnectionを修復してから再実行する。schedule errorへOAuth応答本文を転記しない。

### Googleアクセストークンの期限切れ

収集CLIの接続検索（project / data source指定、明示connection ID指定の両方）は、Google接続に空でないrefresh tokenが
保存されている場合、アクセストークンの期限切れだけでは除外しない。既存のtoken resolverで更新が成功して初めて収集へ進み、
新しいaccess tokenは暗号化して保存する。更新応答の`expires_in`が数値の場合は有効期限も保存し、欠落または数値以外の場合は
`expires_at`に`null`を保存する。project / data sourceの紐付け、provider、Drive / Gmail scope、
切断状態、`connectionError` / `scopeMissing`の拒否条件は維持する。refresh tokenがない期限切れ接続は再認証が必要であり、
refresh APIの失敗時は古いtokenを使って収集を続行しない。GitHub接続の期限判定は変更しない。

定期収集Jobには、WebのGoogle連携と同じOAuth clientの`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`、および保存済みtokenを
復号できる`CONNECTION_SECRET_KEY`（未指定時は`AUTH_SECRET`）が必要である。secret値はログへ出さず、runtime設定の存在と
参照先だけを確認する。Cloud Build exampleでは`_GOOGLE_CLIENT_ID_SECRET_REF`と`_GOOGLE_CLIENT_SECRET_REF`を両方設定すると、
curate / ingest / source-syncの3種類のJobへGoogle参照を追加する。値は同一projectの`secret名:バージョン`で、
バージョンは正の整数または`latest`を使う。独自暗号化keyを使う場合は`_CONNECTION_SECRET_KEY_REF`も設定する。
未設定時は従来の`AUTH_SECRET` fallbackを維持するため、Webと同じ保存済みtokenを復号できることを事前確認する。
secretは既存のものを参照し、この設定を理由に鍵を新規生成・交換しない。

Jobのsecret参照はdeployごとに宣言値で置き換わる。手動追加だけでは次回deployで消えるため、triggerのsubstitutionへ
保持し、build作成前に設定する。すでにpendingのbuildへtrigger更新は反映されない。Google参照の既定値は空なので、
コードのmergeだけでは設定不足は解消しない。形式・IAM・適用対象の詳細は[Cloud Build手順](../deployment/gcp-cloud-build.md#google-oauth収集jobのsecret参照)を参照する。

この修正対象は収集CLIであり、Web管理画面の接続可否判定や未紐付けdata sourceの自動修復は含まない。
再試行上限後も`retry_count`は0へ戻るため、復旧は`last_succeeded_at`が直近の失敗より新しいことと、実際の収集結果で確認する。

多重起動を疑う場合は同じscheduleの `worker_token` と `lease_expires_at` を確認するが、token値自体をIssue、PR、chat、恒久ログへ貼らない。手動でleaseやworker tokenを書き換えず、実行中workerがないことを確認したうえでlease期限切れを待つ。

## 本番確認

1. Cloud Schedulerの直近実行が成功し、OIDC service accountがMastra Serverの `roles/run.invoker` を持つことを確認する。
2. Mastra runtime service accountがdispatcher Jobに対する `roles/run.jobsExecutorWithOverrides`、または `run.jobs.run` と `run.jobs.runWithOverrides` を含むcustom roleを持つことを確認する。
3. Cloud Run Jobの構造化logではevent名、schedule ID、source type、件数だけを確認する。
4. DB停止時間帯に起動していないことを確認する。夜間実行が必要ならDB起動・停止を別運用として用意する。

Cloud Scheduler の status が code 7 / HTTP 403 で、dispatcher Job execution が作成されていない場合は、Scheduler attempt logとMastra logを確認し、403がCloud Run IAMとMastra endpointのどちらで発生したかを先に切り分ける。Cloud Run IAMで拒否されている場合は、Scheduler Job の OIDC service accountとaudienceが現在のMastra service URLを指していること、およびそのScheduler SAがMastra Cloud Run service resourceの`roles/run.invoker`を持つことを確認する。

Schedulerのstatusが成功に変わってもdispatcher Job executionが作成されず、Mastra logに`Cloud Run Jobs API HTTP 403`がある場合は、Mastra runtime SAがdispatcher Job resourceの`roles/run.jobsExecutorWithOverrides`を持つことを確認する。Deploy Cloud Build SAの`iam.serviceAccounts.actAs`はdeploy時のSA指定権限であり、この2つのruntime呼び出し権限を代替しない。

```bash
gcloud scheduler jobs describe "$SCHEDULER_JOB" \
  --project "$PROJECT_ID" \
  --location "$REGION" \
  --format='yaml(httpTarget.uri,httpTarget.oidcToken,lastAttemptTime,status)'

gcloud run jobs executions list \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --job "$DISPATCHER_JOB"

gcloud run services get-iam-policy "$MASTRA_SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION"

gcloud run jobs get-iam-policy "$DISPATCHER_JOB" \
  --project "$PROJECT_ID" \
  --region "$REGION"
```

Cloud SchedulerやJobを手動実行する前に、同じdue scheduleを処理中のexecutionがないこととDB稼働を確認する。手動実行でもsource IDやcredentialをJob overrideへ渡さず、dispatcherにDBから解決させる。

## 自動回帰テスト

```bash
pnpm scripts:test
pnpm --filter @pufu-lens/ingestion test
pnpm --filter @pufu-lens/mastra test
```

主な保証範囲は、due / enabled条件と `SKIP LOCKED`、lease / heartbeat / retry、source単位のcollect→ingest、safe error、raw複数版、document ID維持、最新版chunk置換、旧chunk履歴である。実provider、OIDC、Cloud Run、検索品質はstaging smokeとして別途確認する。
