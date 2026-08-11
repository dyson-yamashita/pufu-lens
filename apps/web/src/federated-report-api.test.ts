import assert from 'node:assert/strict';
import test from 'node:test';
import type postgres from 'postgres';
import {
  FederatedReportsForbiddenError,
  listProjectFederatedReports,
} from './federated-report-api.ts';

const projectId = '10000000-0000-0000-0000-000000000001';
const projectSlug = 'sample-project';
const userId = '20000000-0000-0000-0000-000000000001';

function createMockSql(input: {
  memberAccess?: Record<string, unknown> | null;
  federatedReports?: readonly Record<string, unknown>[];
}): postgres.Sql {
  return (async (strings: TemplateStringsArray) => {
    const query = strings.join('?');
    if (query.includes('FROM public.federated_reports')) {
      return input.federatedReports ?? [];
    }
    if (query.includes('FROM public.projects p')) {
      return input.memberAccess ? [input.memberAccess] : [];
    }
    throw new Error(`Unexpected SQL in federated report API test: ${query}`);
  }) as postgres.Sql;
}

const memberAccessRow = {
  id: projectId,
  slug: projectSlug,
  name: 'Sample Project',
  description: null,
  graphName: 'graph_sample',
  settings: {},
  visibility: 'public',
  appRole: 'member',
  projectRole: 'member',
};

const federatedReportRow = {
  id: '30000000-0000-0000-0000-000000000001',
  project_id: projectId,
  source_follow_id: '40000000-0000-0000-0000-000000000001',
  remote_object_uri: 'https://remote.example/articles/1',
  remote_activity_uri: 'https://remote.example/activities/create/1',
  remote_actor_uri: 'https://remote.example/users/alice',
  object_type: 'article',
  title: 'Remote report',
  summary_html_sanitized: '<p>safe</p>',
  original_url: 'https://remote.example/articles/1',
  published_at: new Date('2026-08-01T12:00:00.000Z'),
  remote_updated_at: null,
  received_at: new Date('2026-08-01T12:00:00.000Z'),
};

test('FederatedReportsForbiddenError is a safe forbidden marker', () => {
  const error = new FederatedReportsForbiddenError();
  assert.equal(error.name, 'FederatedReportsForbiddenError');
  assert.match(error.message, /forbidden/i);
});

test('listProjectFederatedReports rejects non-members without querying federated reports', async () => {
  let federatedQueryCount = 0;
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join('?');
    if (query.includes('FROM public.federated_reports')) {
      federatedQueryCount += 1;
      return [];
    }
    if (query.includes('FROM public.projects p')) {
      return [];
    }
    throw new Error(`Unexpected SQL: ${query}`);
  }) as postgres.Sql;

  await assert.rejects(
    () =>
      listProjectFederatedReports({
        sql,
        userId,
        projectSlug,
      }),
    FederatedReportsForbiddenError,
  );
  assert.equal(federatedQueryCount, 0);
});

test('listProjectFederatedReports omits internal ids and re-sanitizes summary HTML', async () => {
  const response = await listProjectFederatedReports({
    sql: createMockSql({
      memberAccess: memberAccessRow,
      federatedReports: [
        {
          ...federatedReportRow,
          summary_html_sanitized: '<p>safe</p><script>alert(1)</script>',
        },
      ],
    }),
    userId,
    projectSlug,
  });
  assert.equal(response.status, 'ok');
  if (response.status !== 'ok') {
    return;
  }
  assert.equal(response.reports.length, 1);
  const item = response.reports[0];
  assert.ok(item);
  assert.equal(item.title, 'Remote report');
  assert.equal(item.domain, 'remote.example');
  assert.doesNotMatch(item.summaryHtmlSanitized, /script/i);
  assert.doesNotMatch(JSON.stringify(item), /30000000-0000-0000-0000-000000000001/);
});

test('listProjectFederatedReports returns blocked state when all reports are domain-blocked', async () => {
  const response = await listProjectFederatedReports({
    sql: createMockSql({
      memberAccess: memberAccessRow,
      federatedReports: [federatedReportRow],
    }),
    userId,
    projectSlug,
    blockedDomainsEnv: 'remote.example',
  });
  assert.deepEqual(response, {
    status: 'blocked',
    reports: [],
    blockedCount: 1,
  });
});

test('listProjectFederatedReports keeps visible reports and counts mixed blocked entries', async () => {
  const response = await listProjectFederatedReports({
    sql: createMockSql({
      memberAccess: memberAccessRow,
      federatedReports: [
        federatedReportRow,
        {
          ...federatedReportRow,
          id: '30000000-0000-0000-0000-000000000002',
          remote_object_uri: 'https://blocked.example/articles/2',
          remote_actor_uri: 'https://blocked.example/users/bob',
          original_url: 'https://blocked.example/articles/2',
          title: 'Blocked report',
        },
      ],
    }),
    userId,
    projectSlug,
    blockedDomainsEnv: 'blocked.example',
  });
  assert.equal(response.status, 'ok');
  if (response.status !== 'ok') {
    return;
  }
  assert.equal(response.blockedCount, 1);
  assert.equal(response.reports.length, 1);
  assert.equal(response.reports[0]?.title, 'Remote report');
});
