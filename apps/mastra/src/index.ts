import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createTool } from '@mastra/core/tools';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import {
  type ChatProvider,
  type ChatRepository,
  type ChatResponse,
  createExtractiveChatProvider,
  runPrivateChat,
} from '../../web/src/chat.ts';
import {
  createExtractiveReportProvider,
  type GenerateReportResult,
  type ReportGenerationProvider,
  type ReportPeriodKind,
  type ReportRepository,
  type RunGenerateReportOptions,
  runGenerateReport,
} from '../../web/src/report.ts';

export const mastraAppName = 'pufu-lens-mastra';

export const mastraAgentIds = {
  projectChat: 'project-chat-agent',
} as const;

export const mastraWorkflowIds = {
  generateReport: 'generate-report',
} as const;

export const mastraToolIds = {
  documentFetch: 'document-fetch',
  graphQuery: 'graph-query',
  parsedDocFetch: 'parsed-doc-fetch',
  rawDocumentFetch: 'raw-document-fetch',
  vectorSearch: 'vector-search',
} as const;

export interface MastraProjectContext {
  readonly projectId: string;
}

export interface ProjectChatAgentInput {
  readonly now?: Date;
  readonly projectSlug: string;
  readonly question: string;
  readonly userId: string;
}

export interface GenerateReportWorkflowInput {
  readonly now?: Date;
  readonly periodKind?: ReportPeriodKind;
  readonly projectSlug: string;
}

export interface PufuLensMastraDependencies {
  readonly chatProvider?: ChatProvider;
  readonly chatRepository: ChatRepository;
  readonly reportProvider?: ReportGenerationProvider;
  readonly reportRepository: ReportRepository;
  readonly reportStorage: ObjectStorage;
}

export interface PufuLensMastraRuntime {
  readonly mastra: Mastra;
  readonly projectChatTools: ReturnType<typeof createProjectChatTools>;
  readonly projectChatAgent: Agent;
  readonly generateReportWorkflow: ReturnType<typeof createGenerateReportWorkflow>;
  runGenerateReportWorkflow(input: GenerateReportWorkflowInput): Promise<GenerateReportResult>;
  runProjectChat(input: ProjectChatAgentInput): Promise<ChatResponse>;
}

const chatSourceSchema = z.object({
  canonicalUri: z.string(),
  documentId: z.string(),
  docType: z.string(),
  rawDocumentId: z.string(),
  title: z.string(),
});

const chatSourceListSchema = z.object({
  sources: z.array(chatSourceSchema),
});

const mastraProjectContextSchema = z.object({
  projectId: z.string().min(1),
});

export function createProjectChatTools(repository: ChatRepository) {
  const projectIdFromContext = (
    context: { requestContext?: { get<T>(key: string): T } } | undefined,
  ): string => {
    const projectId = context?.requestContext?.get<string>('projectId');
    if (!projectId) {
      throw new Error('Mastra project tool requires requestContext.projectId.');
    }
    return projectId;
  };

  return {
    documentFetch: createTool({
      id: mastraToolIds.documentFetch,
      description: 'Fetch document metadata for the active project by document id.',
      inputSchema: z.object({ documentIds: z.array(z.string()).max(10) }),
      outputSchema: chatSourceListSchema,
      requestContextSchema: mastraProjectContextSchema,
      execute: async ({ documentIds }, context) => ({
        sources: await repository.documentFetch({
          documentIds,
          projectId: projectIdFromContext(context),
        }),
      }),
    }),
    graphQuery: createTool({
      id: mastraToolIds.graphQuery,
      description: 'Query graph-backed document metadata for the active project.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(10), query: z.string() }),
      outputSchema: chatSourceListSchema,
      requestContextSchema: mastraProjectContextSchema,
      execute: async ({ limit, query }, context) => ({
        sources: await repository.graphQuery({
          limit,
          projectId: projectIdFromContext(context),
          query,
        }),
      }),
    }),
    parsedDocFetch: createTool({
      id: mastraToolIds.parsedDocFetch,
      description: 'Fetch parsed document metadata for the active project.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(10) }),
      outputSchema: chatSourceListSchema,
      requestContextSchema: mastraProjectContextSchema,
      execute: async ({ limit }, context) => ({
        sources: await repository.parsedDocFetch({
          limit,
          projectId: projectIdFromContext(context),
        }),
      }),
    }),
    rawDocumentFetch: createTool({
      id: mastraToolIds.rawDocumentFetch,
      description:
        'Fetch raw document metadata for the active project without returning raw body text.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(10),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(64 * 1024),
      }),
      outputSchema: chatSourceListSchema,
      requestContextSchema: mastraProjectContextSchema,
      execute: async ({ limit, maxBytes }, context) => ({
        sources: await repository.rawDocumentFetch({
          limit,
          maxBytes,
          projectId: projectIdFromContext(context),
        }),
      }),
    }),
    vectorSearch: createTool({
      id: mastraToolIds.vectorSearch,
      description: 'Search vector-indexed document metadata for the active project.',
      inputSchema: z.object({
        embedding: z.array(z.number()).min(1),
        limit: z.number().int().min(1).max(10),
        query: z.string(),
      }),
      outputSchema: chatSourceListSchema,
      requestContextSchema: mastraProjectContextSchema,
      execute: async ({ embedding, limit, query }, context) => ({
        sources: await repository.vectorSearch({
          embedding,
          limit,
          projectId: projectIdFromContext(context),
          query,
        }),
      }),
    }),
  };
}

