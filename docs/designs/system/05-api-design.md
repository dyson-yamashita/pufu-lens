# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## API デザイン

この章は、Next.js API Route、Mastra Server の Agent API、内部管理 API の入口と契約を集約する。詳細な業務処理は各設計章に残し、API の一覧性、認可、エラー形式、サイズ上限、project 分離の確認はこの章を基準にする。

### 1. API レイヤ

| レイヤ             | 公開範囲                 | 役割                                                                                                      |
| ------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| Next.js API        | Browser からアクセス可能 | Auth.js セッションを検証し、project 認可後に DB / Storage / Mastra Server へアクセスする                  |
| Mastra Agent API   | Cloud Run private        | Chat Agent / Workflow / Tool 実行。Next.js または内部 Job から OIDC 付きで呼ぶ                            |
| Internal Admin API | Cloud Run private        | Cloud Scheduler から workflow / job を起動する。OIDC service account と input schema を検証する           |
| Public API         | 未ログインアクセス可能   | 公開レポートと公開レポートに紐づく public chat だけを返す。非公開 report / project の存在有無は漏らさない |

### 2. 共通ルール

- Browser から呼ばれる project 配下 API は `/api/projects/[projectSlug]/...` を使う。Next.js API は最初に `projectSlug` を `projects.id` に解決し、以降の DB / Storage / Mastra 呼び出しでは UUID の `projectId` だけを使う。
- すべての `/api/projects/[projectSlug]/...` は `project_members` を確認し、ログインユーザーが対象 project の member であることを検証する。
- Admin API は `project_members.role = 'admin'` のユーザーだけ許可する。
- Mastra tool / workflow は `projectId` を必須 context とし、project をまたぐ DB / Storage / Graph 参照を禁止する。
- API key、OAuth token、refresh token、cookie、DB password、GCP credential は response / log / trace に出さない。
- raw / parsed document の取得 API はサイズ上限を持つ。上限超過や binary は本文を返さず、metadata と取得不可理由を返す。
- PostgreSQL は業務時間のみ起動する。DB 依存 API は業務時間外に DB 接続を試みず、`503 Service Unavailable` と `db_outside_business_hours` を返す。
- 公開レポート API は DB 稼働確認に依存させない。`is_public=true` として公開用 manifest / metadata に記録された redaction 済み public report JSON は Object Storage から取得し、業務時間外でも閲覧できる。private report JSON をそのまま公開しない。
- private レポート API は project member 認可のため DB 依存 API として扱う。業務時間外は DB 接続を試みず、チャットと同様に `503 Service Unavailable` と `db_outside_business_hours` を返す。
- public chat は公開済み report に紐づく限定機能とし、公開用 manifest / metadata、redaction 済み public report JSON、public context bundle だけを参照する。DB / AGE / pgvector / raw document / parsed document にはアクセスしない。
- pagination は `limit` + `cursor` を基本にする。`limit` の既定値は 50、最大値は 200 とする。
- 日時は ISO 8601 文字列、ID は UUID、project の URL / Browser API には `projectSlug`、DB / Mastra / Job / audit log の正規キーには `projectId` を使う。Browser から渡された `projectId` は信用しない。
- エラーは共通 JSON で返す。

```json
{
  "error": {
    "code": "project_not_found",
    "message": "Project not found",
    "request_id": "req_..."
  }
}
```

業務時間外の DB 依存 API は次の形式を返す。

```json
{
  "error": {
    "code": "db_outside_business_hours",
    "message": "現在は営業時間外のため、この機能を利用できません。公開済みレポートは引き続き閲覧できます。",
    "request_id": "req_..."
  }
}
```

### 3. Project API

| Method  | Path                          | 認可                            | 用途                                           |
| ------- | ----------------------------- | ------------------------------- | ---------------------------------------------- |
| `GET`   | `/api/projects`               | login required                  | ユーザーが member の project 一覧              |
| `POST`  | `/api/projects`               | admin bootstrap / service admin | project 作成、graph name / storage prefix 作成 |
| `GET`   | `/api/projects/[projectSlug]` | project member                  | project 詳細                                   |
| `PATCH` | `/api/projects/[projectSlug]` | project admin                   | project 設定更新                               |

`POST /api/projects` は `scripts/create-project.ts` と同じ validation を使い、`slug` から `graph_name` と `storage_prefix` を生成する。

### 4. Data Source / Connection API

| Method   | Path                                                      | 認可           | 用途                            |
| -------- | --------------------------------------------------------- | -------------- | ------------------------------- |
| `GET`    | `/api/projects/[projectSlug]/data-sources`                | project member | data source 一覧                |
| `POST`   | `/api/projects/[projectSlug]/data-sources`                | project admin  | data source 作成                |
| `PATCH`  | `/api/projects/[projectSlug]/data-sources/[dataSourceId]` | project admin  | data source 更新 / enabled 切替 |
| `DELETE` | `/api/projects/[projectSlug]/data-sources/[dataSourceId]` | project admin  | data source 無効化または削除    |
| `POST`   | `/api/connections/google/start`                           | login required | Google OAuth 開始               |
| `GET`    | `/api/connections/google/callback`                        | login required | Google OAuth callback           |
| `POST`   | `/api/connections/github/start`                           | login required | GitHub App / OAuth 開始         |
| `GET`    | `/api/connections/github/callback`                        | login required | GitHub callback                 |

