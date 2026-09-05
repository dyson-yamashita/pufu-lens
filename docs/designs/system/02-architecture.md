# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## システムアーキテクチャ

> 現状（2026-06-19）は、ローカル `docker compose` の PostgreSQL / LocalFsObjectStorage と Node scripts（例: `scripts/ingest-workflow.ts`, `scripts/workflow-job.ts`）で主要処理を検証している。GCS object storage は実装済みだが、Cloud Run Job、Secret Manager、VPC 構成の end-to-end 実接続は staging GCP identifier / IAM 設定後に検証する。

### 1. 全体構成

```
┌──────────────────────────────────────────────────────────────┐
│                プロジェクト単位の設定済みデータソース               │
│   Gmail   │   Drive   │   GitHub   │   Web Pages              │
└─────┬─────┴─────┬─────┴─────┬──────┴──────┬──────────────────┘
      │           │           │             │
      ▼           ▼           ▼             ▼
┌──────────────────────────────────────────────────────────────┐
│         Collection Pipeline（Cloud Run Job）                   │
│   1. source 別 scanner で新規候補を発見                          │
│   2. source contract / hash / DB 制約で関連度・鮮度・重複を評価    │
│   3. 元データをオブジェクトストレージに原本保存                    │
│      + raw_documents を upsert（status=fetched）              │
│   4. ingestion_queue へ投入（project_id / raw_document_id 付き）│
│   ※ Agent は未知形式・低 confidence・parser 修正時だけ補助的に使う │
└─────────────────────┬────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────────┐
│         Ingestion Workflow（Mastra Workflow on Cloud Run Job） │
│   1. キューから対象取得（raw_document_id 経由で原本を解決）        │
│   2. parse  : 原本を解析し本文・メタデータ・引用構造を抽出           │
│   3. resolve: 送信者・作者を actors/aliases に名寄せ              │
│   4. chunk  : 本文をチャンク化 + embedding 生成                  │
│   5. graph  : Document ノード + 関係を AGE グラフへ MERGE         │
└────┬─────────────────────────────────┬───────────────────────┘
     │ parsed JSON                     │ relational + graph + vector
     ▼                                  ▼
┌──────────────────────┐  ┌──────────────────────────────────────┐
│ Object Storage        │  │ PostgreSQL（GCE VM + Docker）        │
│ (Local Vol / GCS)     │  │  ┌──────────────────────────────┐    │
│  raw/                 │  │  │ AGE グラフ（プロジェクト別）    │    │
│  parsed/              │  │  │ Document/Actor/Topic Nodes  │    │
│  reports/             │  │  ├──────────────────────────────┤    │
│                       │  │  │ pgvector embeddings          │    │
│                       │  │  ├──────────────────────────────┤    │
│                       │  │  │ relational (projects,        │    │
│                       │  │  │  data_sources, raw_documents,│    │
│                       │  │  │  documents, document_chunks, │    │
│                       │  │  │  actors, reports, …)         │    │
│                       │  │  └──────────────────────────────┘    │
└──────────┬────────────┘  └───────────────────────┬──────────────┘
           │                                       │
           └───────────────┬───────────────────────┘
                           ▼
            ┌─────────────────────────────┐
            │  Mastra Server (Cloud Run)  │
            │  Chat Agent / Report Agent  │
            │   tools:                    │
            │    - hybrid-search          │
            │    - graph-query            │
            │    - timeline-search        │
            │    - raw-document-fetch     │  ← Object Storage
            │    - parsed-doc-fetch       │
            └──────────────┬──────────────┘
                           │
            ┌──────────────┴───────────────┐
            ▼                              ▼
┌─────────────────────────┐   ┌──────────────────────────────┐
│ Next.js                 │   │ Report Generation Workflow   │
│ Firebase App Hosting    │   │ (Cloud Run Job, Scheduler)   │
│ Chat / Reports / Admin  │   │  -> JSON to Object Storage   │
│ /api/projects/[id]/...  │   │  -> reports table メタデータ   │
│   reports/[id].json     │   │                              │
└─────────────────────────┘   └──────────────────────────────┘
```

#### 検索 candidate capability 境界

Plan 018 Step 1A では、Chat の既存外部挙動を保ったまま検索候補取得を provider-neutral な
`SemanticCandidateRepository` / `KeywordCandidateRepository` へ分離する。`@pufu-lens/retrieval` は
candidate DTO と runtime guard、document dedupe、`k=60` の RRF、表示 chunk provenance の選択を担い、
SQL、provider 名、raw score を持たない。score-aware cutoff、diversity、retrieval confidence、graph coverage
policy は引き続き Core / Workflow が所有する。

