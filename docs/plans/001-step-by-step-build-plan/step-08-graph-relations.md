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
