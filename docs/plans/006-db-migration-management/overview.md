# DB マイグレーション管理整備計画

## 目的

Pufu Lens の DB schema 変更を、fresh DB と既存 DB の両方で再現可能に適用できる運用へ整理する。

現状は `infra/docker/postgres/init.sql` が fresh DB の正本であり、既存 DB には `infra/db/migrations/*.sql` を `scripts/db-migrate.ts` で番号順に適用する仕組みがある。この plan では、既存の軽量 migration runner を正式な運用単位として固め、schema 変更時の作法、検証、deploy 手順、ドキュメント同期を明確にする。

## 前提

- PostgreSQL は `pgcrypto`、`vector`、Apache AGE を使う。
- fresh DB は Docker entrypoint で `infra/docker/postgres/init.sql` から初期化される。
- 既存 DB は `pnpm db:migrate` で `infra/db/migrations/*.sql` を番号順に適用する。
- `schema_migrations` は適用済み migration version を管理する。
- migration runner は advisory lock を使い、同時実行による二重適用を避ける。
- `auth:migrate` は後方互換の alias として残し、内部では `db:migrate` と同じ runner を使う。
- 現在の migration 履歴は空 DB から再生できる完全履歴ではない。`0001_auth_login.sql` は `init.sql` で作成済みの `users` などを前提にするため、Step 1 で baseline の扱いを正式に決める。
- ORM 導入はこの plan の主目的にしない。Prisma / Drizzle / Knex などの採用は、型付き query builder や model layer の必要性が明確になった時点で別 plan として判断する。

## 設計方針

### 正本の分担

| 対象                                   | 役割                                         |
| -------------------------------------- | -------------------------------------------- |
| `infra/docker/postgres/init.sql`       | fresh DB を最新 schema で作るための正本      |
| `infra/db/migrations/*.sql`            | 既存 DB を段階的に最新 schema へ更新する履歴 |
| `public.schema_migrations`             | 適用済み migration version の記録            |
| `docs/designs/system/03-data-model.md` | schema の意図、認可境界、運用上の注意        |
| `docs/operations/deploy-checklist.md`  | staging / production での実行手順と検証記録  |

schema 変更では、原則として `init.sql` と migration SQL を同じ PR で更新する。`init.sql` だけを変更して既存 DB 用の migration を省略してよいのは、既存環境に影響しないコメントや local-only seed 相当の変更に限る。

fresh DB では最新 schema が `init.sql` で直接作成されるため、`schema_migrations` に取り込み済み version を記録する baseline stamping を導入する。これにより、fresh DB に対して `pnpm db:migrate` を実行しても過去 migration を永久に再実行しない状態にする。

Step 1 では `init.sql` の末尾で `public.schema_migrations` を作成し、取り込み済み version を `INSERT` する方式を採用した。

drift check の比較起点は「空 DB」ではなく「baseline 適用済み DB」とする。migration 開始時点の schema snapshot を `0000_baseline.sql` または比較用 fixture として保存するかは Step 5 で決める。

### Migration ファイル規約

- ファイル名は `NNNN_short_description.sql` とする。
- 番号は単調増加させ、一度 main に入った migration の内容は原則変更しない。
- 複数 PR が migration を追加する場合は、merge 前に main へ rebase して番号衝突と順序を確認する。merge / deploy 順が逆転すると環境間で適用順が揺れるため、必要なら番号を採り直す。
- 既存データを持つ DB に適用できるよう、可能な範囲で `IF EXISTS` / `IF NOT EXISTS`、段階的 backfill、constraint 追加順を使う。
- destructive change は、互換期間、backfill、参照コード切替、削除の複数 Step に分ける。
- `vector` 次元変更、AGE graph 構造変更、large table backfill は通常 schema migration と分け、再生成・再index・停止要否を plan に明記する。
- token、secret、PII の実値を migration SQL、fixture、log に含めない。

### Runner 方針

既存の `scripts/db-migrate.ts` を継続し、必要な機能だけを足す。

- `--dry-run` または `--plan` で未適用 migration を表示する。
- 適用済み migration の一覧表示を追加する。
- migration ディレクトリの欠落、番号重複、命名違反を検出する。
- `schema_migrations` に checksum を追加するか検討し、導入する場合は既存行の backfill migration を用意する。
- transaction 内で実行できない DDL が必要になった場合の逃げ道を明文化する。

