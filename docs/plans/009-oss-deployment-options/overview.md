# OSS Deployment Options と GCP Cloud Build 初期実装計画

## 目的

Pufu Lens を OSS として利用者が自分のクラウド環境へデプロイできるようにする。

最初の実装対象は **GCP Cloud Build / Cloud Run / Cloud Run Jobs / Firebase App Hosting** に限定する。ただし設計思想としては、将来 AWS Amplify、Docker Compose、Kubernetes、その他 managed hosting を追加できるように、provider 固有の設定を分離し、リポジトリ直下の本番デプロイ設定に固定しない。

特に次を満たす。

- 公式 repository は特定 provider への production deploy を自動発火しない。
- 利用者は `deploy/examples/` から自分の provider に合う設定を選べる。
- GCP の初期実装では Cloud Build Trigger で CI / deploy を実行できる。
- secret、project id、bucket 名、OAuth client secret、DB password などの環境固有値は repository に入れない。
- deploy provider が増えても、アプリ本体の runtime contract と検証コマンドを再利用できる。

## 前提

- 現行の正の GCP deployment 設計は `docs/designs/system/11-deployment.md` と `docs/operations/deploy-checklist.md`。
- 2026-06-19 時点で GCP project への end-to-end 手動デプロイ実績がある。
- 初期 GCP 構成は PostgreSQL(AGE) VM、Artifact Registry、Cloud Run、Cloud Run Jobs、Firebase App Hosting、GCS、Secret Manager、VPC Access を前提にする。
- Cloud Build Trigger は利用者の GCP project 側で作成する。公式 repository 側には trigger 自体や provider secret を持たせない。
- Step に着手するときは、`main` 最新化、Step 用ブランチ作成、GitHub Issue 作成を行う。

## 設計方針

### Provider-neutral な配置

deploy 設定は provider ごとの example として配置する。

```text
deploy/
  examples/
    gcp-cloud-build/
      cloudbuild.ci.yaml
      cloudbuild.deploy.yaml
      README.md
    aws-amplify/
      README.md
    docker-compose/
      README.md
docs/
  deployment/
    overview.md
    gcp-cloud-build.md
```

初期実装では `gcp-cloud-build` のみ実体を持たせる。`aws-amplify` と `docker-compose` は、今後の追加先を示す短い placeholder README までに留めるか、Step 4 以降で追加する。

### GCP 固有値の扱い

`cloudbuild*.yaml` は再利用可能な template として扱い、環境固有値は次で注入する。

- Cloud Build Trigger substitutions:
  - `_ENV`
  - `_REGION`
  - `_ARTIFACT_REPO`
  - `_RUNTIME_SERVICE_ACCOUNT`
  - `_STORAGE_BUCKET`
  - `_MASTRA_SERVICE`
  - `_WEB_BACKEND`
- Secret Manager:
  - `DATABASE_URL`
  - `AUTH_SECRET`
  - `GEMINI_API_KEY`
  - OAuth / GitHub App 関連 secret
- GCP IAM / service account:
  - CI 用 service account
  - staging deploy 用 service account
  - production deploy 用 service account

project id、実 URL、secret 値、実 bucket 名は example に直書きしない。

### Trigger と deploy 発火制御

deploy の発火条件は `cloudbuild.yaml` 内ではなく Cloud Build Trigger 側で制御する。

| trigger        | event            | build config             | 用途                                      |
| -------------- | ---------------- | ------------------------ | ----------------------------------------- |
| PR CI          | Pull request     | `cloudbuild.ci.yaml`     | lint / typecheck / test / dry-run         |
| main deploy    | Push to `^main$` | `cloudbuild.deploy.yaml` | staging または利用者既定環境へ deploy     |
| release deploy | Push tag `^v.*$` | `cloudbuild.deploy.yaml` | production deploy。approval required 推奨 |

production 相当の trigger は `require approval` を推奨する。Cloud Build service account は trigger ごとに分け、CI 用 identity が deploy 権限を持たないようにする。

### 将来 provider 追加の境界

AWS Amplify などを追加するときも、次の境界を守る。

- アプリ本体の runtime env contract は `docs/deployment/overview.md` に集約する。
- provider 固有の build / deploy DSL は `deploy/examples/<provider>/` に閉じる。
- secret の名前、必要権限、callback URL、検証手順は provider 別 README に書く。
- 公式 repository の CI / release 方針と、利用者 fork の deploy 方針を混同しない。

## Step 一覧

| step   | status      | 内容                                                            | 完了条件                                                                                        |
| ------ | ----------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Step 1 | `completed` | deployment example の情報設計と共通 runtime contract を定義する | `docs/deployment/overview.md` に provider-neutral な env / secret / service contract がまとまる |
| Step 2 | `completed` | GCP Cloud Build CI example を追加する                           | PR / branch 用 `cloudbuild.ci.yaml` と README が追加され、deploy しない検査手順が説明される     |
| Step 3 | `planned`   | GCP Cloud Build deploy example を追加する                       | Mastra / Jobs / Web の build + deploy template と trigger 設定手順が追加される                  |
| Step 4 | `planned`   | GCP deploy example の検証と運用ドキュメントを整える             | dry-run / smoke / Secret Manager / IAM / approval / rollback の手順が docs に反映される         |
| Step 5 | `planned`   | 複数 provider 追加の入口を整備する                              | AWS Amplify などを追加する際の配置ルールと比較観点が docs に残る                                |

## Step 1: Provider-neutral Runtime Contract

### 実装範囲

- `docs/deployment/overview.md` を追加する。
- Pufu Lens の runtime components を provider-neutral に説明する。
  - Web
  - Mastra Server
  - Workflow Jobs
  - PostgreSQL + AGE
  - Object Storage
  - Secret Store
  - Scheduler
