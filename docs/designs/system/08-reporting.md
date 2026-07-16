# プロジェクトエディターエージェント - Pufu Lens - システムデザイン

## レポート生成

Report API、Public Report API、signed URL の共通契約は [API デザイン](05-api-design.md) も参照する。

### 1. 出力フォーマット

レポートは **JSON ファイル** として生成し、Object Storage に保存する。Web からは `/api/projects/[projectSlug]/reports/[reportId]` API 経由で JSON を取得し、Next.js 側で描画する（HTML レンダリングはフロント側責務）。

PostgreSQL は常時稼働させ、DB 依存の report / chat 入口に時刻による利用制限を設けない。public report / public chat も表示・回答生成の処理は private report / private chat と同じ経路を使い、違いはアクセス権だけに限定する。public 入口は `projects.visibility = 'public'` かつ `reports.is_public = true` のときだけ未ログインで許可し、private project では public report / public chat のいずれも許可しない。

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

プ譜ビューは `sections.markdown` の本文をそのまま流し込まず、private report に保存した `pufu_sources`（生成時に参照した data source の title / snippet / doc_type / canonical_uri）を第一入力にして ProjectScoreModel を組み立てる。過去 artifact など `pufu_sources` がない private report では、`sections[].sources` または activity section の source 行を後方互換の入力として扱う。public report でも同じ private report JSON を描画するため、プ譜表示結果は member 向け report と一致する。

Public report JSON / context bundle は公開 artifact 互換や検証用途として生成できるが、現行の public report 表示と public chat の実行経路では private report / private chat の処理を使う。公開可否の判定は DB の project visibility と report `is_public` metadata を正とする。

#### Raw 補完を伴う private report 生成と public 公開

