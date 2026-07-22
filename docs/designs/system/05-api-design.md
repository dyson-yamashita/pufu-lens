# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## API デザイン

この章は Browser / public / internal / CLI / server action の入口を一覧する。現状（2026-07-17）は、管理操作の多くが Next.js server action と Node CLI で実装されており、REST API として未実装の項目もある。表の `実装状況` を正とし、未実装 API を現在形で扱わない。

### 1. 共通ルール

- Browser から呼ばれる project 配下の入口は URL の `projectSlug` を受け取り、server side で `projects.id` に解決する。
- Private 入口は Auth.js session と `project_members` を検証する。admin 操作は `project_members.role = 'admin'` を要求する。
- Public 入口は private project / private report の存在有無を漏らさない。
- OAuth token、refresh token、cookie、DB password、Gemini API key は response / log / trace に出さない。
- public report / public chat は private report / private chat と同じ処理を使う。public 入口は `projects.visibility = 'public'` と `reports.is_public = true` を DB で確認し、private project では public report / public chat を許可しない。
- Chat / Report 生成で使う `raw-document-fetch` は [Agent Raw Read View](07-chat.md#agent-raw-read-view--raw-document-fetch-契約) を返す。raw 本文全文・private locator は response / log / trace に出さない。Public Chat は private chat と同じ処理を使うため、入口の public project / public report 判定を必ず先に通す。Public Chat の response sources は web 由来だけに制限する。

### 2. 実装済み Next.js API Route

| Method  | Path                                                         | 認可           | 実装状況      | 用途                                                    |
| ------- | ------------------------------------------------------------ | -------------- | ------------- | ------------------------------------------------------- |
| `GET`   | `/api/public/projects`                                       | public         | implemented   | public project と公開済み report の一覧                 |
| `GET`   | `/api/public/projects/[projectSlug]/reports/[reportId]`      | public         | implemented   | project-scoped public report（private report JSON）     |
| `POST`  | `/api/public/projects/[projectSlug]/reports/[reportId]/chat` | public         | implemented   | project-scoped public chat（private chat と同じ処理）   |
| `POST`  | `/api/public/projects/[projectSlug]/graph`                   | public         | implemented   | public project の Graph Viewer fixed preset 実行        |
| `GET`   | `/api/public/reports/[reportId]`                             | public         | compatibility | 旧 public report alias。正規 API は project-scoped path |
| `POST`  | `/api/public/reports/[reportId]/chat`                        | public         | compatibility | 旧 public chat alias。正規 API は project-scoped path   |
| `POST`  | `/api/projects/[projectSlug]/chat`                           | project member | implemented   | private chat                                            |
| `GET`   | `/api/projects/[projectSlug]/reports`                        | project member | implemented   | private report 一覧                                     |
| `GET`   | `/api/projects/[projectSlug]/reports/[reportId]`             | project member | implemented   | private report 取得                                     |
| `PATCH` | `/api/projects/[projectSlug]/reports/[reportId]`             | project admin  | implemented   | report 公開/非公開 metadata 更新                        |
| `POST`  | `/api/projects/[projectSlug]/graph`                          | project member | implemented   | Graph Viewer fixed preset 実行                          |
| `GET`   | `/api/connections/google/start`                              | login required | implemented   | Google connection 開始                                  |
| `GET`   | `/api/connections/google/callback`                           | login required | implemented   | Google connection callback                              |
| `GET`   | `/api/connections/github/start`                              | login required | implemented   | GitHub connection 開始                                  |
| `GET`   | `/api/connections/github/callback`                           | login required | implemented   | GitHub connection callback                              |

### 3. Server Action / UI 内部入口

| 入口                                           | 認可                  | 実装状況      | 用途                                                                    |
| ---------------------------------------------- | --------------------- | ------------- | ----------------------------------------------------------------------- |
| `apps/web/src/admin-actions.ts`                | project admin         | server-action | project、member、data source、parser、report、collection 実行の管理操作 |
| `apps/web/src/ui.tsx` 内 server action         | session / action ごと | server-action | UI からの軽量操作                                                       |
| `apps/web/app/login/page.tsx` 内 server action | public                | server-action | credentials sign-in                                                     |

管理 API として REST 化されていない操作は、現状では server action を正規入口として扱う。将来 REST API を追加する場合は、server action と同じ認可 SQL / runtime validation を共有する。

Data Sources 詳細の content preview は初期実装では REST API を増やさず、`apps/web/src/admin-db.ts` の server-side loader と Next.js server component から読む。`projectSlug` と `dataSourceId` の組み合わせを DB で検証し、他 project の data source を返さない。

### 4. CLI / Job 入口

| コマンド / script                                                 | 実装状況           | 用途                                                           |
| ----------------------------------------------------------------- | ------------------ | -------------------------------------------------------------- |
| `scripts/create-project.ts`                                       | cli                | project 作成、graph name / storage prefix 初期化               |
| `scripts/collect-source.ts` / `scripts/collect-fixture-source.ts` | cli                | source 収集、raw 保存、queue 投入                              |
| `scripts/parse-raw-documents.ts`                                  | cli                | raw parse                                                      |
| `scripts/resolve-actors.ts`                                       | cli                | actor / alias 解決                                             |
| `scripts/chunk-and-embed.ts`                                      | cli                | chunk / embedding 保存                                         |
| `scripts/index-graph-relations.ts`                                | cli                | AGE graph relation 生成                                        |
| `scripts/ingest-workflow.ts`                                      | cli                | collect 後の ingestion workflow orchestration                  |
| `scripts/workflow-job.ts`                                         | cli/job-entrypoint | Cloud Run Job 目標の entrypoint。現状は Node script として実行 |
| `scripts/source-sync-dispatcher.ts`                               | cli/job-entrypoint | due source scheduleをlease付きでone-shot実行                   |
| `scripts/report-schedule-dispatcher.ts`                           | cli/job-entrypoint | due report periodをlease付きでmaterialize・生成                |
| `scripts/generate-report.ts` / `scripts/publish-report.ts`        | cli                | report 生成 / 公開 artifact 更新                               |
| `scripts/deploy-dry-run.ts` / `scripts/deploy-smoke.ts`           | cli                | deploy 前検査 / smoke                                          |

### 5. Planned API

| Method  | Path                                                      | 認可           | 実装状況    | 用途                                                           |
| ------- | --------------------------------------------------------- | -------------- | ----------- | -------------------------------------------------------------- |
| `GET`   | `/api/projects`                                           | login required | planned     | member project 一覧。現状は server-side loader / UI 経路で扱う |
| `POST`  | `/api/projects`                                           | service/admin  | planned     | project 作成。現状は CLI / admin action                        |
| `GET`   | `/api/projects/[projectSlug]/data-sources`                | project member | planned     | data source 一覧。現状は admin data loader                     |
| `POST`  | `/api/projects/[projectSlug]/data-sources`                | project admin  | planned     | data source 作成。現状は server action                         |
| `PATCH` | `/api/projects/[projectSlug]/data-sources/[dataSourceId]` | project admin  | planned     | data source 更新。現状は server action                         |
| `POST`  | `/api/projects/[projectSlug]/ingestion/run`               | project admin  | planned     | ingestion 起動。現状は server action / CLI                     |
| `POST`  | `/internal/schedules/source-sync-dispatcher:run`          | scheduler OIDC | implemented | Cloud Schedulerからsource sync dispatcher Jobを起動            |
| `POST`  | `/internal/schedules/report-schedule-dispatcher:run`      | scheduler OIDC | implemented | Cloud Schedulerからreport schedule dispatcher Jobを起動        |
| `POST`  | `/internal/jobs/[workflowId]:run`                         | internal OIDC  | planned     | internal service から Cloud Run Job 起動                       |

### 6. レート制限

- Public Chat API は `PUFU_LENS_PUBLIC_CHAT_HOURLY_LIMIT`（既定 10）、`PUFU_LENS_PUBLIC_CHAT_DAILY_LIMIT`（既定 50）、`PUFU_LENS_PUBLIC_CHAT_QUESTION_MAX_LENGTH` で制御する。
- Private Chat API は `PUFU_LENS_PRIVATE_CHAT_QUESTION_MAX_LENGTH` で質問長を制御する。request body は `{ "question": string, "includeHistory"?: boolean }` を受け取り、`includeHistory` 省略時は `true`。request 数の永続 rate limit は未実装。
- Public Report API の永続 rate limit は未実装。必要になった時点で trusted proxy IP の扱いと storage-only 経路の rate limit store を設計する。

### 7. Graph API

`POST /api/projects/[projectSlug]/graph` は Graph Viewer の fixed preset 実行 API である。

- request では `queryId`、optional な `limit`（Documents 上限）、optional な `periodStart` / `periodEnd`（`YYYY-MM-DD`）だけを受け取り、Cypher 文字列や graph name は受け取らない。
- `limit` は返却 Cypher 行数ではなく、対象 Document 数の上限として解釈する。選択肢は 50 / 100 / 200 / 500。Actor / Topic ノードは上限に含めない。
- `periodStart` / `periodEnd` は blank 省略可。両方 blank のときは occurred_at による絞り込みを行わない。片側 blank はその側を unbounded とする。両方指定時は `periodStart <= periodEnd` を要求する。`periodEnd` は inclusive（`occurred_at < periodEnd + 1 day`）として解釈する。
- server side registry の preset だけを実行する。
- project membership を検証し、`projects.graph_name` から対象 graph を解決する。
- eligible Document は `public.documents` から `project_id`、optional な occurred_at 境界、決定論的 ORDER（`occurred_at DESC NULLS LAST`、tie-breaker 付き）、`LIMIT` で `graph_node_id` を選び、固定 preset Cypher へ agtype パラメータとして渡す。
- response では `documentCount` を normalized graph 内の Document ノード数（`labels` に `Document` を含む node 数、`limit` 以下）、`rowCount` / `rawRows` を AGE 生結果行数として返す。固定 preset Cypher には server-owned な raw result-row 安全上限（現行 preset では `maxEdges = 500` の `LIMIT`）を付与し、request 入力から制御できない。normalize 後の node / edge 安全上限と statement timeout も持つ。

`POST /api/public/projects/[projectSlug]/graph` は public project 用の同等 API である。未ログインで利用できるが、`projects.visibility = 'public'` の project だけを許可し、request から Cypher 文字列や graph name は受け取らない。Documents 上限と occurred_at 期間フィルタの意味論は private API と同じ。公開 UI では graph node / edge / property を表示する一方、document chunk 一覧と chunk 詳細は取得・表示しない。

### 8. Public API

public report / chat は `projectSlug` と `reportId` を path で受け取る project-scoped path を正規 API とする。旧 `/api/public/reports/[reportId]?projectSlug=...` は互換 alias として扱う。

public chat は report-scoped path のみを正規入口とし、DB で public project と公開済み report を確認してから private chat と同じ `private-chat-search` Workflow を streaming 実行する。最終合成は同じ project chat agent を使い、workflow progress と公開用に変換した result を NDJSON で返す。期間表現の基準時刻 `nowIso` はPrivate Chatと共通のserver-side workflow clientが設定し、ブラウザrequestからは受け取らない。ブラウザから渡された `projectId`、`storageUri`、`sourceUri`、artifact URI は信用しない。

---
