# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## レポート生成

Report API、Public Report API、signed URL の共通契約は [API デザイン](05-api-design.md) も参照する。

### 1. 出力フォーマット

レポートは **JSON ファイル** として生成し、Object Storage に保存する。Web からは `/api/projects/[projectSlug]/reports/[reportId]` API 経由で JSON を取得し、Next.js 側で描画する（HTML レンダリングはフロント側責務）。

PostgreSQL は業務時間のみ起動するため、業務時間外でも閲覧可能にするのは公開済みレポートだけに限定する。public report は private report JSON をそのまま公開せず、公開時に redaction 済みの public report JSON、公開用 manifest / metadata、public chat 用 context bundle を Object Storage 側へ別 artifact として保存する。public report は DB 稼働確認に依存せず JSON を取得できるようにする。private report は project member 認可のため DB 依存 API として扱い、業務時間外はチャットと同様に利用不可にする。

Private report JSON スキーマ（`schema_version: "v1"`）：

```jsonc
{
  "schema_version": "v1",
  "report_id": "...",
  "project_id": "...",
  "title": "週次レポート 2026-05-25 〜 2026-05-31",
  "period": { "start": "2026-05-25", "end": "2026-05-31" },
  "generated_at": "2026-05-31T17:00:00+09:00",
  "summary": "今週の概要...",
  "pufu_sources": [
    {
      "document_id": "...",
      "doc_type": "web_page",
      "title": "データソースのタイトル",
      "canonical_uri": "...",
      "occurred_at": "2026-05-31T00:00:00.000Z",
      "snippet": "プ譜生成で参照する短い要約..."
    }
  ],
  "sections": [
    {
      "id": "activity",
      "title": "概況",
      "markdown": "対象期間に確認できた活動の種類を短い文章で要約する。参照資料や source 一覧は含めない。"
    },
    {
      "id": "progress",
      "title": "進行状況",
      "markdown": "- 実施した作業や確認できた活動内容を箇条書きで列挙する",
      "sources": [
        {
          "document_id": "...",
          "doc_type": "web_page",
          "title": "データソースのタイトル",
          "canonical_uri": "https://example.com/article",
          "snippet": "..."
        }
      ]
    },
    {
      "id": "risks",
      "title": "課題・次のアクション",
      "markdown": "- ブロッカーや不確実性、次に取るべきアクションを箇条書きで示す"
    }
  ]
}
```

プ譜ビューは `sections.markdown` の本文をそのまま流し込まず、private report に保存した `pufu_sources`（生成時に参照した data source の title / snippet / doc_type / canonical_uri）を第一入力にして ProjectScoreModel を組み立てる。過去 artifact など `pufu_sources` がない private report では、`sections[].sources` または activity section の source 行を後方互換の入力として扱う。public report でもログイン済みの private report と同じプ譜を描画できるよう、公開可能な title / snippet だけを redaction 済み `pufu_sources` として保存し、内部 `document_id` や `canonical_uri` は公開しない。

Public report JSON は private report JSON から公開可能な情報だけを抽出した別 schema とする。内部 `project_id`、`document_id`、raw / parsed の URI、社内 URL、メールアドレス、個人情報を含む可能性のある未加工 snippet は含めない。根拠は `section_id` と `public_source_id` だけで示し、プ譜用の redaction 済み snippet は public pufu source として分離する。

```jsonc
{
  "schema_version": "public-v1",
  "report_id": "...",
  "title": "週次レポート 2026-05-25 〜 2026-05-31",
  "period": { "start": "2026-05-25", "end": "2026-05-31" },
  "published_at": "2026-05-31T18:00:00+09:00",
  "summary": "公開可能な概要...",
  "pufu_sources": [
    {
      "public_source_id": "pufu_src_001",
      "label": "web page #1",
      "title": "公開可能なデータソースのタイトル",
      "occurred_at": "2026-05-31T00:00:00.000Z",
      "snippet": "プ譜生成で参照する redaction 済み短い要約..."
    }
  ],
  "sections": [
    {
      "id": "activity",
      "title": "アクティビティ",
      "markdown": "...",
      "sources": [
        {
          "public_source_id": "src_001",
          "label": "web page #1"
        }
      ]
    }
  ]
}
```

### 2. ワークフロー

