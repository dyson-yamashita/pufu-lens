# DB Migration 運用

この文書は、Pufu Lens の DB schema 変更を fresh DB と既存 DB の両方へ反映するための作成・レビュー手順である。

## 正本

| 対象                             | 正本                                                              |
| -------------------------------- | ----------------------------------------------------------------- |
| fresh DB                         | `infra/docker/postgres/init.sql`                                  |
| 既存 DB                          | `infra/db/migrations/*.sql`                                       |
| 適用済み履歴                     | `public.schema_migrations`                                        |
| 変更意図、認可境界、運用上の注意 | `docs/designs/system/03-data-model.md` と関連する operations docs |

`init.sql` は最新 schema を直接作成する。`infra/db/migrations/*.sql` は既存 DB を段階的に更新する履歴であり、現時点では空 DB から再生できる完全履歴ではない。

fresh DB では `init.sql` の末尾で `public.schema_migrations` を作成し、`init.sql` に取り込み済みの migration version を seed する。schema 変更を `init.sql` に反映した PR では、対応する migration version も seed へ追加する。

## 作成手順

1. 最新の `main` へ rebase し、`infra/db/migrations` の最大番号を確認する。
2. migration file を作成する。

   ```bash
   pnpm db:migration:new add_example_table
   ```

3. 生成された `infra/db/migrations/NNNN_add_example_table.sql` に既存 DB 向けの差分を書く。
4. fresh DB に同じ最終 schema が必要な場合は `infra/docker/postgres/init.sql` を更新する。
5. `init.sql` に取り込んだ migration version を `schema_migrations` baseline seed へ追加する。
6. 変更の意図、認可境界、運用上の注意が変わる場合は `docs/designs/system/03-data-model.md` など関連 docs を更新する。
7. 検証を実行する。

   ```bash
   pnpm db:migrate --check
   DATABASE_URL=postgres://... pnpm db:migrate --plan
   DATABASE_URL=postgres://... pnpm db:migrate --list
   DATABASE_URL=postgres://... pnpm db:migrate
   ```

`--check` は DB 接続なしの offline check として、migration directory、命名、番号重複、version 衝突を検査する。`--plan` / `--list` / 通常実行は DB 接続が必要で、`schema_migrations` と照合する。

CI では PostgreSQL test container に `init.sql` を適用した後、`DATABASE_URL` 付きの `pnpm db:migrate --check` を実行する。deploy 前は `pnpm deploy:dry-run` でも offline `db:migrate --check` を先に実行する。

schema drift を確認するときは、create database 権限のある PostgreSQL に `DATABASE_URL` を向けて次を実行する。

```bash
DATABASE_URL=postgres://... pnpm db:schema-drift
```

この check は同じ PostgreSQL server 上に一時 DB を 2 つ作り、片方へ `infra/docker/postgres/init.sql`、もう片方へ `infra/db/baseline/0000_baseline.sql` と全 migration を適用して、public schema と `schema_migrations` version を比較する。AGE / pgvector / PGroonga / pgcrypto の extension は extension 名と version だけを比較し、extension 内部 object は比較対象にしない。

`infra/db/baseline/0000_baseline.sql` は migration 履歴の起点であり、空 DB から全 migration を再生する前提ではない。baseline fixture を変更するのは、migration 履歴の起点を明示的に作り直す場合に限る。

## レビュー観点

- `init.sql` と migration SQL の両方が必要な変更か確認する。
- `init.sql` に取り込み済みの migration version が `schema_migrations` baseline seed に追加されているか確認する。
- 既存 DB に対して再実行可能、または失敗時に安全に止まる SQL になっているか確認する。
- `NOT NULL`、unique、foreign key、index 追加は既存データ量と backfill 順序を確認する。
- data backfill がある場合、件数、lock、timeout、再実行時の挙動、検証 query を確認する。
- AGE graph、vector、embedding に影響する場合、再生成、再index、停止要否を deploy checklist に残す。
- real user data、OAuth token、API key、secret、PII を SQL、fixture、log に含めない。
- main merge 前に最新 `main` へ rebase し、番号衝突や merge / deploy 順序逆転のリスクがあれば番号を採り直す。
- `init.sql`、migration、baseline seed の同期漏れが疑わしい場合は `pnpm db:schema-drift` を実行し、差分が出た object に応じて `init.sql`、migration SQL、または docs のいずれを直すか判断する。

## Destructive Change

破壊的変更は単一 migration で即削除しない。原則として次のように分ける。

