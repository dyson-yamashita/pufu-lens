# Graph / Relation 構築

既存のAGE利用modeでは、`documents` と `actors` をAGE graphにmaterializeする。
`relational-only`では`graph_nodes` / `graph_edges`のみを使い、AGE graph名を解決・参照・更新しない。
どちらも`email_quotes`と必要なrelationを保存する。

Plan 018 Step 2A では移行先として `graph_nodes` / `graph_edges` schemaをadditiveに追加し、Step 2B では同schemaを
使うrelational Graph read / mutation adapterを追加した。ViewerとSynthetic Monitorを含むDB testは明示DIで
relational adapterを検証する。Step 2Dではproduction composition rootをAGE-primaryのtransition factoryへ統一した。
Issue #723はCloud Buildの安全な既定を`off`に保ったまま、production Web / Mastra / Workflow Jobsを`dual-write`へ揃える
rollout configを追加し、2026-09-05にdeployした。Issue #726では観測修正の先行反映後、2026-09-12のユーザーによる
残余リスク承認に基づき`dual-write-shadow-read`へ変更し、PR #737まで2026-09-12に本番反映済みである。
2026-09-15 10:10 JSTにPR #739 / #741を本番反映し、全8 unitは`relational-primary`となった。
以下の過去の設定準備記録は当時の状態を示す。

### Step 2F relational単独運用（Issue #742、2026-09-16）

server-only `PUFU_LENS_GRAPH_TRANSITION_MODE=relational-only`を追加する。readはrelationalのみ、mutationも
relationalのみへ同じ値で選択し、AGE fallbackと二重書込みを一体で停止する。既存4 modeの動作と既定`off`は保持する。
実装PR #743はtracked Webの`relational-primary`を維持したままmerge済み。本番mode変更・deployは行っていない。

#### Step 2F 切替設定準備（Issue #744）

PR #743は2026-09-16にmain `3c4309e`へmerge済み。同じStep 2Fの継続としてtracked Webをruntime-only
`relational-only`へ変更し、設定の回帰testを同期する。Cloud Build / OSS既定は`off`を維持する。
これは設定PRであり、本番trigger変更・build承認・deploy・Scheduler停止・traffic変更の実行は含めない。
本番は最終確認時点の全8 unit `relational-primary`からの切替として扱い、承認直前にlive設定を再取得する。

merge後は古いpending buildを使わず、既存OAuth参照とapproval requiredを保持してtriggerの
`_GRAPH_TRANSITION_MODE=relational-only`を設定した後の新buildを使う。最新main SHA / trigger / branch、
tracked Web・Mastra・production 6 Jobsの対象とmodeを照合する。設定の不一致は既存guardで全deployより前に拒否する。
`_FIREBASE_DEPLOY=true`とWeb deploy対象差分を確認し、Webを旧modeのまま残すdeployは行わない。

入口停止・drainは現行Cloud Buildで自動化していない。**この設定PRのmergeだけでは本番有効化のgateは通らない。**
本番承認前にWeb（App Hosting経由と直接URL、private/public Graph・Chat・管理操作）、Mastra、手動CLI / Job起動、
3 Scheduler（source sync / report schedule / ActivityPub）の全入口に対する停止手段・復帰手段・確認担当を確定する。
停止後は新規request / Jobが入らないこと、実行中request / Jobsが終了したことを実測する。Cloud BuildのScheduler更新や
Web deployで受付が再開されないことも確認し、全8 unitのmode一致まで停止を維持する。証明できない場合はbuildを承認しない。
変更前のtraffic / Scheduler状態を記録し、再開時は元から停止中だった入口を勝手に有効化しない。

停止切替中のsmokeは受付停止によって失敗し得る。自動smoke成功だけで再開可能とせず、全unit・旧revision traffic 0・
relational-only writeがまだ発生していないことを確認してから、承認した順序で受付を戻す。最初のwrite時刻を記録し、read / mutation / 認可のsmokeを行う。
途中失敗時は停止を維持して状況を確認し、下記復旧手順に従う。AGEへ単純切戻しはしない。

#### 実装済みの切替境界

