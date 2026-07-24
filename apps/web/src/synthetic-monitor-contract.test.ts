import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseSyntheticMonitorProjectSlugs,
  parseSyntheticMonitorRequest,
  parseSyntheticMonitorServiceAccounts,
  SYNTHETIC_MONITOR_MAX_RELATION_MIN_COUNT,
  SYNTHETIC_MONITOR_MAX_SOURCES,
  SyntheticMonitorRequestError,
} from './synthetic-monitor-contract.ts';

const validGmailSource = {
  kind: 'gmail' as const,
  threadId: 'thread-1',
  expectedMessageId: 'message-1',
};

test('parseSyntheticMonitorRequest accepts bounded gmail source observations', () => {
  const request = parseSyntheticMonitorRequest(
    { projectSlug: 'sample-a', sources: [validGmailSource] },
    128,
  );
  assert.equal(request.projectSlug, 'sample-a');
  assert.equal(request.sources[0]?.kind, 'gmail');
});

test('parseSyntheticMonitorRequest rejects oversize bodies and unknown fields', () => {
  assert.throws(
    () =>
      parseSyntheticMonitorRequest(
        { projectSlug: 'sample-a', sources: [validGmailSource] },
        70_000,
      ),
    (error: unknown) =>
      error instanceof SyntheticMonitorRequestError && /64KiB/.test(error.message),
  );
  assert.throws(
    () =>
      parseSyntheticMonitorRequest(
        { projectSlug: 'sample-a', sources: [validGmailSource], extra: true },
        64,
      ),
    /unknown field/,
  );
});

test('parseSyntheticMonitorRequest rejects arbitrary query fields and source overflow', () => {
  const sources = Array.from({ length: SYNTHETIC_MONITOR_MAX_SOURCES + 1 }, () => validGmailSource);
  assert.throws(
    () => parseSyntheticMonitorRequest({ projectSlug: 'sample-a', sources }, 512),
    /must not exceed/,
  );
  assert.throws(
    () =>
      parseSyntheticMonitorRequest(
        {
          projectSlug: 'sample-a',
          sources: [{ ...validGmailSource, cypher: 'MATCH (n) RETURN n' }],
        },
        256,
      ),
    /unknown field/,
  );
});

test('parseSyntheticMonitorRequest validates github, web, report contracts, and guard limits', () => {
  const request = parseSyntheticMonitorRequest(
    {
      projectSlug: 'sample-a',
      sources: [
        {
          kind: 'github',
          repository: 'org/repo',
          resourceType: 'issue',
          number: 42,
          expectedVersion:
            '2026-07-01T00:00:00Z:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        },
        {
          kind: 'web',
          canonicalUrl: 'https://example.com/docs',
          expectedContentHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        },
      ],
      report: {
        frequency: 'weekly',
        periodStart: '2026-07-07',
        periodEnd: '2026-07-13',
      },
    },
    1024,
  );
  assert.equal(request.sources.length, 2);
  assert.equal(request.report?.frequency, 'weekly');
  assert.throws(
    () =>
      parseSyntheticMonitorRequest(
        {
          projectSlug: 'sample-a',
          sources: [validGmailSource],
          report: {
            frequency: 'weekly',
            periodStart: '2026-07-14',
            periodEnd: '2026-07-07',
          },
        },
        256,
      ),
    /periodStart must be on or before/,
  );
  assert.throws(
    () =>
      parseSyntheticMonitorRequest(
        {
          projectSlug: 'sample-a',
          sources: [
            {
              ...validGmailSource,
              expectedRelations: [
                { type: 'SENT', minCount: SYNTHETIC_MONITOR_MAX_RELATION_MIN_COUNT + 1 },
              ],
            },
          ],
        },
        256,
      ),
    /must not exceed/,
  );
  assert.throws(
    () =>
      parseSyntheticMonitorRequest(
        {
          projectSlug: 'sample-a',
          sources: [
            {
              kind: 'github',
              repository: 'org/repo',
              resourceType: 'issue',
              number: 1,
              expectedVersion: 'not-a-version',
            },
          ],
        },
        256,
      ),
    /expectedVersion/,
  );
  assert.throws(
    () =>
      parseSyntheticMonitorRequest(
        {
          projectSlug: 'sample-a',
          sources: [validGmailSource],
          report: {
            frequency: 'weekly',
            periodStart: '2026-02-30',
            periodEnd: '2026-03-01',
          },
        },
        256,
      ),
    /valid calendar date/,
  );
});

test('environment allowlists require non-empty bounded entries', () => {
  assert.deepEqual(
    parseSyntheticMonitorServiceAccounts(
      'monitor@example.iam.gserviceaccount.com,ops@example.iam.gserviceaccount.com',
    ),
    ['monitor@example.iam.gserviceaccount.com', 'ops@example.iam.gserviceaccount.com'],
  );
  assert.deepEqual(parseSyntheticMonitorProjectSlugs('sample-a,sample-b'), [
    'sample-a',
    'sample-b',
  ]);
  assert.throws(() => parseSyntheticMonitorServiceAccounts(' '), /at least one email/);
  assert.throws(
    () => parseSyntheticMonitorServiceAccounts('monitor@example.com'),
    /Google service account emails/,
  );
  assert.throws(() => parseSyntheticMonitorProjectSlugs('INVALID'), /invalid project slug/);
});
