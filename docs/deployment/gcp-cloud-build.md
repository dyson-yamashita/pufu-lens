# GCP Cloud Build Deployment

この文書は、OSS 利用者が自分の GCP project で Pufu Lens をデプロイするための Cloud Build Trigger 運用手順である。

公式 repository は production deploy を自動発火しない。Trigger、IAM、Secret Manager、project id、bucket 名、backend 名は利用者の GCP project 側で管理する。

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

| file                      | purpose                                         |
| ------------------------- | ----------------------------------------------- |
| `cloudbuild.ci.yaml`      | PR / branch 用の検査。deploy しない。           |
| `cloudbuild.deploy.yaml`  | Mastra / Jobs / Web の build + deploy template  |
| `apphosting.example.yaml` | 利用者 fork / release workspace 用の Web 設定例 |

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
- CI 用 Cloud Build service account。
- staging deploy 用 Cloud Build service account。
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

`DATABASE_URL` を持つ環境で online migration を確認する場合は、deploy 前に次を実行する。

```bash
pnpm db:migrate --plan
pnpm infra:check --env staging
```

private PostgreSQL VM を使う場合、default Cloud Build pool から DB に直接到達できないことがある。online migration は IAP tunnel を張った管理端末、または private pool など利用者環境のネットワーク設計に合わせて実行する。

## Trigger Model

deploy の発火条件は `cloudbuild.deploy.yaml` ではなく Cloud Build Trigger 側で制御する。

| trigger           | event              | config                   | service account         | guard                         |
| ----------------- | ------------------ | ------------------------ | ----------------------- | ----------------------------- |
| PR CI             | Pull request       | `cloudbuild.ci.yaml`     | CI 用 SA                | deploy 権限なし               |
| staging deploy    | Push to `^main$`   | `cloudbuild.deploy.yaml` | staging deploy 用 SA    | path filter、任意で approval  |
| production deploy | Push tag `^v.*$`   | `cloudbuild.deploy.yaml` | production deploy 用 SA | approval required             |
| manual deploy     | Manual trigger run | `cloudbuild.deploy.yaml` | 環境別 deploy 用 SA     | 実行者権限、substitution 確認 |

PR trigger から deploy config を呼ばない。production trigger は dedicated service account と approval required を推奨する。

## Trigger Creation

以下の例では Cloud Build repository connection の 2nd gen repository resource を使う。

```bash
PROJECT_ID="<gcp-project-id>"
BUILD_REGION="<cloud-build-region>"
RUNTIME_REGION="<runtime-region>"
REPOSITORY_RESOURCE="projects/${PROJECT_ID}/locations/${BUILD_REGION}/connections/<connection>/repositories/<repository>"

CI_SA="projects/${PROJECT_ID}/serviceAccounts/cloud-build-ci@${PROJECT_ID}.iam.gserviceaccount.com"
STAGING_DEPLOY_SA="projects/${PROJECT_ID}/serviceAccounts/cloud-build-deploy-staging@${PROJECT_ID}.iam.gserviceaccount.com"
PRODUCTION_DEPLOY_SA="projects/${PROJECT_ID}/serviceAccounts/cloud-build-deploy-production@${PROJECT_ID}.iam.gserviceaccount.com"

RUNTIME_SA="mastra-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_SA="scheduler-oidc@${PROJECT_ID}.iam.gserviceaccount.com"
```

1st gen GitHub connection を使う場合は、`--repository` の代わりに `--repo-owner` と `--repo-name` を使う。

### PR CI Trigger

```bash
gcloud builds triggers create github \
  --project "$PROJECT_ID" \
  --region "$BUILD_REGION" \
  --name pufu-lens-pr-ci \
  --repository "$REPOSITORY_RESOURCE" \
  --pull-request-pattern '^main$' \
  --comment-control COMMENTS_ENABLED_FOR_EXTERNAL_CONTRIBUTORS_ONLY \
  --build-config deploy/examples/gcp-cloud-build/cloudbuild.ci.yaml \
  --service-account "$CI_SA" \
  --included-files 'apps/**,packages/**,scripts/**,infra/**,deploy/examples/gcp-cloud-build/**,package.json,pnpm-lock.yaml,pnpm-workspace.yaml,turbo.json,tsconfig*.json' \
  --ignored-files 'docs/**,**/*.md'
```

CI service account には deploy 権限や Secret Manager secret accessor を付けない。

### Staging Deploy Trigger

