# Graph / Relation 構築

Step 8 では、`documents` と `actors` を AGE graph に materialize し、`email_quotes` と最小 relation を保存する。

Plan 018 Step 2A では移行先として `graph_nodes` / `graph_edges` schemaをadditiveに追加し、Step 2B では同schemaを
使うrelational Graph read / mutation adapterを追加した。ViewerとSynthetic Monitorを含むDB testは明示DIで
relational adapterを検証する。Step 2Dではproduction composition rootをAGE-primaryのtransition factoryへ統一した。
Issue #723はCloud Buildの安全な既定を`off`に保ったまま、production Web / Mastra / Workflow Jobsを`dual-write`へ揃える
rollout configを追加し、2026-09-05にdeployした。Issue #726では観測修正の先行反映後、2026-09-12のユーザーによる
残余リスク承認に基づきtracked Webを`dual-write-shadow-read`へ変更する。本番への反映は別途承認待ちで、稼働modeは`dual-write`のままである。

Plan 018 Step 2C では、source dataからrelational graphをproject単位で再構築し、AGEとの構造差分を監査する
operator CLIを追加した。CLIはproduction compositionへ接続せず、AGE primary read / writeも変更しない。
承認済みのlive rebuild / compareは3 project中2 projectがpassした。596 documentsのprojectは追加source auditにより
relationalがcurrent source期待値と完全一致し、AGE側にlegacy / stale差分があると判断した。このdecisionは
current-source relational出力の採用であり、AGEの全履歴が再生成可能という断定ではない。

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
- `0026_relational_graph_schema`はAGE dataをcopyしない。2Cでrebuild / compareとsource-of-truth auditを実装し、
  live実行した結果も差分が残った。差分が解消または明示判断されるまで全graphを再生成可能と断定しない。

### Relational Graph adapter（Step 2B）

- read adapterはproject-scopedなnode / relation count、SAME_AS / RELATED_TO 1-hop、MENTIONS 2-hop、Viewer presetを
  bounded SQLで実装する。全queryはread-only transaction、5秒timeout、deterministic order / row上限を使う。
- mutation adapterはproject graph lifecycle、node / 9 edge typeのidempotent upsert、Document node cleanup、
  Actor mergeを同一transactionで実装する。SAME_ASはendpointをUTF-8 byte順にcanonicalizeし、PostgreSQLの
  merge SQLでは明示的な`COLLATE "C"`でapplication側と同じ順序を使う。
- node upsertは既存`properties`と入力`properties`をmergeし、同名keyは入力値を優先する。full Documentの後に
  sparse placeholderをupsertしても省略keyを保持し、逆順でもplaceholder固有keyを保持する。edge propertiesの
  conflict更新は従来どおりであり、本補修では変更しない。
- Step 2B完了時点ではViewer / Synthetic Monitorへの接続はtestの明示DIだけだった。Step 2Dでproduction compositionを
  transition factoryへ統一した後も、AGE primaryと既定`off`を維持する。
- adapter testは専用project fixtureだけを作成・削除し、AGE graphや既存projectには触れない。ログにはproperties、
  node identity、content、PII、secretを出さず、安全なoperation / error種別だけを記録する。
- Step 2Bはmigration、backfill、live AGE inventory、dual-write / shadow read、production switchを行わない。
  2Cのrebuild / compareをlive実行した後も差分が残っており、差分補修と後続gateを順に満たしてから実施する。
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
- compareはObject Storageを初期化せず、storage driver / root / bucketの環境変数を必要としない。
- `labelPropertyKeyMismatchCount`は、一致するidentityのnodeでlabel / property-key集合が異なる件数と、
  一致するedgeでproperty-key集合が異なる件数の合計である。node / edgeのいずれも1件ずつ数える。
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

### Dual-write / shadow read（Step 2D）

`PUFU_LENS_GRAPH_TRANSITION_MODE`はdeployment単位のserver-only設定である。request、project、API inputから変更しない。

| 値                       | write                                  | read                                 |
| ------------------------ | -------------------------------------- | ------------------------------------ |
| 未設定 / 空 / `off`      | AGEのみ                                | AGEのみ                              |
| `dual-write`             | AGE primaryの後にrelationalへ全件write | AGEのみ                              |
| `dual-write-shadow-read` | AGE primaryの後にrelationalへ全件write | AGEを返し、固定10%でrelationalを比較 |

