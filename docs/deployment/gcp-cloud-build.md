# GCP Cloud Build Deployment

この文書は、OSS 利用者が自分の GCP project で Pufu Lens をデプロイするための Cloud Build Trigger 運用手順である。

公式 repository は provider 固有の production deploy 設定を必須にしない。Trigger、IAM、Secret Manager、project id、bucket 名、backend 名は利用者の GCP project 側で管理する。

Pufu Lens の現在の GCP project では、GitHub Actions を PR / push CI、Cloud Build を production deploy 専用として使う。Cloud Build の PR CI trigger は作らず、`main` merge 後に production deploy trigger が起動し、Cloud Build approval 後に deploy を進める。

## Scope

この手順は次の GCP runtime を対象にする。

- Mastra Server: Cloud Run service
- Workflow Jobs: Cloud Run Jobs
- Web: Firebase App Hosting
- Database: PostgreSQL + AGE VM
- Object Storage: GCS
- Secret Store: Secret Manager
- Build / Deploy: Cloud Build Trigger

Cloud Build config の example は `deploy/examples/gcp-cloud-build/` にある。

| file                      | purpose                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `cloudbuild.ci.yaml`      | OSS 利用者向けの任意 CI 例。Pufu Lens 公式運用では GitHub Actions CI を使う。 |
| `cloudbuild.deploy.yaml`  | Mastra / Jobs / Web の build + deploy template                                |
| `apphosting.example.yaml` | 利用者 fork / release workspace 用の Web 設定例                               |

## Preconditions

Trigger を有効化する前に、利用者の GCP project で次を用意する。

- Billing が有効な GCP project。
- Cloud Build から参照できる GitHub connection / repository。
- Artifact Registry Docker repository。
- PostgreSQL + AGE VM、VPC、firewall、Private Google Access。
- Cloud Run / Cloud Run Jobs から DB に到達するための VPC connector。
- GCS bucket。
- Firebase project と App Hosting backend。
- Secret Manager secrets。
- production deploy 用 Cloud Build service account。
- runtime service account。
- scheduler / OIDC caller 用 service account。

必要な API の代表例:

```bash
gcloud services enable \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  cloudresourcemanager.googleapis.com \
  cloudscheduler.googleapis.com \
  compute.googleapis.com \
  firebase.googleapis.com \
  firebaseapphosting.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  logging.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  serviceusage.googleapis.com \
  storage.googleapis.com \
  vpcaccess.googleapis.com
```

Google AI API key 方式を使う場合は `generativelanguage.googleapis.com` も有効化する。Vertex AI 方式を使う場合は、provider IAM と runtime env を利用者環境に合わせて追加する。

## Local Readiness Checks

