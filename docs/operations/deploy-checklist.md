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
- [ ] PostgreSQL VM に専用 service account、`cloud-platform` scope、Artifact Registry reader、`POSTGRES_PASSWORD` secret accessor を設定した。
- [ ] PostgreSQL VM を `infra/gcp/postgres-startup.sh` で作成し、`gce-container-declaration` metadata に依存していないことを確認した。
- [ ] Cloud Run / Cloud Run Jobs / Firebase App Hosting の service account を確認した。
- [ ] Admin UI から Cloud Run Job を起動する App Hosting runtime service account に、対象 Job resource の `run.jobs.run` / `run.jobs.runWithOverrides` 権限を付与した（正準の IAM 要件は `docs/deployment/gcp-cloud-build.md` の IAM 節を参照）。
- [ ] Secret Manager に runtime secret を作成した。
- [ ] Google AI API key または Vertex AI 認証方式を設定した。
- [ ] Auth.js アプリログイン用の GitHub OAuth callback URL を設定した。
- [ ] Google data source 連携用の OAuth client と callback URL を設定した。
- [ ] GitHub App installation 用の setup callback URL と repository permissions を設定した。
- [ ] Cloud Scheduler の OIDC service account を作成した。

## Secret 記録

- `POSTGRES_PASSWORD`: PostgreSQL VM 専用。`postgres-vm` service account だけに accessor を付与し、実値は記録しない。
- `DATABASE_URL`: PostgreSQL 接続。実値は記録しない。
- `AUTH_SECRET`: Auth.js。実値は記録しない。
- `AUTH_URL`: Auth.js callback URL の origin。例: `https://app.example.com`。
- `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`: GitHub アプリログイン用 OAuth。callback URL は `${AUTH_URL}/api/auth/callback/github`。実値は記録しない。
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: Google data source 連携用 OAuth。callback URL は `${APP_BASE_URL}/api/connections/google/callback`。App Hosting runtime secret として設定し、実値は記録しない。
- `CONNECTION_SECRET_KEY`: OAuth token と GitHub App private key metadata の暗号化 key。App Hosting runtime secret として設定し、実値は記録しない。
- `GITHUB_APP_WEBHOOK_SECRET`: GitHub App webhook を有効化する場合だけ provider 側に設定する。現行 runtime は GitHub App setup callback を使い、webhook 受信 route は持たない。実値は記録しない。
- `AUTH_CREDENTIALS_EMAIL` / `AUTH_CREDENTIALS_PASSWORD`: Credentials user 作成時だけローカル環境で使う。実値は記録しない。
- `GEMINI_API_KEY`: Google AI API key 利用時のみ。実値は記録しない。
- `GEMINI_CHAT_MODEL`: Chat / report model。モデル名のみ記録可。
- `GEMINI_EMBEDDING_MODEL`: embedding model。モデル名のみ記録可。
- `GEMINI_EMBEDDING_DIMENSIONS`: embedding 次元。既定は `1536`。

## Provider 連携設定

- Google data source OAuth client:
  - callback URL: `${APP_BASE_URL}/api/connections/google/callback`
  - Drive source 追加時に要求する scope: `https://www.googleapis.com/auth/drive.readonly`
  - Gmail source 追加時に要求する scope: `https://www.googleapis.com/auth/gmail.readonly`
  - base profile scope: `openid email profile`
  - scope 不足または access token 失効時は、Settings の Google 連携から再接続する。
- GitHub App:
  - setup callback URL: `${APP_BASE_URL}/api/connections/github/callback`
  - App slug、App ID、private key は project Settings の GitHub App form で登録する。private key 実値は docs、issue、PR、log に記録しない。
  - webhook を provider 側で有効化する場合は、webhook secret を provider secret store に保存し、docs、issue、PR、log に記録しない。
  - repository permission は Issues / Pull requests / Contents の読み取りを有効にする。
  - installation 対象 repository に data source の `owner/repo` が含まれることを確認する。
  - installation 解除または App 設定不備時は、Settings の GitHub 連携から再設定する。

## IAM 記録

