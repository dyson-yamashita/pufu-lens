# Account Login と Public Project 入口計画

## 目的

Issue #63 のアカウントログイン機能を、既存の private project 認可と public report / public chat の設計を壊さずに導入する。

特に Issue コメント
<https://github.com/dyson-yamashita/pufu-lens/issues/63#issuecomment-4631575953>
を踏まえ、未ログインの `/projects` はログイン導線へ強制遷移するのではなく、公開可能な project を表示する入口にする。public project では、未ログインユーザーも public report と public chat を確認できる。一方で private chat、private report、管理 UI、data source、raw / parsed document、OAuth connection はログイン済み project member だけが使えるようにする。

## 前提

- アプリログインは Auth.js で実装する。Google / GitHub data source 連携 OAuth とは別の責務として扱う。
- Auth.js session から `users.id` を解決し、private API は `project_members` で project member / admin を検証する。
- `PUFU_LENS_CHAT_USER_ID`、`PUFU_LENS_REPORT_USER_ID`、`PUFU_LENS_ADMIN_USER_ID` による固定 user id 運用は、開発用 fallback または bootstrap 用に縮小し、通常 request の認可には使わない。
- public report / public chat は既存どおり Object Storage の公開用 manifest / redaction 済み artifact を根拠にし、DB / AGE / pgvector / raw / parsed document へ未ログインでアクセスしない。
- Object Storage の key / URI を組み立てる public API は、`projectSlug`、`reportId` などの path parameter を API entrypoint で厳格に validate し、`..`、slash、URL encoded traversal、想定外文字を含む値を storage lookup 前に拒否する。
- PostgreSQL は業務時間外停止があり得る。未ログインの public report / public chat は DB 稼働確認に依存させない。public project 一覧の DB 依存可否は Step 1 で設計確定する。

## 設計方針

### Project visibility

`projects` に公開入口用の visibility を持たせる。初期案は `visibility` を `private | public` とし、既定は `private` とする。

public project は「project の存在、表示名、説明、公開済み report へのリンク、公開用の状態要約」を未ログインに見せてよい project を意味する。public project であっても、private chat、private report、admin 画面、data source、connection、raw / parsed document は公開しない。

既存の `reports.is_public` は report artifact の公開状態を表すため、project visibility とは別に扱う。未ログインの public project 一覧には、`visibility = public` かつ公開済み manifest が存在する report だけを表示する。

### `/projects` の動作

`/projects` はログイン状態で表示内容を切り替える。

- 未ログイン: public project 一覧を表示する。各 project から公開済み report と public chat へ遷移できる。ログインボタンも表示する。
- ログイン済み: 自分が member の private / public project を優先表示する。必要に応じて public project も別セクションで表示する。
- member でない public project の private route へアクセスした場合、private 画面は開かず public project 詳細または public report 入口へ誘導する。

### API boundary

API は private と public を分ける。

- Private: `/api/projects/[projectSlug]/...` は Auth.js session と `project_members` を必須にする。
- Public project list: `/api/public/projects` または同等の server-side data loader で public project 一覧を返す。
- Public report / public chat: project 単位の公開機能であることを URL にも表すため、`/api/public/projects/[projectSlug]/reports/[reportId]` と `/api/public/projects/[projectSlug]/reports/[reportId]/chat` を正規 API とする。既存の `/api/public/reports/[reportId]?projectSlug=...` 形式は後方互換が必要な場合だけ短期 redirect / alias とし、plan 実装時に廃止可否を決める。

public API は、非公開 project / private report の存在有無を漏らさない。public project 一覧でも、公開済み artifact がない project は表示しない。

## Step 一覧

| step   | status    | 内容                                                                               | 完了条件                                                                                                     |
| ------ | --------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Step 1 | `planned` | public project visibility と公開一覧 contract の設計を固める                       | `docs/designs/system/*` と UI layout に visibility、public `/projects`、API boundary が反映される            |
| Step 2 | `active`  | Auth.js session、user upsert、session user id 解決、必要な DB migration を実装する | Issue #76。migration、ログイン / ログアウト、`users` upsert、session user id 取得の unit / route test が通る |
| Step 3 | `planned` | private API / admin actions を session user id + `project_members` 認可へ移行する  | 固定 user id に依存せず、未ログイン `401`、非 member `403` / `404`、admin role 必須が検証される              |
| Step 4 | `planned` | `/projects` をログイン状態別の member project / public project 入口にする          | 未ログインで public project が表示され、ログイン済みで member project が表示される e2e が通る                |
| Step 5 | `planned` | public project から public report / public chat への遷移と安全性を検証する         | 未ログインで public report / chat が使え、private data / secret / raw / parsed が露出しない                  |
| Step 6 | `planned` | 本番 secret、callback URL、Firebase App Hosting 向け env、運用手順を整理する       | `docs/operations/deploy-checklist.md` などに secret 名、callback URL、未完了の手動作業が記録される           |