`gcp-postgres` composition は Web の Postgres Chat facade 内で構成し、semantic adapter が pgvector の
`<=>` を既存 cutoff と同じ cosine distance へ正規化し、keyword adapter が PGroonga の operator / function
と raw score を内部に閉じる。両 adapter は project scope と chunk provenance を検証済みの candidate として
返す。access、history、raw read、timeline、graph の契約は candidate interface に含めず、private / public
Chat API、tool 名、source response、schema、data は変更しない。

#### Graph read capability 境界

Plan 018 Step 1B では `@pufu-lens/graph` が provider-neutral な `GraphReadRepository`、related document / normalized
node・edge DTO、preset / relation allowlist、runtime guard を所有する。Chat graph coverage、Graph Viewer preset、Synthetic
Monitor の node / relation count は検証済み `projectId` だけを同 contract へ渡す。access lookup、eligible document
選択、document chunk 取得、schedule / raw / history は relational app repository に残し、Graph contract へ混ぜない。

現行 `gcp-postgres` profile の Web composition は PostgreSQL + Apache AGE adapter を注入する。adapter が
`projects.graph_name` の解決、Cypher、agtype parsing、read-only transaction、5 秒 timeout、relation / row 上限を
内部に閉じ、`success` / `unavailable` または normalized result へ変換する。Graph API の既存 `graphName` / preset
preview / `rawRows` response は互換性のため維持するが、request や Graph repository input には graph name、Cypher、
record definition を受け取らない。

Plan 018 Step 2B では、同じ `GraphReadRepository` / `GraphMutationRepository` contract を実装する PostgreSQL
relational adapter を `@pufu-lens/graph` の明示 subpath export として追加した。adapter は `projectId` で scope した
bounded SQL、read-only transaction、5 秒 timeout、provider-neutral JSON、SAME_AS の canonical endpoint、Actor merge
の edge-first dedupe を内部に閉じる。Viewer と Synthetic Monitor は DB test で明示的に同 adapter を注入して検証するが、
production の composition / profile はまだ変更せず AGE primary を維持する。backfill / compare、dual-write / shadow read、
production switch はそれぞれ Step 2C 以降の gate とする。

Plan 018 Step 2Cでは同じprovider-neutral mutation contractをrebuild modeで再利用し、operator CLIの内側だけで
relational adapterへproject-scopedなbounded upsertを行う。AGE / relational inventory queryとprovider固有parserは
`scripts/lib`のmigration boundaryに閉じ、CLI出力はsanitized count / categoryだけにする。これはproduction
compositionへ注入されない。rebuildのObject Storage読取は最大8並列、compareのprovider readは同一の
`REPEATABLE READ READ ONLY` transaction / sessionに固定する。runtimeのdual-write / shadow readはStep 2Dまで
追加しない。承認済みlive rebuild / compareでは3 project中2 projectがpassし、596 documentsのprojectは追加auditで
relationalがcurrent source期待値と一致した。AGE-only legacy / stale構造を移植しないdecision logをStep 2D開始gateとする。
Issue #720ではrelational node upsertのpropertiesを既存値とのmergeへ補修した。

Plan 018 Step 2DではproductionのGraph composition rootをtransition factoryへ統一する。deployment単位のserver-only
modeは既定`off`で、AGE read / writeをprimaryとして維持する。enabled時だけ同じ`GraphMutationRepository` inputを
relational secondaryへdual-writeし、combined modeでは`GraphReadRepository`の10%をshadow比較する。request / project
override、provider固有query、graph nameはCore contractへ追加しない。Viewer presetは`graphNodeId`へcanonicalizeして
比較し、provider固有ID / raw row / property値を境界外へ出さない。production設定・deploy・relational primary切替は
この実装に含めず、Step 2Eの独立gateとする。indexingは1 documentのmutationとstatus更新、Data Source削除は
Document cleanupとsource row削除をそれぞれ同一transactionにまとめ、secondary失敗時に再実行入力を失わない。

Issue #723のproduction rolloutでは、このcomposition境界を変えずにdeployment profileだけを`dual-write`へ進める。
Cloud Buildの既定は`off`を維持し、production triggerからMastra Serverと全Workflow Jobsへ同じ値を渡す。
App Hostingもserver runtimeだけに同じ値を設定し、request / project overrideや`NEXT_PUBLIC_*`は追加しない。
AGE primaryの応答契約、認可、module境界は維持し、shadow readとrelational primaryは別の承認済みdeployへ残す。

