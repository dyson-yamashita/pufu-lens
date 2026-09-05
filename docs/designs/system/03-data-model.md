# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## データモデル

この章はテーブルの役割、分離方針、設計意図を説明する。fresh DB の実際の DDL は `infra/docker/postgres/init.sql` を正とし、既存 DB への差分適用履歴は `infra/db/migrations/*.sql` を正とする。この文書にはフル DDL を写さない。制約、カラム、index を変更する場合は `init.sql` と migration を更新し、この文書は意図や運用上の注意だけを同期する。

### 1. マルチプロジェクト方針

- `projects` テーブルで論理プロジェクトを定義する。`slug` から storage prefix と AGE graph name を生成する。
- ほぼ全ての業務テーブルに `project_id` を持たせ、query と unique 制約を project scope に閉じる。
- 現行 production のナレッジグラフ read / write は project ごとの AGE graph をprimaryとして使う。`projects.graph_name` は DB に保存された値だけを信用し、request body や URL から graph name を受け取らない。Plan 018 Step 2A で移行先の `graph_nodes` / `graph_edges` をadditiveに追加し、Step 2Bでrelational read / mutation adapter、Step 2Dで既定offのAGE-primary transition compositionを追加した。本番mode設定・deploy・relational primary switchは未実施である。
- Object Storage は project ごとの prefix（例: `<project_slug>/raw/...`, `<project_slug>/parsed/...`, `<project_slug>/reports/...`）で分離する。
- Browser から渡された `projectId` は信用せず、URL の `projectSlug` から server side で `projects.id` を解決する。

### 2. DDL / Migration 正本

fresh DB の DDL 正本:

- `infra/docker/postgres/init.sql`

既存 DB の migration 履歴:

- `infra/db/migrations/*.sql`
- `scripts/db-migrate.ts`
- `public.schema_migrations`

`init.sql` は最新 schema を直接作成する。`infra/db/migrations` は既存 DB を段階的に最新 schema へ近づけるための履歴であり、現時点では空 DB から再生できる完全履歴ではない。たとえば `0001_auth_login.sql` は `init.sql` で `users`、`projects`、`project_members` が作成済みであることを前提にする。

fresh DB では `init.sql` の末尾で `public.schema_migrations` を作成し、`init.sql` に取り込み済みの migration version を seed する。これにより、fresh DB に `pnpm db:migrate` を実行しても、過去 migration が再適用され続けない。

現在の主なテーブル:

