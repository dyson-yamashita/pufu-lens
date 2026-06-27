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

`DATABASE_URL` を持つ環境で online migration を確認する場合は、deploy 前に次を実行する。

```bash
pnpm db:migrate --plan
pnpm infra:check --env production
```

private PostgreSQL VM を使う場合、default Cloud Build pool から DB に直接到達できないことがある。online migration は IAP tunnel を張った管理端末、または private pool など利用者環境のネットワーク設計に合わせて実行する。

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
  --substitutions "_ENV=production,_REGION=${RUNTIME_REGION},_ARTIFACT_REPO=<artifact-repo>,_RUNTIME_SERVICE_ACCOUNT=${RUNTIME_SA},_SCHEDULER_SERVICE_ACCOUNT=${SCHEDULER_SA},_STORAGE_BUCKET=<storage-bucket>,_VPC_CONNECTOR=<vpc-connector>,_MASTRA_SERVICE=mastra-server,_MASTRA_IMAGE=mastra-server,_JOBS_IMAGE=workflow-job,_FIREBASE_DEPLOY=true,_FIREBASE_TOOLS_VERSION=14.4.0"
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
- Substitution variables: deploy trigger の `_ENV`、`_REGION` などを設定する。

## IAM

最小権限は organization policy によって変わるため、次を出発点として project / repository / resource scope を絞る。

| principal              | permission area                                                                                      | note                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| CI Cloud Build SA      | Cloud Build 実行、log 書き込み                                                                       | Cloud Build で CI を使う利用者のみ。deploy 権限、Secret Manager accessor は不要 |
| Deploy Cloud Build SA  | Artifact Registry writer、Cloud Run / Jobs deploy、Firebase App Hosting deploy、Service Account User | 環境ごとに分離する                                                              |
| Runtime SA             | Secret Manager accessor、GCS access、VPC connector 利用                                              | Cloud Run service / jobs に attach する                                         |
| App Hosting compute SA | Secret Manager accessor、GCS access、Cloud Run Invoker、App Hosting compute runner                   | backend に custom SA を使う場合は特に確認する                                   |
| Scheduler SA           | OIDC caller / Cloud Run Invoker                                                                      | build / deploy 権限は不要                                                       |

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

- 対象 commit が意図したものか。
- `_ENV` が `staging` または `production` か。
- `_STORAGE_BUCKET`、`_RUNTIME_SERVICE_ACCOUNT`、`_SCHEDULER_SERVICE_ACCOUNT` が対象環境のものか。
- production trigger は approval required か。
- 実行者が approval と trigger run の権限を持つか。

production approval は、承認対象 build の commit が意図した release commit と一致することを確認してから実行する。

```bash
PROJECT_ID="<gcp-project-id>"
BUILD_REGION="<cloud-build-region>"
BUILD_ID="<pending-build-id>"

gcloud builds describe "$BUILD_ID" \
  --project "$PROJECT_ID" \
  --region "$BUILD_REGION" \
  --format 'yaml(id,status,substitutions.TRIGGER_NAME,substitutions.COMMIT_SHA,approval.state,logUrl)'
```

`status: PENDING`、`approval.state: PENDING`、`TRIGGER_NAME`、`COMMIT_SHA` を確認し、GitHub の merge commit または release commit と一致する場合だけ承認する。`gcloud beta builds approve` が対象 region の build を解決できる環境では次を使う。installed SDK が `--region` / `--location` を受け付ける場合は、必ず対象 build の region を指定する。

```bash
gcloud beta builds approve "$BUILD_ID" \
  --project "$PROJECT_ID" \
  --region "$BUILD_REGION" \
  --comment "Approved after release commit verification."
```

Cloud Build の regional build で installed SDK の `gcloud beta builds approve` が `--region` を受け付けない、または location 付き build を解決できない場合は、Cloud Build REST API で承認する。access token は表示せず、shell 変数内だけで扱う。

```bash
ACCESS_TOKEN="$(gcloud auth print-access-token)"
curl --fail-with-body -sS -X POST \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  "https://cloudbuild.googleapis.com/v1/projects/${PROJECT_ID}/locations/${BUILD_REGION}/builds/${BUILD_ID}:approve" \
  -d '{"approvalResult":{"decision":"APPROVED","comment":"Approved after release commit verification."}}'
```

承認後は `status` が `QUEUED` または `WORKING` に進むことを確認する。

```bash
gcloud builds describe "$BUILD_ID" \
  --project "$PROJECT_ID" \
  --region "$BUILD_REGION" \
  --format 'yaml(status,approval.state,approval.result.approvalTime,logUrl)'
```

失敗した build をそのまま再実行する前に、原因が config / IAM / secret / source commit のどれかを切り分ける。source commit を修正した場合は新しい commit で実行する。

## Post-deploy Verification

deploy 後は次を確認する。

- Artifact Registry に `SHORT_SHA` tag の image がある。
- Cloud Run service が `_RUNTIME_SERVICE_ACCOUNT`、VPC connector、Secret Manager reference を使っている。
- Cloud Run Jobs が deploy config の命名規則どおりに作成または更新されている。
- Web runtime が正しい App Hosting backend、secret、bucket、Mastra URL を参照している。
- `pnpm deploy:smoke --env staging` または `pnpm deploy:smoke --env production` が通る。
- build log / runtime log に secret、token、PII が出ていない。

## Deploy Duration Notes

`cloudbuild.deploy.yaml` は、substitution 検証後に Mastra Server image build と Workflow Job image build を並列で開始する。Mastra Server と Workflow Jobs はそれぞれ image push 後に deploy し、Firebase App Hosting deploy は backend 側の deploy 完了後に実行する。これにより、新しい frontend が対応する backend より先に公開される時間差を避ける。smoke check は Cloud Run service、Cloud Run Jobs、Web deploy の完了を待つ。

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

| symptom                                   | check                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| Cloud Build が deploy 権限で失敗する      | trigger の service account、Artifact Registry / Cloud Run / Firebase 権限         |
| Cloud Run が DB に接続できない            | VPC connector、firewall、Private Google Access、`DATABASE_URL` secret             |
| App Hosting が build / rollout で失敗する | `apps/web/package.json` の Next.js version、App Hosting source bucket、backend SA |
| secret 参照で失敗する                     | Secret Manager accessor、App Hosting secret grant、secret 名の typo               |
| docs-only 変更で deploy が走る            | trigger の included files                                                         |
| production が勝手に走りそう               | branch pattern、approval required、deploy SA 分離                                 |

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
