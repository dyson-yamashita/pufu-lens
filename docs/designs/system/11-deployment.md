# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## デプロイメント

> 2026-06-19 に GCP project `pufu-lens`（asia-east1）へ end-to-end でデプロイし、PostgreSQL(AGE) VM・Mastra Server (Cloud Run)・Cloud Run Jobs・Web (Firebase App Hosting) の稼働を確認した。本番ビルドに必要だったアプリ側の修正は [ADR-004](../../adr/ADR-004-storage-module-resolution-mastra-build.md) を参照。クラウド手順を変更する際は `scripts/deploy-dry-run.ts`、`scripts/deploy-smoke.ts`、`scripts/infra-check.ts`、CI、Secret Manager 設計を同時に確認する。
>
> 既知の落とし穴（再現デプロイ時に必須）:
>
> - **Mastra Server / Cloud Run Jobs はコンテナイメージでデプロイする**。`infra/docker/mastra/Dockerfile`・`infra/docker/jobs/Dockerfile` で monorepo を build し、Artifact Registry 経由で Cloud Run / Jobs に渡す（`--source .` の buildpacks は pnpm workspace を解決できない）。
> - **App Hosting の Next.js アダプタの CVE ゲートは `package.json` の version 文字列をそのまま `semver.satisfies` に渡す**。`"next": "^16.2.x"`（キャレット付き）だと誤って "vulnerable" 判定でブロックされるため、`apps/web/package.json` では **キャレット無しの厳密バージョン**（例 `"next": "16.2.9"`）で固定する。
> - **`--no-address` の PostgreSQL VM を使う場合、サブネットで Private Google Access を有効化**しないと起動スクリプトから Secret Manager / Artifact Registry に到達できない。
> - **App Hosting backend に custom service account を割り当てた場合**、その SA に App Hosting ソースバケットの閲覧権 + `roles/firebaseapphosting.computeRunner` を付与し、参照する secret に `firebase apphosting:secrets:grantaccess` を実行する。
> - **Cloud Build の既存 App Hosting backend deploy では Firebase CLI の SA 再作成処理を限定的に回避する**。Firebase CLI 15.25.1 はローカルソース deploy のたびに既定 compute SA の作成と project IAM policy 再設定を試みるため、専用 builder の exact-match patch と deploy command だけの opt-out を使う。backend 初期作成には適用せず、deploy SA に Service Account Creator / Project IAM Admin を付与しない。
> - Cloud Build が Compute default SA を使う構成では `roles/cloudbuild.builds.builder` の付与が必要。
> - production deploy trigger は runtime / deploy config path だけを included files に設定し、`docs/**` や README だけの変更では本番 deploy を起動しない。必要な場合は manual trigger を明示的に実行する。
> - Cloud Build deploy は substitution 検証後に Mastra image build と Workflow Job image build を並列実行し、Docker build は `docker buildx` registry cache（各 image の `:buildcache` tag）を使う。Workflow Job image push 後に `_RUN_DB_MIGRATIONS=true` の場合は Cloud Run Job `${_DB_MIGRATION_JOB}` で `pnpm db:migrate` を `--wait` 付きで実行し、Mastra Server / Workflow Jobs / Firebase App Hosting deploy はその完了後に開始する。`_RUN_DB_MIGRATIONS=false` の場合も migration step は即時成功して deploy barrier として残る。Firebase App Hosting deploy は backend deploy 完了後に実行する。smoke は全 deploy 完了後に実行する。`options.machineType` は指定せず、標準 worker のまま不要な直列待ちと再 build を減らす。

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