Trigger 作成前に、少なくともローカルまたは CI で次を確認する。

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm db:migrate --check
pnpm deploy:dry-run
pnpm typecheck
pnpm test
```

`DATABASE_URL` を持つ環境で online migration の適用予定を deploy 前に確認する場合は、次を実行する。

```bash
pnpm db:migrate --plan
pnpm infra:check --env production
```

`pnpm db:migrate --check` は migration file 命名と `public.schema_migrations` の offline / online 整合を検査する。deploy 本番適用は `cloudbuild.deploy.yaml` の `run-db-migration` step が Cloud Run Job 経由で行う。

private PostgreSQL VM を使う場合、default Cloud Build worker pool から DB へ直接到達できない。`_RUN_DB_MIGRATIONS=true` の deploy では、Workflow Job image を使った Cloud Run Job `${_DB_MIGRATION_JOB}` が `${_VPC_CONNECTOR}` 経由で PostgreSQL に接続し、`DATABASE_URL` secret reference だけを受け取る。Cloud Build worker 自身が DB に接続するわけではない。

`_RUN_DB_MIGRATIONS=false` にして deploy 時 migration を skip する場合は、IAP tunnel を張った管理端末、private pool、または利用者環境のネットワーク設計に合わせて `pnpm db:migrate` を手動実行し、runtime rollout 前に schema を揃える。

## Trigger Model

deploy の発火条件は `cloudbuild.deploy.yaml` ではなく Cloud Build Trigger 側で制御する。

Pufu Lens の現在の GCP project では次の構成を使う。

| trigger           | event              | config                   | service account         | guard                         |
| ----------------- | ------------------ | ------------------------ | ----------------------- | ----------------------------- |
| production deploy | Push to `^main$`   | `cloudbuild.deploy.yaml` | production deploy 用 SA | approval required             |
| manual deploy     | Manual trigger run | `cloudbuild.deploy.yaml` | 環境別 deploy 用 SA     | 実行者権限、substitution 確認 |

PR / push CI は GitHub Actions の `.github/workflows/ci.yml` で実行する。Cloud Build の PR CI trigger は作らない。Cloud Build で CI を実行したい利用者は `deploy/examples/gcp-cloud-build/cloudbuild.ci.yaml` を任意で使えるが、CI trigger には deploy 権限や Secret Manager secret accessor を付けない。

production trigger は dedicated service account と approval required を維持する。release tag や staging trigger を使いたい利用者は、同じ deploy config を別 trigger / 別 service account で追加する。

## Trigger Creation

以下の例では Cloud Build repository connection の 2nd gen repository resource を使う。

```bash
PROJECT_ID="<gcp-project-id>"
BUILD_REGION="<cloud-build-region>"
RUNTIME_REGION="<runtime-region>"
REPOSITORY_RESOURCE="projects/${PROJECT_ID}/locations/${BUILD_REGION}/connections/<connection>/repositories/<repository>"

PRODUCTION_DEPLOY_SA="projects/${PROJECT_ID}/serviceAccounts/cloud-build-deploy-production@${PROJECT_ID}.iam.gserviceaccount.com"

RUNTIME_SA="mastra-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_SA="scheduler-oidc@${PROJECT_ID}.iam.gserviceaccount.com"
```

1st gen GitHub connection を使う場合は、`--repository` の代わりに `--repo-owner` と `--repo-name` を使う。

### Production Deploy Trigger

```bash
gcloud builds triggers create github \
  --project "$PROJECT_ID" \
  --region "$BUILD_REGION" \
  --name pufu-lens-production-deploy \
  --repository "$REPOSITORY_RESOURCE" \
  --branch-pattern '^main$' \
  --build-config deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml \
  --service-account "$PRODUCTION_DEPLOY_SA" \
  --require-approval \
  --included-files 'apps/**,packages/**,scripts/**,infra/**,deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml,.dockerignore,.firebaserc,firebase.json,pnpm-lock.yaml,pnpm-workspace.yaml,package.json,turbo.json,tsconfig*.json' \
  --substitutions "_ENV=production,_REGION=${RUNTIME_REGION},_ARTIFACT_REPO=<artifact-repo>,_RUNTIME_SERVICE_ACCOUNT=${RUNTIME_SA},_SCHEDULER_SERVICE_ACCOUNT=${SCHEDULER_SA},_STORAGE_BUCKET=<storage-bucket>,_VPC_CONNECTOR=<vpc-connector>,_MASTRA_SERVICE=mastra-server,_MASTRA_IMAGE=mastra-server,_JOBS_IMAGE=workflow-job,_FIREBASE_DEPLOY=true,_FIREBASE_TOOLS_VERSION=14.4.0,_RUN_DB_MIGRATIONS=true,_DB_MIGRATION_JOB=db-migrate"
```

既存 trigger を更新する場合も、同じ included files を設定する。

```bash
gcloud builds triggers update github "<trigger-id-or-name>" \
  --project "$PROJECT_ID" \
  --region "$BUILD_REGION" \
  --included-files 'apps/**,packages/**,scripts/**,infra/**,deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml,.dockerignore,.firebaserc,firebase.json,pnpm-lock.yaml,pnpm-workspace.yaml,package.json,turbo.json,tsconfig*.json'
