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

## レビュー観点

- `init.sql` と migration SQL の両方が必要な変更か確認する。
- `init.sql` に取り込み済みの migration version が `schema_migrations` baseline seed に追加されているか確認する。
- 既存 DB に対して再実行可能、または失敗時に安全に止まる SQL になっているか確認する。
- `NOT NULL`、unique、foreign key、index 追加は既存データ量と backfill 順序を確認する。
- data backfill がある場合、件数、lock、timeout、再実行時の挙動、検証 query を確認する。
- AGE graph、vector、embedding に影響する場合、再生成、再index、停止要否を deploy checklist に残す。
- real user data、OAuth token、API key、secret、PII を SQL、fixture、log に含めない。
- main merge 前に最新 `main` へ rebase し、番号衝突や merge / deploy 順序逆転のリスクがあれば番号を採り直す。

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

## AGE / Vector / Embedding

- AGE graph の node / edge label、property、index を変更する場合は、graph ごとの更新対象と再実行手順を明記する。
- `vector(1536)` の次元や embedding model を変更する場合は、既存 embedding の再生成範囲、検索互換性、切替順序を明記する。
- 再生成や再index が必要な変更は、`docs/operations/deploy-checklist.md` の DB Migration 記録へ実施結果を残す。

## Rollback

down migration の作成は必須にしない。標準の復旧方針は、実行前 backup、失敗時の停止判断、backup restore、または forward-fix migration である。

production 適用時は deploy checklist に次を記録する。

- 実行前 backup
- 適用対象 migration
- `schema_migrations` 確認結果
- 実行後 smoke
- 失敗時に restore / forward fix / 再実行のどれを選んだか
