# Step 6: Actor 名寄せと引用チェーン

### 実装する機能

- `resolveActors`
- `actors` / `actor_aliases` upsert
- Gmail quote から sender alias を抽出
- Gmail quote chain を parsed JSON / resolve output として正規化
- alias の confidence / source 記録

### 確認できること

- 同じメールアドレスや GitHub login が同じ Actor に集約される。
- display name だけの曖昧な alias を不用意に統合しない。
- Gmail の最新メール本文と過去引用が分離される。

### 確認方法

```bash
pnpm ingest:resolve-actors --project sample-a --limit 10
psql "$DATABASE_URL" -c "SELECT display_name, primary_email, primary_login, graph_node_id FROM actors ORDER BY display_name;"
psql "$DATABASE_URL" -c "SELECT alias_type, alias_value, confidence, source FROM actor_aliases ORDER BY alias_type, alias_value;"
pnpm test -- --run actor
```

### 完了条件

- fixture 上の既知 Actor 数と DB 件数が一致する。
- alias の重複投入で件数が増えない。
- Gmail quote の順序が parsed JSON / resolve output 上の `quote_index` で再現できる。
