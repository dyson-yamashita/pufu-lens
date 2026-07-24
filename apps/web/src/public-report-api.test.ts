import assert from 'node:assert/strict';
import { inferChatEditingMetadata } from './chat.ts';
import {
  createPublicProjectChatMastraBody,
  LEGACY_PUBLIC_REPORT_CHAT_AGENT_ID,
  mastraProjectChatGenerateUrl,
  PUBLIC_PROJECT_CHAT_AGENT_ID,
} from './mastra-chat.ts';
import { isPublicWebChatSource, publicChatSourcesFromReport } from './public-chat-sources.ts';
import type { PrivateReportJsonV1 } from './report-schema.ts';
import { trustedClientIp } from './request-client.ts';

function requestHeaders(headers: Record<string, string>) {
  return new Headers(headers);
}

assert.equal(
  trustedClientIp(requestHeaders({ 'x-forwarded-for': '203.0.113.10, 198.51.100.20' })),
  '198.51.100.20',
);
assert.equal(
  trustedClientIp(requestHeaders({ 'x-forwarded-for': '203.0.113.10, 10.0.0.1' })),
  '203.0.113.10',
);
assert.equal(trustedClientIp(requestHeaders({ 'x-real-ip': '203.0.113.20' })), '203.0.113.20');
assert.equal(
  trustedClientIp(requestHeaders({ 'x-forwarded-for': 'unknown', 'x-real-ip': '203.0.113.30' })),
  '203.0.113.30',
);
assert.equal(trustedClientIp(requestHeaders({})), 'anonymous');

assert.deepEqual(
  createPublicProjectChatMastraBody({
    project: { graphName: 'graph_sample_a', id: 'project-a' },
    question: '公開 project の進捗は?',
  }),
  {
    messages: [{ content: '公開 project の進捗は?', role: 'user' }],
    requestContext: {
      editing: inferChatEditingMetadata('公開 project の進捗は?'),
      graphName: 'graph_sample_a',
      projectId: 'project-a',
    },
  },
);
assert.equal(
  new URL(mastraProjectChatGenerateUrl({ MASTRA_SERVER_URL: 'http://localhost:4111/' })).pathname,
  `/api/agents/${PUBLIC_PROJECT_CHAT_AGENT_ID}/generate`,
);
assert.notEqual(PUBLIC_PROJECT_CHAT_AGENT_ID, LEGACY_PUBLIC_REPORT_CHAT_AGENT_ID);

assert.equal(
  isPublicWebChatSource({
    canonicalUri: 'https://example.com/release',
    documentId: 'doc-web',
    docType: 'web_page',
    rawDocumentId: 'raw-web',
    title: 'Web release',
  }),
  true,
);
assert.equal(
  isPublicWebChatSource({
    canonicalUri: 'https://github.com/example/repo/issues/42',
    documentId: 'doc-github',
    docType: 'issue',
    rawDocumentId: 'raw-github',
    title: 'GitHub issue',
  }),
  false,
);

const privateReport: PrivateReportJsonV1 = {
  generated_at: '2026-07-05T00:00:00.000Z',
  period: { end: '2026-07-05', start: '2026-06-29' },
  project_id: 'project-a',
  pufu_sources: [
    {
      canonical_uri: 'https://github.com/example/repo/issues/42',
      doc_type: 'issue',
      document_id: 'doc-github',
      occurred_at: null,
      snippet: 'GitHub source',
      title: 'GitHub issue',
    },
  ],
  report_id: 'report-a',
  schema_version: 'v1',
  sections: [
    {
      id: 'activity',
      markdown: 'Web release',
      sources: [
        {
          canonical_uri: 'https://example.com/release',
          doc_type: 'web_page',
          document_id: 'doc-web',
          snippet: 'Web source',
          title: 'Web release',
        },
      ],
      title: 'Activity',
    },
    {
      id: 'issues',
      markdown: 'GitHub issue',
      sources: [
        {
          canonical_uri: 'https://github.com/example/repo/issues/42',
          doc_type: 'issue',
          document_id: 'doc-github',
          snippet: 'GitHub source',
          title: 'GitHub issue',
        },
      ],
      title: 'Issues',
    },
  ],
  summary: 'Summary',
  title: 'Report',
};

const publicReportSources = publicChatSourcesFromReport(
  [
    {
      canonicalUri: 'https://example.com/release',
      documentId: 'doc-web',
      docType: 'web_page',
      rawDocumentId: 'raw-web',
      title: 'Web release',
    },
    {
      canonicalUri: 'https://github.com/example/repo/issues/42',
      documentId: 'doc-github',
      docType: 'issue',
      rawDocumentId: 'raw-github',
      title: 'GitHub issue',
    },
  ],
  privateReport,
);
assert.deepEqual(publicReportSources, [
  {
    label: 'Web release',
    publicSourceId: 'src_activity_1',
    sectionId: 'activity',
  },
]);

const publicReportSourcesWithRetrievalProvenance = publicChatSourcesFromReport(
  [
    {
      canonicalUri: 'https://example.com/release',
      chunkId: 'chunk-secret',
      chunkIndex: 2,
      documentId: 'doc-web',
      docType: 'web_page',
      fusedScore: 0.9,
      keywordRank: 1,
      occurredAt: '2026-01-01T00:00:00.000Z',
      rawDocumentId: 'raw-web',
      snippet: 'internal snippet',
      title: 'Web release',
      vectorDistance: 0.1,
      vectorRank: 1,
    },
    {
      canonicalUri: 'https://github.com/example/repo/issues/42',
      chunkId: 'chunk-github',
      chunkIndex: 0,
      documentId: 'doc-github',
      docType: 'issue',
      fusedScore: 0.5,
      rawDocumentId: 'raw-github',
      title: 'GitHub issue',
      vectorRank: 2,
    },
  ],
  privateReport,
);
assert.deepEqual(publicReportSourcesWithRetrievalProvenance, publicReportSources);
assert.equal(
  JSON.stringify(publicReportSourcesWithRetrievalProvenance).includes('chunk-secret'),
  false,
);
assert.equal(
  JSON.stringify(publicReportSourcesWithRetrievalProvenance).includes('fusedScore'),
  false,
);

console.log('web public report api tests passed');