- principal:
- role:
- scope:
- 理由:

## 検証結果

```bash
pnpm deploy:dry-run
pnpm db:migrate --check
pnpm db:migrate --plan
pnpm db:migrate
pnpm report:backfill-project-manifests -- --dry-run
pnpm infra:check --env staging
pnpm deploy:smoke --env staging
bash -n infra/gcp/postgres-startup.sh
gcloud compute instances list --filter="metadata.items.key:gce-container-declaration"
```

- `deploy:dry-run`: `pnpm db:migrate --check` と、`curate-workflow`、`ingest-workflow`、`generate-report`、`source-sync-dispatcher`、`report-schedule-dispatcher` の `WORKFLOW_ID` / `WORKFLOW_INPUT_JSON` entrypoint 計画をローカル dry-run で検査する。PGroonga migration を含む DB 変更では、dry-run 前に PostgreSQL イメージ更新 → `pnpm db:migrate` の順序を deploy checklist の DB Migration 記録へ残す。
- `db:migrate --check`: migration file の命名、番号重複、履歴との整合を検査する。`DATABASE_URL` がある場合は online check として `schema_migrations` も照合する。
- `db:migrate --plan`: staging / production の `DATABASE_URL` に対して、適用予定 migration を表示する。ここではまだ適用しない。
- `db:migrate`: `infra/db/migrations/*.sql` を番号順に適用し、`auth_accounts`、`auth_password_credentials`、project scoped `oauth_connections` など既存 DB に必要な schema を用意する。migration version はファイル名から `.sql` を除いた値、`public.schema_migrations` に未登録のものが pending として順番に適用される。既存互換の `auth:migrate` も同じ migration runner を呼び出す。
- GCP Cloud Build deploy（`deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml`）: Workflow Job image push 後に Cloud Run Job `${_DB_MIGRATION_JOB}`（既定 `db-migrate`）で `pnpm db:migrate` を `--wait` 付き実行し、Mastra Server / Workflow Jobs / Firebase App Hosting deploy の前に schema migration を完了させる。`_RUN_DB_MIGRATIONS=false` の場合は migration step を skip するが、runtime rollout 前の barrier として同じ位置に残す。
- `auth:create-user`: OAuth を使わない環境で Credentials login 用 user と password hash を作成する。実 password は DB / docs / log に保存しない。
- `report:backfill-project-manifests`: 既存の `projects.visibility = 'public'` project に対して、公開レポート API が参照する `project-public-state.json` を Object Storage に作成する。初回は `--dry-run` で対象を確認し、問題なければ `--dry-run` なしで一度だけ実行する。
- `infra:check`:
- `deploy:smoke`:
- Admin UI data source ingest: App Hosting runtime service account で workflow job execution が作成され、`run.jobs.run` / `run.jobs.runWithOverrides` 不足の 403 が出ないことを確認する。
- Cloud Run Job 単発実行:
- Cloud Scheduler OIDC 実行:
- GCS prefix 作成:
- Secret Manager 参照:
- PostgreSQL VPC 内接続:
- PostgreSQL startup script log（secret 値を含まないこと）: `gcloud compute instances get-serial-port-output pg-ai --zone "$ZONE" | grep startup-script`
- PostgreSQL container: `docker ps --filter name=^/pufu-lens-postgres$` と `docker logs pufu-lens-postgres`
- `gce-container-declaration` metadata 検査（対象 VM が 0 件であること）:
- public report manifest 解決:
- secret / token / PII のログ漏れ確認:

## Credentials account 作成

OAuth を使わない環境、または初回管理者を Credentials login で用意する場合は、PostgreSQL VM に IAP トンネルで接続して `auth:create-user` を実行する。`PGPASS` は PostgreSQL VM 作成時に使った値を一時的な shell 変数として用意し、実 password / `DATABASE_URL` は shell history、docs、ログ、PR に残さない。

