# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## データモデル

この章はテーブルの役割、分離方針、設計意図を説明する。fresh DB の実際の DDL は `infra/docker/postgres/init.sql` を正とし、既存 DB への差分適用履歴は `infra/db/migrations/*.sql` を正とする。この文書にはフル DDL を写さない。制約、カラム、index を変更する場合は `init.sql` と migration を更新し、この文書は意図や運用上の注意だけを同期する。

### 1. マルチプロジェクト方針

- `projects` テーブルで論理プロジェクトを定義する。`slug` から storage prefix と AGE graph name を生成する。
- ほぼ全ての業務テーブルに `project_id` を持たせ、query と unique 制約を project scope に閉じる。
- ナレッジグラフは project ごとに専用の AGE graph を使う。`projects.graph_name` は DB に保存された値だけを信用し、request body や URL から graph name を受け取らない。
- Object Storage は project ごとの prefix（例: `<project_slug>/raw/...`, `<project_slug>/parsed/...`, `<project_slug>/reports/...`）で分離する。
- Browser から渡された `projectId` は信用せず、URL の `projectSlug` から server side で `projects.id` を解決する。

### 2. DDL / Migration 正本

fresh DB の DDL 正本:

- `infra/docker/postgres/init.sql`

既存 DB の migration 履歴:

- `infra/db/migrations/*.sql`
- `scripts/db-migrate.ts`
- `public.schema_migrations`

`init.sql` は最新 schema を直接作成する。`infra/db/migrations` は既存 DB を段階的に最新 schema へ近づけるための履歴であり、現時点では空 DB から再生できる完全履歴ではない。たとえば `0001_auth_login.sql` は `init.sql` で `users`、`projects`、`project_members` が作成済みであることを前提にする。

fresh DB では `init.sql` の末尾で `public.schema_migrations` を作成し、`init.sql` に取り込み済みの migration version を seed する。これにより、fresh DB に `pnpm db:migrate` を実行しても、過去 migration が再適用され続けない。

現在の主なテーブル:

| テーブル                                     | 役割                                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                                      | アプリログインユーザー。global role は bootstrap や運用用途に限定し、project 認可は `project_members` を主に使う。                                                                                      |
| `auth_accounts`                              | Google / GitHub などのアプリログイン provider と `users.id` の対応表。provider token は保存しない。                                                                                                     |
| `auth_password_credentials`                  | OAuth を使わないローカル/運用用 Credentials provider の password hash。                                                                                                                                 |
| `projects`                                   | project slug、graph name、storage prefix、visibility、settings を保持する。                                                                                                                             |
| `project_members`                            | project ごとの member/admin 権限を保持する。private API と server action の主要な認可境界。                                                                                                             |
| `oauth_connections`                          | project 単位の Google / GitHub 連携 metadata。token 実値ではなく暗号化済み値または secret 参照を扱う。                                                                                                  |
| `data_sources`                               | project の収集対象。Gmail / Drive / GitHub は対応する `oauth_connections` を必要とし、Web は connection なしで作成できる。完全成功した差分収集の `sync_cursor` と `last_sync_succeeded_at` を保持する。 |
| `data_source_schedules`                      | GitHub / Drive / Gmail の日次同期設定。`daily_time` と `timezone`、UTC の `next_run_at`、Step 4 dispatcher 用 lease・retry・結果を project / data source scope で保持する。Web には作成しない。         |
| `project_report_schedules`                   | project ごとの定期 report 周期と実行状態。`none` / `weekly` / `monthly` / `annually`、10:00 `Asia/Tokyo` の wall-clock、UTC の `next_run_at`、lease・retry・監査 user を保持する。                      |
| `report_schedule_period_runs`                | 定期 report の calendar period ごとの実行履歴の正本。通常・backfill、pending / running / succeeded / skipped / retry 状態、lease、通知、生成 report を project scope で追跡する。                       |
| `parser_profiles` / `parser_versions`        | source type / data source ごとの parser 選択、artifact、承認状態を管理する。                                                                                                                            |
| `raw_documents`                              | 外部 source から取得した版単位の原本 metadata と storage URI。`logical_source_id` で実体を束ね、`source_version` ごとの履歴を保持する。実体は Object Storage に置く。                                   |
| `raw_document_data_sources`                  | 同じ raw document が複数 data source から見つかった履歴を n:m で保持する。Data Sources 詳細の content preview はこの関連から対象 data source の raw document を列挙する。                               |
| `ingestion_queue`                            | raw document の parse / index 処理キュー。lease、attempts、hold/failed 状態を持つ。                                                                                                                     |
| `documents`                                  | 解析済み document の正規化 metadata。logical source 単位で ID を維持し、`raw_document_id` は検索対象の最新版を参照する。                                                                                |
| `document_chunks` / `document_chunk_history` | chunk 本体、embedding、chunk hash、再生成履歴を保持する。                                                                                                                                               |
| `actors` / `actor_aliases`                   | email / GitHub login / Web author domain などの actor と alias を project scope で管理する。                                                                                                            |
| `email_quotes`                               | Gmail の引用チェーンを document と分離して保持する。                                                                                                                                                    |
| `reports` / `report_chunks`                  | private/public report metadata、artifact URI、検索用 chunk を保持する。`reports` は手動・通常定期・backfill の生成種別、周期、前回定期 report、period run を参照する。                                  |
| `schema_migrations`                          | `pnpm db:migrate` が適用済み migration version を記録する。fresh DB では `init.sql` に取り込み済み version を seed する。                                                                               |