| テーブル                                         | 役割                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `users`                                          | アプリログインユーザー。global role は bootstrap や運用用途に限定し、project 認可は `project_members` を主に使う。                                                                                                                                                                               |
| `auth_accounts`                                  | Google / GitHub などのアプリログイン provider と `users.id` の対応表。provider token は保存しない。                                                                                                                                                                                              |
| `auth_password_credentials`                      | OAuth を使わないローカル/運用用 Credentials provider の password hash。                                                                                                                                                                                                                          |
| `projects`                                       | project slug、graph name、storage prefix、visibility、settings を保持する。                                                                                                                                                                                                                      |
| `graph_nodes`                                    | relational graph の provider-neutral node。`(project_id, node_key)` を identity とし、`document` / `actor` / `topic` の kind、nullable subtype、JSON object properties を保持する。Step 2Dのtransition compositionから既定offでshadow write / read可能だが、productionではまだ有効化しない。     |
| `graph_edges`                                    | relational graph の directed edge。project、source / target node key、canonical 9種の relation type を identity とし、両 endpoint の composite FK で project 越境と orphan を拒否する。Step 2Dのtransition compositionから既定offでshadow write / read可能だが、productionではまだ有効化しない。 |
| `project_members`                                | project ごとの member/admin 権限を保持する。private API と server action の主要な認可境界。                                                                                                                                                                                                      |
| `oauth_connections`                              | project 単位の Google / GitHub 連携 metadata。token 実値ではなく暗号化済み値または secret 参照を扱う。                                                                                                                                                                                           |
| `data_sources`                                   | project の収集対象。Gmail / Drive / GitHub は対応する `oauth_connections` を必要とし、Web は connection なしで作成できる。完全成功した差分収集の `sync_cursor` と `last_sync_succeeded_at` を保持する。                                                                                          |
| `data_source_schedules`                          | GitHub / Drive / Gmail の日次同期設定。`daily_time` と `timezone`、UTC の `next_run_at`、Step 4 dispatcher 用 lease・retry・結果を project / data source scope で保持する。Web には作成しない。                                                                                                  |
| `project_report_schedules`                       | project ごとの定期 report 周期と実行状態。`none` / `weekly` / `monthly` / `annually`、10:00 `Asia/Tokyo` の wall-clock、UTC の `next_run_at`、lease・retry・監査 user を保持する。                                                                                                               |
| `report_schedule_period_runs`                    | 定期 report の対象期間ごとの実行履歴の正本。通常は calendar period、初回 backfill は完了済み履歴全体の期間を表し、pending / running / succeeded / skipped / retry 状態、lease、通知、生成 report を project scope で追跡する。                                                                   |
| `parser_profiles` / `parser_versions`            | source type / data source ごとの parser 選択、artifact、承認状態を管理する。                                                                                                                                                                                                                     |
| `raw_documents`                                  | 外部 source から取得した版単位の原本 metadata と storage URI。`logical_source_id` で実体を束ね、`source_version` ごとの履歴を保持する。実体は Object Storage に置く。                                                                                                                            |
| `raw_document_data_sources`                      | 同じ raw document が複数 data source から見つかった履歴を n:m で保持する。Data Sources 詳細の content preview はこの関連から対象 data source の raw document を列挙する。                                                                                                                        |
| `ingestion_queue`                                | raw document の parse / index 処理キュー。lease、attempts、hold/failed 状態を持つ。                                                                                                                                                                                                              |
| `documents`                                      | 解析済み document の正規化 metadata。logical source 単位で ID を維持し、`raw_document_id` は検索対象の最新版を参照する。                                                                                                                                                                         |
| `document_chunks` / `document_chunk_history`     | chunk 本体、embedding、chunk hash、再生成履歴を保持する。                                                                                                                                                                                                                                        |
| `actors` / `actor_aliases`                       | email / GitHub login / Web author domain などの actor と alias を project scope で管理する。                                                                                                                                                                                                     |
| `email_quotes`                                   | Gmail の引用チェーンを document と分離して保持する。                                                                                                                                                                                                                                             |
| `reports` / `report_chunks`                      | private/public report metadata、artifact URI、検索用 chunk を保持する。`reports` は手動・通常定期・backfill の生成種別、周期、前回定期 report、period run を参照する。                                                                                                                           |
| `activitypub_fedify_kv`                          | Fedify の cache / idempotency state 用 PostgreSQL KV。業務データは保存しない。Step 1 protocol spike で導入済み。                                                                                                                                                                                 |
| `activitypub_queue_messages`                     | ActivityPub inbox / delivery queue。Activity ID 単位の inbound dedupe と recipient 単位の outbox dedupe、ordering key、recipient origin、lease / attempt / 結果を保持する。private JWK は保存しない。                                                                                            |
| `activitypub_instance_config`                    | instance 全体の `article` / `note` 表現を保持する singleton。最初の outbound activity 作成時に DB trigger で lock し、以後の変更・unlock・singleton 削除を拒否する。                                                                                                                             |
| `activitypub_actors`                             | project Actor と aggregate `@all` Actor の正本。instance 内 username 一意、aggregate 最大1件、project ごと最大1件、kind / project 整合、`all` 予約を DB 制約で保証し、display name、icon URL、投稿追加prompt、Actor単位の暗号化秘密鍵を保持する。                                                |
| `activitypub_follows` / `activitypub_activities` | inbound / outbound Follow の状態、Activity receipt、公開 report の Create / Announce transactional outbox の正本。公開状態と outbound row は同じ transaction で更新する。                                                                                                                        |
| `federated_reports`                              | remote object を project scope で参照する外部 report の正本。`project_id + remote_object_uri` を一意にし、accepted outbound followとのproject対応をDB triggerで固定する。chat / graph / embedding / report生成 / ingestionの正本にはしない。                                                     |
| `schema_migrations`                              | `pnpm db:migrate` が適用済み migration version を記録する。fresh DB では `init.sql` に取り込み済み version を seed する。                                                                                                                                                                        |

#### Relational graph schema（Plan 018 Step 2A）

