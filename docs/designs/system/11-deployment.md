# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## デプロイメント

### 1. ローカル開発

```bash
# 全サービス + ローカルストレージ volume を起動
docker compose up

# プロジェクトを 1 つ作成（AGE グラフとストレージ prefix を初期化）
pnpm create-project --slug project-a --name "Project A"

# Mastra のみ
cd apps/mastra && pnpm dev

# Web のみ
cd apps/web && pnpm dev
```

`.infisical.json` がある開発環境では、secret を shell や `.env` に直接置かず Infisical から注入して起動する。初回は `infisical login` を済ませ、`defaultEnvironment` が未設定の場合は `--env=dev` のように利用する環境名を明示する。

```bash
# リポジトリルートで実行
# Mastra のみ（Infisical 経由）
infisical run --env=dev --path=/ -- pnpm --filter @pufu-lens/mastra dev

# Web のみ（Infisical 経由）
infisical run --env=dev --path=/ -- pnpm --filter @pufu-lens/web dev
```

`docker-compose.yml` で `STORAGE_DRIVER=local` と `STORAGE_ROOT=/data` を Mastra コンテナに設定し、`pufu-lens-data` volume を `/data` にマウントする。

### 2. 本番デプロイ（GCP + Firebase App Hosting）

Firebase App Hosting のアジア圏リージョンに合わせ、本番の第一候補リージョンは `asia-east1` とする。Mastra Server、Cloud Run Jobs、PostgreSQL VM、GCS、VPC access も同一リージョンまたは同一 VPC 内で近接させ、Web API から DB / Mastra への遅延とネットワーク構成の複雑さを抑える。

PostgreSQL は Apache AGE が使えるカスタム Docker イメージで運用する。Cloud SQL は Apache AGE 拡張を任意追加できないため、本構成では採用しない。

`infra/docker/postgres/Dockerfile` は PostgreSQL 18 をベースに、`pgvector`、`Apache AGE`、`pgcrypto` が利用できる状態でビルドする。AGE は PostgreSQL のメジャーバージョンと ABI が合う必要があるため、Docker build 時に対象 PostgreSQL の `pg_config` を使ってビルドする。

`infra/docker/postgres/init.sql` では以下を必ず実行する。

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS age;
LOAD 'age';
SET search_path = ag_catalog, "$user", public;
```

アプリケーション側の DB 接続プールも、AGE の Cypher を実行する接続では接続確立時に `LOAD 'age'` と `SET search_path = ag_catalog, "$user", public` を実行する。

```bash
# 1. PostgreSQL VM 起動（初回のみ）
gcloud compute instances create-with-container pg-ai \
  --machine-type=e2-medium \
  --container-image=asia-east1-docker.pkg.dev/PROJECT/postgres-ai:latest \
  --boot-disk-size=50GB \
  --boot-disk-type=pd-ssd \
  --no-address

# 2. レポート / 元データ用 GCS バケット作成
gsutil mb -l asia-east1 gs://pufu-lens-prod

# 3. Mastra Server デプロイ（STORAGE_DRIVER=gcs）
cd apps/mastra && mastra build
gcloud run deploy mastra-server \
  --source . \
  --region asia-east1 \
  --service-account=mastra-runtime@PROJECT.iam.gserviceaccount.com \
  --vpc-connector=mastra-connector \
  --no-allow-unauthenticated \
  --set-env-vars STORAGE_DRIVER=gcs,STORAGE_BUCKET=pufu-lens-prod \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,GITHUB_APP_PRIVATE_KEY=GITHUB_APP_PRIVATE_KEY:latest"

# 4. Ingestion / Report Jobs デプロイ
gcloud run jobs deploy curate-workflow \
  --source . --region asia-east1 \
  --service-account=mastra-runtime@PROJECT.iam.gserviceaccount.com \
  --vpc-connector=mastra-connector \
  --set-env-vars STORAGE_DRIVER=gcs,STORAGE_BUCKET=pufu-lens-prod \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,GITHUB_APP_PRIVATE_KEY=GITHUB_APP_PRIVATE_KEY:latest"

gcloud run jobs deploy ingest-workflow \
  --source . --region asia-east1 \
  --service-account=mastra-runtime@PROJECT.iam.gserviceaccount.com \
  --vpc-connector=mastra-connector \
  --set-env-vars STORAGE_DRIVER=gcs,STORAGE_BUCKET=pufu-lens-prod \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,GITHUB_APP_PRIVATE_KEY=GITHUB_APP_PRIVATE_KEY:latest"