Compute Engine のコンテナ起動エージェントと `create-with-container` は使用しない。Container-Optimized OS の VM を通常の `gcloud compute instances create` で作成し、`infra/gcp/postgres-startup.sh` を startup script metadata として渡す。このスクリプトは永続ディスク、COS host firewall、Artifact Registry 認証、Secret Manager 参照、PostgreSQL コンテナを起動ごとに冪等に構成する。移行理由と代替方式は [Compute Engine の公式移行ガイド](https://cloud.google.com/compute/docs/containers/migrate-containers)を参照する。

`infra/docker/postgres/Dockerfile` は PostgreSQL 18 をベースに、`pgvector`、`PGroonga`、`Apache AGE`、`pgcrypto` が利用できる状態でビルドする。AGE / PGroonga は PostgreSQL のメジャーバージョンと ABI が合う必要があるため、Docker build 時に対象 PostgreSQL の `pg_config` と PGroonga の PostgreSQL 18 向け package を使う。PGDG ベースの `apache/age` では APT package 名は `postgresql-18-pgdg-pgroonga` が正で、`postgresql-18-pgroonga`（Debian 標準 `postgresql-*` 向け）は使わない。

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
# 1. PostgreSQL VM 用 secret / IAM 準備（初回のみ）
POSTGRES_VM_SA=postgres-vm@PROJECT.iam.gserviceaccount.com
POSTGRES_IMAGE=asia-east1-docker.pkg.dev/PROJECT/pufu-lens/postgres-ai:latest
gcloud iam service-accounts create postgres-vm --display-name="PostgreSQL VM"
PGPASS=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)
printf '%s' "$PGPASS" | gcloud secrets create POSTGRES_PASSWORD --data-file=-
gcloud secrets add-iam-policy-binding POSTGRES_PASSWORD \
  --member="serviceAccount:${POSTGRES_VM_SA}" \
  --role=roles/secretmanager.secretAccessor
gcloud artifacts repositories add-iam-policy-binding pufu-lens \
  --location=asia-east1 \
  --member="serviceAccount:${POSTGRES_VM_SA}" \
  --role=roles/artifactregistry.reader

# 2. Direct VPC 専用 subnet と PostgreSQL firewall（初回のみ）
gcloud compute networks subnets create pufu-lens-serverless \
  --region=asia-east1 \
  --network=default \
  --range=10.9.0.0/25 \
  --enable-private-ip-google-access
gcloud compute firewall-rules create pg-ai-allow-direct-vpc \
  --network=default \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:5432 \
  --source-ranges=10.9.0.0/25 \
  --target-tags=pg-ai
gcloud compute firewall-rules create pg-ai-allow-iap \
  --network=default \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:22,tcp:5432 \
  --source-ranges=35.235.240.0/20 \
  --target-tags=pg-ai

# 3. PostgreSQL COS VM 起動（初回のみ）
gcloud compute instances create pg-ai \
  --zone=asia-east1-b \
  --machine-type=e2-custom-small-3072 \
  --image-family=cos-stable \
  --image-project=cos-cloud \
  --boot-disk-size=20GB \
  --boot-disk-type=pd-balanced \
  --create-disk=name=pg-ai-data,device-name=pg-ai-data,size=50GB,type=pd-ssd,auto-delete=no \
  --deletion-protection \
  --service-account="$POSTGRES_VM_SA" \
  --scopes=cloud-platform \
  --metadata="postgres-image=${POSTGRES_IMAGE},postgres-password-secret=POSTGRES_PASSWORD,postgres-data-disk=pg-ai-data" \
  --metadata-from-file=startup-script=infra/gcp/postgres-startup.sh \
  --network=default \
  --tags=pg-ai \
  --no-address

# 4. レポート / 元データ用 GCS バケット作成
gsutil mb -l asia-east1 gs://pufu-lens-prod