- `graph_nodes` は `(project_id, node_key)`、`graph_edges` は
  `(project_id, source_node_key, target_node_key, relation_type)` を composite primary key とする。
- node の project FK と edge の source / target composite FK はすべて `ON DELETE CASCADE` である。project
  delete は node を経由して edge を削除し、Document cleanup 相当の node delete は incident edge だけを削除する。
- `graph_edges` の outgoing / incoming index はいずれも `project_id` を先頭に置く。relation type 単独 index と
  Viewer recent-document index は representative query の計測前には追加しない。
- relation type の正本は `packages/graph` の `GRAPH_EDGE_TYPES` 9種である。migration / fresh schema の
  `graph_edges_relation_type_check` との drift を test で検出し、未知の値を DB 境界でも拒否する。
- Step 2B の Actor merge adapter は、同一 transaction 内で edge を primary endpoint へ先に upsert / dedupeし、
  secondary incident edge を明示削除してから node を削除する。SAME_AS は endpoint を UTF-8 byte 順に
  canonicalizeし、PostgreSQL 側は明示的な `COLLATE "C"` で application と同じ順序を使う。rewire後の競合も
  一件へ吸収する。この順序をDB testで固定し、node cascadeをedge移送に使わない。
- `0026_relational_graph_schema` は table / constraint / index だけを追加し、AGE export、backfill、既存 row 更新を
  行わない。AGE-only row と source-of-truth のinventory契約はStep 2Cで実装した。live rebuild / compareでは
  3 project中2 projectがpassし、596 documentsのprojectは追加source auditでrelationalがcurrent source期待値と一致した。
  AGE-only legacy / stale構造は移植せず、AGEの全履歴が再生成可能とは扱わない。

#### Relational graph adapter（Plan 018 Step 2B）

- read adapter は project-scoped な node / relation count、SAME_AS / RELATED_TO 1-hop、MENTIONS 2-hop、
  Viewer preset を bounded SQL で実装し、read-only transaction と5秒timeoutを適用する。
- mutation adapter は project lifecycle、node / canonical 9 edge type の idempotent upsert、Document node cleanup、
  Actor mergeを実装する。unknown kind / relation type、非object propertiesはSQL binding前に拒否する。
- node upsertのconflict時は既存`properties`と入力`properties`をJSONB objectとしてmergeし、同名keyは入力値を優先する。
  full Documentの後にsparse placeholderをupsertしても省略keyを保持し、placeholderからfull Documentへの順序でも
  placeholder固有keyを保持する。edge propertiesの更新契約は従来どおりで、この補修では変更しない。
- adapter は `@pufu-lens/graph/postgres-relational-read` と
  `@pufu-lens/graph/postgres-relational-mutation` から明示的に注入する。production の AGE adapter選択、
  `projects.graph_name`、API contract、認可境界は変更しない。
- Step 2B はDDL、data migration、AGE export、backfillを追加しない。Step 2Cのrebuild / compareと
  source-of-truth auditをlive実行した後も差分が残っているため、全graphを再生成可能とは扱わない。
- `graph_nodes.properties ->> 'documentId'` を使う代表 query はStep 2Cのlocal synthetic fixtureで実行手順を確認した。
  production相当row count / p95は未取得であり、expression indexは後続の実測を根拠に追加可否を判断する。

#### Graph rebuild / source-of-truth audit（Plan 018 Step 2C）

- relational graphの再構築元は、current `documents` / `raw_documents`、Object Storageのparsed artifact、
  `actors` / `actor_aliases` / `actor_merge_decisions`、`email_quotes`である。rebuild modeはlifecycle-only refreshも
  nodeだけの更新に縮めず、current parsed artifactからfull relationを再計算する。
- rebuildはproject-scopedなbounded upsertであり、ingestion statusと`email_quotes`を変更しない。sourceの
  完全性が未確定な段階で既存relational rowを先に全削除せず、AGE-only / relational-only rowはcompareで監査する。
  parsed artifact読取は最大8並列に制限する。
- AGE / relational inventoryはnode keyをSHA-256 digestへ変換し、physical labelとprovider-neutral
  `graphLabels`、property key、directed relation typeだけを比較する。properties値、content、PII、secretは結果へ出さない。
  project解決からsource auditまで同一の`REPEATABLE READ READ ONLY` transaction / sessionを使用する。