- count / preset / related search / monitorは6秒の応答deadlineと5秒SQL timeoutを維持する。失敗時にもAGEを読まない。
  正常空結果は確定値、利用不能時はcount / presetの固定例外、related searchの`unavailable`契約を維持する。
  read観測は`fallbackProvider: none`、`fallbackLatencyMs: 0`となる。
- ensure / project delete / Document cleanup / Actor merge / node・全9種edgeのupsertはrelational adapterへ直接委譲する。
  caller-owned transaction、認可、project scope、row parserは維持する。AGEとの比較観測は新modeでは発生しない。
- Step 2E write switchの依存残件として、ingestionの既存Document / RELATED_TO選別もrelational tableで行う。
  stale AGEを理由に取り込みをskipしたり繰り返したりしない。status / email_quotesとgraph mutationは同じtransactionを使う。
- `create-project` / `seed:projects`も新modeではAGEを作成せず、project rowとstorageを作る。`graph_name`は予約済みmetadataとして保持する。
  `graph:query --cypher`はAGE専用のため新modeではDB接続前に拒否する。通常の確認はGraph API / monitorと
  project-scoped relational SQLを使う。`graph:migrate compare`は明示的なAGE比較診断として保持するが、
  AGE停止後の差分は想定されるため現行データの整合性gateとして扱わない。rebuildをAGE復旧とみなさない。
- Cloud Buildは新modeを許可し、tracked Webとの不一致をdeploy前に拒否する。Mastra / production 6 Jobsにも同じ値を渡す。
  startup時の未知mode拒否、request / project overrideなし、server-only境界を維持する。

#### 切替実績と観測期間短縮の判断

build `8530966f-334e-4c50-a25a-c5e6aba7092a`はSUCCESS、Web revisionは
`pufu-lens-web-build-2026-09-15-001`。直前snapshot `pg-ai-data-pre-relational-primary-20260915`はREADY。
2026-09-16 11:00 JST頃まで約25時間の観測ではreadPreset 22件がsuccess/none、fallback 0、
primary latency p50 15ms / p95 31ms / max 118ms。自然ensure_project_graph 1件はmatch、Cloud Run ERROR / 5xxは0。
source-sync / report-schedule各298回は全成功、ActivityPub Scheduler→Mastra 298件は202だった。
ingest / curate / generate-report Jobは期間中0件で、自然mutation全経路のcoverageは未達である。
DB接続10/100、deadlocks 0。初回HTTP約4.9秒は新instance起動と同時刻でcold start寄与が示唆されるが断定しない。
公開Graph 4件200、private公開API404・未ログイン401、隔離DBでSAME_AS、ログイン後member200 / non-member403を確認済み。
02:00 UTC以降の追加確認もERROR / 5xxなし、新規read観測0であり追加の成功実績には数えない。

ユーザー指示「前倒しのため問題なければ判定OKとして作業進めてください」に基づき、限定実測と期間短縮による
次工程判定をOKとした。7日間観測を完了したものではない。長期負荷・費用・自然mutation coverageの残余リスクを保持する。
開発projectのAGE-only 29 nodes / 46 edges、relational-only 661 nodes / 916 edges、label/property-key mismatch 108は
主系切替で受容済み。test / pufu-tomonokaiは差分なし。これはAGE全履歴の再生成可能性の保証ではない。

#### 後続の本番有効化と復旧

1. Issue #744の設定PR merge後、最新mainとtracked Webにtriggerの新modeを揃え、対象commit・全8 unit・snapshot・
   pending migration 0・DB余力を確認する。approval requiredとOAuth参照を保持し、本番承認を得る。
2. **全unitのdeployは原子的ではない。** 最初のrelational-only write以降に旧revisionがAGEへfallbackする混在を防ぐため、
   全graph利用入口のtrafficとScheduler / workflow起動を停止し、実行中request / Jobs・旧revisionをdrainする。
   全8 unitの新modeと旧revisionへのtraffic 0を確認するまで処理を再開しない。無停止での順次切替をしない。
3. 再開後はpublic/private・project拒否、preset / related search、monitor、ingestion / Actor merge / cleanupを確認する。
   最初のrelational-only write時刻を記録し、read unavailable / latency、mutation失敗・retry、DB負荷を監視する。