# 5. Mastra Server デプロイ（STORAGE_DRIVER=gcs）
#    monorepo は infra/docker/mastra/Dockerfile で build し、Artifact Registry 経由で渡す。
gcloud builds submit --config /tmp/cb-mastra.yaml .   # docker build -f infra/docker/mastra/Dockerfile
gcloud run deploy mastra-server \
  --image asia-east1-docker.pkg.dev/PROJECT/pufu-lens/mastra-server:latest \
  --region asia-east1 \
  --service-account=mastra-runtime@PROJECT.iam.gserviceaccount.com \
  --clear-vpc-connector \
  --network=default \
  --subnet=pufu-lens-serverless \
  --vpc-egress=private-ranges-only \
  --no-allow-unauthenticated --port 8080 \
  --set-env-vars STORAGE_DRIVER=gcs,STORAGE_BUCKET=pufu-lens-prod,PUFU_LENS_CHAT_MODEL=google/gemini-2.5-flash,PUFU_LENS_EMBEDDING_PROVIDER=gemini,PUFU_LENS_EMBEDDING_MODEL=gemini-embedding-2,PUFU_LENS_EMBEDDING_DIMENSIONS=1536 \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest,GOOGLE_GENERATIVE_AI_API_KEY=GEMINI_API_KEY:latest"

# 6. Ingestion / Report Jobs デプロイ
#    共通イメージ infra/docker/jobs/Dockerfile（entrypoint scripts/workflow-job.ts）を build し、
#    各 Job に WORKFLOW_ID を設定する。WORKFLOW_INPUT_JSON は実行時 override で渡す。
for WF in curate-workflow ingest-workflow generate-report source-sync-dispatcher report-schedule-dispatcher; do
  gcloud run jobs deploy "$WF" \
    --image asia-east1-docker.pkg.dev/PROJECT/pufu-lens/workflow-job:latest \
    --region asia-east1 \
    --service-account=mastra-runtime@PROJECT.iam.gserviceaccount.com \
    --clear-vpc-connector \
    --network=default \
    --subnet=pufu-lens-serverless \
    --vpc-egress=private-ranges-only \
    --set-env-vars STORAGE_DRIVER=gcs,STORAGE_BUCKET=pufu-lens-prod,WORKFLOW_ID="$WF" \
    --set-secrets="DATABASE_URL=DATABASE_URL:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest"
done

# ActivityPub dispatcherは公開originとActor鍵を必要とするため、通常Jobとは分けて設定する。
gcloud run jobs deploy activitypub-dispatcher \
  --image asia-east1-docker.pkg.dev/PROJECT/pufu-lens/workflow-job:latest \
  --region asia-east1 \
  --service-account=mastra-runtime@PROJECT.iam.gserviceaccount.com \
  --clear-vpc-connector \
  --network=default \
  --subnet=pufu-lens-serverless \
  --vpc-egress=private-ranges-only \
  --tasks=1 --max-retries=0 --task-timeout=3300s \
  --set-env-vars STORAGE_DRIVER=gcs,STORAGE_BUCKET=pufu-lens-prod,WORKFLOW_ID=activitypub-dispatcher,ACTIVITYPUB_ENABLED=1,ACTIVITYPUB_CANONICAL_ORIGIN=https://PUBLIC_WEB_ORIGIN \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY=ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY:latest"

# Mastra runtime service accountにはsource-sync-dispatcher、report-schedule-dispatcher、activitypub-dispatcherの各Jobで
# run.jobs.run / run.jobs.runWithOverrides権限を付与する。activitypub-dispatcherにはactive execution確認用の
# run.executions.listも対象Jobだけに付与し、
# scheduler OIDC service accountにはMastra Serverのrun.invokerを付与する。
# Cloud Schedulerは5分ごとに source sync / report schedule / ActivityPub の各 dispatcher routeへ空objectをPOSTする。
# /internal/schedules/source-sync-dispatcher:run
# /internal/schedules/report-schedule-dispatcher:run
# /internal/schedules/activitypub-dispatcher:run