- Actor merge後もsecondary Actorを参照するalias / email quote、merge decision不整合、current documentの
  parsed artifact / status不足、Document rowのないrelational nodeはsource audit blockerとする。
- local PostgreSQL + AGE fixtureでは再構築と比較契約を確認済みである。live rebuild / compareは3 projectへ実施し、
  2 projectがpassし、596 documentsのprojectはrelationalがcurrent source期待値と完全一致した。AGE-only legacy / stale
  構造を移植しないdecision logが承認され、Step 2D開始gateを満たしたが、AGEの全履歴が再生成可能とは扱わない。

#### AGE-primary transition（Plan 018 Step 2D）

- 新しいtable、column、constraint、index、migrationは追加しない。既存`graph_nodes` / `graph_edges`へ同じ
  provider-neutral mutation contractをdual-writeし、fresh / migrated schemaの既存parityを維持する。
- production compositionはAGEをprimaryとして先に実行する。caller-owned transactionを受けるproject lifecycleと
  Actor mergeではAGE / relationalを同じexecutorへbindし、retryable secondary failureでtransaction全体をrollbackする。
  indexingも1 document単位でmutationとstatus更新を同じtransactionへbindする。Data Source削除はDocument cleanupを
  source row削除より先に同じtransactionで行い、secondary failure / count差分時はsource入力を残してrollbackする。
- current sourceから再計算したrelational graphは596 documentsのproduction projectでもmissing / mismatch 0だった。
  AGE-only 30 Topic / 46 MENTIONSはcurrent sourceにないlegacy / stale構造として移植しない。この判断はAGEの全履歴が
  再生成可能という意味ではなく、`projects.graph_name`とAGE graphをrollback window中維持する。

### 3. OAuth connection と data source

- `oauth_connections` は project 単位の共有 connection であり、個人の UI セッション用 provider account とは別物である。
- Gmail / Drive data source は Google connection、GitHub data source は GitHub connection を要求する。
- `data_sources.connection_id` は同じ project の connection だけを参照できるようにする。
- `data_source_schedules` は `(data_source_id, project_id)` の複合外部キーで source と同じ project に固定し、data source 削除時に cascade する。既定値は毎日 06:00 `Asia/Tokyo` である。
- `project_report_schedules` は project ごとに 1 row とし、`none` のときだけ `next_run_at` を `NULL` にする。schedule と period run は `(id, project_id)` の複合外部キーで同じ project に固定する。
- `report_schedule_period_runs` は同じ project・frequency・period を一意にし、report が生成されない `skipped` も理由と完了時刻を持つ履歴として残す。`succeeded` は report ID と完了時刻を必須とし、それ以外の状態では report ID を持たない。生成 report との相互参照は period run ID・project ID・frequency の複合制約で越境と周期不一致を拒否し、前回定期 report 参照も同じ project・frequency に限定する。
- `reports.generation_kind = 'manual'` では schedule metadata を持たず、`scheduled` / `scheduled_backfill` では canonical frequency と `schedule_period_run_id` を必須にする。期間列挙と前回定期 report 解決では project-scoped metadata の `frequency` を検証し、取得した前回 private report JSON では `report_id`・`project_id`・`period` を再検証する。bounded な差分生成、dispatcher、周期設定と実行状態の UI は実装済みである。差分の `frequency` と `previous_report_id` は DB metadata を正として private report JSON の optional `recurrence` に保存する。定期 report JSON は public-safe な optional `project_overview` snapshot も保持する。Project Overview 専用 table は設けず、対象期間が最も新しい定期 report を project-scoped query で解決する。
- token / refresh token の扱いはセキュリティ設計に従う。収集では project の `oauth_connections` から token を解決し、GitHub App 設定は connection metadata に保存する。

### 3.1 ActivityPub Step 1 / Step 2 / Step 3 / Step 4 / Step 5 / Step 6 / Step 7 persistence boundary

