# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## チャット機能

API 入口、認可、stream proxy の共通契約は [API デザイン](05-api-design.md) も参照する。

### 1. Private Chat Agent 設計

Private Chat Agent は **プロジェクトをコンテキストとして固定** して動作する。Browser URL は `/projects/[projectSlug]/chat` を使い、Next.js API が `projectSlug` を UUID の `projectId` に解決して Mastra に渡す。project member だけが利用でき、次のツールを提供する。

| ツール                 | 役割                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `vector-search`        | `document_chunks` から意味的類似度で関連チャンクを取得（document_id 付き）                |
| `graph-query`          | プロジェクト専用 AGE グラフに対する Cypher 探索                                           |
| `document-fetch`       | 特定の `documents.id` の全文 / メタデータを取得                                           |
| `raw-document-fetch`   | Object Storage 上の **元データ** を取得（メール原文、PR の diff、Web ページの元 HTML 等） |
| `parsed-doc-fetch`     | parse 済み JSON（引用分解後のメール、抽出済みエンティティ等）を取得                       |
| `cross-source-summary` | 複数 Document を横断したサマリ                                                            |

```typescript
export const privateChatAgent = new Agent({
  name: 'project-chat-agent',
  model: google(process.env.GEMINI_CHAT_MODEL ?? 'gemini-2.5-flash'),
  instructions: `
あなたはプロジェクト知識グラフのアナリストです。
回答時は次の順で情報を集めます：
  1. vector-search で関連チャンクを取得し、document_id を控える
  2. graph-query で document_id を起点にエンティティ関係を調査
     - 関連ドキュメントを辿る際は SAME_AS 関係も 1 ホップ確認し、
       ソースをまたぐ意味的同一ドキュメント（例: Drive と Web の同一仕様書）も候補に含める
  3. 詳細が必要なら document-fetch / parsed-doc-fetch / raw-document-fetch で原本を確認
     （メールの引用、PR のコード差分、Web ページの原文など）
  4. 情報源を明示して回答する（document_id / canonical_uri を含める）
あなたが扱えるのは指定された projectId のデータだけです。
他プロジェクトのツール呼び出しは行わないでください。
  `,
  tools: {
    vectorSearchTool,
    graphQueryTool,
    documentFetchTool,
    rawDocumentFetchTool,
    parsedDocFetchTool,
    crossSourceSummaryTool
  }
});
```

`rawDocumentFetchTool` は `raw_documents.storage_uri` を読み、`ObjectStorage.getText` で本文を返す。サイズ上限を設け、画像・バイナリは要約メタデータのみ返す。

#### Step 12 初期実装

Step 12 の最小実装では Mastra stream proxy へ進む前に、Next.js 内に同期 JSON API と UI を置く。

- API: `POST /api/projects/[projectSlug]/chat`
- UI: `/projects/[projectSlug]/chat`
- server-side provider: `GEMINI_API_KEY` と `GEMINI_CHAT_MODEL` がある場合は Gemini chat provider、未設定時は source 確認用の extractive fallback provider
- project member 判定: `PUFU_LENS_CHAT_USER_ID` または `PUFU_LENS_ADMIN_USER_ID` を使って `project_members` を確認
- tool call: `vector-search` / `graph-query` / `document-fetch` / `raw-document-fetch` / `parsed-doc-fetch` を同一 API 内で順に実行し、回答に `sources` と `toolCalls` を含める
- raw document fetch: 初期実装では本文実体を返さず、`byte_size <= 64 KiB` の document source metadata に限定する
- 業務時間外: `PUFU_LENS_CHAT_ENFORCE_BUSINESS_HOURS=true` の場合、API は `db_outside_business_hours` を返し、UI は入力欄を disabled にする
- rate limit: process 内 memory bucket で user + project 単位に制限する
- 評価: `pnpm chat:eval --fixture fixtures/chat/private-chat-eval.json` で running web server に対して source / tool call を確認する

この初期実装は Step 12 の確認用であり、Mastra Agent 化、streaming、Object Storage からの raw / parsed 本文取得、AGE Cypher の本格利用、永続 rate limit / audit log は後続で置き換える。

### 2. Public Chat Agent 設計

Public Chat Agent は未ログインユーザー向けに提供するが、対象を **公開済み report** に限定する。private chat と同じ tool set は使わず、Object Storage 上の redaction 済み public report JSON と public context bundle だけを参照する。DB / AGE / pgvector / raw document / parsed document への tool は持たせない。

公開用 context bundle には、公開してよい report section、要約、source snippet、公開 source id、canonical_uri のうち公開許可済みのものだけを含める。メールアドレス、OAuth 情報、社内 URL、未公開 raw / parsed 本文、個人情報を含む可能性のある detail は含めない。

`publicReportFetchTool` と `publicContextFetchTool` は、ユーザー入力や LLM が指定した `storageUri` / `sourceUri` を受け取らない。Next.js が公開用 manifest / metadata を検証し、server side で解決した `reportId`、`artifactVersion`、`public_report_uri`、`public_context_bundle_uri` だけを Mastra へ渡す。tool 側でも manifest に載っていない URI、対象 report と一致しない URI、許可 prefix 外の URI、etag / artifact version が一致しない artifact は拒否する。

```typescript
export const publicReportChatAgent = new Agent({
  name: 'public-report-chat-agent',
  model: google(process.env.GEMINI_CHAT_MODEL ?? 'gemini-2.5-flash'),
  instructions: `
