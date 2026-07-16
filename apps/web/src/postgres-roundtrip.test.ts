import assert from 'node:assert/strict';
import postgres from 'postgres';
import { createPostgresChatRepository } from './chat.ts';
import { CUSTOM_REPORT_LAYOUT_SCHEMA_VERSION } from './custom-report-schema.ts';
import { createPostgresReportRepository } from './report-repository.ts';
import {
  hasScheduledReportForFrequency,
  readPreviousScheduledReport,
  readProjectReportAvailableFrom,
} from './report-schedule-planning.ts';
import {
  listReportSchedulePeriodRuns,
  readOldestIncompleteReportSchedulePeriodRun,
  readProjectReportSchedule,
  readReportSchedulePeriodRun,
} from './report-schedules.ts';
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
const scheduleId = '10000000-0000-0000-0000-000000000438';
const skippedPeriodRunId = '10000000-0000-0000-0000-000000000439';
const generatedPeriodRunId = '10000000-0000-0000-0000-000000000440';
const scheduledReportId = '10000000-0000-0000-0000-000000000441';
const crossProjectId = '10000000-0000-0000-0000-000000000442';
const crossProjectReportId = '10000000-0000-0000-0000-000000000443';
const crossBoundaryPeriodRunId = '10000000-0000-0000-0000-000000000444';
const frequencyMismatchReportId = '10000000-0000-0000-0000-000000000445';
const monthlyPeriodRunId = '10000000-0000-0000-0000-000000000446';
const previousFrequencyMismatchReportId = '10000000-0000-0000-0000-000000000447';

await main();

async function main() {
  try {
    await resetFixtureRows();
    await seedProjectFixture();
    await assertPrivateChatJsonbRoundTrip();
    await assertReportJsonbRoundTrip();
    await assertReportScheduleRoundTrip();
    console.log('web postgres round-trip tests passed');
  } finally {
    try {
      await resetFixtureRows();
    } finally {
      await sql.end();
    }
  }
}

