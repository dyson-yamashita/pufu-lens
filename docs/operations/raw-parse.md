# Raw Parse 運用メモ

Step 5 では Collection Pipeline が保存した `raw_documents.storage_uri` を起点に、原本を再 fetch せず parsed JSON を生成する。

## 実行

```bash
pnpm ingest:parse --project sample-a --limit 10
```

ローカル storage を使う場合は `DATABASE_URL` と `STORAGE_ROOT` を設定する。

```bash
DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
STORAGE_ROOT=./.data/volumes/pufu-lens-data \
pnpm ingest:parse --project sample-a --limit 10
```

管理 UI で data source を作成すると、対象 project / data_source / source_type に built-in parser profile と `fixture-parser-v1` の approved parser version が作成され、active version として設定される。`scripts/parse-raw-documents.ts` も既存 data source の補完として同じ default parser を seed する。未承認 parser の保留動作を確認したい場合は次を使う。

```bash
pnpm ingest:parse --project sample-a --limit 10 --no-seed-built-in-parsers
```

## 状態遷移

- `pending` queue は `parsing` に遷移してから処理される。
- approved active parser が無い場合は `parser_approval_required` で `held` になる。
- raw が parser contract に合わない場合は `parser_contract_mismatch` で `held` になる。
- parse 成功時は parsed JSON を `<project_slug>/parsed/<source_type>/...json` に保存し、`raw_documents.ingest_status` と `ingestion_queue.status` を `parsed` にする。
- parse 失敗時は `failed` にし、本文全文や secret を含まない短い error を `ingest_error` / `last_error` に残す。

## 確認 SQL

```bash
psql "$DATABASE_URL" -c "SELECT ingest_status, parsed_uri, parser_artifact_hash, parsed_schema_version, ingest_error FROM raw_documents ORDER BY updated_at DESC;"
psql "$DATABASE_URL" -c "SELECT status, raw_document_id, parser_profile_id, parser_version_id, hold_reason, last_error FROM ingestion_queue ORDER BY updated_at DESC;"
```

## 失敗 raw の fixture 化

失敗 raw は storage の原本を読み出し、メールアドレス、token、secret、外部 URL をマスクして `fixtures/ingestion/regression/` に保存する。

```bash
pnpm ingest:fixture:add-failed --project sample-a --limit 3 --dry-run
pnpm ingest:fixture:add-failed --raw-document-id <raw-document-id>
```