未知の値は起動後のcomposition時にfail closedする。shadow readはAGE primary完了後に実行し、外側6秒、adapter SQL 5秒の
timeoutを適用する。shadowのtimeout / error / mismatch、観測出力の失敗でuser responseは変えず、AGE結果を返す。

mutationは次のfailure契約を使う。

- node / edge upsert、project graph lifecycle、Actor mergeはAGE→relationalの順に実行する。secondary失敗または
  Actor merge outcome不一致は`GraphShadowMutationError`として呼出元へ返す。caller-owned transaction内なら両backendを
  同じtransactionへbindするため、AGE側を含めてrollbackされる。
- `ingest:index`は1 documentのnode / edge mutation、`email_quotes`、indexed statusをcaller-owned transactionへまとめる。
  secondary失敗時は両graphとstatus更新をrollbackし、transaction外でfailed statusを記録する。既存failed queue retryは
  source rowを保ったまま同じ入力を再実行する。
- Data Source削除はDocument cleanupを`raw_documents` / `data_sources`削除より先に同じtransactionで実行する。
  secondary errorまたはAGE / relational count差分は`GraphShadowMutationError`にしてsource削除ごとrollbackするため、
  source rowとgraph node IDが再実行入力として残る。別outboxやcleanup queueは追加しない。

比較eventは`graph_transition_observation`で、capability、operation、match / mismatch / shadow_error /
shadow_timeout、固定provider名、整数latency、有限のmismatch categoryだけを出す。project / node / document / edge identity、
properties、property値、query、error本文、content、PII、secretを出さない。成功mutationは固定1%を観測し、
mismatch / error / timeoutは全件記録する。

`ingest-workflow`は子script終了後、stdout内の一行観測JSONをresultから分離してallowlist検証し、
上記項目だけを親stdoutへ転送する。子scriptが非zero終了した場合も転送し、observer例外はworkflow結果を変えない。
同名eventの不正なpayloadは転送せずresultからも除く。任意のchild stdoutや追加fieldをそのままログへ流さない。
子process終了前に親processが停止した場合はbuffered観測を失うため、観測0件だけを成功証拠にしない。

Step 2Dのapplication PR #722は本番設定を変更しない。有効化はIssue #723の別PRと明示承認を必要とし、`dual-write`→backfill / compare確認→
`dual-write-shadow-read`の順とする。異常時は環境変数を`off`または未設定へ戻して再deployし、relational tableを削除せず
forward-fix / rebuild対象として保持する。relational primaryへの切替はStep 2Eの独立gateである。

#### Production dual-write rollout（Issue #723）

- このrollout時のproduction App Hostingはruntime-onlyの`PUFU_LENS_GRAPH_TRANSITION_MODE=dual-write`をtracked configに持つ。
- Cloud Buildは`_GRAPH_TRANSITION_MODE=off`を安全な既定値とし、3 canonical mode以外をruntime deploy前に拒否する。
  production triggerだけを`dual-write`へ上書きし、Mastra Serverと6 Workflow Jobsへ同じ値を渡す。OSS App Hosting exampleは
  `off`のままにする。
- merge後のbuild承認前に、対象commit、直前snapshotの`READY`、migration pending 0、3 projectのdecision、DB接続余力、
  retry監視、sanitized `graph_transition_observation`の保存先を確認する。
- deploy後はWeb / Mastra / 全Jobsのruntime env一致、Web / Graph / ingestion smoke、secondary error / mismatch、DB CPU /
  connection / latencyを確認する。異常時はApp Hostingとproduction triggerを`off`へ戻すdeployを優先し、tableを削除しない。

#### Production shadow read 準備の履歴（Issue #726、2026-09-08時点）

- PR #729で準備したproduction App Hostingのtracked値`dual-write-shadow-read`を`dual-write`へ戻し、
  観測ログ修正だけの先行deployを準備する。Cloud Build / OSS exampleの既定は引き続き`off`。
  triggerのsubstitutionは自動変更されない。最新mainのbuild承認前に、Web / Mastra / production 6 Jobsへ配る値を一致させる。
