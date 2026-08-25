# Graph / Relation 構築

Step 8 では、`documents` と `actors` を AGE graph に materialize し、`email_quotes` と最小 relation を保存する。

Plan 018 Step 2A では移行先として `graph_nodes` / `graph_edges` schemaをadditiveに追加し、Step 2B では同schemaを
使うrelational Graph read / mutation adapterを追加した。ViewerとSynthetic Monitorを含むDB testは明示DIで
relational adapterを検証する。現行productionの`ingest:index`、Graph read / Viewer、Actor merge、Document cleanup、
Synthetic Monitorは引き続きAGE adapterを使い、既定compositionやread / write profileは切り替えない。

Plan 018 Step 2C では、source dataからrelational graphをproject単位で再構築し、AGEとの構造差分を監査する
operator CLIを追加した。CLIはproduction compositionへ接続せず、AGE primary read / writeも変更しない。live AGE
inventoryは未実施であり、差分ゼロまたは明示的な扱いが決まるまでは全graphを再生成可能と扱わない。

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
- `0026_relational_graph_schema`はAGE dataをcopyしない。2Cでlocal rebuild / compareとsource-of-truth auditを
  実装したが、live AGE inventoryは未実施である。差分が解消または明示判断されるまで全graphを再生成可能と断定しない。

### Relational Graph adapter（Step 2B）

- read adapterはproject-scopedなnode / relation count、SAME_AS / RELATED_TO 1-hop、MENTIONS 2-hop、Viewer presetを
  bounded SQLで実装する。全queryはread-only transaction、5秒timeout、deterministic order / row上限を使う。
- mutation adapterはproject graph lifecycle、node / 9 edge typeのidempotent upsert、Document node cleanup、
  Actor mergeを同一transactionで実装する。SAME_ASはendpointをUTF-8 byte順にcanonicalizeし、PostgreSQLの
  merge SQLでは明示的な`COLLATE "C"`でapplication側と同じ順序を使う。
- Viewer / Synthetic Monitorへの接続はtestの明示DIだけであり、productionのAGE primary compositionは維持する。
- adapter testは専用project fixtureだけを作成・削除し、AGE graphや既存projectには触れない。ログにはproperties、
  node identity、content、PII、secretを出さず、安全なoperation / error種別だけを記録する。
- Step 2Bはmigration、backfill、live AGE inventory、dual-write / shadow read、production switchを行わない。
  2Cのlocal rebuild / compare契約を満たした後も、live inventoryと後続gateを順に満たしてから実施する。
- `graph_nodes.properties ->> 'documentId'`を使う代表queryはStep 2Cのlocal synthetic fixtureで実行手順を確認した。
  production相当row count / p95は未取得であり、expression indexは後続の実測なしに追加しない。

### Rebuild / compare audit（Step 2C）

`graph:migrate`は任意SQL / Cypher / graph nameを受け付けず、`--project`で解決したprojectだけを対象にする。
rebuildは現在の`documents` / `raw_documents`、parsed artifact、Actor / alias、email quote等からnode / edgeを
再計算し、relational adapterへidempotentにupsertする。既存relational graphを先に全削除しない。source-of-truthの
完全性が確定する前に片側だけのrowを失わず、compareでAGE-only / relational-onlyとして検出するためである。

```bash
# 書込みなし。件数と次のopaque cursorだけを確認する
pnpm graph:migrate rebuild --project sample-a --dry-run --limit 100

# local / test / 承認済み環境だけでproject単位batchを書き込む
pnpm graph:migrate rebuild --project sample-a --execute --limit 100
pnpm graph:migrate rebuild --project sample-a --execute --limit 100 \
  --resume-cursor <64-character-lowercase-hex>

# AGEとrelational graphの構造およびsource-of-truth集計をread-onlyで比較する
pnpm graph:migrate compare --project sample-a --limit 50000
```

- rebuildは`--dry-run`と`--execute`のどちらか一方を必須とする。1 batchのexecuteは単一transactionであり、
  途中に1件でも失敗があればnode / edge更新を全てrollbackする。ingestion statusと`email_quotes`は変更しない。
- parsed artifactはSQL順序を維持したまま最大8件ずつ並列読取し、large limitでもObject Storageへ無制限な
  同時requestを発行しない。1件でも読取に失敗した場合はmutation開始前にbatchを失敗させる。
- dry-runで失敗があった場合は`nextResumeCursor`を返さず、失敗対象を飛ばして進めない。成功時のcursorは
  raw document UUIDのSHA-256 digestで、raw identityを出力しない。resume後も同じproject scopeを維持する。
- compareはproject解決、AGE / relational inventory、source auditを同じ`REPEATABLE READ READ ONLY` transactionで
  実行し、AGE sessionも同じ接続にpinする。node / edge identityをprocess内でSHA-256 digestへ変換し、出力は
  件数、`gateStatus`、source audit categoryだけに限定する。node key、document identity、property値、content、
  PII、secretは出力しない。
- AGEのphysical labelと`graphLabels` propertyを正規化した和集合を、relationalのprovider-neutral
  `graphLabels`と比較する。SAME_ASはendpoint順をcanonicalizeし、その他8 relationは方向を維持する。
- `gateStatus=pass`はbounded inventoryにtruncationも差分もない場合だけである。上限を超えた場合は
  `inconclusive`、duplicate / orphan / unknown relation /片側だけのrow / label・property-key drift / source audit
  blockerがあれば`blocked`とする。`currentLifecycleOnlyDocument`は再構築modeでfull relationを再計算するため
  情報項目であり、単独ではblockerにしない。
- source auditは、current documentのparsed artifact / status不足、merged Actorを参照し続けるalias / email quote、
  merge decision不整合、Document rowのないrelational Document nodeを件数で検出する。

productionのrebuild / compare、live AGE inventory、deploy、read / write切替はStep 2Cの実装作業では行わない。
実行時は事前backup、対象project、batch上限、cursor記録、rollback判断をdeploy checklistへ残し、live compareの
`pass`または承認済みdecision logをStep 2D開始gateとする。

#### Representative queryの計測

index追加はlocal / stagingのproduction相当fixtureで次の順序を守る。`EXPLAIN ANALYZE`はqueryを実行するため、
productionでは明示承認とread-only transactionなしに実行しない。

1. 対象projectのnode / edge件数とrepresentative 1-hop / 2-hopの実行条件を記録する。
2. relational adapterが使うSAME_AS / RELATED_TO 1-hop、MENTIONS 2-hop、および
   `graph_nodes.properties ->> 'documentId'` filterを`EXPLAIN (ANALYZE, BUFFERS, SETTINGS)`で計測する。
3. 既存outgoing / incoming indexのscan種別、actual rows、loops、buffer hit / read、planning / execution timeを記録する。
4. 10倍相当fixtureでも同じqueryを反復し、p50 / p95と書込みcostを比較する。expression indexは
   `properties ->> 'documentId'`の高いfiltered-row比率が継続し、index追加で代表queryが安定して改善し、
   upsert overheadを許容できる場合だけ別migration / PRで追加する。

2Cではlocal transaction内に100 Document / 20 Topic、RELATED_TO 99 edge、MENTIONS 100 edgeのsynthetic fixtureを
作り、1-hopと2-hopを`EXPLAIN (ANALYZE, BUFFERS, SETTINGS)`で実行してrollbackした。小規模fixtureではどちらも
sequential scanを含み、実行時間はそれぞれ約0.19ms / 0.10msだった。この規模ではindex追加の効果を判断できないため、
DDLは追加しない。production row countや10倍相当fixtureでのp50 / p95、buffer、write overhead取得を後続gateに残す。

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
