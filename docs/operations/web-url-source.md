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

取り込み後の状態と Web source contract は `ingest:inspect` で確認する。

```bash
DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=/tmp/pufu-lens-storage \
  pnpm ingest:inspect --project sample-a --source web --limit 5 --format json
```

保留中 raw を parser contract / parser 実行で検査する場合は次を使う。

```bash
DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=/tmp/pufu-lens-storage \
  pnpm parser:version:validate --project sample-a --source web --held --dry-run
```

失敗 raw を regression fixture 化する dry-run は source ごとに絞り込める。

```bash
DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=/tmp/pufu-lens-storage \
  pnpm ingest:fixture:add-failed --project sample-a --source web --limit 3 --dry-run
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

`ingest:inspect` の `sourceContract` では、Web source について次を検査する。

- `metadata.canonicalUrl` と `source_id` が一致する。
- storage 上の HTML SHA-256 が `raw_documents.content_hash` と一致する。
- parsed document が `web_page` として読め、本文抽出結果が空ではない。