- `activitypub_queue_messages.dedupe_key` は inbound では Activity ID、outbound では `activity ID + recipient inbox URI` から決定論的に作り、同じ受信処理または delivery の重複 row を拒否する。
- outbox row は `ordering_key` と `recipient_origin` を必須とし、`worker_token` と `lease_expires_at` は同時に設定・解除する。
- queue payload は Fedify 2.3.4 の version-pinned inbox / outbox shape を保存する。outbox は enqueue transaction 内だけで秘密鍵を利用し、保存時には key ID だけへ変換する。private JWK、OAuth token、credential は保存しない。
- Step 1 の test Actor key table は migration / fresh schema に含めない。Step 2 の本番 Actor 鍵は Actor row ごとに一度だけ生成し、AES-256-GCM の versioned JSON として保存する。公開鍵と Actor ID / username は再有効化・process 再起動後も同じ row を再利用する。
- `activitypub_instance_config` は `id = 1` の singleton とし、最初の outbound `activitypub_activities` row を作る transaction で singleton row を条件付き更新して `representation_locked_at` を設定する。activity table の件数走査には依存しない。lock 後の Article / Note 変更は use-case と DB trigger の双方で拒否する。
- project Actor の enable / disable は project ID と slug が一致する row を transaction 内で lock する。enable は `projects.visibility = 'public'` の場合だけ許可し、username の変更は既存 Actor を作り直さず拒否する。
- Actor profile更新はdisplay nameをtrim後1〜100 code point、icon URLを最大2,048 code point、追加promptを最大2,000 code pointに制限する。空icon / promptは`NULL`へ正規化する。project Actorはproject adminまたはglobal admin、aggregate Actorはglobal adminだけが更新でき、disabled rowも同じidentityと鍵のまま編集できる。一般memberへ追加promptを返さない。
- `activitypub_follows` は `(direction, local_actor_id, remote_actor_uri)` を follow identity とし、再 follow では新しい `follow_activity_uri` を generation ID として保持する。accepted 後の Undo は公開時点 audience 再構築のため `accepted_at` を履歴保持し、Undo-before-Follow は `accepted_at = NULL` のまま `undone_at` を持てる。旧 generation の Accept / Undo は現 generation を変更しない。
- `activitypub_activities.activity_uri` は Activity receipt / transactional outbox の一意キーである。公開 report row の `is_public`、`activitypub_public_summary`、`activitypub_published_at` と必要なoutbound rowを同じtransactionで更新し、raw report本文はpayloadに保存しない。enabledなproject ActorのCreateはaggregate Actorの状態に依存せず作成し、aggregate `@all` Actorがenabledな場合だけAnnounceも作成する。
- ActivityPub を有効にした新規公開は明示的な `activitypub_published_at` と公開用 summary を必須にし、欠落時は transaction を開始せず fail closed とする。一方、既存の公開 report object を読む互換経路は legacy row のため `created_at` を公開時刻の fallback にできる。この非対称は意図した移行境界であり、outbox enqueue 済み判定には fallback を使わない。
- `activitypub_queue_messages` は `attempt_lease_started_at`、lease token、attempt count、runtime serializer / row parser と DB CHECK が同じ固定 allowlist へ制限するsafe error codeを持つ。同じ `ordering_key + recipient_origin` の後続は先行成功まで claimせず、先行 `permanent_failure` / `retry_exhausted` 後は同じ終端結果へ遷移して配送しない。materialization retry exhausted は再試行へ戻さず終端化し、旧queue実装の `activitypub_delivery_failed` はmigrationで `unknown_delivery_error` へ正規化する。
- Step 6のhermetic protocol traceはtest fixture内だけに保持し、production persistence schemaを追加しない。
- `activitypub_queue_operator_actions` はretry exhaustedの再投入 / 破棄だけを監査するappend-only運用tableである。queue messageへの外部キー、`requeue: retry_exhausted -> pending` / `discard: retry_exhausted -> permanent_failure` の固定transition、変更前attempt / safe error code / HTTP status、自由記述を許さない`change_ref`、作成時刻を保持する。payload、dedupe key、response body、署名、秘密鍵は保持しない。queue更新と監査INSERTは同一transactionで行い、DB triggerが監査rowのUPDATE / DELETEを拒否する。
- Step 7のoperation snapshotはbusiness rowを追加せず、queue metadataと対象ActivityPub relationの`pg_total_relation_size`を読み取る。origin failureは`recipient_origin`だけを使い、rolling 24時間のretry_wait / retry exhausted / permanent failure / 429 / 5xxを同じwindowで集計し、上位20 origin以外を`other`へ集約してlabel cardinalityを制限する。
- accepted follower / following collection は `(local_actor_id, direction, created_at, id)` の順序と versioned opaque cursor で pagination し、remote Actor URI 以外の inbox、状態遷移時刻、内部 ID を公開 collection に含めない。
- inbound report保存はacceptedかつ`accepted_at IS NOT NULL`、`undone_at IS NULL`のoutbound follow rowをtransaction内でlockし、そのlocal project Actorと同じ`project_id`だけへinsertする。DB triggerは`project_id`、`source_follow_id`、`remote_actor_uri`の対応と更新時不変性を強制し、repositoryは`project_id + remote_object_uri`の競合を副作用なしで無視する。Activity URI replayはtype、actor、canonical objectが完全一致する場合だけ再利用する。
- migration `0016`〜`0019` に加え、`0020_activitypub_report_publication_outbox`、`0021_activitypub_validate_step4_constraints`、`0022_activitypub_inbound_reports`、`0023_activitypub_validate_inbound_report_constraints`、`0024_activitypub_operations`、`0025_activitypub_actor_profiles` を fresh `init.sql` と同期し、`pnpm db:schema-drift` で検証する。Step 4の制約は`0020`/`0021`、Step 5のHTTPS URL・Article型・accepted follow対応・project固定制約は`0022`/`0023`、Step 7のoperator auditは`0024`、Actorの`icon_url` / `additional_prompt`と長さ制約は`0025`で追加する。migration version の記録は全 statement 成功後に migration runner だけが行い、offline `pnpm db:migrate --check` は全 migration 本文の parse 契約も検証する。

