import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import {
  readProjectReportScheduleSettingsForUser,
  resolveReportSchedulePageAccess,
  resolveReportScheduleSettingsUserId,
  saveProjectReportScheduleForAdmin,
} from './admin-report-schedule-runtime.ts';
import { AuthRequiredError } from './auth-errors.ts';
import { readProjectReportScheduleSettings } from './report-schedule-settings.ts';

const databaseUrl = process.env.DATABASE_URL?.trim();

test('resolveReportScheduleSettingsUserId returns null for missing sessions', async () => {
  const result = await resolveReportScheduleSettingsUserId(async () => {
    throw new AuthRequiredError();
  });
  assert.equal(result, null);
});

test('resolveReportScheduleSettingsUserId rethrows unexpected auth failures', async () => {
  const unexpected = new Error('auth configuration failure');
  await assert.rejects(
    () =>
      resolveReportScheduleSettingsUserId(async () => {
        throw unexpected;
      }),
    unexpected,
  );
});

const authProjectId = '10000000-0000-0000-0000-000000000588';
const authAdminUserId = '10000000-0000-0000-0000-000000000589';
const authMemberUserId = '10000000-0000-0000-0000-000000000590';
const authNonMemberUserId = '10000000-0000-0000-0000-000000000591';
const authOtherProjectId = '10000000-0000-0000-0000-000000000592';
const authProjectSlug = 'issue-588-schedule-auth';
const authOtherProjectSlug = 'issue-588-schedule-other';
const authScheduleAsOf = new Date('2026-07-20T05:00:00.000Z');

test('report schedule runtime auth integration enforces admin save and member read boundaries', {
  skip: !databaseUrl,
}, async () => {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for this test.');
  }
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await resetAuthFixture(sql);
    await seedAuthFixture(sql);

    await saveProjectReportScheduleForAdmin(sql, {
      asOf: authScheduleAsOf,
      frequency: 'weekly',
      projectSlug: authProjectSlug,
      userId: authAdminUserId,
    });
    const adminSettings = await readProjectReportScheduleSettingsForUser(sql, {
      projectSlug: authProjectSlug,
      userId: authAdminUserId,
    });
    assert.equal(adminSettings?.frequency, 'weekly');

    await assert.rejects(
      () =>
        saveProjectReportScheduleForAdmin(sql, {
          asOf: authScheduleAsOf,
          frequency: 'monthly',
          projectSlug: authProjectSlug,
          userId: authMemberUserId,
        }),
      /Admin access denied/,
    );

    const memberSettings = await readProjectReportScheduleSettingsForUser(sql, {
      projectSlug: authProjectSlug,
      userId: authMemberUserId,
    });
    assert.equal(memberSettings?.frequency, 'weekly');

    assert.equal(
      await readProjectReportScheduleSettingsForUser(sql, {
        projectSlug: authProjectSlug,
        userId: authNonMemberUserId,
      }),
      null,
    );

    await assert.rejects(
      () =>
        saveProjectReportScheduleForAdmin(sql, {
          asOf: authScheduleAsOf,
          frequency: 'monthly',
          projectSlug: authOtherProjectSlug,
          userId: authAdminUserId,
        }),
      /Admin access denied/,
    );

    const adminPageAccess = await resolveReportSchedulePageAccess(sql, {
      projectSlug: authProjectSlug,
      userId: authAdminUserId,
    });
    assert.ok(adminPageAccess.adminAccess);
    assert.ok(adminPageAccess.memberAccess);
    assert.equal(adminPageAccess.scheduleSettings?.frequency, 'weekly');

    const memberPageAccess = await resolveReportSchedulePageAccess(sql, {
      projectSlug: authProjectSlug,
      userId: authMemberUserId,
    });
    assert.equal(memberPageAccess.adminAccess, undefined);
    assert.ok(memberPageAccess.memberAccess);
    assert.equal(memberPageAccess.scheduleSettings?.frequency, 'weekly');

    const nonMemberPageAccess = await resolveReportSchedulePageAccess(sql, {
      projectSlug: authProjectSlug,
      userId: authNonMemberUserId,
    });
    assert.equal(nonMemberPageAccess.adminAccess, undefined);
    assert.equal(nonMemberPageAccess.memberAccess, undefined);
    assert.equal(nonMemberPageAccess.scheduleSettings, null);

    const unchangedSettings = await readProjectReportScheduleSettings(sql, {
      projectId: authProjectId,
    });
    assert.equal(unchangedSettings.frequency, 'weekly');
  } finally {
    try {
      await resetAuthFixture(sql);
    } finally {
      await sql.end();
    }
  }
});

async function resetAuthFixture(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM public.report_schedule_period_runs WHERE project_id IN (${authProjectId}, ${authOtherProjectId})`;
  await sql`DELETE FROM public.project_report_schedules WHERE project_id IN (${authProjectId}, ${authOtherProjectId})`;
  await sql`DELETE FROM public.project_members WHERE project_id IN (${authProjectId}, ${authOtherProjectId})`;
  await sql`DELETE FROM public.projects WHERE id IN (${authProjectId}, ${authOtherProjectId})`;
  await sql`DELETE FROM public.users WHERE id IN (${authAdminUserId}, ${authMemberUserId}, ${authNonMemberUserId})`;
}

async function seedAuthFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO public.users (id, email, name, role)
    VALUES
      (${authAdminUserId}, 'issue-588-admin@example.test', 'Issue 588 Admin', 'member'),
      (${authMemberUserId}, 'issue-588-member@example.test', 'Issue 588 Member', 'member'),
      (${authNonMemberUserId}, 'issue-588-outsider@example.test', 'Issue 588 Outsider', 'member')
  `;
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES
      (
        ${authProjectId},
        ${authProjectSlug},
        'Issue 588 Schedule Auth',
        'graph_issue_588_schedule_auth',
        'issue-588-schedule-auth',
        'private'
      ),
      (
        ${authOtherProjectId},
        ${authOtherProjectSlug},
        'Issue 588 Schedule Other',
        'graph_issue_588_schedule_other',
        'issue-588-schedule-other',
        'private'
      )
  `;
  await sql`
    INSERT INTO public.project_members (project_id, user_id, role)
    VALUES
      (${authProjectId}, ${authAdminUserId}, 'admin'),
      (${authProjectId}, ${authMemberUserId}, 'member')
  `;
}