- 2026-09-07のread-only確認ではrelational node 30件 / edge 43件のrollout後更新を確認した。ただし観測0件は、
  samplingだけでなく子process出力欠落の影響もあり得る。secondary errorがない証拠とはしない。
- 3 project中2 projectのcompareはpass。残るprojectのrelational-only nodeは662→661だが、件数減少だけで
  承認済みdecision内と断定せず、current-sourceとのbounded auditを再確認する。AGE全履歴の再生成可能性は主張しない。
- source-sync失敗 / Web500の原因、retry回復、十分なlatency観測も未確認である。
  [gate訂正記録](https://github.com/dyson-yamashita/pufu-lens/issues/726#issuecomment-5578306276)を正とし、開始gateは未達とする。
- shadow readの開始gate未達ではcombined modeのbuildを承認しない。観測修正の先行deployはユーザー承認済みで、
  tracked Web値を`dual-write`へ戻すPRのユーザーmerge後、最新main / trigger / buildと全unitの`dual-write`一致を照合する。
  snapshotの`READY`、migration pending 0を確認してdeployし、sanitized observation / retry / DB負荷を再観測する。
  PR #729直後のbuildはWebとtriggerのmodeが不一致のため承認しない。先行deployではshadow readを有効化しない。
- gate合格後に直前snapshotの`READY`、migration pending 0、最新main / trigger / pending build / modeを照合してdeployする。
  AGE response、固定10% sampling、外側6秒 / SQL 5秒timeoutを維持し、mismatch / error / timeout、DB負荷、retryを監視する。
- rollbackはtracked App Hostingとtriggerを`off`へ戻し、Web / Mastra / 全JobsをAGE-onlyへ揃える。
  AGE graph、relational table、snapshotは保持する。Step 2Eは十分なshadow観測、差分解消または明示decision、性能 / cost、
  restore point、rollback計画、独立した明示承認が揃ってから開始する。Step 2Fは本変更の対象外。

#### 2026-09-12 更新差分・性能のリスク受容と設定準備

- [ユーザー承認記録](https://github.com/dyson-yamashita/pufu-lens/issues/726#issuecomment-5642923527)に基づき、
  差分と性能の保留をリスク受容として解除する。技術的なcompare passや十分な性能実測を証明したという意味ではない。
- 3 projectのread-only compareは、`test` / `pufu-tomonokai`がpass。`pufu-lens-dev-pj`はAGE-only 29 nodes / 46 edges、
  relational-only 661 nodes / 916 edges、label/property-key mismatch 107で`blocked`。全projectでtruncated=false、
  duplicate / orphan / unknown relation / source audit blockerは0。9月5日の承認値から変化した箇所の原因は未検証である。
- 9月9日09:30 UTC以降の確認時点でmutation観測11件は全match（ensure_project_graph 10、upsert_edge 1）。
  primary最大8ms / secondary最大2ms。graph unavailable / source-sync execution failed / Web HTTP 5xxの対象ログは0件。
  DB接続9/100、deadlock0、全4同期scheduleはretry0・active lease0・直近失敗より新しい成功あり。
- Graph HTTPは3件すべて200、最大3.71秒。少数sampleであり性能gateの統計的裏付けにはしない。
  Drive追加1件のindexed完了とChatでの利用は確認済みだが、過去の全失敗原因を個別に証明したものではない。
- 本PRではtracked Webのruntime値`PUFU_LENS_GRAPH_TRANSITION_MODE`とconfig testの期待値のみを`dual-write-shadow-read`へ変更する。Cloud Build / OSS既定`off`、
  AGE primary、10% sampling、timeout、OAuth secret参照、認可・PII方針は変更しない。
- **PR mergeだけでdeployしない。** 本番反映の別途承認後、直前snapshotのREADY、migration pending 0、最新mainを確認し、
  triggerを`dual-write-shadow-read`へ変更して新buildを作成する。既存OAuth参照とapproval requiredを保持する。
  古いbuildのsubstitutionは変わらないため、Webとtriggerのmodeが不一致のpending buildは承認しない。
- 反映時はWeb / Mastra / 全6 Jobsを同一modeへ揃え、AGE応答、shadow mismatch / error / timeout、DB負荷・latency・retryを確認する。
  異常時は全unitを`off`へ戻す。AGE / relational data / snapshotは保持する。Step 2E / 2Fは別gateのままである。

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
