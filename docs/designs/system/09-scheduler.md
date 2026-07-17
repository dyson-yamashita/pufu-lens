# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## 定期実行（Cloud Scheduler）

Internal Scheduler / Job API の共通契約は [API デザイン](05-api-design.md) も参照する。
ローカル・本番の確認、障害・再試行、機密情報非露出の運用手順は [Source Sync Scheduling 運用手順](../../operations/source-sync-scheduling.md) と [定期レポート Scheduling 運用手順](../../operations/report-scheduling.md) にまとめる。

Cloud Scheduler は Cloud Run Job の `:run` API を直接叩かず、Mastra Server の内部管理 API を呼び出す。Mastra Server は受け取った JSON を検証し、Cloud Run Jobs API の overrides（環境変数または args）として各 Job に渡す。

Source sync dispatcher は `scripts/source-sync-dispatcher.ts` に実装し、ローカル one-shot と Cloud Run Job が同じDB lease・heartbeat・retry処理を使う。`scripts/workflow-job.ts` は `source-sync-dispatcher` を受け付ける。

GitHub / Drive / Gmail の data source は作成 transaction 内で毎日 10:00 `Asia/Tokyo` の schedule を作る。既存の有効な対象 source は migration で backfill する。project admin は Data Sources 詳細で ON / OFF と日次時刻を変更でき、変更時は次の wall-clock occurrence を UTC の `next_run_at` に再計算する。Web は自動 schedule を持たない。

定期 report schedule も project ごとの DB row を正とし、Cloud Scheduler resource を project ごとに作らない。`weekly` / `monthly` / `annually` の次回 slot は 10:00 `Asia/Tokyo` の calendar 境界から UTC instant を計算する。停止後の catch-up は保存済み `next_run_at` から古い slot 順に bounded に列挙し、初回 backfill は完了済み period だけを continuation cursor 付きで列挙する。`scripts/report-schedule-dispatcher.ts` は due slot の materialize、最古の未完了 period run の claim、report 生成、lease / heartbeat、15 分・1 時間・6 時間の retry を one-shot で実行する。`scripts/workflow-job.ts` は `report-schedule-dispatcher` を受け付ける。

Web のレポート一覧では project admin が `none` / `weekly` / `monthly` / `annually` を保存し、一般 member は同じ設定と実行状態を読み取り専用で確認する。変更 transaction は project row を先に lock し、schedule row が未作成の場合を含めて同時保存を直列化する。dispatcher の非期限切れ lease がある間は設定変更を拒否し、materialize 中の worker が新しい `next_run_at` を古い slot で上書きしないようにする。`none` は `next_run_at = NULL`、有効周期は保存時点から次の calendar slot を再計算する。

PostgreSQL VM は常時稼働させる。DB 依存の `curate-workflow`、`ingest-workflow`、`generate-report`、`source-sync-dispatcher`、`report-schedule-dispatcher` は時刻による DB 起動制御を前提にせず、各 schedule の due 判定と既存の lease / retry 契約に従って実行する。

入力受け渡しの契約：

1. Scheduler → Mastra Server: source sync は `POST /internal/schedules/source-sync-dispatcher:run`、定期 report は `POST /internal/schedules/report-schedule-dispatcher:run` に空の JSON objectを送る。
2. `--no-allow-unauthenticated` のCloud Run IAMがScheduler service accountのOIDC tokenを検証する。Mastra routeはGoogle署名tokenをアプリuser tokenとして解釈しない。
3. Mastra Serverはbodyが空objectであることを検証し、runtime service accountでdispatcher Cloud Run Jobを起動する。
4. Cloud Run Jobs API overrideは`WORKFLOW_INPUT_JSON={}`だけを渡し、project、data source、period run、credentialはDBとruntime secretから解決する。
5. Job entrypointは対応する dispatcher workflow ID を選び、DB 上の due schedule / period run を bounded に claim して one-shot 実行する。

### Report schedule dispatcher の起動契約

Report schedule dispatcher は Cloud Scheduler から 5 分ごとに起動し、1 run で due slot の materialize と period run の claim をそれぞれ最大 10 件、開始から最大 45 分まで処理する。通常実行と backfill は project + frequency ごとに最古の未完了 period を優先し、`retry_wait` / `retry_exhausted` を暗黙に飛ばさない。report insert は `schedule_period_run_id` で冪等化し、整合する既存 report の競合は成功扱いにする。

