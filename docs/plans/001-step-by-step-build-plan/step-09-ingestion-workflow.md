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