4. **AGE書込み停止後は旧modeへの単純な切戻しは安全でない。** AGEは古くなるため`off`、dual-write系、
   `relational-primary`への変更、旧imageへの復帰でAGEを再び正としない。障害時は入口停止を維持してrelationalをforward-fixする。
   AGEへ戻す必要がある場合は、書込み停止中の完全な再同期（merge・削除を含む）または整合した時点への全DB復元と
   その後の更新再適用、差分・認可・mutation検証を別途計画・承認する。既存rebuild CLIはrelational向けで逆移行機能ではない。

AGEデータ、extension、snapshot / backup、旧imageは保持する。今回の期間短縮で保持期限は短縮しない。
切替時の最低保持期限2026-09-22 10:10 JSTを維持し、期限満了だけで自動削除しない。新snapshotからの復元試験は未実施。
破壊的削除とStep 4全体は対象外。DBのAGEインストール依存自体の撤去も後続工程とする。

### Relational優先読み取りの実装（Step 2E / Issue #738、PR #739 merge済み）

- server-only `relational-primary`を追加する。Web compositionでrelational readを先行し、mutationは既存の
  AGE→relational dual-writeとcaller-owned transactionの原子性を維持する。request / project overrideは追加しない。
- 正常な0件・空配列・空presetは確定結果とし、AGEを読まない。正規化済み利用不能または応答timeoutのみ1回fallbackする。
  厳格なrelational adapterは接続障害、table未作成、SQL timeout、shutdown / capacityの既知codeだけを利用不能にする。
  入力不正、SQL認可拒否、未知の例外・不正rowはそのまま失敗し、AGEへ迂回しない。既存modeの例外契約は維持する。
- 各backendの外側応答deadlineは6秒、合計最大約12秒。adapterのSQL timeoutは5秒のまま。
  外側deadlineはDB処理のcancelではなく、複数SQLやpool待ちが残る可能性がある。両backendは同じPostgreSQLを使うため、
  DB全体障害への冗長性はない。AGE fallbackも失敗・timeoutなら関連文書検索は空候補の`unavailable`、count / presetは
  固定`GraphReadUnavailableError`を返し、生の二重失敗情報を応答へ追加しない。
- `graph_primary_read_observation`は全readで固定operation / outcome / reason / providerとlatencyだけを記録する。
  project / node / document ID、query、properties、error本文は含めない。観測失敗・未完了は応答を遅延させない。
- API shape、graphNodeId、candidate relation / hop / orderはadapterの既存契約を維持する。presetのprovider固有ID / preview /
  rawRows内容は選択backendのものになる。認可は既存のpublic / private入口で完了させ、同じproject-scoped入力でfallbackする。
- このPRは本番設定・deployを変更しない。Cloud Buildの許可値拡張も切替設定PRに残す。切り戻しは全unitを
  `dual-write-shadow-read`へ戻し、AGE / relational dataを保持する。AGE write停止・cleanupは別工程。
- PR #737の本番build `a8e2c485-7a2d-46b9-9f1f-c387a14fef4c`はSUCCESS。2026-09-13のread_preset match 1件と
  mutation match 5件・対象error 0件は誤検知修正の確認であり、全project gate合格ではない。ログはproject識別子を含まない。
  既存compareの開発project差分、性能sample不足はIssue #726のリスク受容として残す。代表query coverage、費用、
  restore point / rollback window、本番切替承認は独立gateであり、この実装の検証成功で置き換えない。

### Step 2E 切替設定準備（Issue #740、2026-09-14）

2026-09-14時点ではPR #739はmerge commit `797f631`でmainへmerge済み、本番未反映だった。Issue #740は同Stepの継続としてCloud Buildの許可値へ
`relational-primary`を追加し、tracked Webを同modeにする設定PRを準備する。OSS / Cloud Build既定は`off`を維持する。
本番buildの先頭でtriggerとtracked Webのmodeを機械的に照合し、不一致や設定不備は全deploy・migrationより前に拒否する。
この照合は`_FIREBASE_DEPLOY=false`でも実行し、Web稼働値の確認は引き続き別途必要となる。
これは本番適用の承認ではなく、以下のgate確認と明示承認までtrigger変更・build承認を行わない。

#### 読み取りで確認した現在値

- Web `pufu-lens-web-build-2026-09-12-002`、Mastra `mastra-server-00112-mjx`、production 6 Jobsは
  全unit `dual-write-shadow-read`。旧名のnon-production Jobsは切替対象に含めない。
