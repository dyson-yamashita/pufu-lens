import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createTool } from '@mastra/core/tools';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import type { ChatRepository } from '../../web/src/chat.ts';
import { publicChatSources } from '../../web/src/chat.ts';
import { createPufuScoreFromReport } from '../../web/src/pufu-score.ts';
import {
  createExtractiveReportProvider,
  type PublicContextBundleV1,
  type PublicReportJsonV1,
  type ReportGenerationProvider,
  type ReportPeriodKind,
  type ReportRepository,
  type RunGenerateReportOptions,
  runGenerateReport,
} from '../../web/src/report.ts';

export const mastraAppName = 'pufu-lens-mastra';

export const mastraAgentIds = {
  crossProjectResearch: 'cross-project-research-agent',
  projectChat: 'project-chat-agent',
  publicReportChat: 'public-report-chat-agent',
} as const;

export const mastraWorkflowIds = {
  generateReport: 'generate-report',
} as const;

export const mastraToolIds = {
  crossProjectDataSourceStatus: 'cross-project-data-source-status',
  crossProjectDocumentSearch: 'cross-project-document-search',
  crossProjectList: 'cross-project-list',
  documentFetch: 'document-fetch',
  graphQuery: 'graph-query',
  parsedDocFetch: 'parsed-doc-fetch',
  pufuScoreGenerate: 'pufu-score-generate',
  publicContextFetch: 'public-context-fetch',
  publicReportFetch: 'public-report-fetch',
  rawDocumentFetch: 'raw-document-fetch',
  vectorSearch: 'vector-search',
} as const;

export interface MastraProjectContext {
  readonly projectId: string;
}