export function createProjectChatAgent(input: {
  readonly model?: string;
  readonly tools: ReturnType<typeof createProjectChatTools>;
}): Agent {
  return new Agent({
    id: mastraAgentIds.projectChat,
    name: 'Project Chat Agent',
    instructions: [
      'あなたはプロジェクト知識グラフのアナリストです。',
      '回答に使えるのは requestContext.projectId で固定された project の data だけです。',
      '他 project の id、raw body、parsed body、secret、OAuth token、Gemini API key を出してはいけません。',
      '必要に応じて vector-search、graph-query、document-fetch、raw-document-fetch、parsed-doc-fetch を使い、source を明示します。',
    ].join('\n'),
    model: input.model ?? 'google/gemini-2.5-flash',
    tools: input.tools,
  });
}

export function createGenerateReportWorkflow(options: RunGenerateReportOptions) {
  const inputSchema = z.object({
    nowIso: z.string().datetime().optional(),
    periodKind: z.literal('weekly').optional(),
    projectSlug: z.string().min(1),
  });
  const outputSchema = z.object({
    reportId: z.string(),
    reportUrl: z.string(),
    schemaVersion: z.literal('v1'),
    storageUri: z.string(),
  });
  const generateReportStep = createStep({
    id: 'generate-report-json',
    inputSchema,
    outputSchema,
    execute: async ({ inputData }) => {
      const result = await runGenerateReport({
        options: {
          ...options,
          now: inputData.nowIso ? new Date(inputData.nowIso) : options.now,
          periodKind: inputData.periodKind ?? options.periodKind,
        },
        projectSlug: inputData.projectSlug,
      });
      return {
        reportId: result.report.report_id,
        reportUrl: result.reportUrl,
        schemaVersion: result.report.schema_version,
        storageUri: result.storageUri,
      };
    },
  });

  return createWorkflow({
    id: mastraWorkflowIds.generateReport,
    inputSchema,
    outputSchema,
  })
    .then(generateReportStep)
    .commit();
}

export function createPufuLensMastraRuntime(
  dependencies: PufuLensMastraDependencies,
): PufuLensMastraRuntime {
  const chatProvider = dependencies.chatProvider ?? createExtractiveChatProvider();
  const reportProvider = dependencies.reportProvider ?? createExtractiveReportProvider();
  const projectChatTools = createProjectChatTools(dependencies.chatRepository);
  const projectChatAgent = createProjectChatAgent({ tools: projectChatTools });
  const generateReportWorkflow = createGenerateReportWorkflow({
    provider: reportProvider,
    repository: dependencies.reportRepository,
    storage: dependencies.reportStorage,
  });
  const mastra = new Mastra({
    agents: { projectChatAgent },
    workflows: { generateReportWorkflow },
  });

  return {
    generateReportWorkflow,
    mastra,
    projectChatAgent,
    projectChatTools,
    async runGenerateReportWorkflow(input) {
      return runGenerateReport({
        options: {
          provider: reportProvider,
          repository: dependencies.reportRepository,
          storage: dependencies.reportStorage,
          now: input.now,
          periodKind: input.periodKind,
        },
        projectSlug: input.projectSlug,
      });
    },
    async runProjectChat(input) {
      return runPrivateChat(input, {
        provider: chatProvider,
        repository: dependencies.chatRepository,
      });
    },
  };
}