Private report 生成では、まず parsed / graph / vector から context bundle を組み立て、根拠確認や文脈補完が必要な場合のみ [Agent Raw Read View](07-chat.md#agent-raw-read-view--raw-document-fetch-契約) の `sections` を **補助 evidence** として provider context に追加する。

| フェーズ             | raw read view の扱い                                                                   |
| -------------------- | -------------------------------------------------------------------------------------- |
| Private 生成         | 利用可。bounded section を根拠補完に使う                                               |
| Private JSON 保存    | `rawDocumentId`、private raw locator、内部 storage URI、raw/parsed URI は **含めない** |
| Public 公開          | raw 補完あり生成でも **公開可能**。表示処理は private report と同じ                    |
| Public artifact 保存 | 互換・検証用に redaction / policy validation 済み artifact を保存可能                  |

#### 参照ドキュメントが多い場合の編集素材化

Private report 生成は、対象期間の document を新しい順に最大 200 件まで候補として読み出す。候補が 30 件以下の場合は従来どおり全件を provider の直接根拠として使う。30 件を超える場合は、候補全件を title / summary の明示的なキーワード規則で次の編集テーマに分類し、各 document ID、doc type、発生日時、短い本文を持つ bounded な編集素材を組み立てる。

- 判断・決定
- 課題・リスク
- 進捗・成果
- 背景・文脈

provider へ直接渡す代表 document は最大 30 件とする。代表選定は新しさだけに寄せず、各編集テーマ、doc type、最古の dated document を時系列 anchor として先に確保し、残りを編集テーマから round-robin で選ぶ。これにより、31 件目以降も編集素材として Gemini / extractive provider の全体文脈と件数に参加させながら、直接根拠、`pufu_sources`、raw read の件数を bounded に保つ。編集素材は編集テーマごとに最大 40 件まで markdown 化し、provider プロンプトの token 増大を抑える。

Raw Read View の取得対象は代表 document だけとし、候補 200 件すべてを raw 補完しない。編集素材には `rawDocumentId`、private raw locator、storage URI を含めず、private report JSON に保存する `pufu_sources` も代表 document だけから組み立てる。候補上限 200 件を超えた古い document はその生成回の対象外とし、必要なら report period を分割して生成する。

public project の report を raw 補完付きで生成しても公開できる。互換・検証用 public artifact に保存できるのは次に限定する。

- redaction / policy validation 済み summary と section markdown
- 公開可能な `public_source_id` / label / title / occurred_at / redaction 済み snippet

public artifact に **含めてはならない** もの:

- private raw locator、`rawDocumentId`、内部 storage URI、raw URI、parsed URI
- 未公開の raw excerpt（raw read view section text の生引用）
- OAuth token、secret、メールアドレス等の PII

private report detail と public report detail は同じ private report JSON を描画する。public 入口に出すかどうかは project visibility と report `is_public` metadata で制御する。

raw 補完あり report の regression では、private report / public artifact の両方で `rawDocumentId`、storage URI、private locator、token、secret、API key、メールアドレスが保存されていないことを確認する。Mastra workflow trace / log では raw 補完の有無を `raw-document-fetch.trace` と report workflow の成功 / 失敗 status で確認し、raw section text を trace-safe summary として保存しない。

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

| 配置                                   | 配置先                                                                | 理由                                                      |
| -------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| レポート本体 JSON                      | Object Storage（local volume / GCS）                                  | 大きな本文をリレーショナル DB に置かない                  |
| Public report JSON                     | Object Storage（local volume / GCS）                                  | 旧互換・検証用の redaction 済み artifact                  |
| 公開レポート閲覧用 metadata / manifest | Object Storage（local volume / GCS）                                  | 旧互換・検証用の公開 artifact metadata                    |
| Public Chat 用 context bundle          | Object Storage（local volume / GCS）                                  | 旧互換・検証用の public context artifact                  |
| メタデータ・要約                       | PostgreSQL `reports`                                                  | private report 一覧、全文検索、管理操作                   |
| 定期実行設定・period 履歴              | PostgreSQL `project_report_schedules` / `report_schedule_period_runs` | report が生成されない skipped period を含む実行履歴の正本 |
| 検索用埋め込み                         | pgvector `report_chunks`                                              | 過去レポートの意味検索                                    |

`reports.generation_kind` は `manual` / `scheduled` / `scheduled_backfill` を区別する。定期生成では `schedule_frequency`、同じ project の `previous_scheduled_report_id`、一意な `schedule_period_run_id` を保持し、手動生成ではこれらを `NULL` にする。`report_schedule_period_runs` は report の有無にかかわらず period 履歴の正本であり、`reports` metadata だけで retry・skip・通知状態を代用しない。Step 1 では schema、runtime guard、project-scoped repository までを実装し、期間列挙、差分生成、dispatcher、UI は後続 Step で追加する。

Web は以下のエンドポイントで JSON を取得する：

- `GET /api/projects/[projectSlug]/reports` → private report を含む project member 向け一覧（DB 依存）
- `GET /api/projects/[projectSlug]/reports/[reportId]` → private report JSON 本体（DB で project member 認可後、Object Storage から取得）
- `GET /api/projects/[projectSlug]/reports/[reportId]/signed-url` → private report 向けに短時間 signed URL を発行（DB 依存。オプション）
- `GET /api/public/projects/[projectSlug]/reports/[reportId]` → public project かつ公開済み report の private report JSON 本体（DB で公開可否を判定）
- `POST /api/public/projects/[projectSlug]/reports/[reportId]/chat` → public project かつ公開済み report を確認したうえで private chat と同じ project chat agent を使う public chat（DB 依存、厳しめの rate limit）
- `GET /api/public/reports/[reportId]` / `POST /api/public/reports/[reportId]/chat` → 旧互換 alias。`projectSlug` を解決できない場合は `404` とし、正規入口は project-scoped path とする

report 生成時は既定で private report として `<project_slug>/reports/private/<report_id>.json` に保存する。project admin が `is_public=false` から `true` に変更したときも、現行の Public Report API / Public Chat API は DB metadata で公開可否を確認し、private report JSON と private chat と同じ project chat agent を使う。private / public の処理差分はアクセス権判定だけにし、private project または未公開 report は Public Report API / Public Chat API の両方で同じ `404` を返す。`true` から `false` に戻したときも DB metadata を正として即時に非公開化する。

旧互換の公開用 manifest は `<project_slug>/reports/public/<report_id>/manifest.json` の固定パスに保存する。manifest は `report_id`、`schema_version`、`project_slug`、`public_report_uri`、`public_context_bundle_uri`、`published_at`、`revoked_at`、`etag`、`artifact_version` を持つ。manifest は未公開化の反映を優先して `Cache-Control: no-store` または短い TTL にし、public report JSON と context bundle は `<project_slug>/reports/public/<report_id>/<artifact_version>/...` の versioned URI に保存する。ただし現行の Next.js public 表示・chat は manifest / public artifact を正とせず、DB metadata と private report JSON を使う。

公開ページの正規 URL は `/reports/public/[projectSlug]/[reportId]` とする。Next.js は URL の `projectSlug` と `reportId` を正規キーとして扱い、DB 上の project visibility / report `is_public` を確認して同じ access / 404 contract を適用する。公開用 manifest / artifact は互換・検証用であり、現行の表示可否判定の正は DB metadata とする。

Next.js のページ `app/projects/[projectSlug]/reports/[reportId]/page.tsx` はクライアント or サーバーから JSON を取得し、`schema_version` に従ってレンダリングする。

---
