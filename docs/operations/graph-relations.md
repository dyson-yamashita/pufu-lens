# Graph / Relation 構築

Step 8 では、`documents` と `actors` を AGE graph に materialize し、`email_quotes` と最小 relation を保存する。

## 前提

- `DATABASE_URL` が PostgreSQL / AGE / pgvector / PGroonga 入りの DB を指している。
- `STORAGE_ROOT` または `LOCAL_STORAGE_ROOT` が local object storage の root を指している。
- 対象 project で collection、parse、actor resolution、chunk / embedding が完了している。

```bash
export DATABASE_URL=postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens
export STORAGE_ROOT=./.data/volumes/pufu-lens-data
```

## 実行

```bash
pnpm ingest:index --project sample-a --limit 10
```

このコマンドは次を行う。

- `documents.graph_node_id` と parsed JSON から再計算した graph key の一致確認
- AGE graph への Document / Actor / Topic node の MERGE
- Actor から Document への `SENT` / `AUTHORED` / `COMMENTED_ON` / `REVIEWED` / `OWNS` edge の MERGE
- parsed `topics` から keyword Topic node と `MENTIONS` edge の MERGE
- parsed relation の `REPLY_TO` から message Topic node と `REPLY_TO` edge の MERGE
- GitHub PR の closing keyword（`Fixes #123` など）から、既存 Issue Document への `RELATED_TO` edge の MERGE
- `email_quotes` の置き換え保存
- `content_hash` が一致する別 source type の Document への `SAME_AS` edge の MERGE
- GitHub lifecycle-only refresh 時は Document node properties（`state`, `closedAt`, `merged`, `mergedAt`, `draft`, `statusKnown`）だけを更新し、既存 edge を再作成しない
- `raw_documents.ingest_status` と `ingestion_queue.status` の `indexed` 更新

`SAME_AS` は Step 8 時点では `content_hash` が一致する別 source type の Document だけを対象にする。埋め込み類似度による同一性判定は未実装である。

## 確認

```bash
psql "$DATABASE_URL" -c "SELECT doc_type, title, graph_node_id FROM documents ORDER BY created_at DESC;"
psql "$DATABASE_URL" -c "SELECT ingest_status, count(*) FROM raw_documents GROUP BY ingest_status ORDER BY ingest_status;"
psql "$DATABASE_URL" -c "SELECT status, count(*) FROM ingestion_queue GROUP BY status ORDER BY status;"
psql "$DATABASE_URL" -c "SELECT quote_index, sender_alias, quoted_message_id FROM email_quotes ORDER BY document_id, quote_index;"

pnpm graph:query --project sample-a --cypher "MATCH (d:Document) RETURN d LIMIT 5"
pnpm graph:query --project sample-b --cypher "MATCH (d:Document) RETURN d LIMIT 5"
```

`sample-b` から `sample-a` の document が返らないことを確認する。ログには raw 本文全文、OAuth token、Gemini API key を出さない。

## Graph Schema 変更

AGE graph の node label、edge type、property、index 相当の構造を変更する場合は、通常 migration の transaction に graph 全体の再構築を含めない。`docs/operations/db-migrations.md` の AGE Graph 方針に従い、schema migration、reader 互換、project 単位の再構築、cleanup を分ける。

deploy checklist の「DB Migration 記録」欄には、以下のように対応付けて記録を残す。

- heavy migration plan: 対象 project / graph name、追加・変更・削除する label / edge / property、reader の新旧互換期間、`pnpm ingest:index` または専用 batch script の実行計画
- read-only / maintenance window: read-only / maintenance window 要否
- batch script dry-run: dry-run 結果
- batch script command: 実行する `pnpm ingest:index` コマンド
- progress query: 進捗確認用の SQL または Cypher query
- graph / embedding smoke: `graph:query` による smoke test
- retry / resume 条件: 失敗時の resume / forward fix / restore 判断
