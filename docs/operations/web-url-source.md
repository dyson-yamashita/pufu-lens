# Web URL 実データソース収集

Step 10 の Web URL 収集は、外部 API / Agent / chat model を使わず、指定された URL を
HTML raw contract に変換して local object storage、`raw_documents`、`ingestion_queue` に保存する。

## 前提

- `docker compose up -d postgres` でローカル DB が起動している。
- `DATABASE_URL` がローカル DB を指している。
- `STORAGE_ROOT` または `LOCAL_STORAGE_ROOT` が local object storage の root を指している。
- 対象 project は `pnpm seed:projects` または `pnpm create-project` で作成済み。

## 実行例

```bash
DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=/tmp/pufu-lens-storage \
  pnpm ingest:collect --project sample-a --source web --url https://example.com --limit 5 --dry-run
```

実投入する場合は `--dry-run` を外す。

```bash
DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=/tmp/pufu-lens-storage \
  pnpm ingest:collect --project sample-a --source web --url https://example.com --limit 5
```

収集後は通常の workflow を Web source に限定して実行できる。

```bash
DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=/tmp/pufu-lens-storage \
  pnpm ingest:run --project sample-a --source web --url https://example.com --limit 5 \
    --embedding-provider deterministic
```

## 収集仕様

- `data_sources.config.urls` または `--url` の URL を候補として扱う。
- URL は `http` / `https` のみ許可し、fragment と末尾 slash を正規化する。
- fetch 後の HTML に canonical link があれば canonical URL を `source_id` に使う。
- raw body は object storage に保存し、DB metadata には本文全文を保存しない。
- `content_hash` は HTML raw body の SHA-256 で算出する。
- 既存 `(project_id, source_type, source_id)` がある場合は raw を増やさず、data source link だけ更新する。

## 確認クエリ

```bash
psql "$DATABASE_URL" -c "SELECT source_type, source_id, ingest_status, metadata->>'canonicalUrl' AS canonical_url FROM raw_documents WHERE source_type = 'web' ORDER BY fetched_at DESC;"
psql "$DATABASE_URL" -c "SELECT status, target_id, reason FROM ingestion_queue ORDER BY created_at DESC;"
find "$STORAGE_ROOT/sample-a/raw/web" -type f | sort
```

同じ command を 2 回実行したとき、既存 raw は `skipped_existing` になり、
`raw_documents` と `ingestion_queue` の件数は増えない。