```

`docs/**`、`README.md`、`deploy/examples/gcp-cloud-build/README.md` だけの変更は production deploy の対象外にする。deploy 手順書の変更を本番反映の契機にしたい場合は、manual trigger を明示的に実行する。

Pufu Lens の現在の GCP project では `_FIREBASE_DEPLOY=true` とし、Cloud Build から Web deploy まで実行する。`apps/web/apphosting.yaml` と Cloud Run Job 名の整合、Firebase App Hosting backend、secret access、deploy service account 権限を事前に確認する。

production release を tag や manual trigger に寄せる場合も、production deploy service account と approval required は維持する。

## Console Creation

Cloud Console から作成する場合は、Cloud Build > Triggers で次を設定する。

- Repository: 利用者 fork または release 用 repository。
- Event: production は Push to branch。
- Branch pattern: `^main$`。
- Configuration: Cloud Build configuration file。
- Location: repository 内の `deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml`。
- Service account: production deploy 用 service account。
- Approval: production は required。
- Included files: 上記 CLI 例と同じ runtime / deploy config path だけを設定し、docs-only 変更で deploy が走らないようにする。
- Substitution variables: deploy trigger の `_ENV`、`_REGION`、`_RUN_DB_MIGRATIONS`、`_DB_MIGRATION_JOB` などを設定する。

## IAM

最小権限は organization policy によって変わるため、次を出発点として project / repository / resource scope を絞る。

| principal              | permission area                                                                                                                                                                                                                                                                                      | note                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| CI Cloud Build SA      | Cloud Build 実行、log 書き込み                                                                                                                                                                                                                                                                       | Cloud Build で CI を使う利用者のみ。deploy 権限、Secret Manager accessor は不要                          |
| Deploy Cloud Build SA  | Artifact Registry writer、Cloud Run / Jobs deploy、Cloud Run Jobs create / update / execute（migration job 含む）、`cloudscheduler.jobs.create/get/update`、`cloudscheduler.locations.get`、Firebase App Hosting deploy、Service Account User、Service Usage Viewer、Browser または custom read role | 環境ごとに分離する。DB migrationと5分dispatcher Schedulerの更新権限が必要                                |
| Runtime SA             | Secret Manager accessor（`DATABASE_URL` など）、GCS access、VPC connector 利用、dispatcher Cloud Run Jobの`run.jobs.run` / `run.jobs.runWithOverrides`                                                                                                                                               | 対象dispatcher Jobに`roles/run.jobsExecutorWithOverrides`または同等custom roleをresource scopeで付与する |
| App Hosting compute SA | Secret Manager accessor、GCS access、Cloud Run Invoker、App Hosting compute runner、Admin UI から workflow job を起動する権限                                                                                                                                                                        | backend に custom SA を使う場合は特に確認する。Admin UI ingest の Job 実行権限は下記を参照               |
| Scheduler SA           | OIDC caller / Cloud Run Invoker                                                                                                                                                                                                                                                                      | build / deploy 権限は不要                                                                                |

production deploy config の `deploy-source-sync-scheduler` step は、Scheduler Job を `describe` してから `create` または `update` する。このため、Deploy Cloud Build SA には少なくとも次の権限が必要になる。

- `cloudscheduler.jobs.create`
- `cloudscheduler.jobs.get`
- `cloudscheduler.jobs.update`
- `cloudscheduler.locations.get`

organization policy で project custom role を利用できる場合は、広い `roles/cloudscheduler.admin` を既定にせず、次のように deploy 用の最小権限 role を作成して付与する。

```bash
PROJECT_ID="<gcp-project-id>"
DEPLOY_SA="cloud-build-deploy-production@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_DEPLOY_ROLE_ID="pufuLensCloudSchedulerDeployer"

cat > /tmp/pufu-lens-cloud-scheduler-deployer.yaml <<'YAML'
title: Pufu Lens Cloud Scheduler Deployer
description: Describe, create, and update Pufu Lens Cloud Scheduler jobs.
stage: GA
includedPermissions:
  - cloudscheduler.jobs.create
  - cloudscheduler.jobs.get
  - cloudscheduler.jobs.update
  - cloudscheduler.locations.get
YAML

gcloud iam roles create "$SCHEDULER_DEPLOY_ROLE_ID" \
  --project "$PROJECT_ID" \
  --file /tmp/pufu-lens-cloud-scheduler-deployer.yaml

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${DEPLOY_SA}" \
  --role="projects/${PROJECT_ID}/roles/${SCHEDULER_DEPLOY_ROLE_ID}"
```

既存の custom role を更新する場合は `gcloud iam roles update` を使う。custom role を利用できない環境では `roles/cloudscheduler.admin` が predefined role の代替になるが、Job の削除・pause・run など deploy step が使わない権限も含むため、organization の IAM 方針を確認して明示的に採用する。

Scheduler Job に `_SCHEDULER_SERVICE_ACCOUNT` の OIDC token を設定するため、Deploy Cloud Build SA には対象 Scheduler SA に対する `iam.serviceAccounts.actAs`（`roles/iam.serviceAccountUser`）も付与する。project 全体ではなく、対象 service account resource に scope を絞る。

Deploy Cloud Build SA は runtime service account を attach するため、対象 runtime SA に対する Service Account User が必要になる。Cloud Build から `firebase deploy --only apphosting` を実行する場合、Firebase CLI が有効 API と project IAM policy を確認するため `serviceusage.services.get`、`resourcemanager.projects.get`、`resourcemanager.projects.getIamPolicy` も必要になる。project scope の `roles/serviceusage.serviceUsageViewer` と `roles/browser` を付与するか、最小権限を厳格にする環境では Resource Manager の読み取り権限だけを含む custom role を付与する。

Firebase App Hosting で custom service account を使う場合は、App Hosting source bucket の read 権限、`roles/firebaseapphosting.computeRunner`、参照 secret への access grant を確認する。

Admin UI の data source ingest は Web runtime から Cloud Run Jobs API の `jobs/{job}:run` を呼び、`WORKFLOW_INPUT_JSON` を container override として渡す。Web runtime SA が workflow job を起動する環境では、対象 Job resource に対して `roles/run.jobsExecutorWithOverrides` を付与するか、`run.jobs.run` と `run.jobs.runWithOverrides` を含む custom role を付与する。Cloud Run の predefined role は project scope でも付与できるが、Admin UI が起動する対象 Job に scope を絞る。Job を作成 / 更新して runtime service account を attach する deploy principal には、別途その runtime service account への `iam.serviceAccounts.actAs`（Service Account User）が必要になる。

## Secret Manager

secret 実値は repository、Cloud Build substitutions、issue、PR、build log に書かない。CLI で作成する場合は stdin を使う。

```bash
printf '%s' "$DATABASE_URL_VALUE" | gcloud secrets create DATABASE_URL --project "$PROJECT_ID" --data-file=-
printf '%s' "$AUTH_SECRET_VALUE" | gcloud secrets create AUTH_SECRET --project "$PROJECT_ID" --data-file=-
printf '%s' "$GEMINI_API_KEY_VALUE" | gcloud secrets create GEMINI_API_KEY --project "$PROJECT_ID" --data-file=-
```

OAuth / data source 連携を使う環境では、必要に応じて次も Secret Manager または App Hosting secret として管理する。

- `AUTH_GITHUB_SECRET`
- `GOOGLE_CLIENT_SECRET`
- `GITHUB_CLIENT_SECRET`
- `CONNECTION_SECRET_KEY`

Cloud Run resource には secret reference を渡す。secret 値そのものを `--set-env-vars` や Cloud Build substitutions に入れない。

| secret name      | used by                                                               |
| ---------------- | --------------------------------------------------------------------- |
| `DATABASE_URL`   | Mastra Server、Workflow Jobs、DB migration job（`_DB_MIGRATION_JOB`） |
| `AUTH_SECRET`    | Workflow Jobs                                                         |
| `GEMINI_API_KEY` | Mastra Server、Workflow Jobs                                          |

## Firebase App Hosting

利用者 fork または release workspace で `deploy/examples/gcp-cloud-build/apphosting.example.yaml` を `apps/web/apphosting.yaml` にコピーし、placeholder を利用者環境の値へ置き換える。

`apps/web/apphosting.yaml` には project id、hosted domain、bucket 名、OAuth client id などの環境固有値が入るため、公式 repository へ実値を upstream しない。

Cloud Build から Web deploy しない場合は、deploy trigger substitution で `_FIREBASE_DEPLOY=false` を設定する。この場合 Cloud Build は Mastra Server と Workflow Jobs の deploy と smoke check を担当し、Web は Firebase App Hosting の GitHub integration など別 release process で管理する。

## Migration

`cloudbuild.deploy.yaml` は `_RUN_DB_MIGRATIONS=true`（既定）のとき、Workflow Job image push 後に Cloud Run Job `${_DB_MIGRATION_JOB}`（既定 `db-migrate`）で `pnpm db:migrate` を `--wait` 付き実行し、Mastra Server / Workflow Jobs / Firebase App Hosting deploy の前に schema migration を完了させる。migration target は `infra/db/migrations/*.sql` をファイル名順に読み、version は `.sql` を除いたファイル名、適用済み version は `public.schema_migrations` に記録される。pending migration だけが順番に適用される。

deploy 前の確認:

```bash
pnpm db:migrate --check
pnpm db:migrate --plan
```

`_RUN_DB_MIGRATIONS=false` にする場合は、Cloud Build の `run-db-migration` step は skip されるが runtime rollout 前の barrier として同じ位置に残る。この場合は Cloud Build deploy を開始する前に、IAP tunnel など DB に到達できる端末から `pnpm db:migrate` を手動実行し、schema を runtime rollout 前に必ず揃えておく。

production では事前 backup、適用予定 migration、heavy migration の有無、rollback ではなく forward fix / restore が必要になるケースを記録する。詳細は `docs/operations/deploy-checklist.md` を使う。

## Manual Run And Approval

手動実行は Cloud Build > Triggers > Run trigger、または `gcloud builds triggers run` を使う。実行前に次を確認する。

- 対象 commit が意図したものか。
- `_ENV` が `staging` または `production` か。
- `_STORAGE_BUCKET`、`_RUNTIME_SERVICE_ACCOUNT`、`_SCHEDULER_SERVICE_ACCOUNT` が対象環境のものか。
- `_RUN_DB_MIGRATIONS` が意図どおりか。`true` の場合は `${_DB_MIGRATION_JOB}` が VPC connector と `DATABASE_URL` secret に到達できるか。
- production trigger は approval required か。
- 実行者が approval と trigger run の権限を持つか。

### Approve Pending Production Build

`main` merge 後の production deploy trigger は approval required で `PENDING` になる。承認前に、古い pending build や別 trigger を誤って承認しないよう、対象 build の branch、trigger、commit を確認する。

```bash
PROJECT_ID="<gcp-project-id>"
BUILD_REGION="<cloud-build-region>"
TRIGGER_NAME="pufu-lens-production-deploy"

gcloud config set project "$PROJECT_ID"

gcloud builds list \
  --region "$BUILD_REGION" \
  --filter="approval.state=PENDING AND substitutions.TRIGGER_NAME=${TRIGGER_NAME}" \
  --format='table(id,createTime,substitutions.BRANCH_NAME,substitutions.COMMIT_SHA,substitutions.TRIGGER_NAME,status,approval.state)' \
  --limit=20
```

複数の pending build がある場合は、通常は `createTime` が最新で、`BRANCH_NAME=main`、`TRIGGER_NAME` が production deploy trigger、`COMMIT_SHA` が承認したい merge commit と一致するものだけを承認する。GitHub repository の最新 `main` と照合する例:

```bash
git ls-remote origin refs/heads/main

BUILD_ID="<pending-build-id>"

gcloud builds describe "$BUILD_ID" \
  --region "$BUILD_REGION" \
  --format='yaml(id,createTime,status,approval,substitutions.BRANCH_NAME,substitutions.COMMIT_SHA,substitutions.TRIGGER_NAME,logUrl)'
```

承認する build が確定したら、Cloud Build の regional build を承認する。`gcloud builds approve` が使える環境では stable コマンドを使ってよいが、regional approval が stable / beta に未対応の gcloud では alpha コマンドの `--location` を使う。

```bash
gcloud alpha builds approve "$BUILD_ID" \
  --location "$BUILD_REGION" \
  --comment "Approve production deploy for merged main <commit-sha>"
```

承認後は `approval.state=APPROVED`、`approval.result.decision=APPROVED`、`status=QUEUED` または `WORKING` になったことを確認する。

```bash
gcloud builds describe "$BUILD_ID" \
  --region "$BUILD_REGION" \
  --format='yaml(id,status,approval.state,approval.result.decision,approval.result.approvalTime,substitutions.COMMIT_SHA,substitutions.TRIGGER_NAME,logUrl)'
```

トークンを端末に表示して Cloud Build REST API を直接叩く運用は避ける。通常は `gcloud alpha builds approve --location` で承認できる。承認権限が不足する場合は、実行者に Cloud Build approver 相当の権限があるか、対象 project / region / trigger が正しいかを先に確認する。

失敗した build をそのまま再実行する前に、原因が config / IAM / secret / source commit のどれかを切り分ける。source commit を修正した場合は新しい commit で実行する。

## Post-deploy Verification

deploy 後は次を確認する。

- Artifact Registry に `SHORT_SHA` tag の image がある。
- `_RUN_DB_MIGRATIONS=true` の build では、Cloud Run Job `${_DB_MIGRATION_JOB}` の execute が成功している。
- migration 適用後、`public.schema_migrations` に期待どおりの version が記録されている（IAP tunnel など DB に到達できる端末から確認する）。
- Cloud Run service が `_RUNTIME_SERVICE_ACCOUNT`、VPC connector、Secret Manager reference を使っている。
- Cloud Run Jobs が deploy config の命名規則どおりに作成または更新されている。
- 5分間隔のsource sync Cloud Schedulerが1件だけ存在し、Scheduler SAのOIDCでMastra内部routeを呼べる。
- Mastra runtime SAがdispatcher Jobを起動でき、routeやJob logにtoken/secret/raw本文が出ていない。
- Web runtime が正しい App Hosting backend、secret、bucket、Mastra URL を参照している。
- Admin UI から data source ingest を実行し、Web runtime SA が対象 workflow job resource を起動できる（`run.jobs.run` / `run.jobs.runWithOverrides` 不足の 403 が出ていない）。
- `pnpm deploy:smoke --env staging` または `pnpm deploy:smoke --env production` が通る。
- build log / runtime log に secret、token、PII が出ていない。

## Deploy Duration Notes

`cloudbuild.deploy.yaml` は、substitution 検証後に Mastra Server image build と Workflow Job image build を並列で開始する。Workflow Job image push 後に `run-db-migration` step が Cloud Run Job migration を `--wait` 付きで完了させ、Mastra Server と Workflow Jobs deploy はその barrier 後に開始する。両方のdeploy後にsource sync Schedulerを作成または更新し、Firebase App Hostingとsmoke checkはSchedulerを含むbackend deployの完了を待つ。これにより、新しいfrontendが対応するbackendより先に公開される時間差を避け、runtime rollout前にschema migrationが完了する。

Docker image build は `docker buildx` の registry cache を使い、各 image の `:buildcache` tag から `--cache-from type=registry` で cache を読み、`--cache-to type=registry,mode=max` で更新する。初回や cache 未作成時は cache なしで継続し、以後の deploy では multi-stage build の中間 layer も含めて再利用を狙う。

この並列化と cache 利用は `options.machineType` を指定せず、Cloud Build の標準 worker のまま不要な直列待ちと再 build を減らす。より大きい worker を指定すると wall-clock time は短縮できる可能性があるが、build 単価が上がるため、コスト優先の環境では標準 worker を維持する。

Cloud Run Job の dry-run 実行例:

```bash
gcloud run jobs execute production-generate-report \
  --region "$RUNTIME_REGION" \
  --update-env-vars '^##^WORKFLOW_INPUT_JSON={"projectSlug":"<project-slug>","period":"weekly","dryRun":true}##DRY_RUN=true' \
  --wait
```

log 漏れの簡易確認例:

```bash
gcloud logging read \
  'resource.type="build" AND resource.labels.build_id="<build-id>"' \
  --project "$PROJECT_ID" \
  --format 'value(textPayload)' |
  grep -Ei 'postgresql://|access_token|refresh_token|client_secret|api[_-]?key|BEGIN (RSA|OPENSSH|PRIVATE)' || true
```

この grep は補助検査であり、完全な漏えい検知ではない。build step で `set -x` を使わない、secret 実値を substitution に入れない、runtime env を丸ごと出力しないことを基本にする。

## Rollback

rollback は component ごとに分けて判断する。

| component            | rollback approach                                                            |
| -------------------- | ---------------------------------------------------------------------------- |
| Cloud Run service    | 直前 revision へ traffic を戻す、または既知の image tag を再 deploy          |
| Cloud Run Jobs       | 既知の `SHORT_SHA` image tag で job を再 deploy する                         |
| Firebase App Hosting | Console で直前 rollout へ戻す、または既知の commit / workspace から再 deploy |
| Database             | 事前 backup から restore、または forward fix を作成する                      |
| GCS artifacts        | public manifest / generated assets の対象 prefix を確認して戻す              |

DB migration を伴う release では、アプリだけを旧 revision に戻しても schema と互換にならない場合がある。production approval 前に migration plan と rollback / restore 方針を確認する。

Cloud Run service の traffic rollback 例:

```bash
gcloud run services update-traffic mastra-server \
  --region "$RUNTIME_REGION" \
  --to-revisions "<previous-revision>=100"
```

## Troubleshooting

| symptom                                   | check                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Cloud Build が deploy 権限で失敗する      | trigger の service account、Artifact Registry / Cloud Run / Firebase 権限                                       |
| Cloud Run が DB に接続できない            | VPC connector、firewall、Private Google Access、`DATABASE_URL` secret、migration job / runtime job の SA attach |
| DB migration job が失敗する               | `${_DB_MIGRATION_JOB}` の execute log、Workflow Job image tag、`DATABASE_URL` secret reference、VPC connector   |
| App Hosting が build / rollout で失敗する | `apps/web/package.json` の Next.js version、App Hosting source bucket、backend SA                               |
| secret 参照で失敗する                     | Secret Manager accessor、App Hosting secret grant、secret 名の typo                                             |
| docs-only 変更で deploy が走る            | trigger の included files                                                                                       |
| production が勝手に走りそう               | branch pattern、approval required、deploy SA 分離                                                               |

Cloud Run Job の log は次のように確認する。DB migration job（`${_DB_MIGRATION_JOB}`）の失敗調査にも使う。

```bash
gcloud logging read \
  'resource.type="cloud_run_job" AND resource.labels.job_name="<job-name>"' \
  --project "$PROJECT_ID" \
  --limit 50 \
  --format json
```

`schema_migrations` の確認例（IAP tunnel など DB に到達できる端末から実行する）:

```bash
psql "$DATABASE_URL" -c 'SELECT version, applied_at FROM public.schema_migrations ORDER BY version;'
```

## References

- `deploy/examples/gcp-cloud-build/README.md`
- `docs/deployment/overview.md`
- `docs/designs/system/11-deployment.md`
- `docs/operations/deploy-checklist.md`
- `docs/plans/009-oss-deployment-options/overview.md`