data source 作成時は次を検証する。

- `owner_user_id` が対象 project の member であること。
- `gmail` / `drive` は Google connection、`github` は GitHub connection を使うこと。
- connection の scope が source type の読み取りに必要な権限を満たすこと。
- `web` data source は `connection_id = null` であること。
- `config` と `ingest_window` は source type ごとの schema に合うこと。

### 5. Ingestion 管理 API

| Method | Path                                                                | 認可           | 用途                                               |
| ------ | ------------------------------------------------------------------- | -------------- | -------------------------------------------------- |
| `GET`  | `/api/projects/[projectSlug]/ingestion/status`                      | project member | raw / queue / failed / indexed 件数と最終実行時刻  |
| `GET`  | `/api/projects/[projectSlug]/ingestion/queue`                       | project member | queue 一覧                                         |
| `POST` | `/api/projects/[projectSlug]/ingestion/collect`                     | project admin  | 手動 collect 起動                                  |
| `POST` | `/api/projects/[projectSlug]/ingestion/run`                         | project admin  | collect 済み対象の ingestion 起動                  |
| `POST` | `/api/projects/[projectSlug]/ingestion/retry`                       | project admin  | failed queue の再試行                              |
| `GET`  | `/api/projects/[projectSlug]/parser-profiles`                       | project member | parser profile / active version 一覧               |
| `POST` | `/api/projects/[projectSlug]/parser-profiles`                       | project admin  | parser profile 作成                                |
| `POST` | `/api/projects/[projectSlug]/parser-profiles/[profileId]/versions`  | project admin  | draft parser version 作成                          |
| `POST` | `/api/projects/[projectSlug]/parser-versions/[versionId]/validate`  | project admin  | held raw / fixture に対する validation report 作成 |
| `POST` | `/api/projects/[projectSlug]/parser-versions/[versionId]/approve`   | project admin  | parser version 承認と active 化                    |
| `POST` | `/api/projects/[projectSlug]/parser-versions/[versionId]/reject`    | project admin  | parser version 却下                                |
| `GET`  | `/api/projects/[projectSlug]/raw-documents/[rawDocumentId]`         | project member | raw document metadata                              |
| `GET`  | `/api/projects/[projectSlug]/raw-documents/[rawDocumentId]/content` | project member | サイズ上限内の原本取得                             |
| `GET`  | `/api/projects/[projectSlug]/documents/[documentId]`                | project member | document metadata / summary                        |
| `GET`  | `/api/projects/[projectSlug]/documents/[documentId]/parsed`         | project member | parsed JSON 取得                                   |

`raw-documents/.../content` と `documents/.../parsed` は、通常ログに本文全文を出さない。PII を含む可能性があるため、監査ログには user id、project id、document id、byte size、結果 status のみを残す。

### 6. Chat API

| Method | Path                                  | 認可           | 用途                               |
| ------ | ------------------------------------- | -------------- | ---------------------------------- |
| `POST` | `/api/projects/[projectSlug]/chat`    | project member | Private Chat Agent へ stream proxy |
| `POST` | `/api/public/reports/[reportId]/chat` | public         | Public Chat Agent へ stream proxy  |

Private Chat API では、Next.js は Auth.js session と project membership を検証した後、Mastra Server の Agent API へ OIDC 付きで proxy する。

Private Chat API は DB / AGE / pgvector に依存するため、業務時間外は Mastra Server へ proxy せず `503 Service Unavailable` を返す。

```text
Browser -> Next.js /api/projects/[projectSlug]/chat
Next.js -> Mastra Server /api/agents/project-chat-agent/stream
```

request body には `messages` と UI 側 metadata を受け取り、Next.js が `projectSlug` から解決した `projectId` を server side で追加する。ブラウザから渡された `projectId` は信用しない。

Public Chat API は未ログインで利用できるが、対象は `is_public=true` の report に限定する。Next.js は公開用 manifest / metadata で report の公開状態を確認し、redaction 済み public report JSON と公開用 context bundle URI を server side で解決して Public Chat Agent に渡す。ブラウザから渡された `projectId`、`storageUri`、`sourceUri`、`artifactVersion` は信用しない。

Public Chat Agent の tool は、ユーザー入力や LLM が指定した URI を読まない。Next.js が検証済み manifest から解決した `reportId`、`artifactVersion`、`public_report_uri`、`public_context_bundle_uri` のみを内部 context として渡し、tool 側でも対象 report、許可 prefix、etag / artifact version の一致を確認する。

Public Chat Agent のルール：