```bash
gcloud compute start-iap-tunnel pg-ai 5432 \
  --local-host-port=localhost:5433 \
  --zone "$ZONE" &

# Wait a moment for the tunnel to establish, then run:
DATABASE_URL="postgresql://pufu:${PGPASS}@localhost:5433/pufu_lens" \
pnpm auth:create-user -- --email '<user@example.com>' --password '<at-least-12-chars>' --name '<User Name>'
```

- `auth:create-user` は `users` と `auth_password_credentials` を作成または更新する。
- 既存の global admin がいる場合は、作成後に `/members` で role と password を管理する。
- Project member への追加は `/projects/<projectSlug>/members` で行う。

## DB Migration 記録

作成・レビュー時の判断基準は `docs/operations/db-migrations.md` を参照する。

- 実行前 backup:
- 実行前 check: `pnpm db:migrate --check`
- 実行前 plan: `pnpm db:migrate --plan`
- 実行コマンド: `pnpm db:migrate` または Cloud Build deploy の Cloud Run Job migration step（`_RUN_DB_MIGRATIONS=true`）
- Cloud Build migration job 名:
- Cloud Build migration job が VPC connector / `DATABASE_URL` secret に到達できることを確認:
- 適用対象 migration:
- `schema_migrations` 確認:
- fresh DB の `init.sql` baseline stamp 更新確認:
- PGroonga migration 適用前に PostgreSQL VM / Docker イメージを PGroonga 入りへ更新済みか確認:
- PGroonga extension / index 確認: `SELECT extname FROM pg_extension WHERE extname = 'pgroonga';` と `\d document_chunks_content_pgroonga_idx`
- data backfill 有無:
- AGE graph 更新有無:
- vector / embedding 再生成有無:
- heavy migration plan:
- read-only / maintenance window:
- batch script dry-run:
- batch script command:
- progress query:
- retry / resume 条件:
- graph / embedding smoke:
- chat hybrid search smoke: 固有名詞 / Issue 番号を含む質問で `vector-search` が keyword 候補を返すこと
- 実行後 smoke:
- 失敗時の判断: restore / forward fix / 再実行 / deploy 停止
- 記録先: PR、Issue、release note、または環境別運用ログの URL

## 未完了項目

- [ ] なし

## Step 14 初期実装メモ

- Cloud Run Job の共通 entrypoint は `scripts/workflow-job.ts`。
- Job コンテナは `WORKFLOW_ID` と `WORKFLOW_INPUT_JSON` を受け取り、`curate-workflow`、`ingest-workflow`、`generate-report`、`source-sync-dispatcher`、`report-schedule-dispatcher` を個別に計画・実行する。
- `DRY_RUN=true` または input の `dryRun: true` では DB / Storage / 外部 API に接続せず、secret 値を出さない計画ログだけを出す。
- Cloud Run Job 用 Dockerfile は `infra/docker/jobs/Dockerfile`。
- ローカルでは `docker build -f infra/docker/jobs/Dockerfile -t pufu-lens-workflow-job:local .` の後、`docker run --rm -e WORKFLOW_ID=generate-report -e WORKFLOW_INPUT_JSON='{"projectSlug":"sample-a","period":"weekly","dryRun":true}' pufu-lens-workflow-job:local` のように entrypoint dry-run を確認できる。
- `infra:check` は GCP identifier と Secret Manager の secret 名だけを検査し、secret の実値は出力しない。
- scheduler OIDC service accountがMastra Cloud Run service resourceの`roles/run.invoker`、Mastra runtime service accountがdispatcher Job resourceの`run.jobs.run` / `run.jobs.runWithOverrides`（`roles/run.jobsExecutorWithOverrides`または同等custom role）を持つことを確認する。Deploy Cloud Build SAの`iam.serviceAccounts.actAs`だけではruntime呼び出し権限にならない。
- ローカルではローカル専用DB/Storage/credentialsを設定し、source sync は `pnpm schedule:dispatch --once`、定期 report は `pnpm report-schedule:dispatch --once` を明示実行する。`pnpm dev`や`docker compose up`からは自動起動しない。
- 定期 report dispatcher の状態確認、retry / lease / skipped の切り分けは [定期レポート Scheduling 運用手順](report-scheduling.md) に従う。
