# Step 8: Graph / Relation 構築

### 実装する機能

- Step 7 で作成した `documents` 行の graph key 検証
- AGE graph に Document / Actor / Topic ノードを `MERGE`
- Document と Actor の関係作成
- `SAME_AS` / `REPLY_TO` / `MENTIONS` など最小 relation
- `email_quotes` の保存
- `raw_documents.ingest_status='indexed'`、`ingestion_queue.status='indexed'` への更新

### 確認できること

- relational / vector / graph の三層に同じ document が矛盾なく保存される。
- project ごとの graph にだけ node / edge が作られる。
- 再実行しても graph node / edge が重複しない。

### 確認方法

```bash
pnpm ingest:index --project sample-a --limit 10
psql "$DATABASE_URL" -c "SELECT doc_type, title, graph_node_id FROM documents ORDER BY created_at DESC;"
psql "$DATABASE_URL" -c "SELECT ingest_status FROM raw_documents GROUP BY ingest_status;"
psql "$DATABASE_URL" -c "SELECT status FROM ingestion_queue GROUP BY status;"
pnpm test -- --run graph
```

AGE の確認クエリは helper script を用意する。

```bash
pnpm graph:query --project sample-a --cypher "MATCH (d:Document) RETURN d LIMIT 5"
pnpm graph:query --project sample-b --cypher "MATCH (d:Document) RETURN d LIMIT 5"
```

### 完了条件

- `sample-a` の graph にだけ `sample-a` のデータが存在する。
- `sample-b` から `sample-a` の document を参照できない。
- raw / queue / document / chunk / graph の件数が fixture 期待値と一致する。

## Step 8 確認記録

- 実施日: 2026-06-01
- 対象 commit: PR 作成前の `feature/issue-23-graph-relations`
- 実装範囲:
  - `indexGraphRelations` による Document / Actor / Topic node と relation edge の stable key `MERGE`
  - `documents.graph_node_id` の検証
  - Gmail quote の `email_quotes` 保存
  - `raw_documents.ingest_status` / `ingestion_queue.status` の `indexed` 更新
  - `pnpm ingest:index` と `pnpm graph:query`
- 実行コマンド:
  - `pnpm --filter @pufu-lens/ingestion test`
  - `pnpm test`
  - `pnpm typecheck`
  - `pnpm format:check`
  - `DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step8-storage pnpm create-project --slug step8-smoke-a --name "Step 8 Smoke A"`
  - `DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step8-storage pnpm create-project --slug step8-smoke-b --name "Step 8 Smoke B"`
  - `DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step8-storage pnpm ingest:collect:fixture --project step8-smoke-a`
  - `DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step8-storage pnpm ingest:parse --project step8-smoke-a --limit 10`
  - `DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step8-storage pnpm ingest:resolve-actors --project step8-smoke-a --limit 10`
  - `DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step8-storage pnpm ingest:chunk --project step8-smoke-a --limit 10 --embedding-provider deterministic`
  - `DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step8-storage pnpm ingest:index --project step8-smoke-a --limit 10`
  - `DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens pnpm graph:query --project step8-smoke-a --cypher "MATCH (d:Document) RETURN count(d)"`
  - `DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens pnpm graph:query --project step8-smoke-b --cypher "MATCH (d:Document) RETURN count(d)"`
- 自動テスト結果:
  - ingestion package: 36 tests passed
  - 全体 `pnpm test`: 5 packages successful
  - `pnpm typecheck`: 5 packages successful
  - `pnpm format:check`: passed
- 補助的な手動確認:
  - `step8-smoke-a` の `ingest:index` は 5 documents を処理し、graph edge は合計 11、Gmail quote は 1 件
  - 同一条件で `ingest:index` を再実行後、graph node は 16、edge は 11 のまま増殖しないことを確認
- DB 確認:
  - `step8-smoke-a`: `raw_documents.indexed=5`、`ingestion_queue.indexed=5`、`documents=5`、`document_chunks=5`、`email_quotes=1`
- Storage 確認:
  - `step8-smoke-a/parsed/...` の parsed JSON を入力に graph indexing を実行
- Graph 確認:
  - `step8-smoke-a`: `MATCH (d:Document) RETURN count(d)` は `5`
  - `step8-smoke-b`: `MATCH (d:Document) RETURN count(d)` は `0`
- ログ / secret 確認:
  - CLI 出力は document / raw / source id と件数のみで、OAuth token、Gemini API key、本文全文は出力しない
- 未確認リスク:
  - Graph query helper は 1 列の `RETURN` を想定する。複数列返却や可視化 UI は Step 11 以降で拡張する
- 次 step に進む判断:
  - relational / vector / graph の件数整合、project graph 分離、再実行時の graph 重複防止を fixture ベースで確認できたため Step 9 に進める
