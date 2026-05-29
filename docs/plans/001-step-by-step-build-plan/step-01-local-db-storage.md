# Step 1: ローカル DB / Storage の最小起動

### 実装する機能

- `docker-compose.yml` に PostgreSQL 18 + pgcrypto + pgvector + Apache AGE のローカル起動を追加
- `infra/docker/postgres/init.sql` に最小 schema を追加
- `users`、`project_members`、`projects`、`data_sources`、`raw_documents`、`raw_document_data_sources`、`ingestion_queue`、`documents`、`document_chunks`、`actors`、`actor_aliases`、`email_quotes` を作成
- `packages/storage` に `ObjectStorage` interface と `LocalFsObjectStorage` を追加
- `STORAGE_ROOT` 配下に `<project_slug>/raw`、`parsed`、`reports` を作れるようにする

### 確認できること

- ローカルだけで DB と file storage が動く。
- プロジェクト単位の storage prefix と graph 名の土台が確認できる。
- DB schema の制約が設計どおり動く。

### 確認方法

```bash
docker compose up -d postgres
pnpm test -- --run storage
psql "$DATABASE_URL" -c "\dt"
psql "$DATABASE_URL" -c "SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto', 'vector', 'age');"
find "$STORAGE_ROOT" -maxdepth 3 -type d
```

### 完了条件

- 必要な extension と table が存在する。
- storage の `put` / `getText` / `exists` / `list` の unit test が通る。
- project ごとの prefix が混在しない。
- fixture / CLI 用の system user と project member を seed できる。
