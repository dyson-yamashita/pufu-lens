# プロジェクト伴奏エージェント システムデザイン

## 1. 概要

プロジェクトに関連する情報源（Gmail / Google Drive / GitHub / Web ページ）を横断的に取り込み、ナレッジグラフとして PostgreSQL に格納する。チャット UI から自然言語で問い合わせ・分析を行い、定期的にプロジェクトレポートを自動生成する。

### 主要機能

- Gmail / Drive / GitHub / Web からのデータ取り込み（Ingestion）
- Curation Agent による情報源の定期監視・収集候補の優先度付け
- ナレッジグラフ（Apache AGE）+ ベクトル検索（pgvector）による知識基盤
- Mastra Agent によるチャット対応（ソース横断クエリ）
- 定期実行によるレポート自動生成・公開閲覧

---

## 2. システムアーキテクチャ

### 2.1 全体構成

```
┌──────────────────────────────────────────────────────────────┐
│                       データソース                              │
│   Gmail   │   Drive   │   GitHub   │   Web Pages              │
└─────┬─────┴─────┬─────┴─────┬──────┴──────┬──────────────────┘
      │           │           │             │
      ▼           ▼           ▼             ▼
┌──────────────────────────────────────────────────────────────┐
│         Curation Agent（Cloud Run Job）                         │
│   1. 情報源の監視・新規候補の発見                                 │
│   2. 関連度・鮮度・重複を評価                                     │
│   3. ingestion_queue へ投入                                      │
└─────────────────────┬────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────────┐
│         Ingestion Workflow（Mastra Workflow on Cloud Run Job）  │
│   1. キューから対象取得                                          │
│   2. データ取得（MCP / API）                                     │
│   3. LLM によるエンティティ・関係抽出                             │
│   4. チャンク化・embedding 生成                                  │
│   5. AGE グラフ + pgvector へ格納                               │
└─────────────────────┬────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────────┐
│              PostgreSQL（GCE VM + Docker）                     │
│  ┌──────────────┐  ┌────────────┐  ┌──────────────────────┐  │
│  │ AGE（グラフ）  │  │ pgvector   │  │ relational           │  │
│  │ Entity/Edge   │  │ embedding  │  │ reports（メタデータ） │  │
│  └──────────────┘  └────────────┘  └──────────────────────┘  │
└─────────────────────┬────────────────────────────────────────┘
                      │
          ┌───────────┴────────────┐
          ▼                        ▼
┌─────────────────────┐  ┌──────────────────────────┐
│  Mastra Server      │  │  Report Generation        │
│  Chat Agent         │  │  Workflow                 │
│  (Cloud Run)        │  │  (Cloud Run Job)          │
└──────────┬──────────┘  └────────────┬─────────────┘
           │                          │ Cloud Scheduler
           ▼                          ▼  （毎週／毎月）
┌─────────────────────┐  ┌──────────────────────────┐
│  Next.js (Cloud Run) │  │  GCS（レポート HTML）      │
│  チャット / レポート  │  │  + Slack 通知             │
└─────────────────────┘  └──────────────────────────┘
```

### 2.2 コンポーネント役割

| コンポーネント | 役割 | デプロイ先 |
|---|---|---|
| Next.js | チャット UI、レポート閲覧 | Cloud Run |
| Mastra Server | Agent API、ツール実行 | Cloud Run |
| Curation Agent | 情報源の監視、収集候補の評価、キュー投入 | Cloud Run Job |
| Ingestion Workflow | キュー処理、データ取得、グラフ構築 | Cloud Run Job |
| Report Workflow | レポート生成 | Cloud Run Job |
| PostgreSQL | ナレッジグラフ・メタデータ | GCE VM（Docker） |
| GCS | レポート本体（HTML/PDF） | Cloud Storage |
| Cloud Scheduler | 定期実行トリガー | GCP マネージド |
| Secret Manager | 認証情報管理 | GCP マネージド |

---

## 3. データモデル

### 3.1 PostgreSQL スキーマ