## Step 1: Public Project Contract

### 実装範囲

- `projects.visibility` または `projects.settings.public` のどちらで public project を表現するか決める。
- 未ログイン `/projects` に表示する project metadata の範囲を定義する。
- public API の path parameter validation を定義する。`projectSlug` は storage prefix と同じ slug pattern、`reportId` は report id の正規 pattern に限定し、Object Storage の key 構築前に不正値を同一の `404` または `400` として拒否する。
- public project 一覧が DB に依存してよいか、公開用 manifest に project index を持たせるかを決める。
- Object Storage 上の public project index を採用する場合は、project 作成 / 更新 / 削除、visibility 変更、report 公開 / 非公開化に伴う index 更新・同期タイミングと失敗時の再同期方法を定義する。
- `/api/public/projects` と `/api/public/projects/[projectSlug]/reports/[reportId]`、`/api/public/projects/[projectSlug]/reports/[reportId]/chat` の response schema、pagination、cache、rate limit、404 / empty state を定義する。
- 既存の `/api/public/reports/[reportId]?projectSlug=...` と `/api/public/reports/[reportId]/chat?projectSlug=...` を残すか、project slug 配下 API へ移行するかを決める。

### 受け入れ条件

- public project の定義が private project / public report と混同されない。
- 未ログインに見せてよい metadata が明示される。
- `projectSlug` / `reportId` の validation pattern と不正値の扱いが明示され、path traversal を含む値で Object Storage lookup が発生しない。
- public project であっても private route / private API は Auth.js session + `project_members` を要求する。
- public report / public chat の正規 API は `projectSlug` と `reportId` の両方を path で受け取り、query string の `projectSlug` に依存しない。
- DB 停止中の public project 一覧の扱いが決まる。
- Object Storage index を採用する場合、書き込み側の更新責務、再生成コマンド、古い index を読んだ場合の許容動作が決まる。

## Step 2: Auth.js Login Foundation

### 実装範囲

- `users` テーブル、Auth.js に必要な account / session 相当の永続化、`projects.visibility` など、この plan で必要になる DB schema の migration を作成・適用する。
- 新規ログインユーザーの global role は `member` を既定にし、`users.role` の既定値が `admin` にならないよう migration で変更する。project 作成や bootstrap 用アカウントの権限は global role と `project_members.role` の境界を明確にして判定する。
- Auth.js の route、provider、session callback、sign in / sign out 導線を追加する。
- provider callback で `users.email` / `users.name` を upsert し、session に `users.id` を載せる。ただし複数 provider の同一 email を自動リンクする場合は provider の `email_verified` 等の検証済み状態を必須にし、未検証 email や provider 不一致の既存 account は自動統合しない。
- provider token / refresh token を app login 用に永続化しない。data source 連携 token は `oauth_connections` / Secret Manager 側の後続 scope とする。

### 受け入れ条件

- ログイン済み session から安定した `users.id` を取得できる。
- migration が local DB に適用でき、既存 project / report / data source の分離制約を壊さない。
- 新規ログインユーザーの `users.role` は制限ロールで作成され、明示的な bootstrap / system admin 設定なしに project 作成権限や全体 admin 権限を得ない。
- provider 間の account linking は検証済み email などの安全条件を満たす場合だけ行われ、未検証 email による account takeover ができない。
- cookie、provider token、secret が response / log / fixture に出ない。
- logout 後、private API は `401` を返す。

## Step 3: Private Authorization Migration

### 実装範囲

- private chat / private report / publish toggle / admin actions で request session user id を使う。
- `PUFU_LENS_*_USER_ID` 固定値は bootstrap / local development の明示設定に限定する。
- `project_members.role` を使い、member と admin の境界を route handler / server action で分ける。

### 受け入れ条件

- member ではない project の private API にアクセスできない。
- admin ではない member は data source 更新、report publish、parser approval などの admin action を実行できない。
- private API の error は project / report の存在有無を過剰に漏らさない。

