---
name: gcp-deploy
description: Deploy the Pufu Lens stack (PostgreSQL+AGE VM, Mastra Server on Cloud Run, Cloud Run Jobs, Next.js Web on Firebase App Hosting) to a GCP project. Use when asked to deploy to GCP, stand up a new environment, or reproduce the cloud deployment. Parameterize PROJECT_ID/REGION; never hardcode secrets or environment-specific values.
---

# GCP Deploy — Pufu Lens

本番相当スタックを GCP 1 プロジェクトにデプロイするための手順。`docs/designs/system/11-deployment.md` と `docs/operations/deploy-checklist.md` が正の設計、本スキルは実行順序と落とし穴のチェックリスト。

> このスキルに secret / API key / DB パスワード / 実トークン / 実 URL / 実プロジェクト ID を書かない。すべて placeholder と stdin 注入で扱う。

## Placeholders

作業前にシェルに用意する（値はコミットしない）。

```bash
PROJECT_ID=<gcp-project-id>
REGION=asia-east1            # App Hosting のアジア圏に合わせる
ZONE=${REGION}-b
REPO=pufu-lens              # Artifact Registry repository
BUCKET=<project>-prod       # GCS バケット（実 prefix はプロジェクト命名規約に従う）
RUNTIME_SA=mastra-runtime@${PROJECT_ID}.iam.gserviceaccount.com
SCHED_SA=scheduler-oidc@${PROJECT_ID}.iam.gserviceaccount.com
POSTGRES_VM_SA=postgres-vm@${PROJECT_ID}.iam.gserviceaccount.com
gcloud config set project "$PROJECT_ID"
```

## 前提

- `gcloud`（+ `gsutil`）/ `firebase` CLI(>=14.4.0) / `docker` がインストール済みでログイン済み（`gcloud auth login`、`firebase login`）。
- 課金有効なプロジェクト。VPC connector と PostgreSQL VM は常時課金が発生する。
- リポジトリの `infra/docker/{postgres,mastra,jobs}/Dockerfile` と `scripts/` を使う。

## Phase 0 — 読み取り専用チェック（クラウド非変更）

```bash
pnpm deploy:dry-run            # db:migrate --check + 3 workflow entrypoint 計画
pnpm db:migrate --check        # migration 命名/番号/履歴のオフライン検査
pnpm infra:check --env production   # 未設定の deploy 識別子を洗い出す（最初は blocked で正常）
```

## Phase 1 — API 有効化（無料・冪等）

```bash
gcloud auth application-default set-quota-project "$PROJECT_ID"
gcloud services enable \
  run.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com \
  vpcaccess.googleapis.com cloudbuild.googleapis.com cloudscheduler.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com generativelanguage.googleapis.com \
  firebase.googleapis.com firebaseapphosting.googleapis.com compute.googleapis.com storage.googleapis.com
```

## Phase 2 — Service Account

```bash
gcloud iam service-accounts create mastra-runtime --display-name "Mastra runtime (Cloud Run/Jobs)"
gcloud iam service-accounts create scheduler-oidc --display-name "Cloud Scheduler OIDC"
gcloud iam service-accounts create postgres-vm --display-name "PostgreSQL VM"
```

`mastra-runtime` を Cloud Run / Jobs / App Hosting backend の共通実行 SA として使う。
`postgres-vm` は PostgreSQL VM 専用とし、Artifact Registry の image 読み取りと `POSTGRES_PASSWORD` secret の参照だけを許可する。

## Phase 3 — Artifact Registry + GCS

```bash
gcloud artifacts repositories create "$REPO" --repository-format=docker --location "$REGION"
gsutil mb -l "$REGION" "gs://${BUCKET}"
# Cloud Build が Compute default SA を使う構成では builder ロールが要る
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')-compute@developer.gserviceaccount.com" \
  --role="roles/cloudbuild.builds.builder"
```

## Phase 4 — Secret Manager（実値は stdin 注入、絶対に echo しない）