```sql
-- 拡張機能
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS age;
LOAD 'age';
SET search_path = ag_catalog, "$user", public;

-- 収集対象の情報源
CREATE TABLE sources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type     TEXT NOT NULL,   -- 'gmail' | 'drive' | 'github' | 'web'
  locator         TEXT NOT NULL,   -- Gmail query、Drive folder ID、repo、URL 等
  metadata        JSONB DEFAULT '{}',
  enabled         BOOLEAN DEFAULT true,
  last_checked_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (source_type, locator)
);

-- Ingestion の実行キュー
CREATE TABLE ingestion_queue (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id    UUID REFERENCES sources(id),
  target_id    TEXT NOT NULL,      -- メール ID、ファイル ID、Issue URL 等
  target_uri   TEXT,
  priority     INTEGER DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending',
  reason       TEXT,
  scheduled_at TIMESTAMPTZ DEFAULT now(),
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (source_id, target_id)
);
CREATE INDEX ON ingestion_queue (status, priority DESC, scheduled_at);

-- ベクトル検索用チャンク
CREATE TABLE knowledge_chunks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL,   -- 'gmail' | 'drive' | 'github' | 'web'
  source_id   TEXT NOT NULL,   -- 外部キー（メール ID、ファイル ID 等）
  chunk_index INTEGER NOT NULL,
  content     TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding   vector(1536),
  embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (source_type, source_id, chunk_index),
  UNIQUE (source_type, source_id, content_hash)
);
CREATE INDEX ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

-- AGE グラフ
SELECT create_graph('project_graph');

-- レポートメタデータ（本体は GCS）
CREATE TABLE reports (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title      TEXT NOT NULL,
  summary    TEXT,                 -- 検索・一覧表示用
  gcs_uri    TEXT NOT NULL,        -- HTML 本体（gs://...）
  period     DATERANGE,
  is_public  BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- レポート検索用チャンク
CREATE TABLE report_chunks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id   UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content     TEXT NOT NULL,
  embedding   vector(1536),
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (report_id, chunk_index)
);
CREATE INDEX ON report_chunks USING hnsw (embedding vector_cosine_ops);
```

### 3.2 ナレッジグラフ構造

```
(Person)-[:SENT]->(Email)-[:MENTIONS]->(Issue)
(Issue)-[:LINKED_TO]->(Commit)
(Commit)-[:MODIFIES]->(File)
(Person)-[:OWNS]->(DriveDoc)-[:REFERENCES]->(Issue)
(WebPage)-[:DESCRIBES]->(Feature)
```

主要ノードラベル：
- `Person` — 人物（メール送信者、コミット作者）
- `Email` — メール
- `Issue` / `PullRequest` / `Commit` — GitHub エンティティ
- `DriveDoc` — Drive ドキュメント
- `WebPage` — 取り込んだ Web ページ
- `Feature` / `Topic` — 抽象的なトピック

---

## 4. データソース連携

### 4.1 Google（Gmail / Drive）

**認証方式：** Service Account（サーバーサイド実行）

Gmail のユーザーメールボックスを横断的に読む場合は、Google Workspace 管理者による Domain-wide Delegation を有効化し、対象ユーザーを impersonate して API を呼び出す。Domain-wide Delegation を使えない環境では、ユーザーごとの OAuth 同意フローに切り替える。

Drive は Service Account 単体では共有されたファイルのみ参照できるため、組織横断で取得する場合は Gmail と同様に Domain-wide Delegation を使うか、対象フォルダを Service Account に共有する。

```typescript
// src/lib/google-auth.ts
import { GoogleAuth } from "google-auth-library";

const auth = new GoogleAuth({
  scopes: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
  clientOptions: {
    subject: process.env.GOOGLE_IMPERSONATED_USER,
  },
});
```

**連携方法：** Google 公式 MCP サーバー or googleapis 直接

| | MCP | googleapis 直接 |
|---|---|---|
| 実装速度 | 速い | 中 |
| 細かい制御 | 限定的 | 高い |
| Agent の自律的選択 | 可能 | ツール化要 |

推奨：MCP で素早く開始、必要に応じて直接実装に切り替え。

### 4.2 GitHub

**認証方式：** GitHub App（複数リポジトリ対応）または PAT（単一リポジトリ）

```typescript
import { createAppAuth } from "@octokit/auth-app";

const auth = createAppAuth({
  appId: process.env.GITHUB_APP_ID,
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
  installationId: process.env.GITHUB_INSTALLATION_ID,
});
```

**連携方法：** GitHub 公式 MCP（`@modelcontextprotocol/server-github`）または Octokit 直接。