## Step 一覧

| step   | status      | 内容                                                                                          | 完了条件                                                                                                   |
| ------ | ----------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Step 1 | `completed` | 現状 runner と migration 履歴を監査し、baseline / stamping 方針と運用ルールを設計書へ反映する | Issue #119。`init.sql` / migration / deploy checklist の責務、baseline、変更時チェックリストが明文化される |
| Step 2 | `completed` | `db:migrate` の安全機能と開発者向け UX を整える                                               | Issue #121。`--plan` / `--list` / `--check`、offline / online 検査、runner unit test が通る                |
| Step 3 | `completed` | migration 作成・レビュー手順を追加する                                                        | Issue #123。新規 migration generator、PR checklist、destructive change 手順が docs に入る                  |
| Step 4 | `completed` | CI / deploy 前検証に migration check を組み込む                                               | Issue #127。`pnpm db:migrate --check` が CI と deploy dry-run で実行される                                 |
| Step 5 | `planned`   | 既存 DB と fresh DB の schema drift 検出を追加する                                            | fresh DB と migrated DB の schema 比較手順が自動または半自動で確認できる                                   |
| Step 6 | `planned`   | AGE graph / vector / backfill を含む重い変更の運用を定義する                                  | 再index、embedding 再生成、graph 更新、rollback 方針が deploy checklist に残る                             |

## Step 1: 現状監査とルール反映

### 実装範囲

- `infra/db/migrations` の既存番号、内容、冪等性、`init.sql` との差分意図を確認する。
- `0001_auth_login.sql` が空 DB ではなく `init.sql` 適用済み DB を前提にしていることを明記し、baseline 方針を決める。
- fresh DB に `schema_migrations` の取り込み済み version を seed するか、別の baseline fixture を使うかを決める。
- `0002_project_oauth_connections.sql` を data migration 事例として振り返り、Step 3 / Step 6 の手順へ反映する観点を整理する。
- `docs/designs/system/03-data-model.md` の DDL 正本説明を、`init.sql` と migration 履歴の二層運用として更新する。
- `docs/designs/system/10-directory-structure.md` に `infra/db/migrations` と `scripts/db-migrate.ts` を追記する。
- `docs/operations/deploy-checklist.md` の migration 実行コマンドを `pnpm db:migrate` 中心へ揃える。

### 受け入れ条件

- fresh DB と既存 DB の更新経路が明確である。
- migration 履歴の起点が明確であり、空 DB から全 migration を再生できるかどうかの前提が docs に残っている。
- fresh DB で過去 migration が再実行され続けないよう、`schema_migrations` の baseline stamping または同等の方式が決まっている。
- schema 変更時に更新すべきファイルが docs から分かる。
- `auth:migrate` が互換 alias であることが明記されている。

## Step 2: Runner の安全機能

### 実装範囲

- `scripts/db-migrate.ts` に CLI option を追加する。
  - `--plan`: 未適用 migration を表示して適用しない。
  - `--list`: 適用済み / 未適用 migration を表示する。
  - `--check`: migration 命名、番号重複、適用済み履歴との整合を検査する。
- check は offline / online を分ける。
  - offline check: DB 接続なしで migration ディレクトリ、命名、番号重複、version 衝突を検査する。
  - online check: DB に接続し、`schema_migrations` と migration ファイルの整合、checksum を導入した場合の一致を検査する。
- migration ファイル名の番号重複、欠番許容可否、version 衝突を検出する。
- runner の unit test を追加する。
- DB 接続を必要とする test は test DB を明示し、通常 unit test と分ける。

### 受け入れ条件

- `pnpm db:migrate --plan` で未適用 migration が確認できる。
- 命名違反や version 重複が non-zero exit になる。
- 既に適用済みの migration は再実行されない。
- advisory lock の取得・解放が失敗時にも破綻しない。

## Step 3: 作成・レビュー手順

### 実装範囲

- migration 作成手順を `docs/operations/db-migrations.md` に追加する。
- 新規 migration の generator script と template を `scripts/create-db-migration.ts` として追加する。
- PR checklist に次を追加する。
  - `init.sql` 更新有無
  - `schema_migrations` baseline seed 更新有無
  - migration SQL 更新有無
  - data backfill 有無
  - destructive change 有無
  - AGE graph / vector / embedding 再生成影響
  - PII / secret / token の混入確認
