# Step 5: Raw Parse と parsed JSON 保存

### 実装する機能

- `ingest-workflow` の `dequeueTargets` と `parseRaw`
- source type 別 parser / validator
  - GitHub: issue / PR / comment / diff metadata
  - Web: title / canonical URL / main text / links
  - Gmail: subject / sender / recipients / thread / quote 分解
  - Drive: title / revision / body / owner
- parser registry
  - `source_type` と raw contract から parser を選択
  - project / data_source / source_type ごとの active approved parser version を選択
  - parser version / schema version を parsed JSON metadata に記録
  - parser artifact hash を検証し、raw / parsed metadata に記録
- parsed JSON を `<project_slug>/parsed/...` に保存
- `raw_documents.parsed_uri`、`parsed_at`、`ingest_status='parsed'` を更新
- 成功時は `ingestion_queue.status='parsed'` を更新
- 失敗時は `raw_documents.ingest_status='failed'`、`ingestion_queue.status='failed'`、error code / parser version / sanitized sample path を保存
- 承認済み parser が無い、または raw が active parser contract に合わない場合は `raw_documents.ingest_status='held'`、`ingestion_queue.status='held'`、`hold_reason='parser_approval_required'` を保存
- `pnpm ingest:fixture:add-failed --raw-document-id <id>` のような失敗 raw の fixture 化 CLI

### 確認できること

- 原本を再 fetch せずに parse できる。
- parse 結果を storage から再取得できる。
- 成功 / 失敗時の状態遷移を DB で観察できる。
- 未承認 parser や contract mismatch の raw が保留され、graph / vector / documents に進まない。
- Gmail の引用分解など、データ成形の難所を早期に確認できる。
- 正常に取り込めないデータを保存し、parser 修正用の回帰テストに変換できる。
- Agent を使う場合も、毎回の取り込み判定ではなく失敗原因の調査・修正補助に限定できる。

### 確認方法

```bash
pnpm ingest:parse --project sample-a --limit 10
psql "$DATABASE_URL" -c "SELECT ingest_status, parsed_uri, ingest_error FROM raw_documents ORDER BY updated_at DESC;"
psql "$DATABASE_URL" -c "SELECT status, raw_document_id, parser_version_id, hold_reason, last_error FROM ingestion_queue ORDER BY updated_at DESC;"
find "$STORAGE_ROOT/sample-a/parsed" -type f | sort
pnpm ingest:fixture:add-failed --project sample-a --limit 3 --dry-run
pnpm test -- --run parse
```

parsed JSON は最低限、schema validation と snapshot で次を検査する。

- `source_type`
- `source_id`
- `title`
- `body`
- `canonical_uri`
- `occurred_at`
- `actors`
- `references`
- `quotes`
- `metadata`

必要に応じて、差分レビュー用に parsed JSON の要約を CLI で表示する。

```bash
pnpm parse:inspect --project sample-a --limit 10
```

### 完了条件

- 正常 fixture が `parsed` になる。
- 壊れた fixture が `failed` になり、原本は残る。
- `parsed_uri` の JSON が snapshot と一致する。
- parser version / artifact hash / schema version が parsed JSON metadata と DB に残る。
- 未承認 parser が必要な raw は `held` になり、承認後の retry まで parsed / indexed へ進まない。
- 失敗 raw をマスク済み fixture として保存し、parser 修正後に同じ fixture が通る。