### 4. Parser registry

- `parser_profiles` は project / data source / source type ごとの parser 選択単位である。
- `parser_versions` は immutable な parser artifact と validation 結果を保持する。
- 本番 ingestion では approved version だけを使う。未承認 version は validation / dry-run のみに使う。
- active version は profile に紐づく version だけを参照する。

### 5. 状態遷移

| 対象                                 | 主な正常系                                   | 主な停止/失敗系                            |
| ------------------------------------ | -------------------------------------------- | ------------------------------------------ |
| `raw_documents.ingest_status`        | `fetched` → `parsed` → `indexed`             | `held`, `failed`                           |
| `ingestion_queue.status`             | `pending` → `parsing` → `parsed` → `indexed` | `held`, `failed`, `skipped`                |
| `parser_versions.status`             | `draft` → `review_requested` → `approved`    | `rejected`, `retired`                      |
| `report_schedule_period_runs.status` | `pending` → `running` → `succeeded`          | `skipped`, `retry_wait`, `retry_exhausted` |

### 6. 変更時の同期ルール

- テーブル、制約、index の正確な定義は `init.sql` を更新する。
- 既存環境の更新が必要な場合は `infra/db/migrations/NNNN_short_description.sql` を追加する。
- 新規に migration を追加、または既存のものを変更した場合は、`init.sql` にスキーマを反映するとともに、末尾の `schema_migrations` seed にも該当する migration version を追加・更新する。
- main に入った migration の中身は原則変更せず、後続の番号で forward migration を追加する。
- 複数 PR が migration を追加する場合は、merge 前に main へ rebase して番号衝突と順序を確認する。
- destructive change は互換期間、backfill、参照コード切替、削除を分ける。
- 大量 backfill、AGE graph 更新、embedding / vector 次元変更は通常 schema migration と分け、deploy checklist に再生成・再index・停止要否を残す。
- この文書には、変更の意図、認可境界、運用上の注意を反映する。
- DDL をこの文書へ全文コピーしない。コピーが必要なレビューでは `init.sql` へのリンクまたは該当行の抜粋で扱う。

### 7. Data source content preview

- Admin UI の content preview は `raw_document_data_sources` → `raw_documents` → `documents` / `document_chunks` と `ingestion_queue` を project slug + data source id で検証したうえで読む。
- 画面に出すのは title、doc type、ingest status、canonical URI、短い snippet、raw/document id の compact 表示、queue status / attempts / 短い error 要約に限定する。
- `storage_uri`、`parsed_uri`、raw 本文、parsed JSON 全文、OAuth token、secret は preview では返さない。

---
