# Deploy Checklist

このファイルは、staging / production の初回手動作業と検証結果を
記録するための運用チェックリストである。secret の実値、OAuth token、
API key、DB password は記録しない。

## 環境

- 対象環境:
- GCP project:
- region:
- billing account:
- 実施日:
- 対象 commit:

## 初回手動作業

- [ ] 必要な GCP API を有効化した。
- [ ] Artifact Registry repository を作成した。
- [ ] GCS bucket を作成した。
- [ ] PostgreSQL VM / VPC / firewall / connector を作成した。
- [ ] Cloud Run / Cloud Run Jobs / Firebase App Hosting の service account を確認した。
- [ ] Secret Manager に runtime secret を作成した。
- [ ] Google AI API key または Vertex AI 認証方式を設定した。
- [ ] Google OAuth / GitHub App の callback URL を設定した。
- [ ] Cloud Scheduler の OIDC service account を作成した。

## Secret 記録

- `DATABASE_URL`: PostgreSQL 接続。実値は記録しない。
- `AUTH_SECRET`: Auth.js。実値は記録しない。
- `GEMINI_API_KEY`: Google AI API key 利用時のみ。実値は記録しない。
- `GEMINI_CHAT_MODEL`: Chat / report model。モデル名のみ記録可。
- `GEMINI_EMBEDDING_MODEL`: embedding model。モデル名のみ記録可。
- `GEMINI_EMBEDDING_DIMENSIONS`: embedding 次元。既定は `1536`。

## IAM 記録

- principal:
- role:
- scope:
- 理由:

## 検証結果

```bash
pnpm deploy:dry-run
pnpm infra:check --env staging
pnpm deploy:smoke --env staging
```

- `deploy:dry-run`: `curate-workflow`、`ingest-workflow`、`generate-report` の `WORKFLOW_ID` / `WORKFLOW_INPUT_JSON` entrypoint 計画をローカル dry-run で検査する。
- `infra:check`:
- `deploy:smoke`:
- Cloud Run Job 単発実行:
- Cloud Scheduler OIDC 実行:
- GCS prefix 作成:
- Secret Manager 参照:
- PostgreSQL VPC 内接続:
- public report manifest 解決:
- secret / token / PII のログ漏れ確認:

## 未完了項目

- [ ] なし

## Step 14 初期実装メモ

- Cloud Run Job の共通 entrypoint は `scripts/workflow-job.ts`。
- Job コンテナは `WORKFLOW_ID` と `WORKFLOW_INPUT_JSON` を受け取り、`curate-workflow`、`ingest-workflow`、`generate-report` を個別に計画・実行する。
- `DRY_RUN=true` または input の `dryRun: true` では DB / Storage / 外部 API に接続せず、secret 値を出さない計画ログだけを出す。
- Cloud Run Job 用 Dockerfile は `infra/docker/jobs/Dockerfile`。
- ローカルでは `docker build -f infra/docker/jobs/Dockerfile -t pufu-lens-workflow-job:local .` の後、`docker run --rm -e WORKFLOW_ID=generate-report -e WORKFLOW_INPUT_JSON='{"projectSlug":"sample-a","period":"weekly","dryRun":true}' pufu-lens-workflow-job:local` のように entrypoint dry-run を確認できる。
- `infra:check` は GCP identifier と Secret Manager の secret 名だけを検査し、secret の実値は出力しない。