- redaction 済み public report JSON、公開用 summary、公開許可された source snippet だけを根拠にする。
- 個人情報、メールアドレス、OAuth 情報、未公開 URL、raw / parsed の本文全文を出さない。
- 公開 report の内容と対象 project の公開済み情報に関係しない質問には回答しない。
- project 内部の未公開データ、他 project、一般雑談、コード生成、外部調査の依頼は拒否する。
- 回答には report section id や公開 source id など、公開可能な根拠だけを含める。

### 7. Report API

| Method  | Path                                                        | 認可           | 用途                                                    |
| ------- | ----------------------------------------------------------- | -------------- | ------------------------------------------------------- |
| `GET`   | `/api/projects/[projectSlug]/reports`                       | project member | report 一覧                                             |
| `POST`  | `/api/projects/[projectSlug]/reports/generate`              | project admin  | report 手動生成                                         |
| `GET`   | `/api/projects/[projectSlug]/reports/[reportId]`            | project member | report JSON 本体                                        |
| `GET`   | `/api/projects/[projectSlug]/reports/[reportId]/signed-url` | project member | private report の短時間 signed URL                      |
| `PATCH` | `/api/projects/[projectSlug]/reports/[reportId]`            | project admin  | `is_public` など metadata 更新                          |
| `GET`   | `/api/public/reports/[reportId]`                            | public         | `is_public = true` の redaction 済み public report JSON |

private report の閲覧・一覧・signed URL 発行・公開状態更新は DB 依存 API として扱う。ログイン済み session と `project_members` を PostgreSQL で検証し、業務時間外は DB 接続を試みず `503 Service Unavailable` と `db_outside_business_hours` を返す。

public report は公開用 manifest または storage metadata で `is_public=true` を判定し、redaction 済み public report JSON を Object Storage から取得して返す。業務時間外でも閲覧可能にするが、非公開・存在しない・無効な場合は同じ `404` を返し、private report の存在有無を漏らさない。

### 8. Internal Scheduler / Job API

| Method | Path                                   | 認可                           | 用途                                    |
| ------ | -------------------------------------- | ------------------------------ | --------------------------------------- |
| `POST` | `/internal/schedules/[workflowId]:run` | Scheduler service account OIDC | Cloud Scheduler から workflow 起動      |
| `POST` | `/internal/jobs/[workflowId]:run`      | internal service account OIDC  | 管理 UI / job runner から workflow 起動 |

Internal API は public ingress から直接使わせない。Mastra Server 側で OIDC issuer / audience / service account を検証し、body を workflow input schema で validate してから Cloud Run Jobs API に渡す。

parser approval API は project admin だけが実行できる。承認 API は artifact hash、validation report URI、対象 parser profile、対象 source type を監査ログに残し、承認済み version だけを Ingestion Workflow の parser selection 対象にする。未承認 parser version は validation / dry-run にだけ使い、本番 `ingest-workflow` では使用しない。

### 9. Mastra Agent / Tool API

Mastra Server は private Cloud Run とし、Next.js / Jobs / Scheduler からだけ呼ぶ。

| Agent / Workflow           | 呼び出し元                   | 主な用途                                                                |
| -------------------------- | ---------------------------- | ----------------------------------------------------------------------- |
| `collection-pipeline`      | Cloud Run Job / Internal API | source contract に基づく候補評価、raw 保存、queue 投入                  |
| `exception-agent`          | Cloud Run Job / Mastra UI    | 失敗 raw / parsed の調査、parser 修正補助、低 confidence 候補整理       |
| `ingest-workflow`          | Cloud Run Job / Internal API | parse、Actor 名寄せ、chunk、graph 構築                                  |
| `project-chat-agent`       | Next.js Private Chat API     | graph / vector / raw / parsed を横断した project member 向け回答        |
| `public-report-chat-agent` | Next.js Public Chat API      | redaction 済み public report と公開用 context bundle だけを使う限定回答 |
| `generate-report`          | Cloud Run Job / Report API   | report JSON 生成と保存                                                  |

Mastra UI（Studio / Playground）は開発時の agent / workflow 動作確認に使うが、DB / Storage / Graph の最終整合性は CLI、DB query、自動テストで確認する。

### 10. レート制限と監査ログ

- Private Chat API は user + project 単位で rate limit する。public より緩めにし、初期値は 1 時間 60 request、1 日 300 request を上限にする。
- Public Chat API は信頼済み client IP + report id 単位で厳しめに rate limit する。初期値は 1 時間 10 request、1 日 50 request を上限にし、同一の信頼済み client IP からの横断的な report access も別途制限する。Mastra 側で使う client IP header は OIDC 検証済みの Next.js が付与したものだけを信頼する。
- Public Report API は信頼済み client IP + report id 単位で rate limit する。
- Internal API は OIDC service account で認証し、外部 IP からの未認証呼び出しを拒否する。
- 監査ログには `request_id`、`user_id`、`project_id`、`path`、`method`、`status`、`latency_ms`、`resource_id` を残す。
- 監査ログに本文全文、raw document body、parsed JSON body、OAuth token、Gemini API key、DB password は出さない。

---