### 4.3 Web ページ

カスタム実装。URL リストまたは RSS / Sitemap から取得し、`@mozilla/readability` 等で本文抽出。

---

## 5. Curation / Ingestion ワークフロー

### 5.1 Curation Agent

Curation Agent は定期実行で `sources` を巡回し、プロジェクトに関連する新規・更新済みの収集候補を `ingestion_queue` に投入する。Ingestion から分離することで、情報源の探索・優先度付け・重複排除と、本文取得・グラフ構築の責務を分ける。

主な判定軸：
- プロジェクト関連度（リポジトリ、担当者、キーワード、既存グラフとの近さ）
- 鮮度（前回確認以降の更新、期限やマイルストーンとの近さ）
- 重複・既取り込み判定（`source_id`、URL canonicalization、content hash）
- 優先度（障害、意思決定、未解決 Issue、重要人物のメール等）

```typescript
// src/mastra/agents/curation-agent.ts
export const curationAgent = new Agent({
  name: "curation-agent",
  model: anthropic("claude-sonnet-4-5"),
  instructions: `
あなたはプロジェクト情報のキュレーターです。
情報源を定期確認し、関連度・鮮度・重複を評価して、
取り込むべき候補だけを ingestion_queue に投入します。
  `,
  tools: { sourceScannerTool, queueCandidateTool, graphContextTool },
});
```

```typescript
// src/mastra/workflows/curate-workflow.ts
export const curateWorkflow = createWorkflow({
  id: "curate-workflow",
  inputSchema: z.object({ sourceTypes: z.array(z.string()).optional() }),
  execute: async ({ inputData, mastra }) => {
    const sources = await loadEnabledSources(inputData.sourceTypes);
    const agent = mastra.getAgent("curation-agent");

    for (const source of sources) {
      const candidates = await scanSourceForUpdates(source);
      await agent.generate({
        prompt: "収集候補を評価して ingestion_queue に投入してください",
        context: { source, candidates },
      });
      await markSourceChecked(source.id);
    }
  },
});
```

### 5.2 Ingestion 処理フロー

```
1. dequeueTargets キューから対象を取得
2. fetchSources   Gmail/Drive/GitHub/Web から取得
3. extractEntities LLM でエンティティ・関係抽出
4. chunkAndEmbed  ソース本文をチャンク化し embedding を生成
5. storeGraph     pgvector + AGE に格納
```

### 5.3 実装スケッチ

```typescript
// src/mastra/workflows/ingest-workflow.ts
export const ingestWorkflow = createWorkflow({
  id: "ingest-workflow",
  inputSchema: z.object({ since: z.string() }),
  execute: async ({ inputData }) => {
    const targets   = await dequeueTargetsStep.execute({ inputData });
    const fetched   = await fetchSourcesStep.execute({ inputData: targets });
    const extracted = await extractEntitiesStep.execute({ inputData: fetched });
    const chunks    = await chunkAndEmbedStep.execute({ inputData: extracted });
    const stored    = await storeGraphStep.execute({ inputData: chunks });
    return stored;
  },
});
```

抽出ステップでは Claude Sonnet で構造化出力（`generateObject` + Zod schema）を行い、エンティティと関係を JSON で得る。冪等性のため `MERGE` を使用してノード重複を回避する。チャンク保存は `source_type`、`source_id`、`chunk_index`、`content_hash` をキーにして再実行時の重複を防ぐ。

---

## 6. チャット機能

### 6.1 Chat Agent 設計

3 つのツールを提供：

| ツール | 役割 |
|---|---|
| `vector-search` | 意味的類似度でチャンクを取得 |
| `graph-query` | Cypher でグラフ探索 |
| `cross-source-summary` | ソース横断のサマリー |

```typescript
export const chatAgent = new Agent({
  name: "project-chat-agent",
  model: anthropic("claude-sonnet-4-5"),
  instructions: `
あなたはプロジェクト知識グラフのアナリストです。
回答時は：
1. まず vector-search で関連チャンクを取得
2. 必要に応じて graph-query でエンティティ関係を調査
3. cross-source-summary でソースを横断的に確認
4. 情報源を明示して回答する
  `,
  tools: { vectorSearchTool, graphQueryTool, crossSourceSummaryTool },
});
```

### 6.2 フロントエンド

