# Graph / Relation 構築

Step 8 では、`documents` と `actors` を AGE graph に materialize し、`email_quotes` と最小 relation を保存する。

Plan 018 Step 2A では移行先として `graph_nodes` / `graph_edges` schemaをadditiveに追加し、Step 2B では同schemaを
使うrelational Graph read / mutation adapterを追加した。ViewerとSynthetic Monitorを含むDB testは明示DIで
relational adapterを検証する。現行productionの`ingest:index`、Graph read / Viewer、Actor merge、Document cleanup、
Synthetic Monitorは引き続きAGE adapterを使い、既定compositionやread / write profileは切り替えない。

### Relational graph schema（Step 2A）

- node identityは既存`graphNodeId`を`node_key`として維持し、`project_id + node_key`で一意にする。
- edge identityは`project_id + source_node_key + target_node_key + relation_type`で、relation typeは
  `GRAPH_EDGE_TYPES`の`AUTHORED`、`COMMENTED_ON`、`MENTIONS`、`OWNS`、`REPLY_TO`、`RELATED_TO`、
  `REVIEWED`、`SAME_AS`、`SENT`だけを許可する。
- endpoint FKは同じ`project_id`のnodeだけを参照でき、unknown relation、orphan、project越境edgeをDBで拒否する。
- project deleteとnode deleteはcascadeする。将来のDocument cleanupは対象node deleteでincident edgeを削除し、
  Actor mergeはedgeをprimaryへupsert / dedupeしてsecondary edgeを明示削除した後にsecondary nodeを削除する。
- propertiesはprovider-neutral JSON objectに限定する。content、PII、secretをschema test fixtureやlogへ記録しない。
- outgoing / incoming traversal用indexだけを2Aで作る。relation type単独 / recent document indexは2B以降の
  representative query計測で必要性を判断する。
- `0026_relational_graph_schema`はAGE dataをcopyしない。live AGE inventoryとsource-of-truth auditは2Cで行い、
  差分が解消または明示判断されるまで全graphを再生成可能と断定しない。

### Relational Graph adapter（Step 2B）

- read adapterはproject-scopedなnode / relation count、SAME_AS / RELATED_TO 1-hop、MENTIONS 2-hop、Viewer presetを
  bounded SQLで実装する。全queryはread-only transaction、5秒timeout、deterministic order / row上限を使う。
- mutation adapterはproject graph lifecycle、node / 9 edge typeのidempotent upsert、Document node cleanup、
  Actor mergeを同一transactionで実装する。SAME_ASはendpointを`node_key`順にcanonicalizeする。
- Viewer / Synthetic Monitorへの接続はtestの明示DIだけであり、productionのAGE primary compositionは維持する。
- adapter testは専用project fixtureだけを作成・削除し、AGE graphや既存projectには触れない。ログにはproperties、
  node identity、content、PII、secretを出さず、安全なoperation / error種別だけを記録する。
- Step 2Bはmigration、backfill、live AGE inventory、dual-write / shadow read、production switchを行わない。
  これらはStep 2C以降のmerge gateを順に満たしてから実施する。

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

`ingest:index` は通常、AGE graph 上に `Document` node が無い document を対象にする。再 parse 後の `raw_documents.ingest_status='parsed'` は、既存 `Document` node があっても graph re-index 対象として選び、Topic / actor / relation edge を MERGE した後に `indexed` へ戻す。`indexed` だけの document は再 index しない。

`SAME_AS` は Step 8 時点では `content_hash` が一致する別 source type の Document だけを対象にする。埋め込み類似度による同一性判定は未実装である。

実装境界では、CLI は `ProjectResolver` で slug を検証済み `projectId` に解決し、relational lookup / status 更新を `GraphIndexingRepository`、AGE node / edge mutation を `GraphMutationRepository` へ委譲する。CLI と ingestion workflow は graph name、Cypher、agtype、provider transaction を受け渡さず、現行 PostgreSQL + AGE 固有処理は adapter 内に閉じる。Actor merge、Document cleanup、project graph lifecycle も同じ mutation capability を使い、public contract は常に `projectId` で scope する。

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