必要な secret はデプロイ範囲で決まる。最小は `POSTGRES_PASSWORD` / `DATABASE_URL`（Phase 6 で確定）/ `AUTH_SECRET` / `GEMINI_API_KEY`。
Gemini は Google AI API key 方式（`GOOGLE_GENAI_USE_VERTEXAI=false`）。OAuth ログインや Slack 通知を使う場合のみ対応 secret を足す。

```bash
# 生成系（AUTH_SECRET 等）はシェル変数内で生成し、値を表示しない
AUTH_SECRET=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48)
printf '%s' "$AUTH_SECRET" | gcloud secrets create AUTH_SECRET --data-file=-
# ユーザー提供（API key 等）は本人に `! printf '%s' '...' | gcloud secrets create ... --data-file=-` で投入してもらう
```

ルール: 実値は shell history / log / docs / コミットに出さない。`--data-file=-` で stdin 経由。`RUNTIME_SA` に各 secret の `roles/secretmanager.secretAccessor` を付与する。

## Phase 5 — VPC connector / firewall / Private Google Access

```bash
gcloud compute networks vpc-access connectors create mastra-connector \
  --region "$REGION" --network default --range 10.8.0.0/28 \
  --min-instances 2 --max-instances 3 --machine-type e2-micro
gcloud compute firewall-rules create pg-ai-allow-iap \
  --network default --direction INGRESS --action ALLOW \
  --rules tcp:22,tcp:5432 --source-ranges 35.235.240.0/20 --target-tags pg-ai
gcloud compute firewall-rules create pg-ai-allow-connector \
  --network default --direction INGRESS --action ALLOW \
  --rules tcp:5432 --source-ranges 10.8.0.0/28 --target-tags pg-ai
# ★必須: --no-address VM がイメージを pull できるよう Private Google Access を有効化
gcloud compute networks subnets update default --region "$REGION" --enable-private-ip-google-access
```

## Phase 6 — PostgreSQL(AGE) VM

```bash
# 1) イメージ build（Cloud Build）
gcloud builds submit infra/docker/postgres \
  --tag "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/postgres-ai:latest"

# 2) PostgreSQL password を作成し、VM 専用 SA だけに参照を許可
PGPASS=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)
printf '%s' "$PGPASS" | gcloud secrets create POSTGRES_PASSWORD --data-file=-
gcloud secrets add-iam-policy-binding POSTGRES_PASSWORD \
  --member="serviceAccount:${POSTGRES_VM_SA}" \
  --role="roles/secretmanager.secretAccessor"
gcloud artifacts repositories add-iam-policy-binding "$REPO" \
  --location "$REGION" \
  --member="serviceAccount:${POSTGRES_VM_SA}" \
  --role="roles/artifactregistry.reader"

# 3) COS VM 作成（永続データディスク + host network コンテナ + 内部IP のみ）
gcloud compute instances create pg-ai \
  --zone "$ZONE" --machine-type e2-medium \
  --image-family cos-stable --image-project cos-cloud \
  --boot-disk-size 20GB --boot-disk-type pd-balanced \
  --create-disk=name=pg-ai-data,device-name=pg-ai-data,size=50GB,type=pd-ssd,auto-delete=no \
  --service-account "$POSTGRES_VM_SA" --scopes cloud-platform \
  --metadata="postgres-image=${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/postgres-ai:latest,postgres-password-secret=POSTGRES_PASSWORD,postgres-data-disk=pg-ai-data" \
  --metadata-from-file=startup-script=infra/gcp/postgres-startup.sh \
  --network default --no-address --tags pg-ai
```

注意点:

