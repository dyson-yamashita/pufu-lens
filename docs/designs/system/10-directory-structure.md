# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## ディレクトリ構成

```
project-root/
│
├── apps/
│   ├── mastra/                    # Mastra Server
│   │   ├── src/
│   │   │   └── mastra/
│   │   │       ├── agents/
│   │   │       │   ├── chat-agent.ts
│   │   │       │   ├── public-report-chat-agent.ts
│   │   │       │   ├── exception-agent.ts
│   │   │       │   └── report-agent.ts
│   │   │       ├── workflows/
│   │   │       │   ├── curate-workflow.ts
│   │   │       │   ├── ingest-workflow.ts
│   │   │       │   └── generate-report-workflow.ts
│   │   │       ├── tools/
│   │   │       │   ├── vector-search.ts
│   │   │       │   ├── graph-query.ts
│   │   │       │   ├── document-fetch.ts
│   │   │       │   ├── raw-document-fetch.ts
│   │   │       │   ├── parsed-doc-fetch.ts
│   │   │       │   ├── public-report-fetch.ts
│   │   │       │   ├── public-context-fetch.ts
│   │   │       │   ├── source-scanner.ts
│   │   │       │   ├── lookup-raw-document.ts
│   │   │       │   ├── fetch-raw.ts
│   │   │       │   ├── link-data-source.ts
│   │   │       │   ├── queue-candidate.ts
│   │   │       │   ├── actor-resolver.ts
│   │   │       │   ├── gmail.ts
│   │   │       │   ├── drive.ts
│   │   │       │   └── github.ts
│   │   │       ├── mcp.ts
│   │   │       └── index.ts
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── web/                       # Next.js フロントエンド
│       ├── app/
│       │   ├── projects/
│       │   │   ├── page.tsx                   # プロジェクト一覧
│       │   │   └── [projectSlug]/
│       │   │       ├── chat/page.tsx
│       │   │       ├── reports/
│       │   │       │   ├── page.tsx           # レポート一覧
│       │   │       │   └── [reportId]/page.tsx# JSON を fetch して描画
│       │   │       └── admin/
│       │   │           ├── data-sources/
│       │   │           └── members/
│       │   ├── reports/
│       │   │   └── public/
│       │   │       └── [projectSlug]/
│       │   │           └── [reportId]/page.tsx # 公開用 JSON を fetch して描画
│       │   ├── admin/
│       │   │   ├── projects/
│       │   │   │   ├── page.tsx               # プロジェクト管理
│       │   │   │   └── new/page.tsx
│       │   │   └── connections/page.tsx
│       │   └── api/
│       │       ├── auth/[...nextauth]/route.ts
│       │       ├── admin/
│       │       │   ├── projects/route.ts
│       │       │   └── connections/{google,github}/route.ts
│       │       ├── public/
│       │       │   ├── projects/
│       │       │   │   ├── route.ts            # public project 一覧
│       │       │   │   └── [projectSlug]/
│       │       │   │       └── reports/[reportId]/
│       │       │   │           ├── route.ts    # redaction 済み public report JSON 配信
│       │       │   │           └── chat/route.ts # Public Chat Agent へ stream proxy
│       │       │   └── reports/[reportId]/     # 短期互換 alias
│       │       └── projects/[projectSlug]/
│       │           ├── chat/route.ts
│       │           ├── data-sources/route.ts
│       │           └── reports/
│       │               ├── route.ts           # 一覧
│       │               └── [reportId]/route.ts# JSON 配信
│       ├── Dockerfile
│       ├── apphosting.yaml         # Firebase App Hosting の runtime/env/secrets 設定
│       ├── package.json
│       └── tsconfig.json
│
├── packages/
│   └── storage/                   # ObjectStorage 抽象とローカル/GCS 実装
│       ├── src/
│       │   ├── object-storage.ts
│       │   ├── local-fs.ts
│       │   ├── gcs.ts
│       │   └── factory.ts
│       └── package.json
│
├── .data/
│   └── volumes/
│       └── pufu-lens-data/        # ローカル運用時の元データ保管場所（gitignore）
│
├── infra/
│   ├── db/
│   │   ├── baseline/              # schema drift check 用の migration 起点 SQL
│   │   └── migrations/            # 既存 DB 向けの番号付き migration SQL
│   ├── docker/
│   │   └── postgres/
│   │       ├── Dockerfile
│   │       └── init.sql           # fresh DB 用スキーマ + schema_migrations baseline stamp
│   └── scheduler/
│       ├── curate-hourly.json
│       ├── ingest-daily.json
│       └── report-weekly.json
│
├── scripts/
│   ├── db-migrate.ts              # infra/db/migrations を schema_migrations で管理して適用
│   ├── create-db-migration.ts     # 次の番号の migration SQL template を生成
│   ├── check-schema-drift.ts      # init.sql と baseline + migration の schema 差分を検出
│   ├── deploy-mastra.sh
│   ├── deploy-web.sh
│   ├── setup-secrets.sh
│   └── create-project.ts          # projects 行作成 + create_graph(graph_name) + ストレージ prefix 用意
│
├── docs/
│   └── operations/
│       ├── db-migrations.md       # DB migration の作成・レビュー・rollback 手順
│       └── deploy-checklist.md    # 初回手動作業と staging / production 検証記録
│
├── .env.local
├── .env.example
├── docker-compose.yml             # postgres + local object storage bind mount + mastra + web
└── package.json
```

---
