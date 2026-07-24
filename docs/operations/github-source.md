# GitHub 実データソース収集と topic 再抽出

GitHub issue / PR の topic 抽出は built-in parser `fixture-parser-v2` で有効になる。旧 `fixture-parser-v1` で parse / index 済みの document は、parsed JSON に `topics` が無いか空のまま残る。

## Topic 抽出の境界

- `TopicExtractionAgent` 入力: `{ title, bodyText: issue/PR body（null/undefined は空文字）, canonicalUri: html_url, html: '' }`
- agent 入力に含めない: `comments` / `reviews` / review comments / diff 本文 / diff metadata / actor / token / connection metadata / internal URI
- `ParsedDocument.bodyText` は従来どおり起票本文 + comments。chunk / embedding はこの全文を使う
- Graph の `Topic` node / `MENTIONS` edge は parsed `topics` から materialize する

## Provider と上限

`scripts/parse-raw-documents.ts` と `ingest:run` は `GEMINI_API_KEY` + `GEMINI_CHAT_MODEL` が設定されている場合に Gemini topic provider を使い、未設定時は deterministic provider に fallback する。

| 項目          | 既定値      |
| ------------- | ----------- |
| 最大 topic 数 | 10          |
| 最大候補語数  | 40          |
| 本文 excerpt  | 12,000 文字 |

コスト確認は workflow JSON Lines の LLM 使用量サマリと Gemini の利用量ダッシュボードを参照する。

## 新 parser version の seed

`fixture-parser-v1` は immutable のまま保持し、`fixture-parser-v2` を insert して active を切り替える。

```bash
DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=./.data/volumes/pufu-lens-data \
  pnpm ingest:parse --project sample-a --source github --limit 0
```

`limit 0` でも parse script の built-in parser seed は走り、approved `fixture-parser-v2` が無ければ insert し、続く別 statement で active に設定する。既存 `fixture-parser-v1` の artifact hash は更新しない。built-in managed profile（`Built-in <source> parser`）は意図的に approved `fixture-parser-v2` を active に保ち、既に v2 が active なら不要な `active_version_id` UPDATE は行わない。

## project 単位の再 parse（推奨）

`ingest:reprocess` は built-in profile 名 `Built-in github parser` の active parser version と `raw_documents.parser_version_id` が異なる最新 GitHub raw / queue だけを bounded に reset する。別名の custom parser profile は stale 判定に使わない。候補は `ingestion_queue.data_source_id` 基準で一意に選び、reset 時に `parsed_uri` も null にして古い parsed JSON への retry 巻き戻しを防ぐ。原本再 fetch はしない。

`ingest:reprocess` は Issue #649 スコープとして `--source github` のみをサポートする。`fixture-parser-v2` の global bump は全 source type の built-in seed に適用されるが、parser version migration の bounded reset は GitHub に限定する（web / gmail / drive の再処理は本 Issue 範囲外）。

dry-run で対象件数と `sourceId` を確認する:

```bash
DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  pnpm ingest:reprocess --project sample-a --source github --dry-run --limit 10
```

apply は明示フラグ必須。reset 後に parse 以降を 1 回実行する:

```bash
DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=./.data/volumes/pufu-lens-data \
  GEMINI_API_KEY=... \
  GEMINI_CHAT_MODEL=... \
  pnpm ingest:reprocess --project sample-a --source github --apply --limit 10 \
    --resume-from parse --embedding-provider deterministic
```

project 全体をバッチ drain する:

```bash
DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens \
  STORAGE_ROOT=./.data/volumes/pufu-lens-data \
  pnpm ingest:reprocess --project sample-a --source github --apply --limit 10 --drain \
    --resume-from parse --max-batches 100 --max-runtime-seconds 540 \
    --embedding-provider deterministic
```

JSON Lines には `remaining`、`selectedCount`、`selectedSourceIds`（sourceId のみ）を出し、本文・token・secret は出さない。新 version で parse 済みの raw は次回対象外になる。

`ingest:reprocess` の workflow は通常 `ingest:run` と同じ step 集合（`--resume-from` / `--step` / `--drain`）を受け取るが、graph と chunk の両方が含まれる場合だけ **graph → chunk** の順に正規化する。通常 ingest の `STEP_ORDER`（parse→resolve→chunk→graph）は変更しない。これにより parse 直後の `ingest_status='parsed'` のうちに graph が Topic / `MENTIONS` を再 materialize し、その後 chunk が `indexed` raw も含めて既存契約どおり処理する。

進捗確認:

```bash
pnpm ingest:status --project sample-a
```

失敗時は既存 retry を使う:

```bash
pnpm ingest:retry --project sample-a --source github --failed-only --embedding-provider deterministic
```

held raw の contract / parser 実行 dry-run:

```bash
pnpm parser:version:validate --project sample-a --source github --held --dry-run
```

## 単一 raw の手動 reset（例外）

対象は必ず `project_slug` と `source_id` で絞る。通常は `ingest:reprocess` を使う。

## Smoke 手順（実データ）

1. `pnpm ingest:reprocess --project sample-a --source github --dry-run --limit 5` で対象件数を確認する
2. `pnpm ingest:reprocess --project sample-a --source github --apply --limit 1 --resume-from parse` で 1 件だけ再 parse する
3. `pnpm ingest:inspect --project sample-a --source github --limit 5 --format json` で parsed `topics` と graph 要約を確認する
4. chunk / embedding は `bodyText`（起票本文 + comments）のままなので、既存 chunk 数が大きく変わらないことを確認する
