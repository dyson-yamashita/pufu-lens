# Drive 実データソース収集

Step 10 の Drive 収集は、Google Drive API から folder 配下の file metadata と本文テキストを取得し、Drive raw contract に変換して local object storage、`raw_documents`、`ingestion_queue` に保存する。

## 前提

- `docker compose up -d postgres` でローカル DB が起動している。
- `DATABASE_URL` がローカル DB を指している。
- `STORAGE_ROOT` または `LOCAL_STORAGE_ROOT` が local object storage の root を指している。
- 対象 project は `pnpm seed:projects` または `pnpm create-project` で作成済み。
- project に Google OAuth connection が設定されている。Settings から Drive を接続するか、`--connection-id` で接続を指定する。

## 実行例

```bash
DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=/tmp/pufu-lens-storage \
  pnpm ingest:collect --project sample-a --source drive --folder-id DRIVE_FOLDER_ID --limit 5 --dry-run
```

実投入する場合は `--dry-run` を外す。

```bash
DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=/tmp/pufu-lens-storage \
  pnpm ingest:collect --project sample-a --source drive --folder-id DRIVE_FOLDER_ID --limit 5
```

収集後は通常の workflow を Drive source に限定して実行できる。

```bash
DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=/tmp/pufu-lens-storage \
  pnpm ingest:run --project sample-a --source drive --folder-id DRIVE_FOLDER_ID --limit 5 \
    --embedding-provider deterministic
```

Drive parse は `bodyText` と title を `TopicExtractionAgent` に渡し、parsed JSON の `topics` を生成する。Graph の `Topic` node / `MENTIONS` edge はこの parsed `topics` から materialize されるため、topic 抽出を有効にする実データ parse では `GEMINI_API_KEY` と `GEMINI_CHAT_MODEL` を設定する。

既に topic 抽出対応前に parse / index 済みの Drive document は、既存 parsed JSON に `topics` が含まれない。対象 raw を原本再取得なしで再 parse するには、必ず `project_id` と `source_id` で対象を絞って status を戻す。

```bash
psql "$DATABASE_URL" <<'SQL'
WITH target_raw AS (
  SELECT rd.id, rd.project_id
  FROM public.raw_documents rd
  JOIN public.projects p ON p.id = rd.project_id
  WHERE p.slug = 'sample-a'
    AND rd.source_type = 'drive'
    AND rd.source_id = 'DRIVE_FILE_ID:REVISION_ID'
)
UPDATE public.raw_documents rd
SET ingest_status = 'fetched',
    ingest_error = null,
    hold_reason = null,
    parsed_at = null
FROM target_raw
WHERE rd.id = target_raw.id;

WITH target_raw AS (
  SELECT rd.id, rd.project_id
  FROM public.raw_documents rd
  JOIN public.projects p ON p.id = rd.project_id
  WHERE p.slug = 'sample-a'
    AND rd.source_type = 'drive'
    AND rd.source_id = 'DRIVE_FILE_ID:REVISION_ID'
)
UPDATE public.ingestion_queue q
SET status = 'pending',
    last_error = null,
    hold_reason = null,
    lease_expires_at = null,
    scheduled_at = now()
FROM target_raw
WHERE q.project_id = target_raw.project_id
  AND q.raw_document_id = target_raw.id;
SQL
```

status を戻したら parse から workflow を再開する。`parse` で新しい parsed JSON が保存され、後続の `chunk` / `graph` で `Topic` node / `MENTIONS` edge が反映される。

```bash
DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=/tmp/pufu-lens-storage \
  GEMINI_API_KEY=... \
  GEMINI_CHAT_MODEL=... \
  pnpm ingest:run --project sample-a --source drive --resume-from parse --limit 1 \
    --embedding-provider deterministic
```

取り込み後の状態と Drive source contract は `ingest:inspect` で確認する。

```bash
DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=/tmp/pufu-lens-storage \
  pnpm ingest:inspect --project sample-a --source drive --limit 5 --format json
```

保留中 raw を parser contract / parser 実行で検査する場合は次を使う。

```bash
DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=/tmp/pufu-lens-storage \
  pnpm parser:version:validate --project sample-a --source drive --held --dry-run
```

失敗 raw を regression fixture 化する dry-run は source ごとに絞り込める。

```bash
DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=/tmp/pufu-lens-storage \
  pnpm ingest:fixture:add-failed --project sample-a --source drive --limit 3 --dry-run
```

## 収集仕様

- `data_sources.config.folderIds` / `folderUrls` または `--folder-id` / `--folder-url` の folder を候補として扱う。
- Drive query は folder 配下かつ `trashed = false` に限定し、`ingest_window.since` が有効な ISO date の場合は `modifiedTime` による incremental window を加える。
- `source_id` は `fileId:revisionId` とし、`revisionId` は `headRevisionId`、`version`、`modifiedTime` の順に採用する。
- Google Docs は export API で text/plain、Google Sheets は text/csv として取得する。
- Google Slides、PDF、画像などの binary / text export 非対応 MIME type は、現時点では Drive raw contract の `bodyText` に安全に変換できないため収集対象外として skip する。
- `text/*`、`application/json`、`application/xml`、`application/yaml`、`application/x-yaml` は `alt=media` で本文を取得する。
- raw body は object storage に保存し、DB metadata には本文全文や OAuth token を保存しない。
- `content_hash` は Drive raw JSON body の SHA-256 で算出する。
- 既存 `(project_id, source_type, source_id)` がある場合は raw を増やさず、data source link だけ更新する。

## 確認クエリ

```bash
psql "$DATABASE_URL" -c "SELECT source_type, source_id, ingest_status, metadata->>'revisionId' AS revision_id, metadata->>'mimeType' AS mime_type FROM raw_documents WHERE source_type = 'drive' ORDER BY fetched_at DESC;"
psql "$DATABASE_URL" -c "SELECT status, target_id, reason FROM ingestion_queue ORDER BY created_at DESC;"
find "$STORAGE_ROOT/sample-a/raw/drive" -type f | sort
```

同じ command を 2 回実行したとき、既存 raw は `skipped_existing` になり、`raw_documents` と `ingestion_queue` の件数は増えない。

`ingest:inspect` の `sourceContract` では、Drive source について次を検査する。

- `metadata.fileId` / `metadata.revisionId` が存在し、`source_id` と一致する。
- `metadata.mimeType` と `metadata.ownerCount` が存在する。
- storage 上の Drive raw JSON SHA-256 が `raw_documents.content_hash` と一致する。
- parsed document が `drive_doc` として読め、本文抽出結果が空ではなく、topic 抽出対象の本文を保持している。
