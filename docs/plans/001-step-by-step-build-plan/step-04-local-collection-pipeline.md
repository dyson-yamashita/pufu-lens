# Step 4: Collection Pipeline のローカル収集パイプライン

### 実装する機能

- 外部 API を呼ばない `fixture-source-scanner`
- source contract / config / ingest_window に基づく `shouldCollectCandidate`
- `lookupRawDocument`
  - source type ごとに `source_id` を正規化する（Gmail は `threadId:messageId`、Drive は `fileId:revisionId`、GitHub は正規化キー、Web は canonical URL）
- `fetchRaw`
  - fixture の原本を Object Storage に保存
  - `raw_documents` を `ingest_status='fetched'` で upsert
  - 同じ `content_hash` の既存 raw は統合せず、SAME_AS 候補として metadata に記録する
- `linkDataSource`
  - `raw_document_data_sources` を upsert
- `queueCandidate`
  - `ingestion_queue` を `status='pending'` で upsert
- `pnpm ingest:collect:fixture --project sample-a --source github` のような CLI
- Agent / LLM を使わずに collect 正常系を完結させる実装境界

### 確認できること

- Collection Pipeline の最重要フローを Agent / LLM なしで決定的に検証できる。
- 原本保存、DB 登録、data_source 紐付け、queue 投入が順番どおり動く。
- 同じ fixture を再投入しても重複しない。
- 同じ `content_hash` でも `source_id` が異なる fixture は別 raw として保存され、SAME_AS 候補として観察できる。
- 取り込み候補数が増えてもチャットモデルのトークン消費が増えない。

### 確認方法

```bash
pnpm ingest:collect:fixture --project sample-a --source github
psql "$DATABASE_URL" -c "SELECT source_type, source_id, ingest_status, storage_uri FROM raw_documents ORDER BY fetched_at DESC;"
psql "$DATABASE_URL" -c "SELECT status, target_id, raw_document_id FROM ingestion_queue ORDER BY created_at DESC;"
find "$STORAGE_ROOT/sample-a/raw" -type f | sort
pnpm ingest:collect:fixture --project sample-a --source github
psql "$DATABASE_URL" -c "SELECT count(*) FROM raw_documents WHERE project_id = (SELECT id FROM projects WHERE slug = 'sample-a');"
psql "$DATABASE_URL" -c "SELECT source_type, content_hash, count(*) FROM raw_documents GROUP BY source_type, content_hash HAVING count(*) > 1;"
```

### 完了条件

- 2 回実行しても `raw_documents` と `ingestion_queue` が意図せず増えない。
- `content_hash` 一致だけで raw が統合されない。
- `raw_document_data_sources.last_seen_at` は更新される。
- `storage_uri` の実体ファイルを読める。
- collect 実行ログに LLM call / token usage が出ない。

## Step 4 確認記録

- 実施日: 2026-05-31
- 対象 commit: PR head commit
- 実装範囲: fixture scanner、candidate filter、source_id 正規化、raw storage 保存、`raw_documents` / `raw_document_data_sources` / `ingestion_queue` upsert、`postgres` client を使う `pnpm ingest:collect:fixture` CLI
- 実行コマンド:
  - `pnpm --filter @pufu-lens/ingestion test`
  - `pnpm typecheck`
  - `pnpm format:check`
  - `pnpm lint`
  - `pnpm test`
  - `pnpm build`
  - `pnpm ingest:collect:fixture --project sample-b --source github`
  - `psql ... SELECT source_type, source_id, ingest_status, storage_uri FROM public.raw_documents ...`
  - `psql ... SELECT status, target_id, raw_document_id FROM public.ingestion_queue ...`
  - `find /private/tmp/pufu-lens-step4-storage-postgres-client/sample-b/raw -type f`
  - `rg -n "token|secret|password|Bearer|refresh_token" fixtures .env.example`
- 自動テスト結果: `packages/ingestion` の 11 tests が pass。全体の `typecheck` / `format:check` / `lint` / `test` / `build` が pass。
- 補助的な手動確認: collect 1 回目は GitHub fixture 2 件が `collected`、2 回目は同じ 2 件が `skipped_existing`。
- DB 確認: `raw_documents` は GitHub 2 件で `ingest_status='fetched'`、`ingestion_queue` は 2 件で `status='pending'`、2 回実行後の raw 件数は 2。
- Storage 確認: `/private/tmp/pufu-lens-step4-storage-postgres-client/sample-b/raw/github/issue-101.json` と `pull-202.json` の実体ファイルを確認。
- ログ / secret 確認: collect 実行ログに LLM call / token usage は出力されない。fixture / `.env.example` の secret pattern 検索は該当なし。
- 未確認リスク: real data source API 連携、実 parser approval flow との接続、実運用 DB migration は後続 Step で確認する。
- 次 step に進む判断: fixture ベースの Collection Pipeline は外部 API / LLM なしで再実行性を確認できたため、Step 5 の raw parse へ進める。
