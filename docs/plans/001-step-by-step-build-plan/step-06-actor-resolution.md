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

## Step 6 確認記録

- 実施日: 2026-05-31
- 対象 commit: PR 作成前の `feature/issue-17-actor-resolution`
- 実装範囲: `resolveActors`、Actor alias repository 境界、`pnpm ingest:resolve-actors`、Gmail quote sender / quoteIndex 正規化、actor resolution unit test、運用メモ
- 実行コマンド:
  - `pnpm format:check`
  - `pnpm typecheck`
  - `pnpm test`
  - `DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step6-storage pnpm seed:projects`
  - `DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step6-storage pnpm ingest:collect:fixture --project sample-b`
  - `DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step6-storage pnpm ingest:parse --project sample-b --limit 10`
  - `DATABASE_URL=postgres://pufu_lens:pufu_lens@localhost:5432/pufu_lens STORAGE_ROOT=/private/tmp/pufu-lens-step6-storage pnpm ingest:resolve-actors --project sample-b --limit 10` を 2 回
- 自動テスト結果: `pnpm test` で 5 package 成功。`@pufu-lens/ingestion` は 22 tests pass。
- 補助的な手動確認: `sample-b` で Gmail / Drive / Web parsed JSON を対象に Actor resolve CLI が成功。Gmail quote は `quoteIndex: 1`、`senderActorId` が `Sample Reviewer` の Actor に解決されることを確認。
- DB 確認: `sample-b` の `actors` は 3 件、`actor_aliases` は 3 件。CLI 再実行後も件数は不変。
- Storage 確認: `/private/tmp/pufu-lens-step6-storage/sample-b/parsed/...` の parsed JSON を CLI が読み込み。
- ログ / secret 確認: CLI 出力に OAuth token / API key / DB password / raw 本文全文は出ていない。quote output は fixture 本文のみを含む。
- 未確認リスク: `documents` / `email_quotes` テーブルへの永続化は Step 7 以降の Document / Graph 構築側で扱うため、この Step では resolve output まで。
- 次 step に進む判断: strong alias の統合、display name 単体の非統合、Gmail quote 順序、alias 冪等性を確認できたため Step 7 に進める。