- `POSTGRES_PASSWORD` はシェル変数 `$PGPASS` から stdin で Secret Manager に作成し、値を表示しない。VM metadata には secret 名だけを渡す。VM 作成後に内部 IP を取得し、`DATABASE_URL` を Secret Manager に stdin で格納する。
- DB 名は `pufu_lens` 固定（`init.sql` が参照）。
- `infra/gcp/postgres-startup.sh` は起動のたびに永続ディスクの EXT4 初期化（未初期化時のみ）/ mount、COS host firewall、Artifact Registry 認証、Secret Manager 参照、`docker run --restart=always --network=host` を冪等に構成する。`cloud-platform` scope と Private Google Access の両方が必要。
- 起動スクリプトは DB init SQL を実行しないので、コンテナ起動後に IAP SSH 経由で `infra/docker/postgres/init.sql` を流し込む。`init.sql` は全テーブル + AGE graph + `schema_migrations` stamp を作るため、適用後は migration head 相当になる。

```bash
INTERNAL_IP=$(gcloud compute instances describe pg-ai --zone "$ZONE" --format='get(networkInterfaces[0].networkIP)')
DATABASE_URL="postgresql://pufu:${PGPASS}@${INTERNAL_IP}:5432/pufu_lens"
printf '%s' "$DATABASE_URL" | gcloud secrets create DATABASE_URL --data-file=-

until gcloud compute ssh pg-ai --zone "$ZONE" --tunnel-through-iap \
  --command 'test -n "$(docker ps -q --filter name=^/pufu-lens-postgres$ --filter status=running)"' >/dev/null 2>&1; do
  echo "Waiting for container to start..."
  sleep 10
done

gcloud compute ssh pg-ai --zone "$ZONE" --tunnel-through-iap \
  --command 'docker exec -i pufu-lens-postgres psql -v ON_ERROR_STOP=1 -U pufu -d pufu_lens' \
  < infra/docker/postgres/init.sql
```

## Phase 7 — DB migration 検証（IAP トンネル）

```bash
gcloud compute start-iap-tunnel pg-ai 5432 --local-host-port=localhost:5433 --zone "$ZONE" &
export DATABASE_URL="postgresql://pufu:${PGPASS}@localhost:5433/pufu_lens"
pnpm db:migrate --check    # online
pnpm db:migrate --plan     # no pending（init.sql 適用済みなら 0 件）
```

## Phase 8 — Mastra Server（Cloud Run）

```bash
# infra/docker/mastra/Dockerfile で monorepo を build（cloudbuild config で -f 指定）
gcloud run deploy mastra-server \
  --image "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/mastra-server:latest" \
  --region "$REGION" --service-account "$RUNTIME_SA" --vpc-connector mastra-connector \
  --no-allow-unauthenticated --port 8080 \
  --set-env-vars STORAGE_DRIVER=gcs,STORAGE_BUCKET=${BUCKET},GEMINI_CHAT_MODEL=gemini-2.5-flash,GEMINI_EMBEDDING_MODEL=gemini-embedding-2,GOOGLE_GENAI_USE_VERTEXAI=false \
  --set-secrets "DATABASE_URL=DATABASE_URL:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest,GOOGLE_GENERATIVE_AI_API_KEY=GEMINI_API_KEY:latest"
```

`mastra build` が storage を解決するには [ADR-004](../../../docs/adr/ADR-004-storage-module-resolution-mastra-build.md) の修正が必要（storage src は `.ts` 指定子、bundler externals に `@google-cloud/storage`）。

## Phase 9 — Cloud Run Jobs

```bash
for WF in curate-workflow ingest-workflow generate-report; do
  gcloud run jobs deploy "$WF" \
    --image "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/workflow-job:latest" \
    --region "$REGION" --service-account "$RUNTIME_SA" --vpc-connector mastra-connector \
    --set-env-vars STORAGE_DRIVER=gcs,STORAGE_BUCKET=${BUCKET},WORKFLOW_ID="$WF" \
    --set-secrets "DATABASE_URL=DATABASE_URL:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest"
done
```

entrypoint は `scripts/workflow-job.ts`。`WORKFLOW_INPUT_JSON` は実行時 override（必須）。dry-run smoke:
`gcloud run jobs execute generate-report --update-env-vars '^##^WORKFLOW_INPUT_JSON={"projectSlug":"<slug>","period":"weekly","dryRun":true}##DRY_RUN=true' --wait`

