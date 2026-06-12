# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## システムアーキテクチャ

> 現状（2026-06-11）は、ローカル `docker compose` の PostgreSQL / LocalFsObjectStorage と Node scripts（例: `scripts/ingest-workflow.ts`, `scripts/workflow-job.ts`）で主要処理を実行している。Cloud Run Job、GCS、Secret Manager、VPC 構成は目標アーキテクチャであり、実装済みの入口は CLI / Next.js API Route / server action / Mastra runtime に分かれている。

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
            │    - vector-search          │
            │    - graph-query            │
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