### 2. コンポーネント役割

| コンポーネント      | 役割                                                                                                         | デプロイ先                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| Next.js             | チャット UI、レポート閲覧（JSON 取得＋描画）、管理者ログイン、連携・データソース・プロジェクト管理           | Firebase App Hosting                    |
| Mastra Server       | Agent API、ツール実行（グラフ / ベクトル / 原本ストレージ）                                                  | Cloud Run                               |
| Collection Pipeline | プロジェクトごとのデータソース監視、source contract に基づく収集候補評価、**原本ストレージ保存**、キュー投入 | 現状: Node CLI / 目標: Cloud Run Job    |
| Exception Agent     | 失敗 raw / parsed の調査、parser / validator 修正補助、低 confidence な名寄せ候補の整理                      | 現状: Mastra UI / 目標: Cloud Run Job   |
| Ingestion Workflow  | キュー処理、parse、Actor 名寄せ、グラフ・ベクトル構築                                                        | 現状: Node CLI / 目標: Cloud Run Job    |
| Report Workflow     | JSON レポート生成、Object Storage 保存、メタデータ DB 登録                                                   | 現状: Node CLI / 目標: Cloud Run Job    |
| PostgreSQL          | プロジェクト別ナレッジグラフ・メタデータ・チャンク                                                           | GCE VM（Docker）                        |
| Object Storage      | プロジェクト別の元データ・parsed JSON・レポート JSON 本体                                                    | ローカル: Docker Volume / クラウド: GCS |
| Cloud Scheduler     | 定期実行トリガー                                                                                             | GCP マネージド                          |
| Secret Manager      | 認証情報管理                                                                                                 | GCP マネージド                          |

---

### 2.1 ActivityPub Step 1 / Step 2 / Step 3 / Step 4 / Step 5 / Step 6 / Step 7 protocol boundary

Plan 017 Step 1 では `packages/activitypub` に Fedify 2.3.4 の protocol contract と PostgreSQL KV / outbox queue adapter を追加した。Next.js の `proxy.ts` は明示的に spike flag を設定した場合だけ WebFinger / Actor / Article fixture を処理し、Web process 内で queue worker を開始しない。delivery は別 Node process が PostgreSQL row を1件 claimし、永続化した key ID から test Actor key を再取得して `Federation.processQueuedTask()` を呼ぶ。

Plan 017 Step 2 では production 用の project / aggregate `@all` Actor、Actor 単位の暗号化鍵 repository、WebFinger / Actor / followers / following / outbox / Article dispatcher を追加した。production proxy は `ACTIVITYPUB_ENABLED=1` のときだけ PostgreSQL-backed federation を single-flight で初期化し、成功した instance だけを process 内で再利用する。初期化失敗時は federation route を `503` で fail closed にし、失敗結果を cache せず、作成済み DB client を閉じて次の request で再試行する。公開 endpoint は public かつ federation-enabled な project だけを解決し、private / disabled / missing project とその Article は `404` に統一する。

project federation の enable / disable は project admin 用 API から既存 authz module を通し、repository transaction 内で exact project row を `FOR UPDATE` して visibility を再検証する。

Plan 017 Step 3 では personal / shared inbox の Follow / Accept / Undo listener、inbound Follow と Accept enqueue、outbound Follow / Undo、Accept receipt、follower / following の決定論的 cursor pagination を追加した。activity URI の receipt と follow generation の状態遷移を併用し、duplicate、Undo-before-Follow、旧 generation の Accept / Undo を冪等に扱う。remote Actor 解決は HTTPS、各 redirect hop の public URL 検証、domain block、5 秒の全体 timeout、1 MiB の response 上限を通す。署名 key owner と Activity actor、embedded Follow の actor / object が一致した場合だけ listener が use-case を呼ぶ。

Web process が queue consumer を起動しない境界は維持し、受信 Activity と配送 Activity は PostgreSQL queue を別 process の one-shot processor が処理する。project settings では member が購読状態を読み取り、project admin だけが server action 経由で outbound Follow / Undo を変更できる。

