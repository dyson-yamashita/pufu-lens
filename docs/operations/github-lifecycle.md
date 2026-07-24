# GitHub lifecycle status 同期

GitHub PR / Issue の `open` / `closed` / `merged` / `draft` を raw → parsed → `documents.metadata` → AGE Graph → private chat retrieval context へ伝搬する。

## 内部 contract（Issue #648 向け）

- `GitHubDocumentLifecycle`: `state`, `closedAt`, `mergedAt`, `merged`, `draft`, `stateReason`, `updatedAt`, `kind`, `statusKnown`
- `statusKnown=false` は lifecycle 未同期を意味する
- `GitHubLifecycleSelectionHint`: `prefer_open` / `prefer_closed_or_merged` / `open_primary_closed_background` / `include_all`
- metadata key: `githubLifecycle`, lifecycle-only refresh flag: `lifecycleOnly`

## 通常収集

`pnpm ingest:collect` の GitHub collection は PR 一覧、standalone Issue 一覧、linked Issue 個別取得のいずれでも同じ lifecycle 正規化を `raw_documents.metadata.githubLifecycle` へ保存する。

## bounded reconciliation / backfill

```bash
export DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens
export STORAGE_ROOT=./.data/volumes/pufu-lens-data

# dry-run: 対象件数と API 見積（OAuth 接続は不要）
pnpm ingest:github-lifecycle --project sample-a --dry-run

# 既知 item を logicalSourceId 昇順で安定巡回（open/closed 問わず reopen を検出）
pnpm ingest:github-lifecycle --project sample-a --data-source-id <uuid> --mode reconcile --batch-size 50

# 既知 logical source 全体を backfill（既定 limit は 10000）
pnpm ingest:github-lifecycle --project sample-a --data-source-id <uuid> --mode backfill

# resume（completed-through cursor: この logicalSourceId まで完了。rate_limited 時は未完了 item を含む）
pnpm ingest:github-lifecycle --project sample-a --data-source-id <uuid> --resume-after example-org/repo/issues/101
```

`reconcile` と `backfill` は同じ安定巡回アルゴリズムを使う。違いは既定 `--limit` のみ（reconcile=50、backfill=10000）。

`--limit` / `--batch-size` / `--max-runtime-seconds` は正の整数のみ受け付け、batch は最大 100、runtime は最大 3600 秒。

decision:

- `unchanged`: API と保存済み lifecycle が一致
- `status_changed`: lifecycle 更新を queue
- `not_found` / `forbidden` / `rate_limited` / `fetch_failed`: 取得失敗を診断

`rate_limited`（HTTP 429 または HTTP 403 + `x-ratelimit-remaining=0`）を検出した batch は以降の API 呼び出しを停止する。`resumeAfter` は completed-through cursor（その batch で最後まで正常に消化した logicalSourceId、または入力 cursor）を指す。rate-limited item 自体は cursor に含めず、`remaining` に含めて次回 resume で再取得する。先頭 item で rate limit なら `resumeAfter` は入力 cursor / 未指定、`remaining` は全対象。

CLI 出力は decision 集計と `resumeAfter` のみを返し、per-item の repository 名や API path は含めない。

`lifecycleOnly=true` の raw は本文再取得・Gemini・embedding 再生成を行わず、document metadata と Graph Document properties のみ更新する。queue 時は同一 transaction で `raw_document_data_sources` も link する。

## セキュリティ / コスト

- 認可済み project / data source に紐づく GitHub OAuth connection（GitHub App installation token または暗号化 access token）のみ使用
- data source ごとの `connection_id` で token を解決し、project / owner 境界を維持
- OAuth token、private repo 名、API response 本文をログに出さない
- reconciliation は batch size / max runtime で GitHub API 呼び出しを bounded

## 確認

```bash
psql "$DATABASE_URL" -c "SELECT metadata->'githubLifecycle' FROM raw_documents WHERE source_type='github' LIMIT 3;"
psql "$DATABASE_URL" -c "SELECT metadata->'githubLifecycle' FROM documents WHERE doc_type IN ('issue','pull_request') LIMIT 3;"
pnpm graph:query --project sample-a --cypher "MATCH (d:Document) WHERE d.state IS NOT NULL RETURN d.title, d.state, d.merged LIMIT 5"
```