- migration 番号は、merge 前に main へ rebase して最新の最大番号を確認し、衝突や順序逆転のリスクがある場合は採り直す。
- rollback 方針は「自動 down migration を必須にしない」前提で、復旧手順、backup、forward fix の判断基準を明記する。
- `0002_project_oauth_connections.sql` を data migration の既存事例として docs に残す。

### 受け入れ条件

- 開発者が新しい schema 変更を追加するときの手順が docs から追える。
- `pnpm db:migration:new <name>` で次の番号の migration template を作成できる。
- destructive change は単一 migration で即削除しない運用になっている。
- review 時に既存 DB 影響を確認する項目がある。

## Step 4: CI / Deploy 前検証

### 実装範囲

- `pnpm db:migrate --check` を CI に組み込む。
- CI では PostgreSQL + AGE + pgvector の test container に `init.sql` を適用した後、`DATABASE_URL` 付きの online check として実行する。
- `pnpm deploy:dry-run` で offline `db:migrate --check` を先に実行する。
- deploy checklist に staging / production の実行順を明記する。
- migration 実行前 backup、実行後 smoke、失敗時の停止判断を運用手順に追加する。

### 受け入れ条件

- migration ファイルの形式不備が deploy 前に検出される。
- staging で `pnpm db:migrate` 実行後に smoke test する手順がある。
- production では backup と migration 実行結果の記録場所が決まっている。

## Step 5: Schema Drift 検出

### 実装範囲

- `init.sql` で作った fresh DB と、baseline から全 migration を適用した DB の schema を比較する方法を決める。
- `schema_migrations` の baseline seed 漏れを drift check で検出できるようにする。
- 比較対象は table、column、constraint、index、extension を中心にする。
- AGE graph 内部 table や extension 管理 object など、比較から除外すべき object を明記する。
- 自動化が重い場合は、まずローカル script と手順書で半自動化する。

### 受け入れ条件

- `init.sql` と migration 履歴の drift を検出できる。
- drift check の起点が baseline として明文化されており、「空 DB に全 migration」前提に依存していない。
- extension 由来の差分で false positive が出ないよう除外ルールがある。
- drift が出た場合に `init.sql`、migration、docs のどこを直すべきか判断できる。

## Step 6: 重い DB 変更の運用

### 実装範囲

- `vector(1536)` の次元変更、embedding model 変更、再生成が必要な migration の手順を定義する。
- AGE graph の node / edge label 追加、property backfill、再index の手順を定義する。
- large table backfill は batch script と schema migration を分ける方針を明記する。
- downtime 要否、read-only window、retry、進捗確認 query を deploy checklist に残せるようにする。

### 受け入れ条件

- 大量データ更新を通常 migration の transaction に詰め込まない方針が明確である。
- embedding / graph 再生成が必要な変更で、アプリコードと DB の適用順を判断できる。
- 失敗時に forward fix、再実行、backup restore のどれを選ぶかの基準がある。

## 検証方針

- runner unit test:
  - migration file discovery と sort。
  - version 重複 / 命名違反の検出。
  - applied / pending の判定。
- integration test:
  - baseline 適用済み DB に `pnpm db:migrate` を適用できる。
  - fresh DB に `pnpm db:migrate` を実行しても、baseline seed 済みの migration が再実行されない。
  - 適用済み migration を再実行しても差分が出ない。
  - 失敗した migration が `schema_migrations` に記録されない。
- drift check:
  - `init.sql` で作った fresh DB と、baseline から migration を適用した DB の schema 差分を確認する。
  - `schema_migrations` に fresh DB が取り込み済み version を記録しているか確認する。
- deploy smoke:
  - migration 後に login、project 作成、data source 一覧、report / chat の主要 query が動く。

## 未決事項

- `schema_migrations` に checksum を必須化するか。
- 欠番を許容するか、連番必須にするか。
- migration generator script を作るか、手動 SQL 作成に留めるか。
- CI で Docker PostgreSQL + AGE + pgvector を毎回起動するか、夜間 / pre-merge job に分けるか。
- rollback を down migration で管理するか、backup + forward fix を標準にするか。
