import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertInboundReportHttpsUrl,
  sanitizeInboundReportSummaryHtml,
} from './inbound-report-sanitizer.ts';
import { createBoundedRemoteJsonFetcher } from './remote-document.ts';

test('sanitizeInboundReportSummaryHtml removes script tags and event handlers', () => {
  const sanitized = sanitizeInboundReportSummaryHtml(
    '<p onclick="alert(1)">Hello<script>alert(1)</script></p><img src="https://evil.example/x.png" />',
  );
  assert.match(sanitized, /Hello/);
  assert.doesNotMatch(sanitized, /script/i);
  assert.doesNotMatch(sanitized, /onclick/i);
  assert.doesNotMatch(sanitized, /img/i);
});

test('sanitizeInboundReportSummaryHtml keeps safe https links with rel', () => {
  const sanitized = sanitizeInboundReportSummaryHtml(
    '<a href="https://remote.example/report/1">open</a>',
  );
  assert.match(sanitized, /href="https:\/\/remote\.example\/report\/1"/);
  assert.match(sanitized, /rel="noopener noreferrer"/);
});

test('sanitizeInboundReportSummaryHtml drops javascript and data URLs', () => {
  const sanitized = sanitizeInboundReportSummaryHtml(
    '<a href="javascript:alert(1)">bad</a><a href="data:text/html,bad">data</a>',
  );
  assert.doesNotMatch(sanitized, /javascript:/);
  assert.doesNotMatch(sanitized, /data:/);
});

test('assertInboundReportHttpsUrl rejects credentials and fragments', () => {
  assert.throws(
    () => assertInboundReportHttpsUrl('https://user:pass@remote.example/a', 'url'),
    /credentials/i,
  );
  assert.throws(
    () => assertInboundReportHttpsUrl('https://remote.example/a#frag', 'url'),
    /fragment/i,
  );
});

test('bounded remote json fetcher rejects oversize Content-Length', async () => {
  const fetcher = createBoundedRemoteJsonFetcher({
    canonicalOrigin: 'https://lens.test',
    fetch: async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(2 * 1024 * 1024) },
      }),
    isDomainBlocked: () => false,
    validateUrl: async () => {},
  });
  await assert.rejects(
    () => fetcher.fetchJsonDocument('https://remote.example/article/1'),
    /size limit/i,
  );
});

test('bounded remote json fetcher rejects http redirect targets', async () => {
  const fetcher = createBoundedRemoteJsonFetcher({
    canonicalOrigin: 'https://lens.test',
    fetch: async (url) => {
      if (url.toString() === 'https://remote.example/article/1') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://remote.example/article/final' },
        });
      }
      return new Response('not found', { status: 404 });
    },
    isDomainBlocked: () => false,
    validateUrl: async () => {},
  });
  await assert.rejects(
    () => fetcher.fetchJsonDocument('https://remote.example/article/1'),
    /HTTPS/i,
  );
});