## Phase 10 — Web（Firebase App Hosting / ローカルソース）

```bash
firebase projects:addfirebase "$PROJECT_ID"
firebase apphosting:backends:create --project "$PROJECT_ID" --backend pufu-lens-web \
  --primary-region "$REGION" --root-dir apps/web --service-account "$RUNTIME_SA" --non-interactive
for SECRET in DATABASE_URL AUTH_SECRET GEMINI_API_KEY; do
  firebase apphosting:secrets:grantaccess "$SECRET" \
    --backend pufu-lens-web --location "$REGION" --project "$PROJECT_ID"
done
firebase deploy --only apphosting --project "$PROJECT_ID"
```

`apps/web/apphosting.yaml`（env/secrets/vpcAccess）+ ルートの `firebase.json` / `.firebaserc` が必要。env-specific 値（Mastra URL 等）は当該環境の実値を書く。

## Phase 11 — 初期アカウント登録（Credentials login）

OAuth を使わない環境、または初回管理者を Credentials login で用意する場合は、PostgreSQL VM に IAP トンネルで接続して `auth:create-user` を実行する。`PGPASS` は Phase 6 で PostgreSQL VM 作成時に使った値を一時的な shell 変数として用意し、実 password / `DATABASE_URL` は shell history / log / docs / コミットに出さない。

```bash
gcloud compute start-iap-tunnel pg-ai 5432 \
  --local-host-port=localhost:5433 \
  --zone "$ZONE" &

# Wait a moment for the tunnel to establish, then run:
DATABASE_URL="postgresql://pufu:${PGPASS}@localhost:5433/pufu_lens" \
pnpm auth:create-user -- --email '<user@example.com>' --password '<at-least-12-chars>' --name '<User Name>'
```

注意点:

- `auth:create-user` は `users` と `auth_password_credentials` を作成または更新する。
- 既存の global admin がいる場合は、作成後に `/members` で role と password を管理する。
- Project member への追加は `/projects/<projectSlug>/members` で行う。

## Critical Gotchas（再発防止）

1. **App Hosting の Next.js アダプタの CVE ゲートは `package.json` の version 文字列を `semver.satisfies` にそのまま渡す**。`"next": "^16.2.x"`（キャレット）は誤って vulnerable 判定 → ブロック。**キャレット無しの厳密版に固定**する。
2. **`--no-address` VM はサブネットの Private Google Access が必須**（無効だと起動スクリプトから Secret Manager / Artifact Registry に到達できない）。VM 専用 SA には `cloud-platform` scope、secret 単位の accessor、repository 単位の reader を付ける。
3. **App Hosting backend に custom SA を使う場合**、その SA に App Hosting ソースバケット閲覧権 + `roles/firebaseapphosting.computeRunner` を付与し、secret には `firebase apphosting:secrets:grantaccess` を実行。
4. **Cloud Build = Compute default SA** 構成では `roles/cloudbuild.builds.builder` を付与。
5. **Mastra / Jobs は `--source .`(buildpacks) では pnpm workspace を解決できない** → 専用 Dockerfile + Artifact Registry。
6. **`mastra build` の storage 解決は ADR-004 の修正が前提**。

## 失敗時の調べ方

- App Hosting build: `firebaseapphosting.googleapis.com/v1/.../builds` を REST で見て `errors[].error.message` と `buildLogsUri` を取得 → `gcloud builds log <id> --region $REGION`。
- Cloud Run Job: `gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="<job>"'`。

## まだ自動化していない

- **Cloud Scheduler**: 設計は Scheduler → Mastra 内部 API `/internal/schedules/{workflowId}:run`（OIDC）経由。この endpoint がアプリ未実装のため、実装するか直接 Jobs:run 方式にするか方針決定が必要（直接叩きは設計 doc 上は非推奨）。

## Output Shape

- `デプロイ完了`: 稼働コンポーネントと URL（非 secret）、実施した検証を列挙。
- `ブロック`: 失敗 Phase と実エラー（secret を伏せる）、次アクション。