1. 新しい column / table / index を追加し、旧 schema と並行稼働できる状態にする。
2. 必要な backfill を実行し、検証 query で欠損を確認する。
3. アプリコードを新 schema 参照へ切り替える。
4. staging / production で smoke test と運用確認を行う。
5. 別 PR / 別 migration で旧 column / table / index を削除する。

## Data Backfill

小規模で transaction 内に収まる backfill は migration SQL に含めてよい。大量データ、外部 API、Object Storage、embedding 再生成、AGE graph 再構築を伴う処理は、schema migration と batch script を分ける。

既存の `0002_project_oauth_connections.sql` は、temporary table、backfill、検証 `DO` block を 1 transaction にまとめた事例である。新しい data migration では、この事例を参照しつつ、対象件数が増える場合は batch 化や read-only window を検討する。

次のいずれかに当てはまる場合は、通常 migration SQL だけで完結させない。

- 対象行数が環境ごとに大きく変わり、単一 transaction の実行時間を事前に見積もれない。
- 外部 API、Object Storage、embedding provider、AGE graph 更新を呼び出す。
- retry / resume / progress 確認が必要である。
- lock が user-facing workflow、collection、ingestion、report generation に影響する。

この場合は、schema migration、batch script、アプリコード切替、cleanup migration を分ける。batch script は idempotent にし、`--dry-run`、`--limit`、対象 project / data source の絞り込み、進捗確認 query、再実行時の skip 条件を持たせる。

## AGE / Vector / Embedding

AGE graph、vector、embedding の変更は、schema とデータ再生成の適用順を分けて設計する。

### Vector / Embedding

- PGroonga を追加する migration は、PostgreSQL ランタイム（Docker イメージ / VM）へ PGroonga パッケージを反映してから適用する。`CREATE EXTENSION pgroonga` は package 未導入の DB では失敗する。
- `vector(1536)` の次元を変える場合は、既存 column を直接型変更しない。新しい column / table を追加し、アプリコードで dual read / dual write または read fallback できる期間を作る。
- embedding model を変える場合は、`embedding_model` に新旧 model 名が混在する期間を許容し、検索 query が対象 model / dimension を明示できるようにする。
- 再生成は migration SQL ではなく batch script で行う。対象件数、project、document、chunk 範囲、provider、rate limit、失敗時 resume 方法を deploy checklist に記録する。
- HNSW index の再作成や大規模 rebuild が必要な場合は、staging で所要時間を測り、production では read-only window または degraded search window の要否を判断する。
- cleanup は、全対象の再生成と smoke test 後に別 migration で旧 column / index を削除する。

適用順の基本形:

1. 新 schema を追加する migration を適用する。
2. アプリコードを dual write / fallback 可能な状態で deploy する。
3. `--dry-run` で対象件数と provider 設定を確認する。
4. batch script で embedding を再生成し、進捗 query と error log を確認する。
5. search / report / chat smoke test を行う。
6. アプリコードから dual write / fallback 処理を削除し、後続 PR で旧 schema を削除する。

### AGE Graph

- graph label、edge type、property の変更は project graph ごとに適用される。対象 project と graph name の一覧、再実行対象 document、再index 要否を明記する。
- AGE graph の再構築は migration transaction に入れない。`pnpm ingest:index` または専用 batch script で project / limit を絞って再実行する。
- property rename / edge rename は、新旧 property / edge を一時的に併存させ、reader が両方を読める期間を作る。
- graph 全削除・再作成が必要な場合は、事前 backup、read-only / maintenance window、復旧手順、再構築完了判定を deploy checklist に残す。
- graph 更新中に検索や可視化が不完全になる場合は、UI / API の degraded behavior と smoke test を明記する。

### 失敗時判断

| 状況                                 | 標準判断                                                  |
| ------------------------------------ | --------------------------------------------------------- |
| schema migration 前に検出した不備    | deploy 停止。migration / docs / checklist を修正する。    |
| schema migration 適用後の軽微な不備  | forward fix migration を優先する。                        |
| batch script の途中失敗              | idempotent な再実行または `--limit` 付き resume を行う。  |
| データ破損、広範な誤更新             | backup restore を検討し、原因を修正して再実行する。       |
| 外部 API rate limit / 一時障害       | deploy は停止または read-only 継続し、時間を置いて再開。  |
| graph / embedding の検索品質劣化のみ | degraded window として扱い、forward regeneration を行う。 |

## Rollback

down migration の作成は必須にしない。標準の復旧方針は、実行前 backup、失敗時の停止判断、backup restore、または forward-fix migration である。

production 適用時は deploy checklist に次を記録する。

- 実行前 backup
- 適用対象 migration
- `schema_migrations` 確認結果
- 実行後 smoke
- 失敗時に restore / forward fix / 再実行のどれを選んだか
