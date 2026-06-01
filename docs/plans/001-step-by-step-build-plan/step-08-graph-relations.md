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
- 対象 commit: PR 作成前の `feature/issue-21-graph-relations`
- 実装範囲:
  - `storeGraphRelations` による Document / Actor / Topic node と最小 edge の materialize
  - `email_quotes` の置き換え保存
  - `SAME_AS` 候補 edge 作成
  - `ingest:index` と `graph:query` CLI
  - plan Step 着手時に最新 `main` からブランチを作成するルール追記
- 実行コマンド:
  - `git pull --ff-only origin main`
  - `pnpm --filter @pufu-lens/ingestion test -- --run graph`
  - `pnpm test`
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm build`
  - `node --check scripts/index-graph-relations.mjs`
  - `node --check scripts/query-graph.mjs`
  - `DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/tmp/pufu-lens-step8-storage pnpm ingest:index --project step8-smoke --limit 10`
  - `DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens pnpm graph:query --project step8-smoke --cypher "MATCH (d:Document) RETURN d LIMIT 5"`
  - `DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens pnpm graph:query --project sample-b --cypher "MATCH (d:Document) RETURN d LIMIT 5"`
- 自動テスト結果:
  - `pnpm --filter @pufu-lens/ingestion test -- --run graph`: 40 tests passed
  - `pnpm test`: 5 packages passed
  - `pnpm typecheck`: 5 packages passed
  - `pnpm lint`: 0 errors
  - `pnpm build`: 5 packages passed
- 補助的な手動確認:
  - `step8-smoke` project で fixture collection、parse、actor resolution、chunk / embedding、graph index を通し実行した。
  - `graph:query --project step8-smoke` で 5 件の `Document` node を確認した。
  - `graph:query --project sample-b` は空配列で、別 project の graph に document が混入していないことを確認した。
- DB 確認:
  - `step8-smoke` の `raw_documents.ingest_status`: `indexed = 5`
  - `step8-smoke` の `ingestion_queue.status`: `indexed = 5`
  - `step8-smoke` の `email_quotes`: `1`
- Storage 確認:
  - `/tmp/pufu-lens-step8-storage/step8-smoke/parsed` を使用し、parsed JSON から graph index まで通した。
- ログ / secret 確認:
  - CLI 出力は decision、ID、件数のみで、raw 本文全文、OAuth token、Gemini API key は出力していない。
- 未確認リスク:
  - AGE の node label は互換性のため `Document` / `Actor` / `Topic` の主ラベルにし、詳細種別は `graphLabels` property に保存した。複数ラベル利用の可否は将来の AGE バージョン差を見て再検討する。
  - `SAME_AS` は `content_hash` が一致する別 source type の Document に限定しており、埋め込み類似度による同一性判定は未実装。
- 次 step に進む判断:
  - relational / vector / graph の三層保存、project graph 分離、再実行時の MERGE idempotency を確認できたため、Step 9 に進める。