# 7. Next.js デプロイ（Firebase App Hosting）
#    Fedify 2.3.4 は Node.js >=22 を要求するため、ActivityPub を有効化する backend は nodejs22 以上を選ぶ。
#    Firebase App Hosting の公式 support schedule では Next.js 16 は preview 扱いのため、Plan 017 の本番有効化前に
#    staging build と proxy.ts の WebFinger / ActivityPub routing smoke を行う。Step 1 の ACTIVITYPUB_SPIKE_ENABLED は
#    本番で設定しない。Step 2 の production endpoint は ACTIVITYPUB_ENABLED=1、固定の
#    ACTIVITYPUB_CANONICAL_ORIGIN、Secret Manager 由来の ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY が揃う場合だけ有効化する。
#    ACTIVITYPUB_DB_MAX_CONNECTIONS は process あたりの ActivityPub 用 DB pool 上限で、未指定時は5、指定時は1..20の10進整数とする。
#    Follow / Accept / Undo inboxを即時処理する環境では、App Hostingに
#    ACTIVITYPUB_INBOX_DISPATCHER_TRIGGER_ENABLED=1、PUFU_LENS_GCP_PROJECT_ID、
#    PUFU_LENS_CLOUD_RUN_JOBS_REGION、PUFU_LENS_ACTIVITYPUB_DISPATCHER_JOB_NAMEをruntime設定する。
#    Web runtimeはInbox rowのcommit後に対象Jobのrun APIだけを呼び、queue consumerにはならない。
#    token取得は2秒、Job APIは3秒で打ち切り、失敗時は5分Schedulerへフォールバックする。
#    Step 4 の activitypub-dispatcher Job は `--once` だけを受け付け、PostgreSQL queue の Follow / Accept / Undo と
#    report Create / Announce delivery をboundedに処理する。Scheduler routeは固定Mastra service URLのOIDC audienceとdesignated SAを検証し、
#    公開federation用ACTIVITYPUB_CANONICAL_ORIGINと内部ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCEを同一値とはみなさない。
#    active execution時は202 no-opにする。repositoryにはrollout定義だけを含み、本番resourceへの適用は別途行う。
#    Step 7 の dispatcherは各run後に本文なしqueue / rolling 24時間のorigin metricsを出し、Web proxyは固定route kind / method / status / status classだけを出す。
#    deploy/examples/gcp-cloud-build/activitypub-observability/apply.sh はlog-based metricsとalert policyをdry-runできる。
#    本番適用は通常のchange approvalを必須とし、lookup失敗・重複をfail closedにする。runbookは
#    docs/operations/activitypub-federation.md、production gateはdocs/operations/deploy-checklist.mdを正とする。
#    Firebase CLI >= 15.25.1 のローカルソースデプロイを使うと GitHub 連携や push なしで rollout できる。
#    apps/web/apphosting.yaml に runtime env / secrets / VPC access、リポジトリルートに firebase.json /
#    .firebaserc を置き、`firebase deploy --only apphosting` でローカルの作業ツリーをそのままデプロイする。
#    Cloud Build は事前作成済み backend への deploy に限り専用 builder の opt-out を使う。下記の workstation 手順や
#    apphosting:backends:create では opt-out を設定しない。
#    NOTE: apps/web/package.json の next は CVE ゲート回避のため厳密バージョンで固定すること（冒頭の注記参照）。
firebase apphosting:backends:create \
  --project PROJECT \
  --primary-region asia-east1 \
  --backend pufu-lens-web \
  --root-dir apps/web \
  --service-account pufu-lens-web-runtime@PROJECT.iam.gserviceaccount.com \
  --non-interactive
firebase apphosting:secrets:grantaccess DATABASE_URL,AUTH_SECRET,GEMINI_API_KEY,ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY \
  --backend pufu-lens-web --location asia-east1 --project PROJECT
firebase deploy --only apphosting --project PROJECT

