# Step 7: Document / Chunk / Embedding の決定的検証

### 実装する機能

- `documents` 行の最小 upsert
- `chunkAndEmbed`
- `document_chunks` への最新版チャンク挿入
- 更新・再 index 時の旧 `document_chunks` 削除と `document_chunk_history` への退避
- ローカルテスト用の deterministic embedding provider
  - 入力テキストとモデル名から hash ベースで固定長 vector を生成し、同じ入力なら必ず同じ出力を返す
  - 意味検索の品質検証ではなく、chunk / DB 書き込み / 冪等性テスト専用として扱う
- Gemini embedding provider interface
- Gemini embedding の出力次元を DB の `vector(1536)` に合わせる設定
  - `GEMINI_EMBEDDING_DIMENSIONS=1536` 相当を provider 実装で必須にし、未指定時は起動時 validation で失敗させる
- chunk size / overlap / content hash の設定

### 確認できること

- 本物の Gemini API 費用をかけずに chunk と vector 保存を検証できる。
- `document_chunks.document_id` の参照先となる `documents` 行が先に作られる。
- 同じ parsed JSON から同じ chunk / hash が生成される。
- 再実行しても chunk が重複しない。
- content hash、parser version、chunk 設定、embedding model の変更で再 index した場合、旧 chunk は検索対象から削除され、新 chunk だけが `document_chunks` に残る。
- 削除前の旧 chunk は `document_chunk_history` に残り、更新前後の差分を追跡できる。
- テスト実行時の embedding 結果が外部 API、モデル更新、レート制限に左右されない。
- Gemini embedding の dry-run で、返却 vector の次元が 1536 と一致することを検査できる。

### 確認方法

```bash
pnpm ingest:chunk --project sample-a --limit 10 --embedding-provider deterministic
pnpm ingest:chunk --project sample-a --limit 3 --embedding-provider gemini --dry-run
pnpm embedding:check --provider gemini --dimensions 1536
psql "$DATABASE_URL" -c "SELECT doc_type, title, graph_node_id FROM documents ORDER BY created_at DESC;"
psql "$DATABASE_URL" -c "SELECT document_id, chunk_index, left(content, 80), embedding_model FROM document_chunks ORDER BY document_id, chunk_index;"
psql "$DATABASE_URL" -c "SELECT document_id, chunk_index, content_hash, archived_at, archive_reason FROM document_chunk_history ORDER BY archived_at DESC;"
pnpm test -- --run chunk
```

### 完了条件

- chunk 数、順序、hash が snapshot と一致する。
- parsed JSON から `documents` が idempotent に作成される。
- 同じ対象を再実行しても `document_chunks` が増殖しない。
- 更新が検知された対象は、旧 `document_chunks` が削除され、新しい chunk set に置き換わる。
- 置き換え前の chunk set は `document_chunk_history` に保存され、`archived_at` と `archive_reason` で追跡できる。
- embedding provider を deterministic / Gemini で切り替えられる。
- Gemini 利用時の embedding 次元と `document_chunks.embedding` の次元が一致する。
- DB schema と異なる embedding 次元では validation error になる。

## Step 7 確認記録

- 実施日: 2026-05-31
- 対象 commit: PR 作成前の `feature/issue-19-chunk-embedding`
- 実装範囲:
  - `chunkAndEmbed`、deterministic embedding provider、Gemini embedding provider interface
  - `documents` upsert と `document_chunks` 最新版保存
  - `document_chunk_history` への退避 schema / repository 実装
  - `pnpm ingest:chunk` と `pnpm embedding:check`
- 実行コマンド:
  - `pnpm --filter @pufu-lens/ingestion test`
  - `pnpm test`
  - `pnpm typecheck`
  - `pnpm format:check`
  - `pnpm embedding:check --provider deterministic --dimensions 1536`
  - `infisical run --env=dev --path=/ -- pnpm embedding:check --provider gemini --dimensions 1536`
  - `pnpm ingest:collect:fixture --project step7-smoke`
  - `pnpm ingest:parse --project step7-smoke --limit 10`
  - `pnpm ingest:chunk --project step7-smoke --limit 10 --embedding-provider deterministic`
  - `pnpm ingest:chunk --project step7-smoke --limit 10 --embedding-provider deterministic`（再実行）
  - `infisical run --env=dev --path=/ -- pnpm ingest:chunk --project step7-smoke --limit 3 --embedding-provider gemini --dry-run`
- 自動テスト結果:
  - ingestion package: 33 tests passed
  - 全体 `pnpm test`: 5 packages successful
  - `pnpm typecheck`: 5 packages successful
  - `pnpm format:check`: passed
- 補助的な手動確認:
  - deterministic embedding check は `dimensions=1536`、`model=deterministic-sha256-v1`、`ok=true`
  - Gemini embedding check は `dimensions=1536`、`model=gemini-embedding-2`、`ok=true`
  - Gemini dry-run は 3 件すべて `dry_run`
  - `step7-smoke` 初回 chunk は 5 documents / 5 chunks を `indexed`
  - 同一条件の再実行は 5 件すべて `unchanged`
- DB 確認:
  - `documents=5`
  - `document_chunks=5`
  - `document_chunk_history=0`（再実行は unchanged のため履歴なし。履歴退避は unit test で確認）
- Storage 確認:
  - `step7-smoke/parsed/...` の parsed JSON を入力に chunk 実行
- ログ / secret 確認:
  - Infisical から `GEMINI_API_KEY` を注入し、secret 値はログ出力なし
- 未確認リスク:
  - Gemini 実 API の dry-run は `gemini-embedding-2` で確認済み。`text-embedding-004` は現行 API で 404 だったため既定値から外した。`gemini-embedding-001` は 2026-07-14 に提供終了予定のため、既定値から外した
  - 既存 Docker volume は Step 7 前の schema だったため、smoke test 前に `document_chunk_history` をローカル DB へ非破壊追加した。fresh DB では `infra/docker/postgres/init.sql` から作成される
- 次 step に進む判断:
  - fixture ベースの deterministic chunk / embedding、冪等性、DB 件数確認が通ったため Step 8 に進める
