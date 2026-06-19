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

- `email`、`github_login`、Web author profile 由来の `domain` は strong alias として扱い、既存 Actor 検索と統合に使う。
- `display_name` は confidence `0.4` の低確信度 alias として resolve output に含めるが、単独では永続 alias にせず、既存 Actor へ自動統合しない。display name のみの Gmail quote sender は quote ごとの未解決 Actor として分離する。
- Web page の JSON-LD / meta author から抽出した author は、profile URL がある場合に `hostname/path` 形式の `domain` alias を持つ。同一 profile の author は document をまたいで同じ Actor に統合する。
- Gmail quote sender は `Name <email>` 形式から email alias を抽出し、`quoteIndex` を 1 から始まる引用順として出力する。
- 同じ alias の再投入では `actor_aliases` 件数を増やさず、異なる検出元がある場合は `source` に一意マージする。
- 後続の parsed document で email と GitHub login が同一人物として bridge された場合、既存 alias の `actor_id` は解決先 Actor に更新される。
- `graph_node_id` は alias や source id などの component を URL encode した安定 ID として保存する。

## 確認 SQL

```bash
psql "$DATABASE_URL" -c "SELECT display_name, primary_email, primary_login, graph_node_id FROM actors ORDER BY display_name;"
psql "$DATABASE_URL" -c "SELECT alias_type, alias_value, confidence, source FROM actor_aliases ORDER BY alias_type, alias_value;"
```