# apps/web/apphosting.yaml に ACTIVITYPUB_ENABLED=1、公開Webと同じ固定ACTIVITYPUB_CANONICAL_ORIGIN、
# ACTIVITYPUB_DB_MAX_CONNECTIONS、ACTIVITYPUB_INBOX_DISPATCHER_TRIGGER_ENABLED=1、
# PUFU_LENS_GCP_PROJECT_ID、PUFU_LENS_CLOUD_RUN_JOBS_REGION、PUFU_LENS_ACTIVITYPUB_DISPATCHER_JOB_NAME、
# ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY secret referenceを含む
# runtime env / secrets / VPC accessを定義する。Mastra Serverとdispatcherも同じoriginとsecret系列を参照する。
# Web API が GCS / PostgreSQL / Mastra にアクセスするため、Mastra runtime SAとは分離した
# 専用App Hosting Web runtime SAに
# Secret Manager、GCS、Cloud Run Invoker の権限を付与する。Direct VPC network user が必要な
# Shared VPC 構成では、runtime SA ではなく provider が指定する service agent へ subnet scope で付与する。
# Admin UI から workflow job を起動する場合、およびActivityPub inboxからdispatcherを即時起動する場合は、
# 専用App Hosting Web runtime SAに対象 Cloud Run Job resource の
# run.jobs.run / run.jobs.runWithOverrides 権限を付与する。
# Admin ingestは対象ingest Jobだけ、ActivityPub即時起動は対象activitypub-dispatcher Jobだけに限定し、
# source-sync-dispatcher / report-schedule-dispatcherへ付与しない。
# 正準の IAM 要件は docs/deployment/gcp-cloud-build.md の IAM 節に従う。

gcloud run services add-iam-policy-binding mastra-server \
  --region asia-east1 \
  --member="serviceAccount:pufu-lens-web-runtime@PROJECT.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

