import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseFederatedReportsApiResponse,
  toSafeFederatedReportApiItem,
} from './federated-report-response.ts';

test('parseFederatedReportsApiResponse accepts ok response with allowlisted fields', () => {
  const parsed = parseFederatedReportsApiResponse({
    status: 'ok',
    blockedCount: 0,
    reports: [
      {
        title: 'Remote report',
        sourceActor: 'https://remote.example/users/alice',
        domain: 'remote.example',
        publishedAt: '2026-08-01T00:00:00.000Z',
        summaryHtmlSanitized: '<p>safe</p>',
        originalUrl: 'https://remote.example/reports/1',
      },
    ],
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.response.status, 'ok');
    assert.equal(parsed.response.reports.length, 1);
  }
});

test('parseFederatedReportsApiResponse strips script tags from summary HTML', () => {
  const parsed = parseFederatedReportsApiResponse({
    status: 'ok',
    blockedCount: 0,
    reports: [
      {
        title: 'Remote report',
        sourceActor: 'https://remote.example/users/alice',
        domain: 'remote.example',
        publishedAt: null,
        summaryHtmlSanitized: '<script>alert(1)</script><p>safe</p>',
        originalUrl: 'https://remote.example/reports/1',
      },
    ],
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.match(parsed.response.reports[0]?.summaryHtmlSanitized ?? '', /safe/);
    assert.doesNotMatch(parsed.response.reports[0]?.summaryHtmlSanitized ?? '', /script/i);
  }
});

test('parseFederatedReportsApiResponse rejects unsafe original URLs', () => {
  const parsed = parseFederatedReportsApiResponse({
    status: 'ok',
    blockedCount: 0,
    reports: [
      {
        title: 'Remote report',
        sourceActor: 'https://remote.example/users/alice',
        domain: 'remote.example',
        publishedAt: null,
        summaryHtmlSanitized: '<p>safe</p>',
        originalUrl: 'javascript:alert(1)',
      },
    ],
  });
  assert.equal(parsed.ok, false);
});

test('parseFederatedReportsApiResponse rejects extra top-level fields', () => {
  const parsed = parseFederatedReportsApiResponse({
    status: 'ok',
    blockedCount: 0,
    reports: [],
    internalId: 'secret',
  });
  assert.equal(parsed.ok, false);
});

test('parseFederatedReportsApiResponse rejects extra item fields', () => {
  const parsed = parseFederatedReportsApiResponse({
    status: 'ok',
    blockedCount: 0,
    reports: [
      {
        title: 'Remote report',
        sourceActor: 'https://remote.example/users/alice',
        domain: 'remote.example',
        publishedAt: '2026-08-01T00:00:00.000Z',
        summaryHtmlSanitized: '<p>safe</p>',
        originalUrl: 'https://remote.example/reports/1',
        id: 'internal-id',
      },
    ],
  });
  assert.equal(parsed.ok, false);
});

test('parseFederatedReportsApiResponse rejects ambiguous publishedAt strings', () => {
  const parsed = parseFederatedReportsApiResponse({
    status: 'ok',
    blockedCount: 0,
    reports: [
      {
        title: 'Remote report',
        sourceActor: 'https://remote.example/users/alice',
        domain: 'remote.example',
        publishedAt: '2026-08-01',
        summaryHtmlSanitized: '<p>safe</p>',
        originalUrl: 'https://remote.example/reports/1',
      },
    ],
  });
  assert.equal(parsed.ok, false);
});

test('toSafeFederatedReportApiItem rejects javascript original URLs', () => {
  assert.throws(
    () =>
      toSafeFederatedReportApiItem({
        title: 'x',
        sourceActor: 'https://remote.example/users/alice',
        domain: 'remote.example',
        publishedAt: null,
        summaryHtmlSanitized: '<p>safe</p>',
        originalUrl: 'javascript:alert(1)',
      }),
    /HTTPS/i,
  );
});
