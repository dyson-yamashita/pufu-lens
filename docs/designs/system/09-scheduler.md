# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## 定期実行（Cloud Scheduler）

Internal Scheduler / Job API の共通契約は [API デザイン](05-api-design.md) も参照する。

Cloud Scheduler は Cloud Run Job の `:run` API を直接叩かず、Mastra Server の内部管理 API を呼び出す。Mastra Server は受け取った JSON を検証し、Cloud Run Jobs API の overrides（環境変数または args）として各 Job に渡す。

PostgreSQL VM はコスト削減のため業務時間のみ起動する方針だが、DB 依存の Scheduler / Job は DB 稼働時間内に実行する。夜間に実行したい場合は、Scheduler の直前に DB VM を起動し、job 成功後に停止する専用運用を用意する。初期構築では DB 起動制御を増やさず、`curate-workflow`、`ingest-workflow`、`generate-report` は平日業務時間内に寄せる。

入力受け渡しの契約：

1. Scheduler → Mastra Server: `POST /internal/schedules/{workflowId}:run` に JSON body を送る。
2. Mastra Server: OIDC の service account を検証し、body を workflow input schema で validate する。
3. Mastra Server → Cloud Run Jobs API: `run` request の container overrides に `WORKFLOW_INPUT_JSON=<validated json>` を設定する。
4. Job entrypoint: `WORKFLOW_INPUT_JSON` を parse して対象 Mastra Workflow の `inputData` として渡す。

Ingestion Job は Cloud Run のローカルファイルシステムに parser や中間成果物を永続化しない。parser は Parser Registry で承認済みの version を DB から解決し、Object Storage 上の artifact を hash 検証して使用する。Job 実行中に active parser version が変わっても、dequeue 時に queue item へ固定した `parser_version_id` を使い続ける。承認済み parser が無い raw は `held` にして、Scheduler の通常実行では graph / vector へ進めない。

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
