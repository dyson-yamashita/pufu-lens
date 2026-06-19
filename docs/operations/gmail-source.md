# Gmail 実データソース収集

Step 10 の Gmail 収集は、Gmail API から query / label で絞った message 候補を取得し、thread 全体を Gmail raw contract に変換して local object storage、`raw_documents`、`ingestion_queue` に保存する。

## 前提

- `docker compose up -d postgres` でローカル DB が起動している。
- `DATABASE_URL` がローカル DB を指している。
- `STORAGE_ROOT` または `LOCAL_STORAGE_ROOT` が local object storage の root を指している。
- 対象 project は `pnpm seed:projects` または `pnpm create-project` で作成済み。
- project に Google OAuth connection が設定されている。Settings から Gmail を接続するか、`--connection-id` で接続を指定する。
- OAuth scope は読み取り専用の `https://www.googleapis.com/auth/gmail.readonly` を使う。

## 実行例

```bash
DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=/tmp/pufu-lens-storage \
  pnpm ingest:collect --project sample-a --source gmail --label-id INBOX \
    --query "newer_than:30d" --limit 5 --dry-run
```

実投入する場合は `--dry-run` を外す。

```bash
DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=/tmp/pufu-lens-storage \
  pnpm ingest:collect --project sample-a --source gmail --label-id INBOX \
    --query "newer_than:30d" --limit 5
```

収集後は通常の workflow を Gmail source に限定して実行できる。

```bash
DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=/tmp/pufu-lens-storage \
  pnpm ingest:run --project sample-a --source gmail --label-id INBOX \
    --query "newer_than:30d" --limit 5 --embedding-provider deterministic
```

取り込み後の状態と Gmail source contract は `ingest:inspect` で確認する。

```bash
DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=/tmp/pufu-lens-storage \
  pnpm ingest:inspect --project sample-a --source gmail --limit 5 --format json
```

保留中 raw を parser contract / parser 実行で検査する場合は次を使う。

```bash
DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=/tmp/pufu-lens-storage \
  pnpm parser:version:validate --project sample-a --source gmail --held --dry-run
```

失敗 raw を regression fixture 化する dry-run は source ごとに絞り込める。

```bash
DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=/tmp/pufu-lens-storage \
  pnpm ingest:fixture:add-failed --project sample-a --source gmail --limit 3 --dry-run
```

## 収集仕様

- `data_sources.config.labelIds` / `labels`、`query` / `q` または `--label-id` / `--query` を候補条件として扱う。
- `ingest_window.since` が有効な ISO date の場合は Gmail search query に `after:<unix_seconds>` を追加する。
- `messages.list` は候補列挙だけに使い、raw contract 作成時は `threads.get?format=full` で thread 全体を取得する。
- thread 内の最新 message だけを primary document とし、過去 message は `quotedMessages` に入れて `email_quotes` へ流す。
- `source_id` は `threadId:messageId` とし、messageId は最新 message の Gmail message id を使う。
- `text/plain` part を優先して本文抽出し、無い場合は `text/html` をテキスト化し、さらに無い場合だけ snippet に fallback する。
- raw body は object storage に保存し、DB metadata には本文全文や OAuth token を保存しない。
- `content_hash` は Gmail raw JSON body の SHA-256 で算出する。
- 既存 `(project_id, source_type, source_id)` がある場合は raw を増やさず、data source link だけ更新する。

## 確認クエリ

```bash
psql "$DATABASE_URL" -c "SELECT source_type, source_id, ingest_status, metadata->>'threadId' AS thread_id, metadata->>'messageId' AS message_id FROM raw_documents WHERE source_type = 'gmail' ORDER BY fetched_at DESC;"
psql "$DATABASE_URL" -c "SELECT status, target_id, reason FROM ingestion_queue ORDER BY created_at DESC;"
find "$STORAGE_ROOT/sample-a/raw/gmail" -type f | sort
```

同じ command を 2 回実行したとき、既存 raw は `skipped_existing` になり、`raw_documents` と `ingestion_queue` の件数は増えない。

`ingest:inspect` の `sourceContract` では、Gmail source について次を検査する。

- `metadata.threadId` / `metadata.messageId` が存在し、`source_id` と一致する。
- `metadata.toCount` と `metadata.quotedMessageCount` が存在する。
- storage 上の Gmail raw JSON SHA-256 が `raw_documents.content_hash` と一致する。
- parsed document が `email` として読め、本文抽出結果が空ではない。