## Step 4: `/projects` Public / Member Entry

### 実装範囲

- 未ログイン `/projects` に public project 一覧、公開済み report への導線、ログイン導線を表示する。
- ログイン済み `/projects` に member project 一覧を表示し、必要なら public project を別セクションに分離する。
- プロジェクト作成 UI（Add Project）は作成権限を持つログイン済みユーザーだけに表示し、`createProject` action も server side で同じ権限を検証する。
- Top Bar / Global Nav にアカウント表示、ログアウト、ログイン導線を追加する。

### 受け入れ条件

- 未ログインユーザーが public project と public report / chat を発見できる。
- 未ログインユーザーに admin / private chat / private report / data source の導線を出さない。
- 未ログインユーザーと作成権限のないログイン済みユーザーには Add Project を表示せず、直接 action を呼んでも project を作成できない。
- ログイン済み member は既存の admin console / chat / report へ遷移できる。
- モバイル / デスクトップでボタンやテキストが重ならない。

## Step 5: Public Safety Verification

### 実装範囲

- public project 一覧、public report、public chat の e2e を追加する。
- `../`、URL encoded slash / dot、許可外文字、過長値などの不正な `projectSlug` / `reportId` で public API を呼び、Object Storage の想定外 key 参照が起きず同一の拒否応答になることを確認する。
- public report / public chat は正規 URL と正規 API の両方で `projectSlug` と `reportId` を path から解決し、ブラウザから渡された query/body の `projectSlug`、`projectId`、`storageUri`、`sourceUri` を信用しないことを確認する。
- `projectId`、`storageUri`、`sourceUri`、raw / parsed 本文全文、OAuth token、secret を未ログイン経路から要求しても出ないことを確認する。
- public project から private route へ直接アクセスした場合の `401` / public 入口誘導を確認する。

### 受け入れ条件

- 未ログイン public e2e が通る。
- private API の未ログイン / 非 member / 非 admin test が通る。
- public chat の拒否ルールが維持される。

## Step 6: Operations

### 実装範囲

- Auth.js secret、provider client id / secret、callback URL、Firebase App Hosting env を運用チェックリストに記録する。
- 本番 secret の実値は docs / logs / fixture に入れない。
- ローカル開発用の `.env.example` には secret 名や設定名だけを記載する。

### 受け入れ条件

- deploy checklist にログイン機能の手動作業と未完了項目が残る。
- callback URL と provider 設定の確認手順が明示される。
- secret 実値が repo に含まれない。

## 検証方針

- unit / route test:
  - session なし、session あり、member なし、member あり、admin / non-admin。
  - public project 一覧に private project が含まれない。
  - project 作成 UI / action が作成権限に従い、未ログインと非権限ユーザーを拒否する。
  - public report / chat API が path の `projectSlug` と `reportId` を正規キーにし、query/body の project 指定を無視する。
  - public API が不正な `projectSlug` / `reportId` を storage lookup 前に拒否し、path traversal が成立しない。
  - 未検証 email や provider 不一致による account linking が拒否され、新規ユーザーが制限ロールで作成される。
  - public report / chat の URI injection が拒否される。
- e2e:
  - 未ログイン `/projects` で public project を表示。
  - 未ログインで public report / public chat を利用。
  - 未ログインで private route / private API は利用不可。
  - ログイン済み member が member project を表示。
- log / secret 確認:
  - OAuth token、refresh token、Auth.js secret、cookie、Gemini API key、DB password、raw / parsed 本文全文が response / log / trace に出ない。

## 未決事項

- public project 一覧を DB から読むか、Object Storage 上の public project index から読むか。
- public project の公開状態を `projects.visibility` にするか、`projects.settings` に入れるか。
- 初回管理者 bootstrap と member 招待をこの plan 内で扱うか、後続 plan に分けるか。
- Auth provider の初期選択を Google にするか GitHub にするか、両方にするか。

## 参照

- Issue #63: <https://github.com/dyson-yamashita/pufu-lens/issues/63>
- Issue comment: <https://github.com/dyson-yamashita/pufu-lens/issues/63#issuecomment-4631575953>
- `docs/designs/system/03-data-model.md`
- `docs/designs/system/05-api-design.md`
- `docs/designs/system/12-security.md`
- `docs/designs/system/16-tech-stack.md`
- `docs/designs/ui/ui-layout.md`