```bash
gcloud builds triggers create github \
  --project "$PROJECT_ID" \
  --region "$BUILD_REGION" \
  --name pufu-lens-staging-deploy \
  --repository "$REPOSITORY_RESOURCE" \
  --branch-pattern '^main$' \
  --build-config deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml \
  --service-account "$STAGING_DEPLOY_SA" \
  --no-require-approval \
  --included-files 'apps/**,packages/**,scripts/**,infra/**,deploy/examples/gcp-cloud-build/**,firebase.json,pnpm-lock.yaml,pnpm-workspace.yaml,package.json,turbo.json,tsconfig*.json' \
  --substitutions "_ENV=staging,_REGION=${RUNTIME_REGION},_ARTIFACT_REPO=<artifact-repo>,_RUNTIME_SERVICE_ACCOUNT=${RUNTIME_SA},_SCHEDULER_SERVICE_ACCOUNT=${SCHEDULER_SA},_STORAGE_BUCKET=<storage-bucket>,_VPC_CONNECTOR=<vpc-connector>,_MASTRA_SERVICE=mastra-server,_MASTRA_IMAGE=mastra-server,_JOBS_IMAGE=workflow-job,_FIREBASE_DEPLOY=true,_FIREBASE_TOOLS_VERSION=14.4.0"
```

staging でも手動承認を挟みたい場合は `--require-approval` を使う。

### Production Deploy Trigger

```bash
gcloud builds triggers create github \
  --project "$PROJECT_ID" \
  --region "$BUILD_REGION" \
  --name pufu-lens-production-deploy \
  --repository "$REPOSITORY_RESOURCE" \
  --tag-pattern '^v.*$' \
  --build-config deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml \
  --service-account "$PRODUCTION_DEPLOY_SA" \
  --require-approval \
  --included-files 'apps/**,packages/**,scripts/**,infra/**,deploy/examples/gcp-cloud-build/**,firebase.json,pnpm-lock.yaml,pnpm-workspace.yaml,package.json,turbo.json,tsconfig*.json' \
  --substitutions "_ENV=production,_REGION=${RUNTIME_REGION},_ARTIFACT_REPO=<artifact-repo>,_RUNTIME_SERVICE_ACCOUNT=${RUNTIME_SA},_SCHEDULER_SERVICE_ACCOUNT=${SCHEDULER_SA},_STORAGE_BUCKET=<storage-bucket>,_VPC_CONNECTOR=<vpc-connector>,_MASTRA_SERVICE=mastra-server,_MASTRA_IMAGE=mastra-server,_JOBS_IMAGE=workflow-job,_FIREBASE_DEPLOY=true,_FIREBASE_TOOLS_VERSION=14.4.0"
```

production release を tag ではなく manual trigger に寄せる場合も、production deploy service account と approval required は維持する。

## Console Creation

Cloud Console から作成する場合は、Cloud Build > Triggers で次を設定する。

- Repository: 利用者 fork または release 用 repository。
- Event: PR CI は Pull request、staging は Push to branch、production は Push new tag。
- Branch / tag pattern: `^main$` または `^v.*$`。
- Configuration: Cloud Build configuration file。
- Location: repository 内の `deploy/examples/gcp-cloud-build/cloudbuild.*.yaml`。
- Service account: CI / staging / production で分ける。
- Approval: production は required。
- Included / ignored files: docs-only 変更で deploy が走らないように設定する。
- Substitution variables: deploy trigger の `_ENV`、`_REGION` などを設定する。

## IAM

最小権限は organization policy によって変わるため、次を出発点として project / repository / resource scope を絞る。

| principal              | permission area                                                                                      | note                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| CI Cloud Build SA      | Cloud Build 実行、log 書き込み                                                                       | deploy 権限、Secret Manager accessor は不要   |
| Deploy Cloud Build SA  | Artifact Registry writer、Cloud Run / Jobs deploy、Firebase App Hosting deploy、Service Account User | staging / production で分離する               |
| Runtime SA             | Secret Manager accessor、GCS access、VPC connector 利用                                              | Cloud Run service / jobs に attach する       |
| App Hosting compute SA | Secret Manager accessor、GCS access、Cloud Run Invoker、App Hosting compute runner                   | backend に custom SA を使う場合は特に確認する |
| Scheduler SA           | OIDC caller / Cloud Run Invoker                                                                      | build / deploy 権限は不要                     |

Deploy Cloud Build SA は runtime service account を attach するため、対象 runtime SA に対する Service Account User が必要になる。

Firebase App Hosting で custom service account を使う場合は、App Hosting source bucket の read 権限、`roles/firebaseapphosting.computeRunner`、参照 secret への access grant を確認する。

## Secret Manager

secret 実値は repository、Cloud Build substitutions、issue、PR、build log に書かない。CLI で作成する場合は stdin を使う。