- 最新pending build `f3326640-e4db-4dae-b674-68ed2c09abe5`はmain `797f631`と一致するが、modeは
  `dual-write-shadow-read`。これは主系切替用buildではなく、この準備では承認しない。
- `pg-ai-data-pre-shadow-read-20260912`はREADY。新snapshot作成、restore試験、live migration照合は今回未実施。
  PR #739でmigrationファイル変更はないが、切替直前のlive pending 0確認を省略しない。
- 2026-09-13 00:00 UTC以降、照会時点の観測12件はread_preset match 1件、mutation match 11件。
  primary latency最大283ms / shadow最大12ms、対象graph unavailable / Web HTTP 5xxは0件。
  read 1件では性能・費用・全project coverageを判断できず、project対応もログ単独では断定しない。

#### 適用前の判断と手順

1. 代表query（2 preset、関連文書のSAME_AS / RELATED_TO / MENTIONS、count、public/private・project隔離）の
   coverage、開発project差分、性能・費用を判断する。既存Issue #726の残余リスク受容を主系切替承認へ読み替えない。
   常時read観測への変更によるログ量とDB read負荷も費用確認に含める。未測定の項目を残す場合は個別に判断を記録する。
2. 切替時刻、担当、直前restore point、保存期限、復旧手順、最低7日のrollback windowを確定する。
   直前snapshot READY、live migration pending 0、DB余力、旧revision・imageを確認し、本番切替の明示承認を得る。
3. 設定PR merge後、既存OAuth secret参照とapproval requiredを保持してtriggerを`relational-primary`へ更新する。
   既存pendingのsubstitutionは変わらないため、更新後の新buildだけで最新main SHA・branch・trigger・modeを照合する。
4. 承認済みbuildでWeb / Mastra / production 6 Jobsを揃える。サービス単位のdeployは全unit同時のtransactionではないので、
   移行中の一時的なmode混在を監視し、途中失敗時は放置せず全unitを切り戻す。AGE→relational dual-writeは常に維持する。
5. public/private Graph、関連検索、monitor、自然起動のmutationとsanitized観測を確認する。認可・project越境、
   応答回帰、fallback / unavailable発生、許容範囲外のDB負荷時は切り戻しを優先する。0件の観測だけでsoak完了としない。

切り戻しはtracked Webを`dual-write-shadow-read`へ戻す修正とtrigger値を揃えたbuildで、全unitのmodeとAGE応答を確認する。
DB schema / dataは削除せず、backupも保持する。当初の最低7日soakは上記2026-09-16の明示判断で短縮した。
この旧切戻し手順はAGE write停止前だけに適用する。停止後はStep 2Fの復旧手順に従う。

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

| 値                       | write                                  | read                                                                         |
| ------------------------ | -------------------------------------- | ---------------------------------------------------------------------------- |
| 未設定 / 空 / `off`      | AGEのみ                                | AGEのみ                                                                      |
| `dual-write`             | AGE primaryの後にrelationalへ全件write | AGEのみ                                                                      |
| `dual-write-shadow-read` | AGE primaryの後にrelationalへ全件write | AGEを返し、固定10%でrelationalを比較                                         |
| `relational-primary`     | AGE primaryの後にrelationalへ全件write | relational優先、利用不能・timeout時のみAGEへfallback。2026-09-15本番反映済み |
| `relational-only`        | relationalのみ                         | relationalのみ、AGE fallbackなし。Issue #742で実装、本番未有効化             |

未知の値は起動後のcomposition時にfail closedする。shadow readはAGE primary完了後に実行し、外側6秒、adapter SQL 5秒の
timeoutを適用する。shadowのtimeout / error / mismatch、観測出力の失敗でuser responseは変えず、AGE結果を返す。

Viewer presetの比較では、node property keyからAGE読取時に追加される`ageId`だけを除外する。
ラベルはadapterの`labels`と、有効な文字列配列の`properties.graphLabels`を統合・重複排除・ソートして比較する。
これによりAGEの単一label表現とrelationalの複数label表現を揃え、実際のラベル差分・通常property keyの欠落は検出する。
正規化は比較内に限定し、画面へ返すAGE結果、保存データ、edge property key、sampling率は変更しない。

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
