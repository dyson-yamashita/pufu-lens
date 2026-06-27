# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## デプロイメント

> 2026-06-19 に GCP project `pufu-lens`（asia-east1）へ end-to-end でデプロイし、PostgreSQL(AGE) VM・Mastra Server (Cloud Run)・Cloud Run Jobs ×3・Web (Firebase App Hosting) の稼働を確認した。本番ビルドに必要だったアプリ側の修正は [ADR-004](../../adr/ADR-004-storage-module-resolution-mastra-build.md) を参照。クラウド手順を変更する際は `scripts/deploy-dry-run.ts`、`scripts/deploy-smoke.ts`、`scripts/infra-check.ts`、CI、Secret Manager 設計を同時に確認する。
>
> 既知の落とし穴（再現デプロイ時に必須）:
>
> - **Mastra Server / Cloud Run Jobs はコンテナイメージでデプロイする**。`infra/docker/mastra/Dockerfile`・`infra/docker/jobs/Dockerfile` で monorepo を build し、Artifact Registry 経由で Cloud Run / Jobs に渡す（`--source .` の buildpacks は pnpm workspace を解決できない）。
> - **App Hosting の Next.js アダプタの CVE ゲートは `package.json` の version 文字列をそのまま `semver.satisfies` に渡す**。`"next": "^16.2.x"`（キャレット付き）だと誤って "vulnerable" 判定でブロックされるため、`apps/web/package.json` では **キャレット無しの厳密バージョン**（例 `"next": "16.2.9"`）で固定する。
> - **`--no-address` の PostgreSQL VM を使う場合、サブネットで Private Google Access を有効化**しないと konlet / コンテナイメージの pull に失敗する。
> - **App Hosting backend に custom service account を割り当てた場合**、その SA に App Hosting ソースバケットの閲覧権 + `roles/firebaseapphosting.computeRunner` を付与し、参照する secret に `firebase apphosting:secrets:grantaccess` を実行する。
> - Cloud Build が Compute default SA を使う構成では `roles/cloudbuild.builds.builder` の付与が必要。
> - production deploy trigger は runtime / deploy config path だけを included files に設定し、`docs/**` や README だけの変更では本番 deploy を起動しない。必要な場合は manual trigger を明示的に実行する。
> - Cloud Build deploy は substitution 検証後に Mastra image build と Workflow Job image build を並列実行し、Firebase App Hosting deploy は backend deploy 完了後に実行する。smoke は全 deploy 完了後に実行する。`options.machineType` は指定せず、標準 worker のまま不要な直列待ちを減らす。

### 1. ローカル開発

```bash
# 全サービス + ローカルストレージ bind mount を起動
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

`docker-compose.yml` では `.data/volumes/pufu-lens-data` を `/data` に bind mount する。ホスト実行の Node scripts / Web 開発サーバーは repo 直下の `.data/volumes/pufu-lens-data` を `STORAGE_ROOT` として使い、Docker コンテナ内では `STORAGE_DRIVER=local` と `STORAGE_ROOT=/data` で同じ実体を参照する。

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
#    monorepo は infra/docker/mastra/Dockerfile で build し、Artifact Registry 経由で渡す。
gcloud builds submit --config /tmp/cb-mastra.yaml .   # docker build -f infra/docker/mastra/Dockerfile
gcloud run deploy mastra-server \
  --image asia-east1-docker.pkg.dev/PROJECT/pufu-lens/mastra-server:latest \
  --region asia-east1 \
  --service-account=mastra-runtime@PROJECT.iam.gserviceaccount.com \
  --vpc-connector=mastra-connector \
  --no-allow-unauthenticated --port 8080 \
  --set-env-vars STORAGE_DRIVER=gcs,STORAGE_BUCKET=pufu-lens-prod,GEMINI_CHAT_MODEL=gemini-2.5-flash,GEMINI_EMBEDDING_MODEL=gemini-embedding-2 \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest,GOOGLE_GENERATIVE_AI_API_KEY=GEMINI_API_KEY:latest"

# 4. Ingestion / Report Jobs デプロイ
#    共通イメージ infra/docker/jobs/Dockerfile（entrypoint scripts/workflow-job.ts）を build し、
#    各 Job に WORKFLOW_ID を設定する。WORKFLOW_INPUT_JSON は実行時 override で渡す。
for WF in curate-workflow ingest-workflow generate-report; do
  gcloud run jobs deploy "$WF" \
    --image asia-east1-docker.pkg.dev/PROJECT/pufu-lens/workflow-job:latest \
    --region asia-east1 \
    --service-account=mastra-runtime@PROJECT.iam.gserviceaccount.com \
    --vpc-connector=mastra-connector \
    --set-env-vars STORAGE_DRIVER=gcs,STORAGE_BUCKET=pufu-lens-prod,WORKFLOW_ID="$WF" \
    --set-secrets="DATABASE_URL=DATABASE_URL:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest"
done

# 5. Next.js デプロイ（Firebase App Hosting）
#    Firebase CLI >= 14.4.0 のローカルソースデプロイを使うと GitHub 連携や push なしで rollout できる。
#    apps/web/apphosting.yaml に runtime env / secrets / VPC access、リポジトリルートに firebase.json /
#    .firebaserc を置き、`firebase deploy --only apphosting` でローカルの作業ツリーをそのままデプロイする。
#    NOTE: apps/web/package.json の next は CVE ゲート回避のため厳密バージョンで固定すること（冒頭の注記参照）。
firebase apphosting:backends:create \
  --project PROJECT \
  --primary-region asia-east1 \
  --backend pufu-lens-web \
  --root-dir apps/web \
  --service-account mastra-runtime@PROJECT.iam.gserviceaccount.com \
  --non-interactive
firebase apphosting:secrets:grantaccess DATABASE_URL,AUTH_SECRET,GEMINI_API_KEY \
  --backend pufu-lens-web --location asia-east1 --project PROJECT
firebase deploy --only apphosting --project PROJECT

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
printf '%s' "$SLACK_WEBHOOK_URL_VALUE" | gcloud secrets create SLACK_WEBHOOK_URL --data-file=-
```

secret 値は shell history に残さない。ローカルの一時ファイルや環境変数から `--data-file=-` に流し込み、作業後に一時ファイルを削除する。`.env.example`、deploy script、build log には実値を出さない。

管理者が作成した Google / GitHub 連携の token と GitHub App 設定は project Settings で管理し、暗号化済み値または参照 metadata を `oauth_connections` に保存する。

Firebase App Hosting から参照する secret は、`firebase apphosting:secrets:set` で作成するか、既存の Secret Manager secret に App Hosting backend service account のアクセス権を付与する。

---