export interface MastraPublicReportContext {
  readonly contextBundle: PublicContextBundleV1;
  readonly projectSlug: string;
  readonly report: PublicReportJsonV1;
  readonly reportId: string;
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

export interface CrossProjectSummary {
  readonly description: string | null;
  readonly documentCount: number;
  readonly enabledDataSourceCount: number;
  readonly name: string;
  readonly rawDocumentCount: number;
  readonly slug: string;
}

export interface CrossProjectDocumentSource {
  readonly canonicalUri: string;
  readonly docType: string;
  readonly documentId: string;
  readonly occurredAt: string | null;
  readonly projectName: string;
  readonly projectSlug: string;
  readonly summary: string;
  readonly title: string;
}

export interface CrossProjectDataSourceStatus {
  readonly enabled: boolean;
  readonly lastCheckedAt: string | null;
  readonly name: string;
  readonly projectName: string;
  readonly projectSlug: string;
  readonly sourceType: string;
}

export interface CrossProjectInvestigationRepository {
  dataSourceStatus(input: {
    readonly limit: number;
    readonly projectSlugs?: readonly string[];
    readonly sourceTypes?: readonly string[];
  }): Promise<CrossProjectDataSourceStatus[]>;
  listProjects(input: { readonly limit: number }): Promise<CrossProjectSummary[]>;
  searchDocuments(input: {
    readonly limit: number;
    readonly projectSlugs?: readonly string[];
    readonly query: string;
    readonly sourceTypes?: readonly string[];
  }): Promise<CrossProjectDocumentSource[]>;
}

export interface PufuLensMastraDependencies {
  readonly chatRepository: ChatRepository;
  readonly crossProjectInvestigationRepository?: CrossProjectInvestigationRepository;
  readonly reportProvider?: ReportGenerationProvider;
  readonly reportRepository: ReportRepository;
  readonly reportStorage: ObjectStorage;
}

export interface PufuLensMastraRuntime {
  readonly crossProjectResearchAgent?: Agent;
  readonly crossProjectResearchTools?: ReturnType<typeof createCrossProjectResearchTools>;
  readonly mastra: Mastra;
  readonly projectChatTools: ReturnType<typeof createProjectChatTools>;
  readonly projectChatAgent: Agent;
  readonly publicReportChatTools: ReturnType<typeof createPublicReportChatTools>;
  readonly publicReportChatAgent: Agent;
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

const publicChatSourceSchema = z.object({
  label: z.string(),
  publicSourceId: z.string(),
  sectionId: z.string(),
});

const publicReportContextSchema = z.object({
  contextBundle: z.unknown(),
  projectSlug: z.string().min(1),
  report: z.unknown(),
  reportId: z.string().min(1),
});

const crossProjectSummarySchema = z.object({
  description: z.string().nullable(),
  documentCount: z.number().int().min(0),
  enabledDataSourceCount: z.number().int().min(0),
  name: z.string(),
  rawDocumentCount: z.number().int().min(0),
  slug: z.string(),
});

const crossProjectDocumentSourceSchema = z.object({
  canonicalUri: z.string(),
  docType: z.string(),
  documentId: z.string(),
  occurredAt: z.string().nullable(),
  projectName: z.string(),
  projectSlug: z.string(),
  summary: z.string(),
  title: z.string(),
});

const crossProjectDataSourceStatusSchema = z.object({
  enabled: z.boolean(),
  lastCheckedAt: z.string().nullable(),
  name: z.string(),
  projectName: z.string(),
  projectSlug: z.string(),
  sourceType: z.string(),
});

const optionalProjectSlugFilterSchema = z.array(z.string().min(1)).max(20).optional();
const optionalSourceTypeFilterSchema = z
  .array(z.enum(['drive', 'github', 'gmail', 'web']))
  .max(4)
  .optional();

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

export function createCrossProjectResearchTools(repository: CrossProjectInvestigationRepository) {
  return {
    dataSourceStatus: createTool({
      id: mastraToolIds.crossProjectDataSourceStatus,
      description:
        'List enabled and disabled data sources across projects without exposing OAuth tokens or source configs.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(20),
        projectSlugs: optionalProjectSlugFilterSchema,
        sourceTypes: optionalSourceTypeFilterSchema,
      }),
      outputSchema: z.object({ dataSources: z.array(crossProjectDataSourceStatusSchema) }),
      execute: async ({ limit, projectSlugs, sourceTypes }) => ({
        dataSources: await repository.dataSourceStatus({ limit, projectSlugs, sourceTypes }),
      }),
    }),
    documentSearch: createTool({
      id: mastraToolIds.crossProjectDocumentSearch,
      description:
        'Search document titles and summaries across projects. Returns metadata and summaries only, never raw or parsed body text.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(25).default(10),
        projectSlugs: optionalProjectSlugFilterSchema,
        query: z.string().min(1),
        sourceTypes: optionalSourceTypeFilterSchema,
      }),
      outputSchema: z.object({ sources: z.array(crossProjectDocumentSourceSchema) }),
      execute: async ({ limit, projectSlugs, query, sourceTypes }) => ({
        sources: await repository.searchDocuments({ limit, projectSlugs, query, sourceTypes }),
      }),
    }),
    listProjects: createTool({
      id: mastraToolIds.crossProjectList,
      description:
        'List project-level inventory counts for cross-project investigation. Does not return project UUIDs or storage prefixes.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
      outputSchema: z.object({ projects: z.array(crossProjectSummarySchema) }),
      execute: async ({ limit }) => ({
        projects: await repository.listProjects({ limit }),
      }),
    }),
  };
}

export function createCrossProjectResearchAgent(input: {
  readonly model?: string;
  readonly tools: ReturnType<typeof createCrossProjectResearchTools>;
}): Agent {
  return new Agent({
    id: mastraAgentIds.crossProjectResearch,
    name: 'Cross Project Research Agent',
    instructions: [
      'あなたは Pufu Lens の内部調査用アナリストです。',
      '複数 project を横断して、project inventory、data source 状態、document title / summary の傾向を比較します。',
      'Web アプリ利用者向けではなく、Mastra Studio での運用調査だけを想定します。',
      'raw body、parsed body、OAuth token、secret、API key、storage prefix、project UUID、個人情報を出してはいけません。',
      '回答では project slug、source type、document title、canonical URI、summary を根拠として示します。',
      '未取得の本文や非公開詳細を推測せず、必要なら追加の収集・解析作業として明示します。',
    ].join('\n'),
    model: input.model ?? 'google/gemini-2.5-flash',
    tools: input.tools,
  });
}

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