Next.js + `@ai-sdk/react` の `useChat` でストリーミング対応。

```typescript
// app/chat/page.tsx
"use client";
import { useChat } from "@ai-sdk/react";

export default function ChatPage() {
  const { messages, input, handleInputChange, handleSubmit } = useChat({
    api: "/api/chat",
  });
  return /* チャット UI */;
}
```

API ルートは Mastra Server へのプロキシ：

```typescript
// app/api/chat/route.ts
import { GoogleAuth } from "google-auth-library";

export async function POST(req: Request) {
  const body = await req.json();
  const mastraUrl = `${process.env.MASTRA_API_URL}/api/agents/chat-agent/stream`;
  const auth = new GoogleAuth();
  const client = await auth.getIdTokenClient(process.env.MASTRA_API_URL!);
  const headers = await client.getRequestHeaders(mastraUrl);

  const res = await fetch(mastraUrl, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return new Response(res.body, { headers: res.headers });
}
```

frontend の Cloud Run service account には Mastra Server への `roles/run.invoker` を付与する。Mastra Server は `--no-allow-unauthenticated` のまま運用し、ブラウザから直接呼び出せないようにする。

### 6.3 公開時のレート制限

```typescript
server: {
  middleware: [{
    path: "/api/agents/*",
    handler: rateLimiter({
      windowMs: 60_000,
      limit: 10,
      keyGenerator: (c) => c.req.header("x-forwarded-for") ?? "unknown",
    }),
  }],
}
```

---

## 7. レポート生成

### 7.1 ワークフロー

```typescript
const generateReportWorkflow = createWorkflow({
  id: "generate-report",
  execute: async ({ inputData, mastra }) => {
    const agent = mastra.getAgent("chat-agent");
    const { periodStart, periodEnd } = resolveReportPeriod(inputData);

    // 1. 各セクションを並列生成
    const [activity, issues, progress, risks] = await Promise.all([
      agent.generate(`${inputData.since} 以降のアクティビティサマリーを生成`),
      agent.generate("未解決の Issue と担当者をグラフから一覧化"),
      agent.generate("プロジェクト進捗をコミット・ドキュメント変更から分析"),
      agent.generate("リスク・懸念事項をメールや Issue から抽出"),
    ]);

    const content = renderReport({ activity, issues, progress, risks });
    const html = markdownToHtml(content);

    // 2. GCS へアップロード
    const reportId = crypto.randomUUID();
    const gcsPath = `reports/${reportId}.html`;
    await storage.bucket(BUCKET).file(gcsPath).save(html, {
      contentType: "text/html; charset=utf-8",
      metadata: { cacheControl: "private, max-age=3600" },
    });

    // 3. メタデータを DB に保存
    const gcsUri = `gs://${BUCKET}/${gcsPath}`;
    await db.query("BEGIN");
    await db.query(`
      INSERT INTO reports (id, title, summary, gcs_uri, period)
      VALUES ($1, $2, $3, $4, $5)
    `, [reportId, "週次レポート", content.slice(0, 500), gcsUri,
        `[${periodStart}, ${periodEnd}]`]);

    // 4. 検索用チャンクを保存
    const reportChunks = await chunkAndEmbedReport(content);
    await insertReportChunks(reportId, reportChunks);
    await db.query("COMMIT");

    // 5. Slack 通知
    const reportUrl = `${process.env.FRONTEND_URL}/reports/${reportId}`;
    await slackAgent.generate(`レポートが生成されました: ${reportUrl}`);

    return { reportId, reportUrl };
  },
});
```

### 7.2 ストレージ方針

| | 配置先 | 理由 |
|---|---|---|
| レポート本体 HTML | GCS | CDN 配信、コスト効率 |
| メタデータ・要約 | PostgreSQL | 一覧表示、全文検索 |
| 検索用埋め込み | pgvector | 過去レポートの意味検索 |

レポート閲覧は Next.js が `reports.is_public` を確認し、許可された場合のみ GCS オブジェクトを取得する。公開レポートは Next.js の公開ページで配信し、非公開レポートは認可チェック後に短時間の signed URL を発行する。

---

## 8. 定期実行（Cloud Scheduler）

```bash
# 1 時間ごとに情報源を確認し、収集候補をキューに投入
gcloud scheduler jobs create http curate-hourly \
  --schedule="0 * * * *" \
  --uri="https://asia-northeast1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/PROJECT/jobs/curate-workflow:run" \
  --message-body='{"sourceTypes":["gmail","drive","github","web"]}' \
  --oidc-service-account-email="scheduler-sa@PROJECT.iam.gserviceaccount.com" \
  --time-zone="Asia/Tokyo"

