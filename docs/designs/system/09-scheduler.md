# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## 定期実行（Cloud Scheduler）

Internal Scheduler / Job API の共通契約は [API デザイン](05-api-design.md) も参照する。
ローカル・本番の確認、障害・再試行、機密情報非露出の運用手順は [Source Sync Scheduling 運用手順](../../operations/source-sync-scheduling.md) にまとめる。

Cloud Scheduler は Cloud Run Job の `:run` API を直接叩かず、Mastra Server の内部管理 API を呼び出す。Mastra Server は受け取った JSON を検証し、Cloud Run Jobs API の overrides（環境変数または args）として各 Job に渡す。

Source sync dispatcher は `scripts/source-sync-dispatcher.ts` に実装し、ローカル one-shot と Cloud Run Job が同じDB lease・heartbeat・retry処理を使う。`scripts/workflow-job.ts` は `source-sync-dispatcher` を受け付ける。

GitHub / Drive / Gmail の data source は作成 transaction 内で毎日 10:00 `Asia/Tokyo` の schedule を作る。既存の有効な対象 source は migration で backfill する。project admin は Data Sources 詳細で ON / OFF と日次時刻を変更でき、変更時は次の wall-clock occurrence を UTC の `next_run_at` に再計算する。Web は自動 schedule を持たない。

PostgreSQL VM はコスト削減のため業務時間のみ起動する方針だが、DB 依存の Scheduler / Job は DB 稼働時間内に実行する。夜間に実行したい場合は、Scheduler の直前に DB VM を起動し、job 成功後に停止する専用運用を用意する。初期構築では DB 起動制御を増やさず、`curate-workflow`、`ingest-workflow`、`generate-report`、`source-sync-dispatcher` は平日業務時間内に寄せる。

入力受け渡しの契約：

1. Scheduler → Mastra Server: `POST /internal/schedules/source-sync-dispatcher:run` に空の JSON objectを送る。
2. `--no-allow-unauthenticated` のCloud Run IAMがScheduler service accountのOIDC tokenを検証する。Mastra routeはGoogle署名tokenをアプリuser tokenとして解釈しない。
3. Mastra Serverはbodyが空objectであることを検証し、runtime service accountでdispatcher Cloud Run Jobを起動する。
4. Cloud Run Jobs API overrideは`WORKFLOW_INPUT_JSON={}`だけを渡し、project、data source、credentialはDBとruntime secretから解決する。
5. Job entrypointは`source-sync-dispatcher`を選び、DB上のdue scheduleを最大10件、開始から最大45分まで順次claimしてone-shot実行する。

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

# 毎週金曜 17 時にプロジェクトごとに Report Job を起動
gcloud scheduler jobs create http report-weekly-project-a \
  --schedule="0 17 * * 5" \
  --uri="https://mastra-server-xxx.run.app/internal/schedules/generate-report:run" \
  --http-method=POST \
  --message-body='{"projectId":"<project-a-uuid>","period":"weekly","since":"7daysAgo"}' \
  --oidc-service-account-email="scheduler-sa@PROJECT.iam.gserviceaccount.com" \
  --time-zone="Asia/Tokyo"
```

プロジェクトを追加するたびに対応する Report Job を Scheduler に登録する（IaC 化推奨）。

---