- 必須 env / secret / callback URL / storage contract を整理する。
- GCP 固有名を避け、provider 固有の注入方法は provider 別 docs へリンクする。

### 受け入れ条件

- 利用者が「何を用意すればどの provider でも動くか」を把握できる。
- secret の実値を repository に置かない方針が明記されている。
- `docs/designs/system/11-deployment.md` の GCP 実績と矛盾しない。

### 対応状況

- Issue #318 で `docs/deployment/overview.md` を追加し、Web、Mastra Server、Workflow Jobs、PostgreSQL + AGE、Object Storage、Secret Store、Scheduler の provider-neutral runtime contract を整理した。
- GCP 固有の構築手順は `docs/designs/system/11-deployment.md` と後続の provider 別 document / example に分離する方針を明記した。

## Step 2: GCP Cloud Build CI Example

### 実装範囲

- `deploy/examples/gcp-cloud-build/cloudbuild.ci.yaml` を追加する。
- PR / branch trigger 用の Cloud Build 手順を README に書く。
- CI では deploy 権限を要求しない。
- `pnpm install --frozen-lockfile`、lint、typecheck、test、`pnpm deploy:dry-run`、`pnpm db:migrate --check` の扱いを決める。

### 受け入れ条件

- CI example が secret を必要最小限にできる。
- CI trigger の service account に deploy 権限が不要である。
- PR から production deploy が発火しないことが README に明記されている。

### 対応状況

- Issue #325 で `deploy/examples/gcp-cloud-build/cloudbuild.ci.yaml` と `deploy/examples/gcp-cloud-build/README.md` を追加した。
- CI example は `pnpm install --frozen-lockfile`、`pnpm format:check`、`pnpm lint`、`pnpm db:migrate --check`、`pnpm deploy:dry-run`、`pnpm typecheck`、`pnpm test` を実行し、deploy step と runtime secret を含まない。
- README に CI trigger の推奨 event、CI service account に deploy 権限を付与しないこと、production deploy は別 trigger / 別 service account / approval で分離することを明記した。

## Step 3: GCP Cloud Build Deploy Example

### 実装範囲

- `deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml` を追加する。
- Mastra Server image を `infra/docker/mastra/Dockerfile` で build / push / deploy する。
- Workflow Job image を `infra/docker/jobs/Dockerfile` で build / push し、Cloud Run Jobs を deploy する。
- Firebase App Hosting の deploy 方法を README に整理する。
- substitutions と Secret Manager の責務を明確化する。
- デプロイ後の smoke test に必要な `MASTRA_SERVER_URL` を `gcloud run services describe` 等で動的に取得し、`SCHEDULER_SERVICE_ACCOUNT` と合わせて `pnpm deploy:smoke --env ${_ENV}` に渡す手順を検討する。

### 受け入れ条件

- GCP project id、secret 値、実 bucket 名が example に含まれない。
- deploy trigger の substitution 一覧が README にあり、`_ENV` は `staging` / `production` のどちらかとして `deploy:smoke` に渡される。
- production trigger では approval required と dedicated service account が推奨されている。
- 既存の `docs/operations/deploy-checklist.md` と同じ検証観点を参照できる。

## Step 4: GCP Verification / Operations Docs

### 実装範囲

- `docs/deployment/gcp-cloud-build.md` を追加する。
- Cloud Build Trigger の作成手順を console / gcloud のどちらか、または両方で記載する。
- IAM、Secret Manager、Artifact Registry、Cloud Run、Jobs、Firebase App Hosting、VPC connector の前提を整理する。
- rollback、manual run、approval、included / ignored files、tag release の運用を記載する。

### 受け入れ条件

- 新規利用者が GCP project 側で trigger を作成できる。
- deploy 発火条件が branch / tag / approval / path filter で説明されている。
- secret / token / PII が build log に出ない検証項目がある。

## Step 5: Multi-provider Expansion Guide

### 実装範囲

- `docs/deployment/overview.md` に provider 追加時の checklist を追加する。
- `deploy/examples/aws-amplify/README.md` など、将来 provider 用の配置方針を最小限で示す。
- provider 比較観点を整理する。
  - runtime components の適合性
  - DB / AGE の運用方法
  - object storage
  - secret store
  - scheduler / job 実行
  - preview environment
  - production approval

### 受け入れ条件

- GCP 初期実装が AWS Amplify などの将来追加を前提にした命名・配置になっている。
- provider ごとの deploy DSL がアプリ本体や root config に漏れない。

## 検証方針

- ドキュメント検証:
  - `docs/designs/system/11-deployment.md` と矛盾しない。
  - `docs/operations/deploy-checklist.md` の secret / IAM / smoke 観点を参照している。
  - `completed` / `deprecated` plan に依存しない。
- Cloud Build dry-run:
  - CI config は deploy step を含まない。
  - deploy config は substitutions 未設定時に分かりやすく失敗する。
  - secret 値をログに出さない。
- GCP 実行検証:
  - Artifact Registry に image が push される。
  - Cloud Run service / Jobs が指定 service account で更新される。
  - Firebase App Hosting deploy が成功する。
  - `pnpm deploy:smoke --env <env>` が通る。

## 未決事項

- 公式 repository 自体に CI を置くか、OSS 利用者向け example のみに留めるか。
- Firebase App Hosting deploy を Cloud Build から実行するか、利用者の workstation / release process から実行するか。
- production release を `main` push、tag push、manual trigger のどれに寄せるか。
- AWS Amplify が担当できる範囲を Web のみとするか、backend / jobs まで含める別 AWS 構成を設計するか。

## 参照

- `docs/designs/system/11-deployment.md`
- `docs/operations/deploy-checklist.md`
- `.codex/skills/gcp-deploy/SKILL.md`
