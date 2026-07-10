# Collection Pipeline ローカル確認

Step 4 の fixture collection は、外部 API、Agent、LLM を使わずに `fixtures/ingestion`
から raw document を保存し、DB の `raw_documents`、`raw_document_data_sources`、
`ingestion_queue` を更新する。

## 前提

- `docker compose up -d postgres` でローカル DB が起動している。
- `DATABASE_URL` がローカル DB を指している。
- `STORAGE_ROOT` または `LOCAL_STORAGE_ROOT` が local object storage の root を指している。
- 対象 project は `pnpm seed:projects` または `pnpm create-project` で作成済み。

## 実行例

```bash
DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=/tmp/pufu-lens-storage \
  pnpm ingest:collect:fixture --project sample-a --source github
```

`--source` は `github`、`web`、`gmail`、`drive` を指定できる。省略した場合は全 source の
fixture data source を作成して収集する。

実 API の `pnpm ingest:collect` では `--data-source-id <uuid>` を指定できる。指定時は
`project`、`source type`、`data source ID` のすべてが一致する有効な data source だけを
収集する。dispatcher など data source 単位の実行では必ずこの指定を使用する。

## 確認クエリ

```bash
psql "$DATABASE_URL" -c "SELECT source_type, source_id, ingest_status, storage_uri FROM raw_documents ORDER BY fetched_at DESC;"
psql "$DATABASE_URL" -c "SELECT status, target_id, raw_document_id FROM ingestion_queue ORDER BY created_at DESC;"
find "$STORAGE_ROOT/sample-a/raw" -type f | sort
```

同じ command を 2 回実行したとき、既存 raw は `skipped_existing` になり、
`raw_documents` と `ingestion_queue` の件数は増えない。

実 API 収集では同じ logical source の更新版は別の `raw_documents` 行として追加される。
同一版の再実行では Object Storage と queue を増やさず、関連行の `last_seen_at` だけを
更新する。`last_sync_succeeded_at` と `sync_cursor` は候補の処理がすべて成功し、limit に
よる打ち切りがなかった場合だけ更新される。
