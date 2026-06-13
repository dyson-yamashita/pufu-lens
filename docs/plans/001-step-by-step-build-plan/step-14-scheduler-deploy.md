# Step 14: Scheduler / Cloud Run Job / Deploy 検証

### 実装する機能

- Cloud Run Job 用 Dockerfile
- `curate-workflow`、`ingest-workflow`、`generate-report` の job entrypoint
- Cloud Scheduler 設定
- Secret Manager / Workload Identity / GCS / VPC 接続
- 本番向け env validation

### 進捗メモ

- Issue #57 / branch `feature/issue-57-scheduler-deploy-check` で着手。
- `scripts/workflow-job.ts` を追加し、Cloud Run Job の共通 entrypoint として `WORKFLOW_ID` / `WORKFLOW_INPUT_JSON` を受ける形にした。
- `curate-workflow`、`ingest-workflow`、`generate-report` の dry-run 計画を `pnpm deploy:dry-run` で確認できるようにした。
- `pnpm infra:check --env staging` と `pnpm deploy:smoke --env staging` の入口を追加し、GCP identifier / Secret Manager secret 名の不足を secret 実値なしで検査する。
- Cloud Run Job 用 Dockerfile を `infra/docker/jobs/Dockerfile` として追加。
- ローカル Docker で job image を build し、3 workflow の container dry-run を確認。
- PR #58 は merge 済み。`pnpm infra:check --env staging` は GCP project / region / bucket / service account / VPC connector / Secret Manager secret 名などが未設定のため `blocked` になることを確認済み。
- DB / GCS / Secret Manager / Cloud Scheduler / Cloud Run Jobs API の実接続 smoke は、staging GCP identifier と権限設定後に実施する。

### 確認できること

- ローカルで確認済みの workflow を job として実行できる。
- Scheduler から project ごとに定期実行できる。
- DB / GCS / Mastra / Next.js の権限境界が設計どおりになる。

### 確認方法

```bash
pnpm build
docker compose build
pnpm deploy:dry-run
pnpm infra:check --env staging
pnpm deploy:smoke --env staging
```

GCP / Google AI Studio で必要な初回手動作業は `docs/operations/deploy-checklist.md` に記録する。手動作業そのものを完了条件にせず、完了判定は `infra:check`、`deploy:smoke`、Cloud Run / Scheduler / Secret Manager / GCS / DB の API 検査結果で行う。

- 利用する GCP project、billing account、region を決める。
- 必要な API を有効化する。
  - Cloud Run
  - Cloud Run Jobs
  - Cloud Scheduler
  - Secret Manager
  - Artifact Registry
  - Cloud Build
  - IAM Credentials
  - Compute Engine / VPC 関連 API
  - Vertex AI を使う場合は Vertex AI API
- Gemini 接続方式を決める。
  - Google AI API key を使う場合は Gemini API key を払い出し、Secret Manager に保存する。
  - Vertex AI を使う場合は service account / Workload Identity と project / location を設定し、API key を使わない。
- Secret Manager に runtime secret を作成する。
  - `GEMINI_API_KEY`（Google AI API key 利用時のみ）
  - `GEMINI_CHAT_MODEL`
  - `GEMINI_EMBEDDING_MODEL`
  - `DATABASE_URL`
  - `STORAGE_BUCKET`
  - Google OAuth / GitHub App などの連携 secret
- Cloud Run / Cloud Run Jobs / Firebase App Hosting の service account に必要最小限の IAM を付与する。
- GCS bucket と project ごとの prefix を作成し、Cloud Run / Job から読み書きできることを確認する。
- PostgreSQL VM / VPC / firewall / private connection を作成し、Cloud Run / Job から DB に接続できることを確認する。
- Cloud Scheduler から Mastra Server の内部管理 API へ OIDC で実行できるようにする。
- secret 値を `.env.example`、ログ、build output、Git 管理ファイルに入れないことを確認する。
- `generate-report` は workflow id、Cloud Run Job 名、Scheduler body の `workflowId` を同じ名前で揃える。実装ファイル名は `generate-report-workflow.ts` とする。

`infra:check` / `deploy:smoke` では次を確認する。

- Cloud Run Job の単発実行
- Cloud Scheduler からの OIDC 実行
- GCS prefix の作成
- Secret Manager の参照
- PostgreSQL への VPC 内接続

### 完了条件

- job が `curate-workflow`、`ingest-workflow`、`generate-report` を個別に実行できる。
- unauthenticated な Mastra / DB アクセスができない。
- secret 値が build log / runtime log に出ない。
- Gemini API key または Vertex AI 認証情報が Secret Manager / Workload Identity 経由で参照される。
- `infra:check` / `deploy:smoke` の結果が成功し、GCP / Google AI Studio で実施した初回手動作業、作成した secret 名、付与した IAM role、未完了項目が `docs/operations/deploy-checklist.md` に記録されている。
