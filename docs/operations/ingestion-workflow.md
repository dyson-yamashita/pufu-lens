# Ingestion Workflow 通し実行

Step 9 では、既存の fixture collection / parse / actor resolution / chunk / graph CLI を `ingest:run` で順に実行する。

## 前提

- `DATABASE_URL` が PostgreSQL / AGE / pgvector 入りの DB を指している。
- `STORAGE_ROOT` または `LOCAL_STORAGE_ROOT` が local object storage の root を指している。
- fixture ingest は外部 API、Agent、chat model を呼ばない。

```bash
export DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens
export STORAGE_ROOT=./infra/volumes/pufu-lens-data
```

既存 DB に過去の検証で作った `file:///private/tmp/...` URI が残っている場合は、その URI を含む root を指定して再実行する。

## 実行

GitHub fixture だけを通し実行する。

```bash
pnpm ingest:run --project sample-a --source github --fixture --embedding-provider deterministic
```

途中 step から再開する。

```bash
pnpm ingest:run --project sample-a --source github --fixture --resume-from resolve --embedding-provider deterministic
```

実行予定だけを構造化ログで確認する。

```bash
pnpm ingest:run --project sample-a --source github --fixture --dry-run
```

`ingest:run` の workflow log は JSON Lines で、step ごとの開始、完了、処理件数、LLM 使用量を出す。子 CLI の詳細結果は要約し、raw / parsed 本文、quote 本文、token、secret、API key、alias 詳細は出さない。

## Status

```bash
pnpm ingest:status --project sample-a
```

このコマンドは `raw_documents`、`ingestion_queue`、`documents`、`document_chunks`、`email_quotes` の集計と、failed / held queue の短いエラーを返す。

## Retry

failed queue を原本再取得なしで再処理する。

```bash
pnpm ingest:retry --project sample-a --source github --failed-only --embedding-provider deterministic
```

`ingest:retry` は `ingestion_queue.status='failed'` かつ `raw_documents.ingest_status='failed'` の対象を reset する。`parsed_uri` がある raw は `parsed` に戻し、`parsed_uri` がない raw は `fetched` に戻すため、parse 失敗と graph / chunk 失敗のどちらも同じコマンドで再開できる。

## 確認 SQL

```bash
psql "$DATABASE_URL" -c "SELECT ingest_status, count(*) FROM raw_documents WHERE project_id = (SELECT id FROM projects WHERE slug = 'sample-a') GROUP BY ingest_status ORDER BY ingest_status;"
psql "$DATABASE_URL" -c "SELECT status, count(*) FROM ingestion_queue WHERE project_id = (SELECT id FROM projects WHERE slug = 'sample-a') GROUP BY status ORDER BY status;"
psql "$DATABASE_URL" -c "SELECT doc_type, count(*) FROM documents WHERE project_id = (SELECT id FROM projects WHERE slug = 'sample-a') GROUP BY doc_type ORDER BY doc_type;"
psql "$DATABASE_URL" -c "SELECT count(*) FROM document_chunks WHERE project_id = (SELECT id FROM projects WHERE slug = 'sample-a');"
```
