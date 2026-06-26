# Deployment Overview

Pufu Lens は特定の hosting provider を前提にしない。公式 repository は production deploy を自動発火せず、利用者が自分の環境に合う provider example を選び、project id、secret、IAM、trigger を自分の管理下で設定する。

この文書は provider に依存しない runtime contract を定義する。GCP Cloud Build など provider 固有の手順は `deploy/examples/<provider>/` と provider 別 document に分離する。GCP Cloud Build の trigger / IAM / Secret Manager / rollback 手順は `docs/deployment/gcp-cloud-build.md` を参照する。

## Runtime Components

| component        | 役割                                                                         | 必須要件                                                                                              |
| ---------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Web              | Next.js UI、Auth.js login、admin / public report / chat API を提供する       | `DATABASE_URL`、Auth secret、object storage、必要に応じて Mastra Server への到達性を持つ              |
| Mastra Server    | agent / workflow runtime を HTTP service として提供する                      | container image として build し、DB、object storage、LLM secret にアクセスできる                      |
| Workflow Jobs    | collect / ingest / report などの workflow entrypoint を job として実行する   | `WORKFLOW_ID` と実行時 input を受け取り、DB、object storage、LLM secret にアクセスできる              |
| PostgreSQL + AGE | project、data source、auth、graph、migration state を保持する                | PostgreSQL、Apache AGE、pgvector、pgcrypto が利用でき、migration を適用できる                         |
| Object Storage   | raw data、parsed artifacts、public report manifest、report assets を保持する | private read/write と public artifact 配信の境界を provider 側で表現できる                            |
| Secret Store     | DB URL、Auth secret、OAuth secret、LLM API key、provider token を保持する    | secret 実値を repository、build log、snapshot、issue / PR に出さず runtime へ注入できる               |
| Scheduler        | recurring collect / ingest / report を起動する                               | OIDC などで認証された workflow 起動、または provider job の manual / scheduled execution を提供できる |

## Build Artifacts

Mastra Server と Workflow Jobs は monorepo buildpacks ではなく、専用 Dockerfile から container image を作る。

- Mastra Server: `infra/docker/mastra/Dockerfile`
- Workflow Jobs: `infra/docker/jobs/Dockerfile`
- PostgreSQL + AGE image: `infra/docker/postgres/Dockerfile`

Web は provider によって build 方法が異なる。Firebase App Hosting、Amplify、container hosting、static + server runtime などの差分は provider example に閉じる。

## Required Runtime Environment

### Common

| name                        | kind   | used by                                              | note                                                                                       |
| --------------------------- | ------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `DATABASE_URL`              | secret | Web、Mastra Server、Workflow Jobs、migration scripts | PostgreSQL 接続文字列。実値は repository に置かない                                        |
| `AUTH_SECRET`               | secret | Web                                                  | Auth.js と local encrypted metadata の fallback に使う                                     |
| `STORAGE_DRIVER`            | env    | Web、Mastra Server、Workflow Jobs                    | 現在の実装値は `local` / `gcs`。production は `gcs` など managed object storage を使う     |
| `STORAGE_ROOT`              | env    | local storage                                        | local driver の root。production secret ではないが provider 固有値として扱う               |
| `STORAGE_BUCKET`            | env    | managed object storage                               | bucket / container 名。実 bucket 名は provider example や trigger substitutions で注入する |
| `APP_BASE_URL` / `AUTH_URL` | env    | Web、OAuth callbacks                                 | public origin。provider の assigned URL または custom domain を設定する                    |
| `MASTRA_API_URL`            | env    | Web                                                  | Web から Mastra Server を呼ぶ場合の internal / private service URL                         |

### LLM

