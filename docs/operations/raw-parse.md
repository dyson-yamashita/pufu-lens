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

data source 作成時（server action）は、対象 project / data_source / source_type に built-in parser profile と approved parser version が **内部 seed** され、active version として設定される。現在の built-in active version は全 source type で `fixture-parser-v2` であり、旧 `fixture-parser-v1` は immutable のまま DB に残す（artifact hash は上書きしない）。`Built-in <source> parser` という managed profile は seed のたびに approved v2 を active に保つ意図的契約であり、既に v2 active なら DB write は省略する。`scripts/parse-raw-documents.ts` も既存 data source の補完として同じ default parser を seed する。**管理 UI から parser profile を作成・承認・却下する user-facing workflow は廃止** した（Issue #294）。未承認 parser の保留動作を確認したい場合は次を使う。

```bash
pnpm ingest:parse --project sample-a --limit 10 --no-seed-built-in-parsers
```

GitHub parse は issue / PR の `title` と起票 `body` だけを `TopicExtractionAgent` のローカル候補生成へ渡す。`comments` / `reviews` / diff / actor / token は候補生成に含めない。`GEMINI_API_KEY` と `GEMINI_CHAT_MODEL` が設定されている場合は Gemini provider を使い、未設定時は deterministic provider に fallback する。

Gemini provider は本文を最大 12,000 文字の予算内で文書全体から等間隔にローカルサンプリングし、HTML tag / title / metadata / 引用句 / tokenizer の候補を全サンプルから集約する。候補はソース優先度・出現頻度・セクション被覆で順位付けし、ローカルの文字 n-gram 類似度を使う MMR で近似重複を抑える。Gemini へ送るのは最大 40 件（既定）の `{ id, text, evidence }` だけで、title / canonical URI / raw HTML / 本文 excerpt を独立した文書コンテキストとしては送らない。ただし、そこから抽出・正規化された候補語自体は `text` に含む。Gemini の `selectedCandidateIds` をローカル辞書へ厳密に戻し、topic 数は最大 10 件とする。候補が空なら Gemini を呼ばない。追加の embedding API 呼び出しは行わず、raw / provider 全文や secret はログに出さない。

既存 GitHub raw の topic 再抽出手順は [GitHub 実データソース収集](github-source.md) の `ingest:reprocess` を参照する。

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