ローカルではローカル専用の DB / Storage / provider credentials を設定して `pnpm report-schedule:dispatch --once` を明示実行する。CLI は常駐 loop を持たず、`pnpm dev` と通常の `docker compose up` から自動起動しない。ログと DB の `last_error` には raw 本文、provider response、OAuth token、secret、email PII を保存しない。

Ingestion Job は Cloud Run のローカルファイルシステムに parser や中間成果物を永続化しない。parser は Parser Registry で承認済みの version を DB から解決し、Object Storage 上の artifact を hash 検証して使用する。Job 実行中に active parser version が変わっても、dequeue 時に queue item へ固定した `parser_version_id` を使い続ける。承認済み parser が無い raw は `held` にして、Scheduler の通常実行では graph / vector へ進めない。

### Source sync dispatcher の起動契約

Source sync dispatcher は起動元に依存せず、DB 上の due schedule を claim して対象 data source の collect と ingest を実行する one-shot runner とする。

| 環境     | キック方法                                                                 | 外部境界                                   |
| -------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| 本番     | Cloud Scheduler が 5 分ごとに OIDC 付き内部 API を呼び、Cloud Run Job 起動 | Scheduler OIDC / Cloud Run Jobs API        |
| ローカル | `pnpm schedule:dispatch --once` を開発者または host scheduler から実行     | PostgreSQL / Object Storage / provider API |

ローカル実行は Mastra Server と GCP IAM を必要としないが、本番と同等の環境変数（`DATABASE_URL`、Object Storage 設定、connection secret 復号設定、provider credentials）をローカル専用の値で設定する。本番 DB、Object Storage、credentials へローカル dispatcher から直接接続してはならない。ローカル専用の schedule 状態や簡略化した排他処理は持たず、本番と同じ DB lease、heartbeat、retry、結果更新の実装を使う。

one-shot CLI は due schedule が無ければ外部 API を呼ばず成功終了する。継続実行が必要な開発環境では `cron` / `launchd` などから 5 分ごとに呼び、CLI 自身には常駐 loop を持たせない。`pnpm dev` と通常の `docker compose up` からは自動起動せず、開発者が明示的に有効化した場合だけ外部 provider へアクセスする。

claim は `FOR UPDATE SKIP LOCKED` で1件ずつ行い、1件の完了後に次のdue scheduleを再取得する。1回のdispatcherは最大10件または開始から45分の早い方を上限とし、期限到達後は新規claimしない。Cloud Run Jobのtask timeoutは55分とし、dispatcher期限との差10分を中断・結果更新などの後処理に確保する。処理中に期限へ到達したsourceは中断し、leaseが有効なら失敗・再試行経路へ渡す。各claimは15分のleaseをworker tokenで保持し、heartbeatは最大60分まで延長できる。ingest drain が `max_runtime` または `max_batches` に達した時点で実処理対象の残件がある場合も成功扱いにせず、dispatcher の失敗・再試行経路へ渡す。成功時は次の日次時刻へ戻し、失敗時は15分、1時間、6時間の順で再試行した後に通常の日次時刻へ戻す。完了更新はschedule IDとworker tokenの一致を必須とし、期限切れworkerは後続workerの状態を上書きしない。保存するerrorはcommand種別とexit codeだけに制限する。

```bash
# 1 時間ごとに全プロジェクトのデータソースを確認
gcloud scheduler jobs create http curate-hourly \
  --schedule="0 * * * *" \
  --uri="https://mastra-server-xxx.run.app/internal/schedules/curate-workflow:run" \
  --http-method=POST \
  --message-body='{"sourceTypes":["gmail","drive","github","web"]}' \
  --oidc-service-account-email="scheduler-sa@PROJECT.iam.gserviceaccount.com" \
  --time-zone="Asia/Tokyo"

# 平日午前に Ingestion Job を起動（projectId 省略 = 全プロジェクト）
gcloud scheduler jobs create http ingest-daily \
  --schedule="0 10 * * 1-5" \
  --uri="https://mastra-server-xxx.run.app/internal/schedules/ingest-workflow:run" \
  --http-method=POST \
  --message-body='{"since":"1dayAgo"}' \
  --oidc-service-account-email="scheduler-sa@PROJECT.iam.gserviceaccount.com" \
  --time-zone="Asia/Tokyo"

```

---
