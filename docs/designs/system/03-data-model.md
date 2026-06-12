# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## データモデル

この章はテーブルの役割、分離方針、設計意図を説明する。実際の DDL は `infra/docker/postgres/init.sql` を唯一の正とし、この文書にはフル DDL を写さない。制約、カラム、index を変更する場合は `init.sql` と migration を更新し、この文書は意図や運用上の注意だけを同期する。

### 1. マルチプロジェクト方針

- `projects` テーブルで論理プロジェクトを定義する。`slug` から storage prefix と AGE graph name を生成する。
- ほぼ全ての業務テーブルに `project_id` を持たせ、query と unique 制約を project scope に閉じる。
- ナレッジグラフは project ごとに専用の AGE graph を使う。`projects.graph_name` は DB に保存された値だけを信用し、request body や URL から graph name を受け取らない。
- Object Storage は project ごとの prefix（例: `<project_slug>/raw/...`, `<project_slug>/parsed/...`, `<project_slug>/reports/...`）で分離する。
- Browser から渡された `projectId` は信用せず、URL の `projectSlug` から server side で `projects.id` を解決する。

### 2. DDL 正本

DDL 正本:

- `infra/docker/postgres/init.sql`

現在の主なテーブル:

| テーブル                                     | 役割                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `users`                                      | アプリログインユーザー。global role は bootstrap や運用用途に限定し、project 認可は `project_members` を主に使う。         |
| `auth_accounts`                              | Google / GitHub などのアプリログイン provider と `users.id` の対応表。provider token は保存しない。                        |
| `auth_password_credentials`                  | OAuth を使わないローカル/運用用 Credentials provider の password hash。                                                    |
| `projects`                                   | project slug、graph name、storage prefix、visibility、settings を保持する。                                                |
| `project_members`                            | project ごとの member/admin 権限を保持する。private API と server action の主要な認可境界。                                |
| `oauth_connections`                          | project 単位の Google / GitHub 連携 metadata。token 実値ではなく暗号化済み値または secret 参照を扱う。                     |
| `data_sources`                               | project の収集対象。Gmail / Drive / GitHub は対応する `oauth_connections` を必要とし、Web は connection なしで作成できる。 |
| `parser_profiles` / `parser_versions`        | source type / data source ごとの parser 選択、artifact、承認状態を管理する。                                               |
| `raw_documents`                              | 外部 source から取得した原本 metadata と storage URI。実体は Object Storage に置く。                                       |
| `raw_document_data_sources`                  | 同じ raw document が複数 data source から見つかった履歴を n:m で保持する。                                                 |
| `ingestion_queue`                            | raw document の parse / index 処理キュー。lease、attempts、hold/failed 状態を持つ。                                        |
| `documents`                                  | 解析済み document の正規化 metadata。                                                                                      |
| `document_chunks` / `document_chunk_history` | chunk 本体、embedding、chunk hash、再生成履歴を保持する。                                                                  |
| `actors` / `actor_aliases`                   | email / GitHub login などの actor と alias を project scope で管理する。                                                   |
| `email_quotes`                               | Gmail の引用チェーンを document と分離して保持する。                                                                       |
| `reports` / `report_chunks`                  | private/public report metadata、artifact URI、検索用 chunk を保持する。                                                    |

### 3. OAuth connection と data source

- `oauth_connections` は project 単位の共有 connection であり、個人の UI セッション用 provider account とは別物である。
- Gmail / Drive data source は Google connection、GitHub data source は GitHub connection を要求する。
- `data_sources.connection_id` は同じ project の connection だけを参照できるようにする。
- token / refresh token の扱いはセキュリティ設計に従う。現状の実装では local/dev 経路に env token fallback が残るため、本番相当の収集では connection 単位の token 解決へ移行する。

### 4. Parser registry

- `parser_profiles` は project / data source / source type ごとの parser 選択単位である。
- `parser_versions` は immutable な parser artifact と validation 結果を保持する。
- 本番 ingestion では approved version だけを使う。未承認 version は validation / dry-run のみに使う。
- active version は profile に紐づく version だけを参照する。

### 5. 状態遷移

| 対象                          | 主な正常系                                   | 主な停止/失敗系             |
| ----------------------------- | -------------------------------------------- | --------------------------- |
| `raw_documents.ingest_status` | `fetched` → `parsed` → `indexed`             | `held`, `failed`            |
| `ingestion_queue.status`      | `pending` → `parsing` → `parsed` → `indexed` | `held`, `failed`, `skipped` |
| `parser_versions.status`      | `draft` → `review_requested` → `approved`    | `rejected`, `retired`       |

### 6. 変更時の同期ルール

- テーブル、制約、index の正確な定義は `init.sql` を更新する。
- 既存環境の更新が必要な場合は migration script を追加する。
- この文書には、変更の意図、認可境界、運用上の注意を反映する。
- DDL をこの文書へ全文コピーしない。コピーが必要なレビューでは `init.sql` へのリンクまたは該当行の抜粋で扱う。

---