```bash
printf '%s' "$DATABASE_URL_VALUE" | gcloud secrets create DATABASE_URL --project "$PROJECT_ID" --data-file=-
printf '%s' "$AUTH_SECRET_VALUE" | gcloud secrets create AUTH_SECRET --project "$PROJECT_ID" --data-file=-
printf '%s' "$GEMINI_API_KEY_VALUE" | gcloud secrets create GEMINI_API_KEY --project "$PROJECT_ID" --data-file=-
```

OAuth / data source 連携を使う環境では、必要に応じて次も Secret Manager または App Hosting secret として管理する。

- `AUTH_GOOGLE_SECRET`
- `AUTH_GITHUB_SECRET`
- `GOOGLE_CLIENT_SECRET`
- `GITHUB_CLIENT_SECRET`
- `CONNECTION_SECRET_KEY`

Cloud Run resource には secret reference を渡す。secret 値そのものを `--set-env-vars` や Cloud Build substitutions に入れない。

## Firebase App Hosting

利用者 fork または release workspace で `deploy/examples/gcp-cloud-build/apphosting.example.yaml` を `apps/web/apphosting.yaml` にコピーし、placeholder を利用者環境の値へ置き換える。

`apps/web/apphosting.yaml` には project id、hosted domain、bucket 名、OAuth client id などの環境固有値が入るため、公式 repository へ実値を upstream しない。

Cloud Build から Web deploy しない場合は、deploy trigger substitution で `_FIREBASE_DEPLOY=false` を設定する。この場合 Cloud Build は Mastra Server と Workflow Jobs の deploy と smoke check を担当し、Web は Firebase App Hosting の GitHub integration など別 release process で管理する。

## Migration

DB migration は deploy とは別に明示的な手順として扱う。

```bash
pnpm db:migrate --check
pnpm db:migrate --plan
pnpm db:migrate
```

production では事前 backup、適用予定 migration、heavy migration の有無、rollback ではなく forward fix / restore が必要になるケースを記録する。詳細は `docs/operations/deploy-checklist.md` を使う。

## Manual Run And Approval

手動実行は Cloud Build > Triggers > Run trigger、または `gcloud builds triggers run` を使う。実行前に次を確認する。

- 対象 commit / tag が意図したものか。
- `_ENV` が `staging` または `production` か。
- `_STORAGE_BUCKET`、`_RUNTIME_SERVICE_ACCOUNT`、`_SCHEDULER_SERVICE_ACCOUNT` が対象環境のものか。
- production trigger は approval required か。
- 実行者が approval と trigger run の権限を持つか。

失敗した build をそのまま再実行する前に、原因が config / IAM / secret / source commit のどれかを切り分ける。source commit を修正した場合は新しい commit / tag で実行する。

## Post-deploy Verification

deploy 後は次を確認する。

- Artifact Registry に `SHORT_SHA` tag の image がある。
- Cloud Run service が `_RUNTIME_SERVICE_ACCOUNT`、VPC connector、Secret Manager reference を使っている。
- Cloud Run Jobs が `${_ENV}-curate-workflow`、`${_ENV}-ingest-workflow`、`${_ENV}-generate-report` として作成または更新されている。
- Web runtime が正しい App Hosting backend、secret、bucket、Mastra URL を参照している。
- `pnpm deploy:smoke --env staging` または `pnpm deploy:smoke --env production` が通る。
- build log / runtime log に secret、token、PII が出ていない。

Cloud Run Job の dry-run 実行例:

```bash
gcloud run jobs execute staging-generate-report \
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

| symptom                                   | check                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| Cloud Build が deploy 権限で失敗する      | trigger の service account、Artifact Registry / Cloud Run / Firebase 権限         |
| Cloud Run が DB に接続できない            | VPC connector、firewall、Private Google Access、`DATABASE_URL` secret             |
| App Hosting が build / rollout で失敗する | `apps/web/package.json` の Next.js version、App Hosting source bucket、backend SA |
| secret 参照で失敗する                     | Secret Manager accessor、App Hosting secret grant、secret 名の typo               |
| docs-only 変更で deploy が走る            | trigger の included / ignored files                                               |
| production が勝手に走りそう               | tag pattern、approval required、deploy SA 分離                                    |

Cloud Run Job の log は次のように確認する。

```bash
gcloud logging read \
  'resource.type="cloud_run_job" AND resource.labels.job_name="<job-name>"' \
  --project "$PROJECT_ID" \
  --limit 50 \
  --format json
```

## References

- `deploy/examples/gcp-cloud-build/README.md`
- `docs/deployment/overview.md`
- `docs/designs/system/11-deployment.md`
- `docs/operations/deploy-checklist.md`
- `docs/plans/009-oss-deployment-options/overview.md`