export function createPublicReportChatTools() {
  const contextFromRequest = (
    context:
      | {
          requestContext?: { get<T>(key: string): T } | Partial<MastraPublicReportContext>;
        }
      | undefined,
  ): MastraPublicReportContext => {
    const requestContext = context?.requestContext;
    const getValue = <T>(key: keyof MastraPublicReportContext): T | undefined => {
      if (!requestContext) {
        return undefined;
      }
      if ('get' in requestContext && typeof requestContext.get === 'function') {
        return requestContext.get<T>(key);
      }
      const objectContext = requestContext as Partial<MastraPublicReportContext>;
      return key in objectContext ? (objectContext[key] as T) : undefined;
    };
    const projectSlug = getValue<string>('projectSlug');
    const reportId = getValue<string>('reportId');
    const report = getValue<PublicReportJsonV1>('report');
    const contextBundle = getValue<PublicContextBundleV1>('contextBundle');
    if (!projectSlug || !reportId || !report || !contextBundle) {
      throw new Error(
        'Mastra public report tool requires requestContext.projectSlug, reportId, report, and contextBundle.',
      );
    }
    return { contextBundle, projectSlug, report, reportId };
  };

  return {
    publicContextFetch: createTool({
      id: mastraToolIds.publicContextFetch,
      description:
        'Fetch the redacted public context bundle already resolved by Next.js. Never accepts storage URI, project ID, source URI, or raw document input.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        contextBundle: z.unknown(),
        resultCount: z.number().int().min(0),
        sources: z.array(publicChatSourceSchema),
      }),
      requestContextSchema: publicReportContextSchema,
      execute: async (_input, context) => {
        const publicContext = contextFromRequest(context);
        return {
          contextBundle: publicContext.contextBundle,
          resultCount: publicContext.contextBundle.sections.length,
          sources: publicChatSources(publicContext.report, publicContext.contextBundle),
        };
      },
    }),
    publicReportFetch: createTool({
      id: mastraToolIds.publicReportFetch,
      description:
        'Fetch the redacted public report already resolved by Next.js. Never accepts storage URI, project ID, source URI, or raw document input.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        report: z.unknown(),
        resultCount: z.number().int().min(0),
      }),
      requestContextSchema: publicReportContextSchema,
      execute: async (_input, context) => {
        const publicContext = contextFromRequest(context);
        return { report: publicContext.report, resultCount: 1 };
      },
    }),
  };
}

export function createPublicReportChatAgent(input: {
  readonly model?: string;
  readonly tools: ReturnType<typeof createPublicReportChatTools>;
}): Agent {
  return new Agent({
    id: mastraAgentIds.publicReportChat,
    name: 'Public Report Chat Agent',
    instructions: [
      'あなたは公開レポートの読者向けアシスタントです。',
      '回答に使える情報は requestContext に固定された redaction 済み public report JSON と public context bundle だけです。',
      '回答前に必ず 1) public-report-fetch、2) public-context-fetch の順で両方の tool を呼び出します。',
      'public-context-fetch の sources を確認してから、section id または public source id を根拠に回答します。',
      'public-report-fetch だけで回答してはいけません。',
      '個人情報、メールアドレス、OAuth 情報、secret、未公開 URL、raw / parsed の本文全文を出してはいけません。',
      'report の内容と対象 project の公開済み情報に関係しない質問には回答しません。',
      '他 project、内部データ、未公開資料、一般雑談、外部調査、コード生成の依頼には回答しません。',
      '根拠は public report の section id または公開 source id だけで示します。',
      'tool に URI、projectId、storageUri、sourceUri を指定しようとしてはいけません。',
      '不明な内容は推測せず、公開情報だけでは回答できないと伝えます。',
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
  const crossProjectResearchTools = dependencies.crossProjectInvestigationRepository
    ? createCrossProjectResearchTools(dependencies.crossProjectInvestigationRepository)
    : undefined;
  const crossProjectResearchAgent = crossProjectResearchTools
    ? createCrossProjectResearchAgent({ tools: crossProjectResearchTools })
    : undefined;
  const projectChatTools = createProjectChatTools(dependencies.chatRepository);
  const projectChatAgent = createProjectChatAgent({ tools: projectChatTools });
  const publicReportChatTools = createPublicReportChatTools();
  const publicReportChatAgent = createPublicReportChatAgent({ tools: publicReportChatTools });
  const generateReportWorkflow = createGenerateReportWorkflow({
    provider: reportProvider,
    repository: dependencies.reportRepository,
    storage: dependencies.reportStorage,
  });
  const mastra = new Mastra({
    agents: {
      ...(crossProjectResearchAgent ? { crossProjectResearchAgent } : {}),
      projectChatAgent,
      publicReportChatAgent,
    },
    workflows: { generateReportWorkflow },
  });

  return {
    crossProjectResearchAgent,
    crossProjectResearchTools,
    generateReportWorkflow,
    mastra,
    projectChatAgent,
    projectChatTools,
    publicReportChatAgent,
    publicReportChatTools,
  };
}