gcloud run jobs deploy generate-report \
  --source . --region asia-east1 \
  --service-account=mastra-runtime@PROJECT.iam.gserviceaccount.com \
  --vpc-connector=mastra-connector \
  --set-env-vars STORAGE_DRIVER=gcs,STORAGE_BUCKET=pufu-lens-prod,FRONTEND_URL=https://pufu-lens-web--PROJECT.asia-east1.hosted.app \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,SLACK_WEBHOOK_URL=SLACK_WEBHOOK_URL:latest"

# 5. Next.js デプロイ
#    Web は Firebase App Hosting で管理する。GitHub 連携を作成し、live branch への push で rollout する。
#    App Hosting は Cloud Build で build し、Firebase 管理下の Cloud Run / Cloud CDN で配信する。
cd apps/web
firebase init apphosting
firebase apphosting:backends:create \
  --project PROJECT \
  --location asia-east1 \
  --backend pufu-lens-web

# apps/web/apphosting.yaml に runtime env / secrets / VPC access を定義する。
# Web API が GCS / PostgreSQL / Mastra にアクセスするため、App Hosting backend service account に
# Secret Manager、GCS、Cloud Run Invoker、必要に応じて VPC access の権限を付与する。

gcloud run services add-iam-policy-binding mastra-server \
  --region asia-east1 \
  --member="serviceAccount:firebase-app-hosting-compute@PROJECT.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

# GCS 権限
gsutil iam ch serviceAccount:mastra-runtime@PROJECT.iam.gserviceaccount.com:objectAdmin gs://pufu-lens-prod
gsutil iam ch serviceAccount:firebase-app-hosting-compute@PROJECT.iam.gserviceaccount.com:objectViewer gs://pufu-lens-prod
```

`apps/web/apphosting.yaml` の最小例：

```yaml
runConfig:
  minInstances: 0
  maxInstances: 10
  concurrency: 80
  cpu: 1
  memoryMiB: 1024
  vpcAccess:
    egress: PRIVATE_RANGES_ONLY
    connector: mastra-connector

env:
  - variable: STORAGE_DRIVER
    value: gcs
    availability:
      - RUNTIME
  - variable: STORAGE_BUCKET
    value: pufu-lens-prod
    availability:
      - RUNTIME
  - variable: MASTRA_API_URL
    value: https://mastra-server-xxx.run.app
    availability:
      - RUNTIME
  - variable: FRONTEND_URL
    value: https://pufu-lens-web--PROJECT.asia-east1.hosted.app
    availability:
      - RUNTIME
  - variable: GOOGLE_CLIENT_ID
    value: ...
    availability:
      - RUNTIME
  - variable: GITHUB_CLIENT_ID
    value: Iv1.xxx
    availability:
      - RUNTIME
  - variable: DATABASE_URL
    secret: DATABASE_URL
    availability:
      - RUNTIME
  - variable: AUTH_SECRET
    secret: AUTH_SECRET
    availability:
      - RUNTIME
  - variable: GOOGLE_CLIENT_SECRET
    secret: GOOGLE_CLIENT_SECRET
    availability:
      - RUNTIME
  - variable: GITHUB_CLIENT_SECRET
    secret: GITHUB_CLIENT_SECRET
    availability:
      - RUNTIME
```

### 3. Secret Manager

```bash
printf '%s' "$DATABASE_URL_VALUE" | gcloud secrets create DATABASE_URL --data-file=-
printf '%s' "$AUTH_SECRET_VALUE" | gcloud secrets create AUTH_SECRET --data-file=-
printf '%s' "$GOOGLE_CLIENT_SECRET_VALUE" | gcloud secrets create GOOGLE_CLIENT_SECRET --data-file=-
printf '%s' "$GITHUB_CLIENT_SECRET_VALUE" | gcloud secrets create GITHUB_CLIENT_SECRET --data-file=-
gcloud secrets create GITHUB_APP_PRIVATE_KEY --data-file=github-app-private-key.pem
printf '%s' "$SLACK_WEBHOOK_URL_VALUE" | gcloud secrets create SLACK_WEBHOOK_URL --data-file=-
```

secret 値は shell history に残さない。ローカルの一時ファイルや環境変数から `--data-file=-` に流し込み、作業後に一時ファイルを削除する。`.env.example`、deploy script、build log には実値を出さない。

管理者が作成した Google / GitHub 連携の token は、接続作成時に個別の Secret Manager secret として保存し、`oauth_connections` には参照名だけを保存する。

Firebase App Hosting から参照する secret は、`firebase apphosting:secrets:set` で作成するか、既存の Secret Manager secret に App Hosting backend service account のアクセス権を付与する。

---