# 毎日深夜に Ingestion Job を起動
gcloud scheduler jobs create http ingest-daily \
  --schedule="0 2 * * *" \
  --uri="https://asia-northeast1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/PROJECT/jobs/ingest-workflow:run" \
  --message-body='{"since":"1dayAgo"}' \
  --oidc-service-account-email="scheduler-sa@PROJECT.iam.gserviceaccount.com" \
  --time-zone="Asia/Tokyo"

# 毎週金曜 17 時に Report Job を起動
gcloud scheduler jobs create http report-weekly \
  --schedule="0 17 * * 5" \
  --uri="https://asia-northeast1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/PROJECT/jobs/generate-report:run" \
  --message-body='{"period":"weekly","since":"7daysAgo"}' \
  --oidc-service-account-email="scheduler-sa@PROJECT.iam.gserviceaccount.com" \
  --time-zone="Asia/Tokyo"
```

OIDC 認証で Cloud Run Jobs Admin API を呼び出す。`scheduler-sa` には対象 Job の実行に必要な `roles/run.developer` と、Job 実行時 service account への `roles/iam.serviceAccountUser` を最小権限で付与する。

---

## 9. ディレクトリ構成

```
project-root/
│
├── apps/
│   ├── mastra/                    # Mastra Server
│   │   ├── src/
│   │   │   └── mastra/
│   │   │       ├── agents/
│   │   │       │   ├── chat-agent.ts
│   │   │       │   ├── curation-agent.ts
│   │   │       │   └── report-agent.ts
│   │   │       ├── workflows/
│   │   │       │   ├── curate-workflow.ts
│   │   │       │   ├── ingest-workflow.ts
│   │   │       │   └── report-workflow.ts
│   │   │       ├── tools/
│   │   │       │   ├── vector-search.ts
│   │   │       │   ├── graph-query.ts
│   │   │       │   ├── source-scanner.ts
│   │   │       │   ├── queue-candidate.ts
│   │   │       │   ├── gmail.ts
│   │   │       │   ├── drive.ts
│   │   │       │   └── github.ts
│   │   │       ├── mcp.ts         # MCPClient 設定
│   │   │       └── index.ts       # Mastra インスタンス
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── web/                       # Next.js フロントエンド
│       ├── app/
│       │   ├── chat/
│       │   │   └── page.tsx
│       │   ├── reports/
│       │   │   ├── page.tsx       # レポート一覧
│       │   │   └── [id]/
│       │   │       └── page.tsx   # レポート詳細
│       │   └── api/
│       │       └── chat/
│       │           └── route.ts   # Mastra へのプロキシ
│       ├── Dockerfile
│       ├── package.json
│       └── tsconfig.json
│
├── infra/
│   ├── docker/
│   │   └── postgres/
│   │       ├── Dockerfile         # PG17 + pgvector + AGE
│   │       └── init.sql           # スキーマ初期化
│   ├── k8s/                       # GKE 移行時用（将来）
│   └── scheduler/
│       ├── ingest-daily.json      # Cloud Scheduler 設定
│       └── report-weekly.json
│
├── scripts/
│   ├── deploy-mastra.sh
│   ├── deploy-web.sh
│   └── setup-secrets.sh
│
├── .env.local                     # ローカル開発用（gitignore）
├── .env.example                   # サンプル（git 管理）
├── docker-compose.yml             # ローカル開発用
└── package.json                   # ワークスペース定義
```

---

## 10. デプロイメント

### 10.1 ローカル開発

```bash
# 全サービス起動
docker compose up

# Mastra のみ
cd apps/mastra && npm run dev

# Web のみ
cd apps/web && npm run dev
```

### 10.2 本番デプロイ（GCP）

```bash
# 1. PostgreSQL VM 起動（初回のみ）
gcloud compute instances create-with-container pg-ai \
  --machine-type=e2-medium \
  --container-image=asia-northeast1-docker.pkg.dev/PROJECT/postgres-ai:latest \
  --boot-disk-size=50GB \
  --boot-disk-type=pd-ssd \
  --no-address