### 3. OAuth connection と data source

- `oauth_connections` は project 単位の共有 connection であり、個人の UI セッション用 provider account とは別物である。
- Gmail / Drive data source は Google connection、GitHub data source は GitHub connection を要求する。
- `data_sources.connection_id` は同じ project の connection だけを参照できるようにする。
- `data_source_schedules` は `(data_source_id, project_id)` の複合外部キーで source と同じ project に固定し、data source 削除時に cascade する。既定値は毎日 10:00 `Asia/Tokyo` である。
- `project_report_schedules` は project ごとに 1 row とし、`none` のときだけ `next_run_at` を `NULL` にする。schedule と period run は `(id, project_id)` の複合外部キーで同じ project に固定する。
- `report_schedule_period_runs` は同じ project・frequency・period を一意にし、report が生成されない `skipped` も理由と完了時刻を持つ履歴として残す。`succeeded` は report ID と完了時刻を必須とし、それ以外の状態では report ID を持たない。生成 report との相互参照は period run ID・project ID・frequency の複合制約で越境と周期不一致を拒否し、前回定期 report 参照も同じ project・frequency に限定する。
- `reports.generation_kind = 'manual'` では schedule metadata を持たず、`scheduled` / `scheduled_backfill` では canonical frequency と `schedule_period_run_id` を必須にする。dispatcher、期間列挙、UI は定期レポート計画の後続 Step で実装する。
- token / refresh token の扱いはセキュリティ設計に従う。収集では project の `oauth_connections` から token を解決し、GitHub App 設定は connection metadata に保存する。

### 4. Parser registry

- `parser_profiles` は project / data source / source type ごとの parser 選択単位である。
- `parser_versions` は immutable な parser artifact と validation 結果を保持する。
- 本番 ingestion では approved version だけを使う。未承認 version は validation / dry-run のみに使う。
- active version は profile に紐づく version だけを参照する。

### 5. 状態遷移

| 対象                                 | 主な正常系                                   | 主な停止/失敗系                            |
| ------------------------------------ | -------------------------------------------- | ------------------------------------------ |
| `raw_documents.ingest_status`        | `fetched` → `parsed` → `indexed`             | `held`, `failed`                           |
| `ingestion_queue.status`             | `pending` → `parsing` → `parsed` → `indexed` | `held`, `failed`, `skipped`                |
| `parser_versions.status`             | `draft` → `review_requested` → `approved`    | `rejected`, `retired`                      |
| `report_schedule_period_runs.status` | `pending` → `running` → `succeeded`          | `skipped`, `retry_wait`, `retry_exhausted` |

### 6. 変更時の同期ルール

- テーブル、制約、index の正確な定義は `init.sql` を更新する。
- 既存環境の更新が必要な場合は `infra/db/migrations/NNNN_short_description.sql` を追加する。
- 新規に migration を追加、または既存のものを変更した場合は、`init.sql` にスキーマを反映するとともに、末尾の `schema_migrations` seed にも該当する migration version を追加・更新する。
- main に入った migration の中身は原則変更せず、後続の番号で forward migration を追加する。
- 複数 PR が migration を追加する場合は、merge 前に main へ rebase して番号衝突と順序を確認する。
- destructive change は互換期間、backfill、参照コード切替、削除を分ける。
- 大量 backfill、AGE graph 更新、embedding / vector 次元変更は通常 schema migration と分け、deploy checklist に再生成・再index・停止要否を残す。
- この文書には、変更の意図、認可境界、運用上の注意を反映する。
- DDL をこの文書へ全文コピーしない。コピーが必要なレビューでは `init.sql` へのリンクまたは該当行の抜粋で扱う。

### 7. Data source content preview

- Admin UI の content preview は `raw_document_data_sources` → `raw_documents` → `documents` / `document_chunks` と `ingestion_queue` を project slug + data source id で検証したうえで読む。
- 画面に出すのは title、doc type、ingest status、canonical URI、短い snippet、raw/document id の compact 表示、queue status / attempts / 短い error 要約に限定する。
- `storage_uri`、`parsed_uri`、raw 本文、parsed JSON 全文、OAuth token、secret は preview では返さない。

---
