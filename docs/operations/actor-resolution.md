# Actor Resolution

Step 6 では parsed JSON の `actors` と Gmail `emailQuotes` から Actor alias を抽出し、`actors` / `actor_aliases` に冪等に保存する。

## 実行

```bash
pnpm ingest:resolve-actors --project sample-a --limit 10
```

必要な環境変数:

- `DATABASE_URL`: PostgreSQL 接続文字列
- `STORAGE_ROOT` または `LOCAL_STORAGE_ROOT`: local object storage の root

## 挙動

- `email` と `github_login` は strong alias として扱い、既存 Actor 検索と統合に使う。
- `display_name` は confidence `0.4` の低確信度 alias として resolve output に含めるが、単独では永続 alias にせず、既存 Actor へ自動統合しない。
- Gmail quote sender は `Name <email>` 形式から email alias を抽出し、`quoteIndex` を 1 から始まる引用順として出力する。
- 同じ alias の再投入では `actor_aliases` 件数を増やさず、異なる検出元がある場合は `source` に追記する。

## 確認 SQL

```bash
psql "$DATABASE_URL" -c "SELECT display_name, primary_email, primary_login, graph_node_id FROM actors ORDER BY display_name;"
psql "$DATABASE_URL" -c "SELECT alias_type, alias_value, confidence, source FROM actor_aliases ORDER BY alias_type, alias_value;"
```