# 2. Mastra Server ビルド & デプロイ
cd apps/mastra && mastra build
gcloud run deploy mastra-server \
  --source . \
  --region asia-northeast1 \
  --service-account=mastra-runtime@PROJECT.iam.gserviceaccount.com \
  --vpc-connector=mastra-connector \
  --no-allow-unauthenticated \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,GITHUB_TOKEN=GITHUB_TOKEN:latest"

# 3. Curation / Ingestion / Report Jobs デプロイ
gcloud run jobs deploy curate-workflow \
  --source . \
  --region asia-northeast1 \
  --service-account=mastra-runtime@PROJECT.iam.gserviceaccount.com \
  --vpc-connector=mastra-connector \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,GITHUB_TOKEN=GITHUB_TOKEN:latest,GOOGLE_SA_KEY=GOOGLE_SA_KEY:latest"

gcloud run jobs deploy ingest-workflow \
  --source . \
  --region asia-northeast1 \
  --service-account=mastra-runtime@PROJECT.iam.gserviceaccount.com \
  --vpc-connector=mastra-connector \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,GITHUB_TOKEN=GITHUB_TOKEN:latest,GOOGLE_SA_KEY=GOOGLE_SA_KEY:latest"

gcloud run jobs deploy generate-report \
  --source . \
  --region asia-northeast1 \
  --service-account=mastra-runtime@PROJECT.iam.gserviceaccount.com \
  --vpc-connector=mastra-connector \
  --set-env-vars FRONTEND_URL=https://frontend-xxx.run.app \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,SLACK_WEBHOOK_URL=SLACK_WEBHOOK_URL:latest"

# 4. Next.js デプロイ
cd apps/web
gcloud run deploy frontend \
  --source . \
  --region asia-northeast1 \
  --service-account=frontend-runtime@PROJECT.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --set-env-vars MASTRA_API_URL=https://mastra-server-xxx.run.app,FRONTEND_URL=https://frontend-xxx.run.app

gcloud run services add-iam-policy-binding mastra-server \
  --region asia-northeast1 \
  --member="serviceAccount:frontend-runtime@PROJECT.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
```

### 10.3 Secret Manager

```bash
# シークレット登録
echo -n "ghp_xxxx" | gcloud secrets create GITHUB_TOKEN --data-file=-
echo -n "postgresql://..." | gcloud secrets create DATABASE_URL --data-file=-
gcloud secrets create GOOGLE_SA_KEY --data-file=service-account.json
echo -n "https://hooks.slack.com/services/..." | gcloud secrets create SLACK_WEBHOOK_URL --data-file=-
```

Cloud Run に `--set-secrets` でマウントすると環境変数として読める。

---

## 11. ネットワーク・セキュリティ

### 11.1 ネットワーク構成

```
Internet
   │
   ▼
Cloud Run (Next.js) ── allow-unauthenticated（公開）
   │
   │ VPC 内部通信
   ▼
Cloud Run (Mastra) ── no-allow-unauthenticated（非公開）
   │
   │ Private IP（VPC 内）
   ▼
