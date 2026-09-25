import type postgres from 'postgres';
import {
  createPostgresReportRepository,
  createReportStorageFromEnv,
  type PrivateReportJsonV1,
  publishPublicReport,
  validatePrivateReportJson,
} from '../../apps/web/src/report.ts';
import { liveChatDocuments } from './live-chat-corpus.ts';

/**
 * Adds local public-report artifacts after the loopback-only live seed has populated documents.
 * The caller must enforce the disposable DB and explicit local storage guards before invoking.
 */
export async function seedLivePublicChat(sql: postgres.Sql, projectId: string): Promise<void> {
  const members =
    await sql`SELECT user_id::text FROM project_members WHERE project_id = ${projectId} LIMIT 1`;
  const userId: unknown = members[0]?.user_id;
  if (typeof userId !== 'string') throw new Error('Missing evaluation member.');
  const sources: NonNullable<PrivateReportJsonV1['sections'][number]['sources']>[number][] = [];
  for (const doc of liveChatDocuments) {
    const rows =
      await sql`SELECT id::text FROM documents WHERE project_id = ${projectId} AND logical_source_id = ${doc.key}`;
    const documentId: unknown = rows[0]?.id;
    if (typeof documentId !== 'string') throw new Error(`Missing synthetic document: ${doc.key}`);
    sources.push({
      canonical_uri: `https://example.test/${doc.key}`,
      doc_type: 'web_page',
      document_id: documentId,
      snippet: doc.content,
      title: doc.title,
    });
  }
  const storage = createReportStorageFromEnv();
  await sql`UPDATE projects SET visibility = 'public' WHERE id = ${projectId} OR slug = 'chat-e2e-empty'`;
  for (const [reportId, publish] of [
    ['11111111-1111-4111-8111-111111111111', true],
    ['22222222-2222-4222-8222-222222222222', false],
  ] as const) {
    const report: PrivateReportJsonV1 = {
      schema_version: 'v1',
      report_id: reportId,
      project_id: projectId,
      title: '実Chat評価用の合成公開レポート',
      summary: '実在の個人・業務情報を含まない検証専用レポートです。',
      generated_at: '2026-08-07T00:00:00.000Z',
      period: { start: '2026-08-01', end: '2026-08-07' },
      sections: [{ id: 'progress', title: '合成資料', markdown: '合成資料の一覧です。', sources }],
    };
    validatePrivateReportJson(report);
    const storageUri = `local-dev/reports/private/${reportId}.json`;
    await storage.put(storageUri, JSON.stringify(report), { contentType: 'application/json' });
    await sql`INSERT INTO reports (id,project_id,title,summary,storage_uri,period)
      VALUES (${reportId},${projectId},${report.title},${report.summary},${storageUri},
        daterange(${report.period.start}::date,${report.period.end}::date,'[]'))`;
    if (publish) {
      await publishPublicReport({
        projectSlug: 'local-dev',
        reportId,
        userId,
        now: new Date('2026-08-07T00:00:00.000Z'),
        options: { repository: createPostgresReportRepository(sql), storage },
      });
    }
  }
}