Issue #699 では、新規の Follow / Accept / Undo inbox row を commit した Web runtime が、専用の App Hosting Web runtime service account で既存 `activitypub-dispatcher` Cloud Run Job の run API を直ちに呼ぶ。この Web runtime SA は Mastra runtime SA と分離し、即時起動に必要な権限を対象 ActivityPub Job resource だけに限定する。Web process 自身は queue を処理せず、Job 起動要求だけを認証2秒・API 3秒の上限内で待つ。重複 inbox row、Create / Announce、outbox enqueue では起動しない。設定不足、認証失敗、timeout、非2xxでも inbox 永続化を失敗させず、5分ごとの Scheduler 経路を durable fallback とする。

Plan 017 Step 4 では report 公開更新と project Actor の Create、およびenabledなaggregate `@all` Actorがある場合のAnnounceを同じDB transactionに置き、commit後だけdispatcherが公開snapshotと公開時点のfollower audienceをmaterializeする。materialization transaction 内の Actor 参照と秘密鍵復号は transaction-bound repository で同じ接続を使い、root pool から別接続を再取得しない。Web は `manuallyStartQueue: true` のまま workerを起動せず、Cloud Scheduler → issuer / audience / subject / email allowlist 付き内部 OIDC route、または新規Follow lifecycle inbox用のbounded Web triggerが起動する `activitypub-dispatcher` Cloud Run Job → `--once` entrypointだけがqueueを処理する。Scheduler SA は対象 Mastra service の invoker だけ、Mastra runtime SA は3つの dispatcher Job、専用 Web runtime SA は ActivityPub dispatcher Job（Admin ingest は別の対象 ingest Job）だけへ resource-level IAM を持つ。Job は最大100件 / 45分で新規 claim を止め、PostgreSQL lease / heartbeat / retry / ordering gate を正本とする。

Plan 017 Step 5 では同じFedify inboxとPostgreSQL queueへ inbound `Create(Article)` / `Announce(Article)` を統合した。listenerはHTTP署名のkey owner、actor、Public audience、object typeを検証し、use-caseはacceptedかつ未解除のoutbound followだけをprojectへ対応付ける。Announce objectはredirect各hopを既存SSRF guardとdomain blockで検証するbounded fetchから共通Article mappingへ正規化し、repositoryとDB triggerがproject越境を拒否する。外部reportは`federated_reports`とmember-only一覧API/UIに閉じ、chat、graph、embedding、search candidate、report生成、ingestionへ接続しない。

Plan 017 Step 6 では実装コードを共有するPufu Lens A / Bをdatabase、canonical origin、Actor keyごとに分離し、Mastodon v4.6.5互換fixtureとtest-only in-memory HTTP transportで接続した。WebFinger、Actor、personal / shared inbox、Follow / Accept / Undo、Create / Announceをservice直接呼出しではなく実route、HTTP署名、Fedify parser、PostgreSQL queue経由で完走し、fault controlと仮想clockでtimeout、429、503、停止・復旧、応答後切断、重複、順序逆転を再現する。host routerとdocument loader差し替えはtest dependency injectionだけに閉じ、production loaderのSSRF guardとWeb process / one-shot processor境界は変更しない。

Plan 017 Step 7 では Web proxy と one-shot dispatcher が本文なしの low-cardinality structured log を出し、Cloud Logging の user metric と Cloud Monitoring alertへ接続する。queue snapshotは depth、oldest age、24時間の success / retry / retry exhausted / permanent failure / 429 / 5xx、ActivityPub table bytesだけを読み、originは上位20件と固定`other`へ制限する。運用者のretry exhausted操作は専用CLIからmetadataだけをinspectし、row lock、lease / status / `updated_at`再検証、queue更新、監査行を同一transactionで行う。Web processがqueue consumerを起動しない境界、PostgreSQLをqueue正本とする境界、remote body / signature / secretをlogへ出さない境界は維持する。正規runbookは `docs/operations/activitypub-federation.md` とする。

Issue #701 では global app settings と project settings に Actor profile 管理を追加し、固定 identity である Actor ID、canonical URL、preferred username、署名鍵を変えずに display name、HTTPS URLまたはcanonical origin内 pathのicon、ActivityPub投稿文生成用の追加promptを更新できるようにした。global adminはaggregate `@all` Actorだけを有効・無効化でき、無効時は新しいAnnounceを作らない一方、enabledなproject ActorのCreateとproject followerへの配送は継続する。`ACTIVITYPUB_ENABLED`は引き続きdeployment全体のmaster switchであり、DB上の`@all`制御とは別である。
