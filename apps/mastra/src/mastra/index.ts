import { Mastra } from '@mastra/core/mastra';
import postgres from 'postgres';
import { createPostgresChatRepository } from '../../../web/src/chat.ts';
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

const sql = postgres(requiredEnv('DATABASE_URL'), { max: 5 });
const chatRepository = createPostgresChatRepository(sql);
const reportRepository = createPostgresReportRepository(sql);
const projectChatTools = createProjectChatTools(chatRepository);
const projectChatAgent = createProjectChatAgent({ tools: projectChatTools });
const generateReportWorkflow = createGenerateReportWorkflow({
  provider: createExtractiveReportProvider(),
  repository: reportRepository,
  storage: createReportStorageFromEnv(),
});

export const mastra = new Mastra({
  agents: { projectChatAgent },
  workflows: { generateReportWorkflow },
});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