GCE VM PostgreSQL ── パブリック IP 無し
```

- Cloud Run → GCE VM は VPC コネクタ経由
- PostgreSQL はインターネット側に露出しない
- Next.js → Mastra は OIDC 認証

### 11.2 認証・認可

| 対象 | 方式 |
|---|---|
| Cloud Run → Cloud Run | OIDC（Service Account） |
| Cloud Run → GCE VM | VPC 内部通信 + DB パスワード |
| Cloud Scheduler → Cloud Run | OIDC |
| Cloud Run → Google API | Service Account |
| Cloud Run → GitHub | GitHub App / PAT |
| Cloud Run → Secret Manager | Workload Identity |

### 11.3 公開レポートの保護

- GCS バケットは private にする
- `is_public = true` のレポートは Next.js の公開ページから配信する
- `is_public = false` のレポートは認可チェック後に短時間の signed URL を発行する
- レート制限を Cloud Armor または Hono middleware で実装

---

## 12. 運用コスト見積もり（月額）

### 12.1 GCE VM + Cloud Run 構成（推奨）

| コンポーネント | スペック | 月額 |
|---|---|---|
| Cloud Run（Next.js） | リクエストベース | $3〜15 |
| Cloud Run（Mastra Server） | リクエストベース | $5〜30 |
| Cloud Run Jobs（Ingestion / Report） | 日次実行 | $1〜5 |
| GCE VM（e2-medium） | 業務時間のみ | $13〜33 |
| Persistent Disk SSD 50GB | $0.17/GB | $9 |
| GCS（レポート HTML） | 1GB 程度 | $0.03 |
| VPC コネクタ | $0.01/GB + $6 | $6〜 |
| Secret Manager | 数バージョン | $1 |
| Cloud Scheduler | 数ジョブ | 無料枠内 |
| **合計** | | **$38〜100** |

### 12.2 コスト最適化施策

- GCE VM の業務時間外停止（Cloud Scheduler + `gcloud compute instances stop/start`）
- Cloud Run の最小インスタンス数を 0 に
- GCS のライフサイクル管理（古いレポートは Nearline / Coldline へ）

---

## 13. フェーズ別ロードマップ

### Phase 1: 基盤構築（2 週間）

- GCE VM 起動と PostgreSQL（pgvector + AGE）セットアップ
- カスタム Docker イメージのビルドと Artifact Registry 登録
- スキーマ初期化、基本的な接続確認
- `sources` / `ingestion_queue` と Curation Agent の最小実装
- GitHub Ingestion のみ実装、動作確認

### Phase 2: マルチソース対応（2 週間）

- Gmail / Drive Ingestion 追加（Google MCP）
- Web ページ取り込み実装
- Curation Agent の関連度・重複判定精度調整
- Chat Agent の基本動作確認
- ナレッジグラフの拡張・エンティティ抽出精度調整

### Phase 3: フロントエンド（1 週間）

- Next.js チャット UI 実装
- レポート閲覧ページ実装
- Cloud Run デプロイ
- VPC コネクタ・ネットワーク構成

### Phase 4: 自動化・運用（1 週間）

- レポート自動生成ワークフロー
- Cloud Scheduler 設定
- Slack 通知
- Secret Manager 統合・本番運用開始

---

## 14. 将来の拡張

### 14.1 GKE への移行検討トリガー

以下のいずれかが該当した場合、GCE VM から GKE Autopilot + CloudNativePG への移行を検討する：

- 複数の Agent / サービスを統一管理したい
- PostgreSQL の HA（自動フェイルオーバー）が必要
- インフラを完全に IaC で管理したい
- チーム拡大によりオペレーション標準化が必要

### 14.2 機能拡張候補

- マルチプロジェクト対応（プロジェクト単位でグラフを分離）
- Slack / Teams 統合（Bot から直接質問）
- 過去レポートの差分分析（pgvector で類似レポート検索）
- ダッシュボード機能（メトリクス可視化）
- エンティティ承認フロー（誤検出の修正）

### 14.3 検討中の代替構成

| 構成 | メリット | デメリット |
|---|---|---|
| Cloud SQL（AGE 無し） | 完全マネージド | グラフクエリ不可 |
| GKE Autopilot | HA・スケーラブル | 運用コスト増 |
| EDB BigAnimal on GCP | AGE 対応マネージド | コスト高 |
| Azure HorizonDB | AGE 対応マネージド | クロスクラウド |

---

## 15. 技術スタック サマリー

| カテゴリ | 採用技術 |
|---|---|
| Agent Framework | Mastra |
| LLM | Anthropic Claude Sonnet 4.5 |
| Frontend | Next.js + AI SDK |
| Database | PostgreSQL 17 + pgvector + Apache AGE |
| MCP | Google MCP、GitHub MCP |
| Compute | Cloud Run、Cloud Run Jobs |
| Database Host | GCE VM（Container-Optimized OS） |
| Storage | Cloud Storage（GCS） |
| Scheduler | Cloud Scheduler |
| Secrets | Secret Manager |
| Auth | Service Account、GitHub App |
| Monorepo | npm workspaces / Turborepo |

---

## 16. 参考リンク

- Mastra Docs: https://mastra.ai/docs
- Apache AGE: https://age.apache.org
- pgvector: https://github.com/pgvector/pgvector
- CloudNativePG: https://cloudnative-pg.io
- Cloud Run: https://cloud.google.com/run/docs
- Anthropic API: https://docs.claude.com