| name                           | kind         | used by                                    | note                                                                                           |
| ------------------------------ | ------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY`               | secret       | Web、Mastra Server、Workflow Jobs、scripts | Google AI API key 方式で使う。Vertex AI 方式を採る provider では provider IAM へ置き換えられる |
| `GOOGLE_GENERATIVE_AI_API_KEY` | secret alias | Mastra Server                              | `GEMINI_API_KEY` と同じ secret を注入してよい                                                  |
| `GEMINI_CHAT_MODEL`            | env          | Web、Mastra Server、scripts                | chat / report model 名                                                                         |
| `GEMINI_EMBEDDING_MODEL`       | env          | ingestion scripts / jobs                   | embedding model 名                                                                             |
| `GEMINI_EMBEDDING_DIMENSIONS`  | env          | ingestion scripts / jobs                   | embedding 次元。既定値を使う場合は省略できる                                                   |
| `GOOGLE_GENAI_USE_VERTEXAI`    | env          | infra check / LLM runtime                  | Vertex AI 認証へ切り替える provider では `true` を使う                                         |

### Auth And Connections

| name                                                   | kind              | used by                       | note                                                                                                                                                  |
| ------------------------------------------------------ | ----------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`                | env / secret      | Web login                     | GitHub login を使う場合に設定する                                                                                                                     |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`            | env / secret      | Google data source connection | Gmail / Drive data source 連携用。Google はアプリログイン provider としては使わない                                                                   |
| `CONNECTION_SECRET_KEY`                                | secret            | Web、collection scripts       | project connection token metadata の暗号化 key。任意の高エントロピー文字列を SHA-256 で AES-256-GCM key に派生する。未設定時は `AUTH_SECRET` fallback |
| `AUTH_CREDENTIALS_EMAIL` / `AUTH_CREDENTIALS_PASSWORD` | local-only secret | initial admin script          | credentials user 作成時だけ使い、repository や deploy config に置かない                                                                               |

### Workflow Jobs And Smoke

| name                        | kind        | used by             | note                                                                            |
| --------------------------- | ----------- | ------------------- | ------------------------------------------------------------------------------- |
| `WORKFLOW_ID`               | env         | Workflow Jobs       | `curate-workflow`、`ingest-workflow`、`generate-report` のいずれか              |
| `WORKFLOW_INPUT_JSON`       | runtime env | Workflow Jobs       | job 実行時に override する JSON input。secret を含めない                        |
| `DRY_RUN`                   | runtime env | Workflow Jobs       | `true` の場合、外部書き込みを避ける dry-run を優先する                          |
| `MASTRA_SERVER_URL`         | env         | `pnpm deploy:smoke` | remote smoke が確認する Mastra Server URL。provider deploy 後に動的取得してよい |
| `SCHEDULER_SERVICE_ACCOUNT` | env         | `pnpm deploy:smoke` | scheduler / OIDC caller の service account identifier                           |

### Provider Identifiers

Provider 固有の project id、region、artifact repository、service account、bucket、backend 名は repository に固定しない。Cloud Build Trigger substitutions、provider console、Secret Store、Terraform などの利用者管理レイヤーで注入する。

例:

- `_ENV`
- `_REGION`
- `_ARTIFACT_REPO`
- `_RUNTIME_SERVICE_ACCOUNT`
- `_STORAGE_BUCKET`
- `_MASTRA_SERVICE`
- `_WEB_BACKEND`

## Secret Handling

secret 実値は次に置かない。

- Git repository
- `cloudbuild*.yaml` や provider example
- `.env.example`
- build log
- test snapshot
- issue / PR / release note

secret は provider の Secret Store から runtime へ注入する。CLI で作成する場合は shell history に残る `echo` や inline literal を避け、stdin や provider CLI の secret input 機能を使う。

## Storage Contract

Object Storage は次の用途を分離して扱える必要がある。

- raw collected documents
- parsed artifacts
- report artifacts
- public report manifest
- recovery / reconciliation artifacts

private data は authenticated runtime だけが読める。public report に必要な manifest / asset だけを公開または署名 URL / application API 経由で配信する。

## Database Contract

Database は PostgreSQL を前提にする。Graph 機能には Apache AGE、embedding / vector data には pgvector、id / token 補助には pgcrypto を使う。

provider が managed PostgreSQL を提供していても、Apache AGE を有効化できない場合は別の運用方式が必要になる。GCP の既存設計では Cloud SQL ではなく PostgreSQL + AGE の container / VM 構成を採る。

deployment 前後では次を確認する。

```bash
pnpm db:migrate --check
pnpm db:migrate --plan
pnpm db:migrate
```

## Verification Contract

provider example は、少なくとも次を説明する。

- CI で deploy を発火しない検査
- build artifact の作成方法
- migration の plan / apply
- runtime secret の注入方法
- smoke test の実行方法
- secret / token / PII が log に出ていないことの確認

共通検証コマンド:

```bash
pnpm deploy:dry-run
pnpm db:migrate --check
pnpm infra:check --env staging
pnpm deploy:smoke --env staging
```

`deploy:smoke` の `--env` は `staging` または `production` に限定する。provider 固有の deploy URL が実行後に決まる場合は、provider CLI で URL を取得して `MASTRA_SERVER_URL` に注入する。

## Provider Expansion Checklist

新しい provider を `deploy/examples/<provider>/` に追加するときは、アプリ本体の runtime contract を変えず、provider 固有の build / deploy / IAM / secret 注入だけを example 側へ閉じる。

追加 PR では次を確認する。

- `deploy/examples/<provider>/README.md` に、その provider が担当する runtime component を明記する。
- Web、Mastra Server、Workflow Jobs、PostgreSQL + AGE、Object Storage、Secret Store、Scheduler のうち、provider が直接扱わない component の外部依存を明記する。
- provider 固有 DSL、workflow、manifest、Terraform、CLI script は `deploy/examples/<provider>/` 配下に置く。
- root 直下の production deploy 設定や利用者固有 config を追加しない。
- `apps/**`、`packages/**`、`infra/**` の実装を provider 固有に分岐させない。
- 必須 env / secret はこの文書の runtime contract と同じ名前を優先し、provider の注入方法だけを README に書く。
- project id、account id、bucket 名、OAuth client secret、DB password、API key、token の実値を example に入れない。
- PR / preview / staging / production の発火条件、approval、path filter、rollback、manual run を provider trigger 側で説明する。
- `pnpm deploy:dry-run`、`pnpm db:migrate --check`、`pnpm infra:check --env <env>`、`pnpm deploy:smoke --env <env>` のどれをどの段階で実行するかを説明する。
- secret / token / PII が provider build log / runtime log に出ない確認方法を書く。

## Provider Comparison

provider を選ぶときは、Web hosting の可否だけでなく、Pufu Lens の runtime component 全体を配置できるかで判断する。

| 観点                | 確認すること                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------- |
| Web runtime         | Next.js server runtime、Auth callback URL、private backend 呼び出し、preview URL を扱えるか。 |
| Mastra Server       | `infra/docker/mastra/Dockerfile` から作る container image を HTTP service として動かせるか。  |
| Workflow Jobs       | `infra/docker/jobs/Dockerfile` の image を manual / scheduled job として実行できるか。        |
| PostgreSQL + AGE    | Apache AGE、pgvector、pgcrypto を有効化できる PostgreSQL を運用できるか。                     |
| Object Storage      | private raw data と public report artifact の境界を分けられるか。                             |
| Secret Store        | runtime secret を repository / build log に出さず注入できるか。                               |
| Scheduler           | OIDC などで認証された job 起動、または provider job scheduler を使えるか。                    |
| Preview Environment | PR preview が本番 DB / production secret / production storage を参照しないよう分離できるか。  |
| Production Approval | tag release、manual approval、protected environment など production guard を設定できるか。    |
| Rollback            | Web、service、jobs、DB、storage artifact を component ごとに戻せるか。                        |

## Example Directory Status

| directory                          | status      | scope                                                                                                     |
| ---------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| `deploy/examples/gcp-cloud-build/` | implemented | GCP Cloud Build / Cloud Run / Cloud Run Jobs / Firebase App Hosting の CI と deploy example。             |
| `deploy/examples/aws-amplify/`     | placeholder | AWS Amplify を Web hosting / preview entrypoint として検討するための境界メモ。backend / jobs は別途必要。 |
| `deploy/examples/docker-compose/`  | placeholder | self-hosted / local reproduction 用の配置方針メモ。production hardening は利用者環境で追加する。          |

## Provider Example Boundary

Provider example は次の境界を守る。

- provider 固有 DSL は `deploy/examples/<provider>/` に閉じる。
- root 直下に利用者固有の production deploy 設定を置かない。
- secret 名と権限は README に書くが、実値は書かない。
- branch / tag / approval / path filter など deploy 発火条件は provider trigger 側で制御する。
- OSS 公式 repository の CI 方針と利用者 fork の deploy 方針を混同しない。

## References

- `deploy/examples/aws-amplify/README.md`
- `deploy/examples/docker-compose/README.md`
- `deploy/examples/gcp-cloud-build/README.md`
- `docs/deployment/gcp-cloud-build.md`
- `docs/designs/system/11-deployment.md`
- `docs/operations/deploy-checklist.md`
- `docs/plans/009-oss-deployment-options/overview.md`
