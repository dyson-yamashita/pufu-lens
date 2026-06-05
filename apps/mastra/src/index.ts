import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createTool } from '@mastra/core/tools';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import type { ChatRepository } from '../../web/src/chat.ts';
import { createPufuScoreFromReport } from '../../web/src/pufu-score.ts';
import {
  createExtractiveReportProvider,
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
  pufuScoreGenerate: 'pufu-score-generate',
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

const reportSourceSchema = z.object({
  canonical_uri: z.string().optional(),
  doc_type: z.string().optional(),
  document_id: z.string().optional(),
  occurred_at: z.string().nullable().optional(),
  snippet: z.string().optional(),
  title: z.string().optional(),
});

const reportSectionSchema = z.object({
  id: z.enum(['activity', 'issues', 'progress', 'risks']),
  markdown: z.string(),
  metrics: z.record(z.string(), z.number()).optional(),
  sources: z.array(reportSourceSchema).optional(),
  title: z.string(),
});

const pufuScoreGenerateInputSchema = z.object({
  period: z.object({ end: z.string(), start: z.string() }),
  pufuSources: z.array(reportSourceSchema).default([]),
  reportId: z.string().default('agent-generated-pufu'),
  sections: z.array(reportSectionSchema).default([]),
  summary: z.string(),
  title: z.string(),
});

const pufuScoreGenerateOutputSchema = z.object({
  score: z.unknown(),
});

type PufuScoreGenerateInput = z.infer<typeof pufuScoreGenerateInputSchema>;

export function createProjectChatTools(repository: ChatRepository) {
  const projectIdFromContext = (
    context:
      | {
          requestContext?:
            | { get<T>(key: string): T }
            | {
                projectId?: string;
              };
        }
      | undefined,
  ): string => {
    const requestContext = context?.requestContext;
    const projectId =
      requestContext && 'get' in requestContext && typeof requestContext.get === 'function'
        ? requestContext.get<string>('projectId')
        : requestContext && 'projectId' in requestContext
          ? requestContext.projectId
          : undefined;
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
    pufuScoreGenerate: createTool({
      id: mastraToolIds.pufuScoreGenerate,
      description:
        'Generate ProjectScore (プ譜) data from project data source records. Use pufuSources as the primary input and structure gaining goal, win condition, intermediate purposes, measures, and eight elements instead of quoting report prose into pufu boxes.',
      inputSchema: pufuScoreGenerateInputSchema,
      outputSchema: pufuScoreGenerateOutputSchema,
      requestContextSchema: mastraProjectContextSchema,
      execute: async (input: PufuScoreGenerateInput, context) => {
        projectIdFromContext(context);
        return {
          score: createPufuScoreFromReport({
            period: input.period,
            pufu_sources: input.pufuSources.map((source, index) => ({
              canonical_uri: source.canonical_uri ?? '',
              doc_type: source.doc_type ?? 'unknown',
              document_id: source.document_id ?? `agent-source-${index}`,
              occurred_at: source.occurred_at ?? null,
              snippet: source.snippet ?? '',
              title: source.title ?? source.snippet ?? `データソース ${index + 1}`,
            })),
            report_id: input.reportId,
            sections: input.sections.map((section) => ({
              ...section,
              sources: section.sources?.map((source) => ({
                canonical_uri: source.canonical_uri ?? '',
                doc_type: source.doc_type ?? 'unknown',
                document_id: source.document_id ?? '',
                snippet: source.snippet ?? '',
              })),
            })),
            summary: input.summary,
            title: input.title,
          }),
        };
      },
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
      'プ譜データを作る場合は、レポート本文ではなく data source の title、snippet、doc_type、canonical_uri を pufu-score-generate の pufuSources に渡し、獲得目標、勝利条件、中間目的、施策、廟算八要素として再構成します。',
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
  };
}
