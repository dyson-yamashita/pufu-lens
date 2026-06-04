import { Mastra } from '@mastra/core/mastra';
import postgres from 'postgres';
import type { ObjectStorage } from '../../../../packages/storage/src/object-storage.ts';
import type { ChatRepository } from '../../../web/src/chat.ts';
import { createPostgresChatRepository } from '../../../web/src/chat.ts';
import type { ReportRepository } from '../../../web/src/report.ts';
import {
  createExtractiveReportProvider,
  createPostgresReportRepository,
  createReportStorageFromEnv,
} from '../../../web/src/report.ts';
import {
  createGenerateReportWorkflow,
  createProjectChatAgent,
  createProjectChatTools,
} from '../index.ts';

const databaseUrl = process.env.DATABASE_URL;
const sql = postgres(databaseUrl ?? 'postgresql://localhost/pufu_lens_mastra_build', { max: 5 });
const chatRepository = databaseUrl
  ? createPostgresChatRepository(sql)
  : unavailableChatRepository('DATABASE_URL');
const reportRepository = databaseUrl
  ? createPostgresReportRepository(sql)
  : unavailableReportRepository('DATABASE_URL');
const projectChatTools = createProjectChatTools(chatRepository);
const projectChatAgent = createProjectChatAgent({ tools: projectChatTools });
const generateReportWorkflow = createGenerateReportWorkflow({
  provider: createExtractiveReportProvider(),
  repository: reportRepository,
  storage: createStorage(),
});

export const mastra = new Mastra({
  agents: { projectChatAgent },
  workflows: { generateReportWorkflow },
});

function createStorage(): ObjectStorage {
  try {
    return createReportStorageFromEnv();
  } catch (error) {
    return unavailableObjectStorage(error);
  }
}

function unavailableChatRepository(envName: string): ChatRepository {
  return {
    documentFetch: unavailableMethod(envName),
    graphQuery: unavailableMethod(envName),
    lookupProjectMember: unavailableMethod(envName),
    parsedDocFetch: unavailableMethod(envName),
    rawDocumentFetch: unavailableMethod(envName),
    vectorSearch: unavailableMethod(envName),
  };
}

function unavailableReportRepository(envName: string): ReportRepository {
  return {
    insertReport: unavailableMethod(envName),
    listRecentDocuments: unavailableMethod(envName),
    listReports: unavailableMethod(envName),
    lookupProject: unavailableMethod(envName),
    lookupProjectMember: unavailableMethod(envName),
    readReportMetadata: unavailableMethod(envName),
    setReportPublicState: unavailableMethod(envName),
  };
}

function unavailableObjectStorage(error: unknown): ObjectStorage {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    exists: unavailableStorageMethod(reason),
    get: unavailableStorageMethod(reason),
    getText: unavailableStorageMethod(reason),
    list: () => unavailableStorageList(reason),
    put: unavailableStorageMethod(reason),
  };
}

function unavailableMethod(envName: string) {
  return async () => {
    throw new Error(`${envName} is required to execute the Mastra runtime.`);
  };
}

function unavailableStorageMethod(reason: string) {
  return async () => {
    throw new Error(`Object storage is not configured: ${reason}`);
  };
}

function unavailableStorageList(reason: string) {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      throw new Error(`Object storage is not configured: ${reason}`);
    },
  };
}