async function resetFixtureRows() {
  await sql`DELETE FROM public.private_chat_messages WHERE project_id = ${projectId} OR user_id IN (${userId}, ${chatUserId})`;
  await sql`DELETE FROM public.report_template_runs WHERE project_id = ${projectId} OR report_id = ${reportId}`;
  await sql`DELETE FROM public.report_chunks WHERE project_id = ${projectId} OR report_id = ${reportId}`;
  await sql`
    UPDATE public.report_schedule_period_runs
    SET status = 'pending', report_id = NULL, completed_at = NULL
    WHERE project_id IN (${projectId}, ${crossProjectId})
      AND report_id IS NOT NULL
  `;
  await sql`DELETE FROM public.reports WHERE project_id IN (${projectId}, ${crossProjectId}) OR id IN (${reportId}, ${scheduledReportId}, ${crossProjectReportId})`;
  await sql`DELETE FROM public.report_schedule_period_runs WHERE project_id IN (${projectId}, ${crossProjectId})`;
  await sql`DELETE FROM public.project_report_schedules WHERE project_id IN (${projectId}, ${crossProjectId})`;
  await sql`DELETE FROM public.project_members WHERE project_id = ${projectId} OR user_id IN (${userId}, ${chatUserId})`;
  await sql`DELETE FROM public.custom_report_templates WHERE project_id = ${projectId} OR id = ${templateId}`;
  await sql`DELETE FROM public.projects WHERE id IN (${projectId}, ${crossProjectId})`;
  await sql`DELETE FROM public.users WHERE id IN (${userId}, ${chatUserId})`;
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
    VALUES
      (
        ${projectId},
        'issue-433-roundtrip',
        'Issue 433 Round Trip',
        'graph_issue_433_roundtrip',
        'issue-433-roundtrip',
        'private'
      ),
      (
        ${crossProjectId},
        'issue-579-cross-project',
        'Issue 579 Cross Project',
        'graph_issue_579_cross_project',
        'issue-579-cross-project',
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

  assert.equal(stringField(row, 'sources_type'), 'array');
  assert.equal(stringField(row, 'tool_calls_type'), 'array');
  assert.equal(stringField(row, 'editing_type'), 'object');
  assert.equal(stringField(row, 'first_document_id'), 'document-433');
  assert.equal(stringField(row, 'first_tool_name'), 'vector-search');
  assert.equal(stringField(row, 'editing_confidence'), 'medium');
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

  assert.equal(stringField(row, 'chunk_metadata_type'), 'object');
  assert.equal(stringField(row, 'chunk_nested_ok'), 'true');
  assert.equal(stringField(row, 'layout_snapshot_type'), 'object');
  assert.equal(stringField(row, 'layout_root_type'), 'title');
  assert.equal(stringField(row, 'judgement_summary_type'), 'object');
  assert.equal(stringField(row, 'judgement_first_tag'), 'round-trip');

  const metadata = await repository.readReportMetadata({ projectId, reportId });
  assert.equal(metadata?.generationKind, 'manual');
  assert.equal(metadata?.scheduleFrequency, null);
  assert.equal(metadata?.schedulePeriodRunId, null);
}

async function assertReportScheduleRoundTrip() {
  await sql`
    INSERT INTO public.project_report_schedules (
      id, project_id, frequency, next_run_at, created_by, updated_by
    )
    VALUES (
      ${scheduleId}, ${projectId}, 'weekly', '2026-07-20T01:00:00Z', ${userId}, ${userId}
    )
  `;

  const schedule = await readProjectReportSchedule(sql, { projectId });
  assert.equal(schedule?.id, scheduleId);
  assert.equal(schedule?.frequency, 'weekly');
  assert.equal(schedule?.nextRunAt, '2026-07-20T01:00:00.000Z');

  await sql`
    INSERT INTO public.report_schedule_period_runs (
      id, schedule_id, project_id, frequency, period_start, period_end,
      run_kind, status, skip_reason, completed_at
    )
    VALUES (
      ${skippedPeriodRunId}, ${scheduleId}, ${projectId}, 'weekly',
      '2026-06-29', '2026-07-05', 'scheduled_backfill', 'skipped',
      'no_documents', '2026-07-06T01:00:00Z'
    )
  `;

  const skipped = await readReportSchedulePeriodRun(sql, {
    periodRunId: skippedPeriodRunId,
    projectId,
  });
  assert.equal(skipped?.status, 'skipped');
  assert.equal(skipped?.reportId, null);
  assert.equal(skipped?.skipReason, 'no_documents');
  assert.equal(
    await readReportSchedulePeriodRun(sql, {
      periodRunId: skippedPeriodRunId,
      projectId: crossProjectId,
    }),
    null,
  );

  const runs = await listReportSchedulePeriodRuns(sql, {
    limit: 10,
    projectId,
    scheduleId,
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.id, skippedPeriodRunId);

  await assert.rejects(
    () => sql`
      INSERT INTO public.report_schedule_period_runs (
        schedule_id, project_id, frequency, period_start, period_end, run_kind, status
      )
      VALUES (
        ${scheduleId}, ${projectId}, 'yearly', '2025-01-01', '2025-12-31',
        'scheduled', 'pending'
      )
    `,
    databaseErrorCode('23514'),
  );

  await sql`
    INSERT INTO public.report_schedule_period_runs (
      id, schedule_id, project_id, frequency, period_start, period_end, run_kind, status
    )
    VALUES (
      ${generatedPeriodRunId}, ${scheduleId}, ${projectId}, 'weekly',
      '2026-07-06', '2026-07-12', 'scheduled', 'pending'
    )
  `;

  const repository = createPostgresReportRepository(sql);
  const scheduledReport: PrivateReportJsonV1 = {
    generated_at: '2026-07-13T01:00:00.000Z',
    period: { end: '2026-07-12', start: '2026-07-06' },
    project_id: projectId,
    report_id: scheduledReportId,
    schema_version: 'v1',
    sections: [],
    summary: 'Scheduled round-trip summary',
    title: 'Scheduled Round-trip Report',
  };
  await repository.insertReport({
    chunks: [],
    generatedBy: 'postgres-roundtrip.test',
    generationMetadata: {
      generationKind: 'scheduled',
      scheduleFrequency: 'weekly',
      schedulePeriodRunId: generatedPeriodRunId,
    },
    projectId,
    report: scheduledReport,
    storageUri: 'issue-579/reports/private/scheduled.json',
  });
  await assert.rejects(
    () => sql`
      UPDATE public.report_schedule_period_runs
      SET status = 'succeeded'
      WHERE id = ${generatedPeriodRunId} AND project_id = ${projectId}
    `,
    databaseErrorCode('23514'),
  );
  await sql`
    UPDATE public.report_schedule_period_runs
    SET status = 'succeeded', report_id = ${scheduledReportId}, completed_at = now()
    WHERE id = ${generatedPeriodRunId} AND project_id = ${projectId}
  `;

  const metadata = await repository.readReportMetadata({ projectId, reportId: scheduledReportId });
  assert.equal(metadata?.generationKind, 'scheduled');
  assert.equal(metadata?.scheduleFrequency, 'weekly');
  assert.equal(metadata?.schedulePeriodRunId, generatedPeriodRunId);
  assert.equal(await hasScheduledReportForFrequency(sql, { frequency: 'weekly', projectId }), true);
  assert.equal(
    await hasScheduledReportForFrequency(sql, { frequency: 'monthly', projectId }),
    false,
  );
  assert.equal(
    await hasScheduledReportForFrequency(sql, {
      frequency: 'weekly',
      projectId: crossProjectId,
    }),
    false,
  );
  assert.deepEqual(
    await readPreviousScheduledReport(sql, {
      beforePeriodStart: '2026-07-13',
      frequency: 'weekly',
      projectId,
    }),
    {
      id: scheduledReportId,
      periodEnd: '2026-07-12',
      periodStart: '2026-07-06',
      storageUri: 'issue-579/reports/private/scheduled.json',
    },
  );
  assert.equal(
    await readPreviousScheduledReport(sql, {
      beforePeriodStart: '2026-07-06',
      frequency: 'weekly',
      projectId,
    }),
    null,
  );
  assert.equal(
    await readPreviousScheduledReport(sql, {
      beforePeriodStart: '2026-08-01',
      frequency: 'monthly',
      projectId,
    }),
    null,
  );
  assert.equal(
    await readPreviousScheduledReport(sql, {
      beforePeriodStart: '2026-07-13',
      frequency: 'weekly',
      projectId: crossProjectId,
    }),
    null,
  );
  assert.match(
    (await readProjectReportAvailableFrom(sql, { projectId })) ?? '',
    /^\d{4}-\d{2}-\d{2}$/,
  );

  await sql`
    INSERT INTO public.report_schedule_period_runs (
      id, schedule_id, project_id, frequency, period_start, period_end, run_kind, status
    )
    VALUES (
      ${crossBoundaryPeriodRunId}, ${scheduleId}, ${projectId}, 'weekly',
      '2026-07-13', '2026-07-19', 'scheduled', 'pending'
    )
  `;

  const oldestIncomplete = await readOldestIncompleteReportSchedulePeriodRun(sql, {
    frequency: 'weekly',
    projectId,
    scheduleId,
  });
  assert.equal(oldestIncomplete?.id, crossBoundaryPeriodRunId);
  assert.equal(oldestIncomplete?.periodStart, '2026-07-13');

  assert.equal(
    await readOldestIncompleteReportSchedulePeriodRun(sql, {
      frequency: 'weekly',
      projectId: crossProjectId,
      scheduleId,
    }),
    null,
  );

  await assert.rejects(
    () =>
      repository.insertReport({
        chunks: [],
        generatedBy: 'postgres-roundtrip.test',
        generationMetadata: {
          generationKind: 'scheduled',
          scheduleFrequency: 'weekly',
          schedulePeriodRunId: crossBoundaryPeriodRunId,
        },
        projectId: crossProjectId,
        report: { ...scheduledReport, project_id: crossProjectId, report_id: crossProjectReportId },
        storageUri: 'issue-579/reports/private/cross-project.json',
      }),
    databaseErrorCode('23503'),
  );

  await assert.rejects(
    () =>
      repository.insertReport({
        chunks: [],
        generatedBy: 'postgres-roundtrip.test',
        generationMetadata: {
          generationKind: 'scheduled',
          scheduleFrequency: 'monthly',
          schedulePeriodRunId: crossBoundaryPeriodRunId,
        },
        projectId,
        report: { ...scheduledReport, report_id: frequencyMismatchReportId },
        storageUri: 'issue-579/reports/private/frequency-mismatch.json',
      }),
    databaseErrorCode('23503'),
  );

  await sql`
    INSERT INTO public.report_schedule_period_runs (
      id, schedule_id, project_id, frequency, period_start, period_end, run_kind, status
    )
    VALUES (
      ${monthlyPeriodRunId}, ${scheduleId}, ${projectId}, 'monthly',
      '2026-07-01', '2026-07-31', 'scheduled', 'pending'
    )
  `;
  await assert.rejects(
    () =>
      repository.insertReport({
        chunks: [],
        generatedBy: 'postgres-roundtrip.test',
        generationMetadata: {
          generationKind: 'scheduled',
          previousScheduledReportId: scheduledReportId,
          scheduleFrequency: 'monthly',
          schedulePeriodRunId: monthlyPeriodRunId,
        },
        projectId,
        report: { ...scheduledReport, report_id: previousFrequencyMismatchReportId },
        storageUri: 'issue-579/reports/private/previous-frequency-mismatch.json',
      }),
    databaseErrorCode('23503'),
  );
}

function databaseErrorCode(expected: string): (error: unknown) => boolean {
  return (error) =>
    Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === expected);
}

function singleRow(rows: readonly unknown[]): Record<string, unknown> {
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row && typeof row === 'object' && !Array.isArray(row));
  return row as Record<string, unknown>;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected ${key} to be a string.`);
  }
  return value;
}
