import assert from 'node:assert/strict';
import { RequestContext } from '@mastra/core/request-context';
import type { ObjectInfo, ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import type { ChatRepository } from '../../web/src/chat.ts';
import type { ReportRepository } from '../../web/src/report.ts';
import {
  createPufuLensMastraRuntime,
  type MastraProjectContext,
  mastraAgentIds,
  mastraToolIds,
  mastraWorkflowIds,
} from './index.ts';

class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, string>();

  async put(uri: string, body: Buffer | NodeJS.ReadableStream | string): Promise<{ uri: string }> {
    const text =
      typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : '';
    const storedUri = `file:///tmp/pufu-lens/${uri}`;
    this.objects.set(storedUri, text);
    this.objects.set(uri, text);
    return { uri: storedUri };
  }

  async get(): Promise<NodeJS.ReadableStream> {
    throw new Error('not implemented');
  }

  async getText(uri: string): Promise<string> {
    const value = this.objects.get(uri);
    if (!value) {
      throw new Error(`missing object: ${uri}`);
    }
    return value;
  }

  async exists(uri: string): Promise<boolean> {
    return this.objects.has(uri) || this.objects.has(`file:///tmp/pufu-lens/${uri}`);
  }

  async *list(): AsyncIterable<ObjectInfo> {}
}

const sampleSource = {
  canonicalUri: 'https://example.com/spec',
  documentId: 'doc-a',
  docType: 'web_page',
  rawDocumentId: 'raw-a',
  title: 'Spec Update',
};

function createChatRepository(): ChatRepository & { projectIds: string[] } {
  const projectIds: string[] = [];
  return {
    projectIds,
    async lookupProjectMember({ projectSlug, userId }) {
      return projectSlug === 'sample-a' && userId === 'user-a'
        ? { id: 'project-a', slug: 'sample-a' }
        : undefined;
    },
    async vectorSearch({ projectId }) {
      projectIds.push(projectId);
      return [sampleSource];
    },
    async graphQuery({ projectId }) {
      projectIds.push(projectId);
      return [{ ...sampleSource, documentId: 'doc-graph', title: 'Related Issue' }];
    },
    async documentFetch({ documentIds, projectId }) {
      projectIds.push(projectId);
      assert.deepEqual(documentIds, ['doc-a']);
      return [sampleSource];
    },
    async rawDocumentFetch({ maxBytes, projectId }) {
      projectIds.push(projectId);
      assert.equal(maxBytes, 64 * 1024);
      return [{ ...sampleSource, documentId: 'doc-raw', title: 'Raw Metadata' }];
    },
    async parsedDocFetch({ projectId }) {
      projectIds.push(projectId);
      return [{ ...sampleSource, documentId: 'doc-parsed', title: 'Parsed Metadata' }];
    },
  };
}

function createReportRepository(): ReportRepository & { insertedReports: number } {
  return {
    insertedReports: 0,
    async lookupProject({ projectSlug }) {
      return projectSlug === 'sample-a' ? { id: 'project-a', slug: 'sample-a' } : undefined;
    },
    async lookupProjectMember({ projectSlug, userId }) {
      return projectSlug === 'sample-a' && userId === 'user-a'
        ? { id: 'project-a', slug: 'sample-a' }
        : undefined;
    },
    async listRecentDocuments({ projectId }) {
      assert.equal(projectId, 'project-a');
      return [
        {
          canonicalUri: 'https://example.com/issues/42',
          docType: 'issue',
          documentId: 'doc-issue',
          occurredAt: '2026-06-03T00:00:00.000Z',
          summary: 'Login failure risk',
          title: 'Issue #42 Login failure',
        },
      ];
    },
    async insertReport({ report }) {
      assert.equal(report.project_id, 'project-a');
      this.insertedReports += 1;
    },
    async listReports() {
      return [];
    },
    async readReportMetadata() {
      return undefined;
    },
  };
}

const chatRepository = createChatRepository();
const reportRepository = createReportRepository();
const storage = new MemoryStorage();
const runtime = createPufuLensMastraRuntime({
  chatRepository,
  reportRepository,
  reportStorage: storage,
});

assert.equal(runtime.projectChatAgent.id, mastraAgentIds.projectChat);
assert.equal(runtime.generateReportWorkflow.id, mastraWorkflowIds.generateReport);
assert.ok(runtime.mastra.getAgentById(mastraAgentIds.projectChat));
assert.ok(runtime.mastra.getWorkflow('generateReportWorkflow'));

assert.deepEqual(
  Object.values(runtime.projectChatTools)
    .map((tool) => tool.id)
    .sort(),
  Object.values(mastraToolIds).sort(),
);

const requestContext = new RequestContext<MastraProjectContext>([['projectId', 'project-a']]);
const vectorSearch = await runtime.projectChatTools.vectorSearch.execute?.(
  { embedding: [0.1], limit: 3, query: '仕様変更' },
  { requestContext } as never,
);
assert.deepEqual(vectorSearch, { sources: [sampleSource] });

const graphQuery = await runtime.projectChatTools.graphQuery.execute?.(
  { limit: 3, query: '関連 issue' },
  { requestContext } as never,
);
assert.equal(graphQuery?.sources[0]?.documentId, 'doc-graph');

const documentFetch = await runtime.projectChatTools.documentFetch.execute?.(
  { documentIds: ['doc-a'] },
  { requestContext } as never,
);
assert.deepEqual(documentFetch, { sources: [sampleSource] });

const rawDocumentFetch = await runtime.projectChatTools.rawDocumentFetch.execute?.(
  { limit: 3, maxBytes: 64 * 1024 },
  { requestContext } as never,
);
assert.equal(rawDocumentFetch?.sources[0]?.documentId, 'doc-raw');

const parsedDocFetch = await runtime.projectChatTools.parsedDocFetch.execute?.({ limit: 3 }, {
  requestContext,
} as never);
assert.equal(parsedDocFetch?.sources[0]?.documentId, 'doc-parsed');

assert.ok(chatRepository.projectIds.every((projectId) => projectId === 'project-a'));

const run = await runtime.generateReportWorkflow.createRun();
const report = await run.start({
  inputData: {
    nowIso: '2026-06-04T12:00:00.000Z',
    projectSlug: 'sample-a',
  },
});
assert.equal(report.status, 'success');
const reportResult = report.result as {
  readonly reportUrl: string;
  readonly schemaVersion: string;
  readonly storageUri: string;
};
assert.equal(reportResult.schemaVersion, 'v1');
assert.match(reportResult.reportUrl, /^\/projects\/sample-a\/reports\//);
assert.equal(reportRepository.insertedReports, 1);
assert.ok(await storage.exists(reportResult.storageUri));

console.log('mastra runtime tests passed');
