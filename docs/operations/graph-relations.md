# Graph / Relation Indexing

Step 8 の graph indexing は、Step 7 までに作成済みの `documents` / `document_chunks` と、Step 6 の `actors` / `actor_aliases` を入力にして、project 専用 AGE graph へ Document / Actor / Topic node と relation edge を `MERGE` する。

## 前提

- `DATABASE_URL`: PostgreSQL 接続文字列
- `STORAGE_ROOT` または `LOCAL_STORAGE_ROOT`: parsed JSON を読める local object storage root
- 対象 project で collect、parse、resolve actors、chunk が完了している

## 実行

```bash
DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
STORAGE_ROOT=/private/tmp/pufu-lens-step8-storage \
pnpm ingest:index --project step8-smoke-a --limit 10
```

`pnpm ingest:index` は次を実行する。

- `documents.graph_node_id` と parsed JSON から導出した graph key の一致を検証する
- project の `graph_name` にだけ `Document` / `Actor` / `Topic` node を `MERGE` する
- Actor mention を `MENTIONS` edge として作成する
- parsed relation を `COMMENTED_ON` / `REVIEWED` / `LINKS_TO` / `REPLY_TO` / `SAME_AS` edge として作成する
- Gmail quote を `email_quotes` に保存する
- `raw_documents.ingest_status` と `ingestion_queue.status` を `indexed` に更新する

## Graph 確認

```bash
DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
pnpm graph:query --project step8-smoke-a --cypher "MATCH (d:Document) RETURN count(d)"

DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
pnpm graph:query --project step8-smoke-b --cypher "MATCH (d:Document) RETURN count(d)"
```

`graph:query` は project slug から `graph_name` を解決し、その project 専用 graph だけに Cypher を実行する。helper は 1 列の `RETURN` を想定する。

## DB 確認

```bash
psql "$DATABASE_URL" -c "SELECT ingest_status, count(*) FROM raw_documents GROUP BY ingest_status;"
psql "$DATABASE_URL" -c "SELECT status, count(*) FROM ingestion_queue GROUP BY status;"
psql "$DATABASE_URL" -c "SELECT count(*) FROM documents;"
psql "$DATABASE_URL" -c "SELECT count(*) FROM document_chunks;"
psql "$DATABASE_URL" -c "SELECT count(*) FROM email_quotes;"
```

Graph node / edge は stable key で `MERGE` するため、同じ対象を再実行しても増殖しない。
