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

## 手動マージ

- 管理画面で project admin が Actor merge を確定した場合、代表 Actor は `active` のまま残し、吸収元 Actor は物理削除せず `status = 'merged'`、`merged_into_actor_id = <代表 Actor>`、`disabled_at`、`disabled_by_user_id`、`disabled_reason` を保存する。
- merge 時は `actor_aliases.actor_id` と `email_quotes.sender_actor_id` を代表 Actor に寄せ、判断内容を `actor_merge_decisions` に `decision_type = 'merge'` として保存する。
- reject した候補は `actor_merge_decisions` に `decision_type = 'reject'` として保存し、同じ Actor ペアを候補として再表示しない。
- Actor 詳細画面では、その Actor が代表・吸収元・reject 対象として関係した判断履歴を表示する。
- AGE graph の Actor node / edge は手動 merge 時に破壊的更新せず、後続の graph materialize / reconcile で代表 Actor に寄せる。

## 確認 SQL

```bash
psql "$DATABASE_URL" -c "SELECT display_name, primary_email, primary_login, graph_node_id FROM actors ORDER BY display_name;"
psql "$DATABASE_URL" -c "SELECT alias_type, alias_value, confidence, source FROM actor_aliases ORDER BY alias_type, alias_value;"
```