# GCS 権限
gsutil iam ch serviceAccount:mastra-runtime@PROJECT.iam.gserviceaccount.com:objectAdmin gs://pufu-lens-prod
gsutil iam ch serviceAccount:pufu-lens-web-runtime@PROJECT.iam.gserviceaccount.com:objectViewer gs://pufu-lens-prod
```

本番 PostgreSQL VM は deletion protection を有効にする。boot disk は再構築可能なため `autoDelete=true`、DB の正である `pg-ai-data` は `autoDelete=false` とし、誤って VM を削除しても data disk が残る構成にする。意図的な VM 削除では、対象 project / zone / instance、backup、`pg-ai-data` の接続先と `autoDelete=false` を確認した後にだけ deletion protection を解除する。

既存のコンテナ起動エージェント管理 VM を移行するときは、先に `gce-container-declaration` metadata の有無を確認し、メンテナンス時間内に DB backup と `pg-ai-data` snapshot を取得する。旧 VM と新 VM から同じ永続ディスクを同時に read-write mount してはならない。旧 VM を停止してディスクを保持した後、新 VM の作成では `--create-disk` の代わりに `--disk=name=pg-ai-data,device-name=pg-ai-data,auto-delete=no` を使う。内部 IP が変わる場合は `DATABASE_URL` に新しい secret version を追加してから、Cloud Run / Jobs / App Hosting を再デプロイし、接続 smoke 後に旧 VM を削除する。

Cloud Build deploy example（`deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml`）では、Workflow Job image push 後に Cloud Run Job で `pnpm db:migrate` を実行し、Mastra Server / Workflow Jobs / Web deploy の前に schema migration を完了させる。migration target は `infra/db/migrations/*.sql` のファイル名順で、version は `.sql` を除いたファイル名、適用済み version は `public.schema_migrations` に記録される。deploy 前の手動確認として `pnpm db:migrate --check` と `pnpm db:migrate --plan` を使い、Cloud Build 側では `_RUN_DB_MIGRATIONS=true` と `_DB_MIGRATION_JOB=db-migrate` を既定とする。

Plan 018 Step 2Cの`pnpm graph:migrate rebuild|compare`はdeployやmigration Jobから自動実行しない。
productionで使用する場合は、事前backup、対象project、Object Storage読取権限、limit / resume cursor、
read-only AGE inventory、実行前後のsanitized count、rollback / forward-fix判断をdeploy checklistへ記録し、
明示承認後にoperatorがproject単位で実行する。live compareが`pass`または差分のdecision logが承認されるまで、
dual-write / shadow read、relational primary切替、AGE停止を進めない。

Plan 018 Step 2Dのapplicationは`PUFU_LENS_GRAPH_TRANSITION_MODE`をserver-only deployment profileとして読む。
未設定 / 空値 / `off`はAGE-only、`dual-write`はAGE primary + relational secondary write、
`dual-write-shadow-read`はdual-writeに加えてAGE responseを返したまま固定10%のrelational readを比較する。
未知の値はcomposition時にfail closedする。request / project単位overrideや`NEXT_PUBLIC_*`設定を追加しない。

Step 2Dのapplication mergeだけでは環境変数を設定せず、本番動作を変更しない。Issue #723のrollout configはCloud Buildの
`_GRAPH_TRANSITION_MODE`を既定`off`のallowlist付きsubstitutionとしてMastra Serverと全Workflow Jobsへ渡し、production
App Hostingだけ`dual-write`を明示する。production triggerも`dual-write`へ上書きし、3 deployment unitを同じmodeに揃える。
config mergeだけでは稼働revisionは変わらず、直前backup、対象commit、全projectのrebuild / compare decision、DB connection余力、
retry監視、sanitized observation保存先を確認した承認済みCloud Buildで初めて有効化する。その後はbackfill / compare確認を挟み、
`dual-write-shadow-read`を別deployで有効化する。shadow readは固定10%、外側6秒timeoutであり、追加DB queryのlatency /
connection / CPU costを観測する。異常時はproduction App Hostingとtrigger substitutionを`off`へ戻して再deployし、AGE primaryを
維持する。relational primaryへの変更はStep 2Eで再度明示承認を得る。

2026-09-05にIssue #723 / PR #724のmerge commit `84240ed`をCloud Build `ac4ee36c-d030-49b9-a021-088b318c0fd3`で
本番deployした。直前snapshot `pg-ai-data-pre-dual-write-20260905t064605z`は`READY`で、production trigger、App Hosting、
Mastra Server、production 6 Workflow Jobsのmodeを`dual-write`へ揃えた。readはAGE primaryを維持し、shadow read、
relational primary switch、AGE停止・削除は実施していない。

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
    networkInterfaces:
      - network: default
        subnetwork: pufu-lens-serverless

env:
  # Production dual-write rollout only. OSS examples keep this value at `off`.
  - variable: PUFU_LENS_GRAPH_TRANSITION_MODE
    value: dual-write
    availability:
      - RUNTIME
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
printf '%s' "$POSTGRES_PASSWORD_VALUE" | gcloud secrets create POSTGRES_PASSWORD --data-file=-
printf '%s' "$DATABASE_URL_VALUE" | gcloud secrets create DATABASE_URL --data-file=-
printf '%s' "$AUTH_SECRET_VALUE" | gcloud secrets create AUTH_SECRET --data-file=-
printf '%s' "$GOOGLE_CLIENT_SECRET_VALUE" | gcloud secrets create GOOGLE_CLIENT_SECRET --data-file=-
printf '%s' "$GITHUB_CLIENT_SECRET_VALUE" | gcloud secrets create GITHUB_CLIENT_SECRET --data-file=-
printf '%s' "$SLACK_WEBHOOK_URL_VALUE" | gcloud secrets create SLACK_WEBHOOK_URL --data-file=-
```

secret 値は shell history に残さない。ローカルの一時ファイルや環境変数から `--data-file=-` に流し込み、作業後に一時ファイルを削除する。`.env.example`、deploy script、build log には実値を出さない。

`POSTGRES_PASSWORD` は PostgreSQL VM 専用 service account だけに `roles/secretmanager.secretAccessor` を secret 単位で付与する。VM metadata には secret 名だけを設定し、実値は `infra/gcp/postgres-startup.sh` が起動時に取得して `/run` の root-only file 経由でコンテナへ渡す。

管理者が作成した Google / GitHub 連携の token と GitHub App 設定は project Settings で管理し、暗号化済み値または参照 metadata を `oauth_connections` に保存する。

Firebase App Hosting から参照する secret は、`firebase apphosting:secrets:set` で作成するか、既存の Secret Manager secret に App Hosting backend service account のアクセス権を付与する。

---
