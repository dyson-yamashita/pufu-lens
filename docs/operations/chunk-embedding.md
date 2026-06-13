# Chunk / Embedding 運用メモ

Step 7 では parsed JSON から `documents` を upsert し、本文を chunk 化して `document_chunks` に最新版だけを保存する。

## 実行

```bash
pnpm ingest:chunk --project sample-a --limit 10 --embedding-provider deterministic
```

ローカル storage を使う場合は `DATABASE_URL` と `STORAGE_ROOT` を設定する。

```bash
DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
STORAGE_ROOT=./infra/volumes/pufu-lens-data \
pnpm ingest:chunk --project sample-a --limit 10 --embedding-provider deterministic
```

Gemini embedding を使う場合は次を設定する。

```bash
GEMINI_API_KEY=... \
GEMINI_EMBEDDING_MODEL=gemini-embedding-2 \
GEMINI_EMBEDDING_DIMENSIONS=1536 \
pnpm ingest:chunk --project sample-a --limit 3 --embedding-provider gemini --dry-run
```

`GEMINI_EMBEDDING_DIMENSIONS` は `1536` 必須。DB の `vector(1536)` と異なる値は起動時 validation error にする。
`gemini-embedding-001` は 2026-07-14 に提供終了予定のため、既定の Gemini embedding model は `gemini-embedding-2` とする。

## 挙動

- `raw_documents.ingest_status IN ('parsed', 'indexed')` かつ `parsed_uri` がある行を対象にする。
- `documents.raw_document_id` をキーに document を upsert し、その後で chunk を保存する。
- deterministic provider は入力テキストとモデル名から hash ベースの固定長 vector を生成する。検索品質ではなく DB 書き込み、chunk hash、冪等性の検証用。
- Gemini provider は `batchEmbedContents` の request 数を 100 件ずつに分割し、空の chunk list では API を呼び出さない。
- 同じ chunk hash / embedding model / chunk index の再実行では `document_chunks` を変更しない。
- chunk set が変わった場合は既存 `document_chunks` を `document_chunk_history` に退避してから削除し、新しい chunk set を挿入する。
- chunk 保存後は `raw_documents.ingest_status` と `ingestion_queue.status` を `indexed` にする。

## 確認 SQL

```bash
psql "$DATABASE_URL" -c "SELECT doc_type, title, graph_node_id FROM documents ORDER BY created_at DESC;"
psql "$DATABASE_URL" -c "SELECT document_id, chunk_index, left(content, 80), embedding_model FROM document_chunks ORDER BY document_id, chunk_index;"
psql "$DATABASE_URL" -c "SELECT document_id, chunk_index, content_hash, archived_at, archive_reason FROM document_chunk_history ORDER BY archived_at DESC;"
```

embedding provider の次元確認:

```bash
pnpm embedding:check --provider deterministic --dimensions 1536
pnpm embedding:check --provider gemini --dimensions 1536
```

## 次元 / Model 変更

`vector(1536)` の次元や embedding model を変更する場合は、通常 migration だけで既存 column を直接変更しない。`docs/operations/db-migrations.md` の Vector / Embedding 方針に従い、新旧 schema の併存、batch regeneration、search smoke test、cleanup migration を分ける。

deploy checklist には次を残す。

- 対象 embedding model / dimension
- 対象 project / document / chunk 件数
- dry-run 結果
- rate limit / retry / resume 条件
- HNSW index rebuild 要否と所要時間
- search / report / chat smoke test 結果
