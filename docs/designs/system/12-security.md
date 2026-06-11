# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## ネットワーク・セキュリティ

API の一覧、エラー形式、サイズ上限、rate limit、監査ログの共通方針は [API デザイン](05-api-design.md) も参照する。

### 1. ネットワーク構成

```
Internet
   │
   ▼
Firebase App Hosting (Next.js) ── 公開
   │
   │ OIDC / VPC 内部通信
   ▼
Cloud Run (Mastra) ── no-allow-unauthenticated（非公開）
   │
   │ Private IP（VPC 内）
   ▼
GCE VM PostgreSQL ── パブリック IP 無し

Firebase App Hosting / Cloud Run / Jobs ─ Service Account / Workload Identity ─▶ GCS（pufu-lens-prod）
```

### 2. 認証・認可

| 対象                                              | 方式                                                        |
| ------------------------------------------------- | ----------------------------------------------------------- |
| Browser → Next.js                                 | Firebase App Hosting 上の Auth.js セッション                |
| Admin → Google / GitHub 連携                      | OAuth / GitHub App installation                             |
| Firebase App Hosting → Cloud Run                  | OIDC（App Hosting backend service account）                 |
| Firebase App Hosting → GCE VM                     | VPC access + DB パスワード                                  |
| Cloud Run → Cloud Run                             | OIDC（Service Account）                                     |
| Cloud Run → GCE VM                                | VPC 内部通信 + DB パスワード                                |
| Cloud Scheduler → Cloud Run                       | OIDC                                                        |
| Firebase App Hosting / Cloud Run → Google API     | 管理者 OAuth token（Secret Manager 経由）                   |
| Firebase App Hosting / Cloud Run → GitHub         | GitHub App installation token / PAT                         |
| Firebase App Hosting / Cloud Run → Secret Manager | Service Account / Workload Identity                         |
| Firebase App Hosting / Cloud Run → GCS            | Service Account / Workload Identity（バケットスコープ IAM） |

API は以下の認可をかける：

- すべての `/api/projects/[projectSlug]/...` で `projectSlug` を UUID の `projectId` に解決し、`project_members` を確認して、ログインユーザーが対象プロジェクトのメンバーであることを検証する。
- Admin API は `project_members.role IN ('admin')` のユーザーのみ可。
- `/members` の Accounts 一覧は `users.role IN ('admin', 'member')` のログインユーザーのみ可。ユーザー登録、全体 role 変更、Credentials password 更新は `users.role = 'admin'` の global admin のみ可とし、server action 側でも再検証する。
- `/projects/[projectSlug]/members` の閲覧は、global admin または対象 project の `project_members` に含まれるログインユーザーのみ可。プロジェクトへの紐付け追加は global admin または対象 project の `project_members.role = 'admin'` のみ可。解除は `project_members.role = 'member'` の紐付けだけを対象にし、global admin と project admin は解除不可とする。
- Mastra のツール呼び出しは `projectId` 必須、context にない場合エラー。
- 公開レポートは通常の `/api/projects/[projectSlug]/...` とは別に、未ログイン用の `/api/public/projects/[projectSlug]/reports/[reportId]` を用意する。公開ページの正規 URL は `/reports/public/[projectSlug]/[reportId]` とする。
- `/api/public/projects/[projectSlug]/reports/[reportId]` は API entrypoint で `projectSlug` と `reportId` を storage-safe pattern に validate し、Object Storage 上の公開用 manifest / metadata で公開可否を確認できた場合だけ redaction 済み public report JSON を取得して返す。private report JSON は直接公開しない。`is_public = false`、存在しない、または project が無効な場合は同じ `404` を返し、非公開レポートの存在有無を漏らさない。
- `/api/public/projects/[projectSlug]/reports/[reportId]/chat` は公開済みレポートに紐づく public chat だけを提供する。public chat は redaction 済み public report JSON と公開用 context bundle のみ参照し、DB / AGE / pgvector / raw document / parsed document にはアクセスしない。Public Chat tool はユーザー入力や LLM が指定した URI を読まず、Next.js が検証済み manifest から解決した URI だけを使う。
- private レポートの閲覧と signed URL 発行は DB 依存 API として扱う。`/api/projects/[projectSlug]/reports/[reportId]` または `/api/projects/[projectSlug]/reports/[reportId]/signed-url` で必ず `project_members` 認可後に返し、業務時間外はチャットと同様に `db_outside_business_hours` を返す。公開 API では private レポート本体や signed URL を返さない。

### 3. 公開レポートの保護

- Object Storage（GCS）バケットは Private
- 公開用 manifest / metadata で `is_public = true` のレポートは Next.js の公開ページ `/reports/public/[projectSlug]/[reportId]` から `/api/public/projects/[projectSlug]/reports/[reportId]` 経由で redaction 済み public report JSON を取得・描画
- `is_public = false` のレポートは `/api/projects/[projectSlug]/reports/[reportId]` で DB による認可チェック後にサーバから JSON を返す、または短時間の signed URL を発行する。DB 停止中は利用不可にする
- public chat は個人情報、メールアドレス、未公開 URL、raw / parsed 本文全文、secret を回答しない。公開 report と対象 project の公開済み情報に関係しない質問は拒否する
- レート制限を Cloud Armor または Hono middleware で実装する。public chat は信頼プロキシが付与した `x-forwarded-for` の右端の有効値（なければ `x-real-ip`、最後に anonymous bucket）+ report id 単位で 1 時間 / 1 日 / 質問長の上限を設け、クライアントが任意に付与できる左端値は信用しない。private chat は user + project 単位で public より緩い上限にする。Mastra 側で使う rate limit 用 header は OIDC 検証済みの Next.js から来たものだけを信頼する
- App Hosting の runtime env と secret は `apphosting.yaml` で参照し、secret 値をリポジトリに含めない。

---
