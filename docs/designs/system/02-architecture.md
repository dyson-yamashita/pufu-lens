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

### 2.1 ActivityPub Step 1 / Step 2 / Step 3 protocol boundary

Plan 017 Step 1 では `packages/activitypub` に Fedify 2.3.4 の protocol contract と PostgreSQL KV / outbox queue adapter を追加した。Next.js の `proxy.ts` は明示的に spike flag を設定した場合だけ WebFinger / Actor / Article fixture を処理し、Web process 内で queue worker を開始しない。delivery は別 Node process が PostgreSQL row を1件 claimし、永続化した key ID から test Actor key を再取得して `Federation.processQueuedTask()` を呼ぶ。

Plan 017 Step 2 では production 用の project / aggregate `@all` Actor、Actor 単位の暗号化鍵 repository、WebFinger / Actor / followers / following / outbox / Article dispatcher を追加した。production proxy は `ACTIVITYPUB_ENABLED=1` のときだけ PostgreSQL-backed federation を single-flight で初期化し、成功した instance だけを process 内で再利用する。初期化失敗時は federation route を `503` で fail closed にし、失敗結果を cache せず、作成済み DB client を閉じて次の request で再試行する。公開 endpoint は public かつ federation-enabled な project だけを解決し、private / disabled / missing project とその Article は `404` に統一する。

project federation の enable / disable は project admin 用 API から既存 authz module を通し、repository transaction 内で exact project row を `FOR UPDATE` して visibility を再検証する。

Plan 017 Step 3 では personal / shared inbox の Follow / Accept / Undo listener、inbound Follow と Accept enqueue、outbound Follow / Undo、Accept receipt、follower / following の決定論的 cursor pagination を追加した。activity URI の receipt と follow generation の状態遷移を併用し、duplicate、Undo-before-Follow、旧 generation の Accept / Undo を冪等に扱う。remote Actor 解決は HTTPS、各 redirect hop の public URL 検証、domain block、5 秒の全体 timeout、1 MiB の response 上限を通す。署名 key owner と Activity actor、embedded Follow の actor / object が一致した場合だけ listener が use-case を呼ぶ。

Web process が queue consumer を起動しない境界は維持し、受信 Activity と配送 Activity は PostgreSQL queue を別 process の one-shot processor が処理する。project settings では member が購読状態を読み取り、project admin だけが server action 経由で outbound Follow / Undo を変更できる。report 公開時の Create / Announce transactional outbox、report 配送の scheduler / Job、外部 report 取り込みは Step 4 以降であり、Step 3 には含めない。
