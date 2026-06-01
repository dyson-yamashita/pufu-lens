# Step 9: Ingestion Workflow の通し実行

### 実装する機能

- `pnpm ingest:run --project sample-a --source github --fixture` で collect → parse → resolve → chunk → graph を通す
- step ごとの dry-run / resume / retry option
- failed queue の retry option
- parser 修正ループ
  - 失敗 raw を保存
  - fixture / snapshot test を追加
  - parser / validator を修正
  - test 通過後に `ingest:retry --failed-only` で再処理
- status dashboard 用の集計 API または CLI
- workflow 実行ログの構造化
- LLM call / token usage を step ごとに記録し、通常 ingest で Agent が呼ばれていないことを確認できるログ項目

### 確認できること

- データ取り込みからデータ構築まで、ローカルで end-to-end に動く。
- 途中失敗した対象を原本再取得なしで再処理できる。
- 処理件数、skip 件数、failed 件数、重複件数を確認できる。
- 失敗時だけ Agent / 開発者が parser 修正に介入し、正常系は決定的コードで再実行できる。
- deterministic embedding provider により、E2E テストで Gemini embedding コストを発生させずに済む。

### 確認方法

```bash
pnpm ingest:run --project sample-a --source github --fixture
pnpm ingest:status --project sample-a
pnpm ingest:retry --project sample-a --failed-only
pnpm ingest:run --project sample-a --source github --fixture --embedding-provider deterministic
pnpm test -- --run ingestion
```

DB では次を確認する。

```sql
SELECT ingest_status, count(*) FROM raw_documents GROUP BY ingest_status;
SELECT status, count(*) FROM ingestion_queue GROUP BY status;
SELECT doc_type, count(*) FROM documents GROUP BY doc_type;
SELECT count(*) FROM document_chunks;
```

### 完了条件

- 通し実行後、正常 fixture が `indexed` になる。
- failed fixture は原因を保持し、retry で再処理できる。
- ログに token、secret、本文全文、不要な PII が出ない。
- 通常の fixture ingest では chat model の token usage が 0 または未発生である。
- parser 修正後、同じ failed fixture が `indexed` まで到達する。

## Step 9 確認記録

- 実施日: 2026-06-01
- 対象 commit: 作業ブランチ `feature/issue-25-ingestion-workflow`
- 実装範囲: `pnpm ingest:run` / `pnpm ingest:status` / `pnpm ingest:retry`、fixture workflow の構造化ログ、dry-run、resume、failed-only retry reset、運用メモ
- 実行コマンド:
  - `git pull --ff-only origin main`
  - `gh issue create ...` で Issue #25 を作成
  - `pnpm ingest:run --project sample-a --source github --fixture --dry-run --embedding-provider deterministic`
  - `DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp pnpm ingest:run --project sample-a --source github --fixture --embedding-provider deterministic`
  - `DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp pnpm ingest:retry --project sample-a --source github --failed-only --embedding-provider deterministic`
  - `DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens pnpm ingest:status --project sample-a`
  - `node --check scripts/ingest-workflow.mjs`
  - `pnpm format:check`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
- 自動テスト結果: `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` が pass。`@pufu-lens/ingestion` は 40 tests pass。
- 補助的な手動確認: `ingest:run --dry-run` で collect / parse / resolve / chunk / graph の予定 step と LLM 使用量 0 を JSON Lines で確認。GitHub fixture の 1 件を手動で failed にして `ingest:retry --failed-only` で reset 1 件、最終 `indexed` 復帰を確認。
- DB 確認: `pnpm ingest:status --project sample-a` で `rawDocuments=5`、`queueItems=5`、`documents=5`、`documentChunks=5`、`emailQuotes=1`、`rawDocumentsByStatus.indexed=5`、`ingestionQueueByStatus.indexed=5`、`failedQueue=[]` を確認。
- Storage 確認: 既存 DB の parsed URI が過去検証用の `/private/tmp/pufu-lens-step4-storage`、`/private/tmp/pufu-lens-step6-storage` を参照していたため、E2E 検証では `STORAGE_ROOT=/private/tmp` を指定して既存 URI を読めることを確認。
- ログ / secret 確認: workflow log は子 CLI 結果を要約し、raw / parsed 本文、quote 本文、token、secret、API key、alias 詳細を出さない。通常 fixture ingest の `llm.chatModelCalls` と `llm.tokenUsage` は 0。
- 未確認リスク: 実データソースの parser 修正ループは Step 10 以降で source ごとの malformed raw を使って追加確認する。
- 次 step に進む判断: fixture ベースの通し実行、status 集計、failed retry、決定的 embedding、ログ安全性を確認できたため Step 10 に進める。
