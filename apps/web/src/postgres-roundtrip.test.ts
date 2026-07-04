import assert from 'node:assert/strict';
import postgres from 'postgres';
import { createPostgresChatRepository } from './chat.ts';
import { CUSTOM_REPORT_LAYOUT_SCHEMA_VERSION } from './custom-report-schema.ts';
import { createPostgresReportRepository } from './report-repository.ts';
import type { PrivateReportJsonV1 } from './report-schema.ts';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for postgres round-trip tests.');
}

const sql = postgres(databaseUrl, { max: 1 });

const projectId = '10000000-0000-0000-0000-000000000433';
const userId = '10000000-0000-0000-0000-000000000434';
const reportId = '10000000-0000-0000-0000-000000000435';
const templateId = '10000000-0000-0000-0000-000000000436';
const chatUserId = '10000000-0000-0000-0000-000000000437';

try {
  await resetFixtureRows();
  await seedProjectFixture();
  await assertPrivateChatJsonbRoundTrip();
  await assertReportJsonbRoundTrip();
  console.log('web postgres round-trip tests passed');
} finally {
  await resetFixtureRows();
  await sql.end();
}

async function resetFixtureRows() {
  await sql`DELETE FROM public.users WHERE id IN (${userId}, ${chatUserId})`;
  await sql`DELETE FROM public.projects WHERE id = ${projectId}`;
}

async function seedProjectFixture() {
  await sql`
    INSERT INTO public.users (id, email, name, role)
    VALUES
      (${userId}, 'issue-433-owner@example.test', 'Issue 433 Owner', 'admin'),
      (${chatUserId}, 'issue-433-chat@example.test', 'Issue 433 Chat User', 'member')
  `;
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES (
      ${projectId},
      'issue-433-roundtrip',
      'Issue 433 Round Trip',
      'graph_issue_433_roundtrip',
      'issue-433-roundtrip',
      'private'
    )
  `;
  await sql`
    INSERT INTO public.project_members (project_id, user_id, role)
    VALUES
      (${projectId}, ${userId}, 'admin'),
      (${projectId}, ${chatUserId}, 'member')
  `;
}

async function assertPrivateChatJsonbRoundTrip() {
  const repository = createPostgresChatRepository(sql);
  const saved = await repository.savePrivateChatTurn({
    answer: '実 DB への保存結果です。',
    editing: {
      caveats: ['fixture caveat'],
      confidence: 'medium',
      inferredMode: 'summary',
      operations: ['summarize'],
      questionType: 'status',
    },
    projectId,
    question: 'JSONB は文字列化されませんか。',
    sources: [
      {
        canonicalUri: 'https://example.test/docs/issue-433',
        documentId: 'document-433',
        docType: 'web_page',
        rawDocumentId: 'raw-document-433',
        snippet: 'round-trip fixture',
        title: 'Issue 433 Source',
      },
    ],
    toolCalls: [{ name: 'vector-search', resultCount: 1 }],
    userId: chatUserId,
  });

  const rows = (await sql`
    SELECT
      jsonb_typeof(sources) AS sources_type,
      jsonb_typeof(tool_calls) AS tool_calls_type,
      jsonb_typeof(editing) AS editing_type,
      sources #>> '{0,documentId}' AS first_document_id,
      tool_calls #>> '{0,name}' AS first_tool_name,
      editing ->> 'confidence' AS editing_confidence
    FROM public.private_chat_messages
    WHERE id = ${saved.id}
  `) as readonly unknown[];
  const row = singleRow(rows);

  assert.equal(row.sources_type, 'array');
  assert.equal(row.tool_calls_type, 'array');
  assert.equal(row.editing_type, 'object');
  assert.equal(row.first_document_id, 'document-433');
  assert.equal(row.first_tool_name, 'vector-search');
  assert.equal(row.editing_confidence, 'medium');
}

async function assertReportJsonbRoundTrip() {
  const repository = createPostgresReportRepository(sql);
  const layoutSnapshot = {
    root: { id: 'title', text: 'Issue 433', type: 'title' },
    schema_version: CUSTOM_REPORT_LAYOUT_SCHEMA_VERSION,
  } as const;
  const report: PrivateReportJsonV1 = {
    generated_at: '2026-07-04T00:00:00.000Z',
    period: { end: '2026-07-04', start: '2026-06-29' },
    project_id: projectId,
    report_id: reportId,
    schema_version: 'v1',
    sections: [
      {
        id: 'activity',
        markdown: 'JSONB round-trip fixture',
        title: 'Activity',
      },
    ],
    summary: 'Round-trip summary',
    title: 'Round-trip Report',
  };

  await sql`
    INSERT INTO public.custom_report_templates (
      id,
      project_id,
      name,
      layout,
      created_by_user_id,
      updated_by_user_id
    )
    VALUES (
      ${templateId},
      ${projectId},
      'Issue 433 Template',
      ${sql.json(layoutSnapshot)}::jsonb,
      ${userId},
      ${userId}
    )
  `;

  await repository.insertReport({
    chunks: [
      {
        chunkIndex: 0,
        content: 'JSONB metadata fixture',
        embedding: Array(1536).fill(0),
        metadata: { nested: { ok: true }, tags: ['issue-433'] },
      },
    ],
    customTemplateRun: {
      judgementSummary: { score: 0.9, tags: ['round-trip'] },
      layoutSnapshot,
      templateId,
      templateSnapshotHash: 'sha256:issue-433',
      templateVersion: 1,
    },
    generatedBy: 'postgres-roundtrip.test',
    projectId,
    report,
    storageUri: 'issue-433-roundtrip/reports/private/report.json',
  });

  const rows = (await sql`
    SELECT
      jsonb_typeof(rc.metadata) AS chunk_metadata_type,
      rc.metadata #>> '{nested,ok}' AS chunk_nested_ok,
      jsonb_typeof(rtr.layout_snapshot) AS layout_snapshot_type,
      rtr.layout_snapshot #>> '{root,type}' AS layout_root_type,
      jsonb_typeof(rtr.judgement_summary) AS judgement_summary_type,
      rtr.judgement_summary #>> '{tags,0}' AS judgement_first_tag
    FROM public.report_chunks rc
    JOIN public.report_template_runs rtr
      ON rtr.project_id = rc.project_id
     AND rtr.report_id = rc.report_id
    WHERE rc.project_id = ${projectId}
      AND rc.report_id = ${reportId}
  `) as readonly unknown[];
  const row = singleRow(rows);

  assert.equal(row.chunk_metadata_type, 'object');
  assert.equal(row.chunk_nested_ok, 'true');
  assert.equal(row.layout_snapshot_type, 'object');
  assert.equal(row.layout_root_type, 'title');
  assert.equal(row.judgement_summary_type, 'object');
  assert.equal(row.judgement_first_tag, 'round-trip');
}

function singleRow(rows: readonly unknown[]): Record<string, unknown> {
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row && typeof row === 'object' && !Array.isArray(row));
  return row as Record<string, unknown>;
}