```typescript
const generateReportWorkflow = createWorkflow({
  id: 'generate-report',
  inputSchema: z.object({
    projectId: z.string().uuid(),
    period: z.enum(['weekly', 'monthly']).default('weekly'),
    since: z.string().optional()
  }),
  execute: async ({ inputData, mastra }) => {
    const project = await loadProject(inputData.projectId);
    const storage = StorageFactory.fromEnv();
    const agent = mastra.getAgent('chat-agent');
    const { periodStart, periodEnd } = resolveReportPeriod(inputData);

    const [activity, progress, risks] = await Promise.all([
      agent.generate({
        prompt: `${inputData.since} 以降のアクティビティサマリーを生成`,
        context: { projectId: project.id }
      }),
      agent.generate({
        prompt: '進行状況と参照資料を整理',
        context: { projectId: project.id }
      }),
      agent.generate({
        prompt: '課題と次のアクションを整理',
        context: { projectId: project.id }
      })
    ]);

    const reportId = crypto.randomUUID();
    const json = buildReportJson({
      reportId,
      project,
      periodStart,
      periodEnd,
      sections: [activity, progress, risks]
    });

    const storageUri = `${storage.uriForProject(project.slug)}/reports/${reportId}.json`;
    await storage.put(storageUri, Buffer.from(JSON.stringify(json), 'utf-8'), {
      contentType: 'application/json; charset=utf-8',
      cacheControl: 'private, max-age=3600'
    });

    await db.query('BEGIN');
    await db.query(
      `
      INSERT INTO reports (id, project_id, title, summary, storage_uri, schema_version, period, is_public, generated_by)
      VALUES ($1, $2, $3, $4, $5, 'v1', $6, false, $7)
    `,
      [
        reportId,
        project.id,
        json.title,
        json.summary,
        storageUri,
        `[${periodStart}, ${periodEnd}]`,
        'generate-report-job'
      ]
    );
    const reportChunks = await chunkAndEmbedReport(json);
    await insertReportChunks(project.id, reportId, reportChunks);
    await db.query('COMMIT');

    const reportUrl = `${process.env.FRONTEND_URL}/projects/${project.slug}/reports/${reportId}`;
    await slackAgent.generate(`レポートが生成されました: ${reportUrl}`);

    return { reportId, reportUrl };
  }
});
```

### 3. 配信方針

| 配置                                   | 配置先                               | 理由                                                                      |
| -------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| レポート本体 JSON                      | Object Storage（local volume / GCS） | 大きな本文をリレーショナル DB に置かない                                  |
| Public report JSON                     | Object Storage（local volume / GCS） | private report JSON を直接公開せず、公開可能な情報だけを配信する          |
| 公開レポート閲覧用 metadata / manifest | Object Storage（local volume / GCS） | DB 停止中でも公開済みレポートを表示する                                   |
| Public Chat 用 context bundle          | Object Storage（local volume / GCS） | public chat が DB / raw / parsed に触れず、公開許可済み情報だけで回答する |
| メタデータ・要約                       | PostgreSQL `reports`                 | 業務時間内の private report 一覧、全文検索、管理操作                      |
| 検索用埋め込み                         | pgvector `report_chunks`             | 過去レポートの意味検索                                                    |

Web は以下のエンドポイントで JSON を取得する：

- `GET /api/projects/[projectSlug]/reports` → private report を含む project member 向け一覧（DB 依存。業務時間外は `db_outside_business_hours`）
- `GET /api/projects/[projectSlug]/reports/[reportId]` → private report JSON 本体（DB で project member 認可後、Object Storage から取得。業務時間外は `db_outside_business_hours`）
- `GET /api/projects/[projectSlug]/reports/[reportId]/signed-url` → private report 向けに短時間 signed URL を発行（DB 依存。オプション）
- `GET /api/public/reports/[reportId]` → redaction 済み public report JSON 本体（公開用 manifest / metadata で公開可否を判定し、業務時間外でも Object Storage から取得）
- `POST /api/public/reports/[reportId]/chat` → redaction 済み public report と public context bundle だけを使う public chat（DB 非依存、厳しめの rate limit）

report 生成時は既定で private report として `<project_slug>/reports/private/<report_id>.json` に保存する。project admin が `is_public=false` から `true` に変更したとき、公開用 redaction を実行し、public report JSON、公開用 manifest / metadata、public chat 用 context bundle を作成・更新する。`true` から `false` に戻したときは、公開用 manifest / metadata と public artifact を削除または無効化し、Public Report API / Public Chat API は同じ `404` を返す。

公開用 manifest は `<project_slug>/reports/public/<report_id>/manifest.json` の固定パスに保存する。manifest は `report_id`、`schema_version`、`project_slug`、`public_report_uri`、`public_context_bundle_uri`、`published_at`、`revoked_at`、`etag`、`artifact_version` を持つ。manifest は未公開化の反映を優先して `Cache-Control: no-store` または短い TTL にし、public report JSON と context bundle は `<project_slug>/reports/public/<report_id>/<artifact_version>/...` の versioned URI に保存する。Next.js は manifest に載った URI だけを server side で解決し、ブラウザや LLM から渡された URI は使わない。

Public API は DB 停止中でも `reportId` を解決できる必要があるため、公開ページの正規 URL は `/reports/public/[projectSlug]/[reportId]` とする。Next.js は URL の `projectSlug` から `<project_slug>/reports/public/<report_id>/manifest.json` を読み、manifest 不在、`revoked_at` 設定済み、許可 prefix 外 URI、etag / artifact version 不一致はいずれも同じ `404` とする。

Next.js のページ `app/projects/[projectSlug]/reports/[reportId]/page.tsx` はクライアント or サーバーから JSON を取得し、`schema_version` に従ってレンダリングする。

---