あなたは公開レポートの読者向けアシスタントです。
回答に使える情報は、指定された redaction 済み public report JSON と public context bundle だけです。

次の制約を必ず守ってください：
  - 個人情報、メールアドレス、OAuth 情報、secret、未公開 URL、raw / parsed の本文全文を出さない
  - report の内容と対象 project の公開済み情報に関係しない質問には回答しない
  - 他 project、内部データ、未公開資料、一般雑談、外部調査、コード生成の依頼には回答しない
  - 根拠は public report の section id または公開 source id だけで示す
  - tool に URI や projectId を指定しようとしない
  - 不明な内容は推測せず、公開情報だけでは回答できないと伝える
  `,
  tools: {
    publicReportFetchTool,
    publicContextFetchTool
  }
});
```

public chat の入口：

```text
Browser -> Next.js /api/public/reports/[reportId]/chat
Next.js -> Mastra Server /api/agents/public-report-chat-agent/stream
```

Next.js は公開用 manifest / metadata で `reportId` が public であることを確認し、server side で public report JSON と public context bundle URI を解決する。ブラウザから送られた `projectId`、`storageUri`、`sourceUri`、`artifactVersion` は信用しない。

### 3. 業務時間外の扱い

PostgreSQL は GCE VM（e2-medium）上で業務時間のみ起動する。Private Chat Agent は `vector-search`、`graph-query`、`document-fetch` などで DB / AGE / pgvector に依存するため、業務時間外はチャットを実行しない。

Next.js の Private Chat API は Mastra Server へ proxy する前に DB 利用可能時間を確認し、業務時間外の場合は `503 Service Unavailable` と共通エラー `db_outside_business_hours` を返す。チャット UI は入力欄を disabled にし、次のメッセージを表示する。

```text
現在は営業時間外のため、チャットを利用できません。公開済みレポートは引き続き閲覧できます。
```

Public Chat API は DB に依存しない redaction 済み public report / public context bundle だけを使うため、業務時間外でも利用できる。ただし Gemini provider、Mastra Server、Object Storage が利用できない場合は通常の service unavailable を返す。

### 4. フロントエンド

Next.js + `@ai-sdk/react` の `useChat` でストリーミング対応。URL にプロジェクトを含める。

```typescript
// app/projects/[projectSlug]/chat/page.tsx
'use client';
import { useChat } from '@ai-sdk/react';

export default function ChatPage({ params }: { params: { projectSlug: string } }) {
  const { messages, input, handleInputChange, handleSubmit } = useChat({
    api: `/api/projects/${params.projectSlug}/chat`
  });
  return /* チャット UI */;
}
```

API ルートは Mastra Server へのプロキシ（`projectSlug` を検証し、解決した `projectId` を body に詰める）：

```typescript
// app/api/projects/[projectSlug]/chat/route.ts
import { GoogleAuth } from 'google-auth-library';

export async function POST(req: Request, { params }: { params: { projectSlug: string } }) {
  const project = await assertProjectMemberBySlug(req, params.projectSlug);
  const body = await req.json();
  const mastraUrl = `${process.env.MASTRA_API_URL}/api/agents/project-chat-agent/stream`;
  const auth = new GoogleAuth();
  const client = await auth.getIdTokenClient(process.env.MASTRA_API_URL!);
  const headers = await client.getRequestHeaders(mastraUrl);

  const res = await fetch(mastraUrl, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, projectId: project.id })
  });
  return new Response(res.body, { headers: res.headers });
}
```

Public report page では、必要に応じて report 本文の横に public chat composer を表示する。private chat と誤認しないよう、公開情報だけに基づく回答であることを短く表示し、入力 placeholder も report 内容への質問に限定する。

### 5. レート制限

private chat と public chat は別の rate limit bucket を使う。

| 対象         | キー                           |                             初期上限 | ルール                                                                            |
| ------------ | ------------------------------ | -----------------------------------: | --------------------------------------------------------------------------------- |
| Private Chat | user id + project id           | 60 request / hour、300 request / day | project member 向け。raw / parsed 取得はサイズ上限と監査ログを必須にする          |
| Public Chat  | 信頼済み client IP + report id |  10 request / hour、50 request / day | 公開 report 限定。複数 report への横断アクセスも信頼済み client IP 単位で制限する |

```typescript
server: {
  middleware: [{
    path: "/api/agents/project-chat-agent/*",
    handler: rateLimiter({
      windowMs: 60 * 60_000,
      limit: 60,
      keyGenerator: (c) => `${c.req.header("x-user-id") ?? "_"}:${c.req.header("x-project-id") ?? "_"}`,
    }),
  }, {
    path: "/api/agents/public-report-chat-agent/*",
    handler: rateLimiter({
      windowMs: 60 * 60_000,
      limit: 10,
      keyGenerator: (c) => `${c.req.header("x-report-id") ?? "_"}:${c.req.header("x-client-ip") ?? "unknown"}`,
    }),
  }],
}
```

Mastra Server は private Cloud Run とし、rate limit 用の `x-user-id`、`x-project-id`、`x-report-id`、`x-client-ip` は OIDC 検証済みの Next.js から来た内部 header だけを信頼する。ブラウザから直接送られた同名 header は Next.js で破棄し、信頼済み proxy 情報から client IP を解決して付与する。

---
