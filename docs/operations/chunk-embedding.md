# Chunk / Embedding 運用メモ

Step 7 では parsed JSON から `documents` を upsert し、本文を chunk 化して `document_chunks` に最新版だけを保存する。

## 実行

```bash
pnpm ingest:chunk --project sample-a --limit 10 --embedding-provider deterministic
```

ローカル storage を使う場合は `DATABASE_URL` と `STORAGE_ROOT` を設定する。

```bash
DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
STORAGE_ROOT=./.data/volumes/pufu-lens-data \
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

## Chat 検索との整合

Private Chat の query embedding は Mastra Server が `GEMINI_EMBEDDING_MODEL` / `GEMINI_EMBEDDING_DIMENSIONS=1536` で生成する。pgvector 検索は同じ `document_chunks.embedding_model` の chunk だけを候補にし、異なる model や deterministic provider の vector と cosine 距離を比較しない。PGroonga の keyword 候補は embedding model に依存しないため、再生成中も本文一致の候補として利用できる。

環境内に複数 model が混在している場合は、次の SQL で件数を確認する。対象 project の再生成は、2 番目の SQL の `mismatched_chunk_count` が **0** になるまで完了扱いにしない。

```bash
psql "$DATABASE_URL" -c "SELECT embedding_model, count(*) FROM document_chunks GROUP BY embedding_model ORDER BY embedding_model;"
psql "$DATABASE_URL" -v project_slug='sample-a' -v target_model="$GEMINI_EMBEDDING_MODEL" -c "SELECT count(*) AS mismatched_chunk_count FROM document_chunks dc JOIN projects p ON p.id = dc.project_id WHERE p.slug = :'project_slug' AND dc.embedding_model IS DISTINCT FROM :'target_model';"
```

検索対象 model と異なる chunk は、対象 project ごとに Gemini provider で再実行する。`embedding_model` の変更は既存 chunk set の退避・置換対象になるため、先に `--dry-run` で対象件数を確認し、deploy checklist に実行コマンドと進捗を残す。本番での再生成実行は deploy 承認後に行う。`--limit` は batch size ではなく、その実行で先頭から読み取る上限なので、全件再生成時は project の最新処理対象 raw document 件数以上を指定する。100 件の例だけで停止せず、不一致件数が残る場合は上限を増やして再実行し、0 件を確認する。

```bash
pnpm ingest:chunk --project sample-a --limit 100 --embedding-provider gemini --dry-run
psql "$DATABASE_URL" -v project_slug='sample-a' -c "SELECT count(*) AS latest_embedding_target_count FROM raw_documents rd JOIN projects p ON p.id = rd.project_id WHERE p.slug = :'project_slug' AND rd.ingest_status IN ('parsed', 'indexed') AND rd.parsed_uri IS NOT NULL AND NOT EXISTS (SELECT 1 FROM raw_documents newer WHERE newer.project_id = rd.project_id AND newer.source_type = rd.source_type AND newer.logical_source_id = rd.logical_source_id AND newer.ingest_status IN ('parsed', 'indexed') AND newer.parsed_uri IS NOT NULL AND (newer.created_at, newer.id) > (rd.created_at, rd.id));"
CHAT_REEMBED_TARGET_LIMIT=1234 # 直前の件数以上へ置き換える
pnpm ingest:chunk --project sample-a --limit "$CHAT_REEMBED_TARGET_LIMIT" --embedding-provider gemini
psql "$DATABASE_URL" -v project_slug='sample-a' -v target_model="$GEMINI_EMBEDDING_MODEL" -c "SELECT count(*) AS mismatched_chunk_count FROM document_chunks dc JOIN projects p ON p.id = dc.project_id WHERE p.slug = :'project_slug' AND dc.embedding_model IS DISTINCT FROM :'target_model';"
```

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

deploy checklist の「DB Migration 記録」欄には、以下のように対応付けて記録を残す。

- heavy migration plan: 対象 embedding model / dimension、対象 project / document / chunk 件数、HNSW index rebuild 要否と所要時間
- read-only / maintenance window: read-only / maintenance window 要否（HNSW index rebuild 時など）
- batch script dry-run: dry-run 結果
- batch script command: 実行する `pnpm ingest:chunk` コマンド
- progress query: 進捗確認用の SQL（`document_chunks` の件数確認など）
- retry / resume 条件: rate limit / retry / resume 条件
- graph / embedding smoke: query と chunk の `embedding_model` 一致、search / report / chat smoke test 結果
