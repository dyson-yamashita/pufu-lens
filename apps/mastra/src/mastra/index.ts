import { Mastra } from '@mastra/core/mastra';
import type { ChatRepository } from '@pufu-lens/web/chat';
import { createPostgresChatRepository } from '@pufu-lens/web/chat';
import type { ReportRepository } from '@pufu-lens/web/report';
import {
  createExtractiveReportProvider,
  createGeminiReportProviderWithExtractiveFallback,
  createPostgresReportRepository,
  createReportStorageFromEnv,
  type ReportGenerationProvider,
} from '@pufu-lens/web/report';
import postgres from 'postgres';
import type { ObjectStorage } from '../../../../packages/storage/src/object-storage.ts';
import { createChatEmbeddingProvider } from '../chat-embedding-provider.ts';
import {
  type CrossProjectInvestigationRepository,
  createCrossProjectResearchAgent,
  createCrossProjectResearchTools,
  createGenerateReportWorkflow,
  createPrivateChatQueryPlannerAgent,
  createPrivateChatSearchWorkflow,
  createProjectChatAgent,
  createProjectChatTools,
  createPublicReportChatAgent,
  createPublicReportChatTools,
} from '../index.ts';
import { resolveChatModel } from '../model-runtime.ts';
import { reportScheduleDispatcherRoute } from '../report-schedule-dispatcher-route.ts';
import { sourceSyncDispatcherRoute } from '../source-sync-dispatcher-route.ts';
import { syntheticMonitorRoute } from '../synthetic-monitor-route.ts';

if (process.env.GEMINI_API_KEY) {
  process.env.GOOGLE_API_KEY ??= process.env.GEMINI_API_KEY;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY ??= process.env.GEMINI_API_KEY;
}

const databaseUrl = process.env.DATABASE_URL;
const sql = postgres(databaseUrl ?? 'postgresql://localhost/pufu_lens_mastra_build', { max: 5 });
const storage = createStorage();
const chatRepository = databaseUrl
  ? createPostgresChatRepository(sql, { rawStorage: storage })
  : unavailableChatRepository('DATABASE_URL');
const reportRepository = databaseUrl
  ? createPostgresReportRepository(sql)
  : unavailableReportRepository('DATABASE_URL');
const crossProjectInvestigationRepository = databaseUrl
  ? createPostgresCrossProjectInvestigationRepository(sql)
  : unavailableCrossProjectInvestigationRepository('DATABASE_URL');
const crossProjectResearchTools = createCrossProjectResearchTools(
  crossProjectInvestigationRepository,
);
const chatModel = resolveChatModel();
const crossProjectResearchAgent = createCrossProjectResearchAgent({
  model: chatModel,
  tools: crossProjectResearchTools,
});
const chatEmbeddingProvider = createChatEmbeddingProvider();
const projectChatTools = createProjectChatTools(chatRepository, chatEmbeddingProvider);
const projectChatAgent = createProjectChatAgent({ model: chatModel, tools: projectChatTools });
const privateChatQueryPlannerAgent = createPrivateChatQueryPlannerAgent({ model: chatModel });
const publicReportChatTools = createPublicReportChatTools();
const publicReportChatAgent = createPublicReportChatAgent({
  model: chatModel,
  tools: publicReportChatTools,
});
const generateReportWorkflow = createGenerateReportWorkflow({
  provider: createReportProvider(),
  rawReadViewRepository: { fetchRawReadView: chatRepository.rawReadViewFetch },
  repository: reportRepository,
  storage,
});
const privateChatSearchWorkflow = createPrivateChatSearchWorkflow({
  chatRepository,
  embeddingProvider: chatEmbeddingProvider,
  projectChatAgent,
  queryPlannerAgent: privateChatQueryPlannerAgent,
});

export const mastra = new Mastra({
  agents: {
    crossProjectResearchAgent,
    projectChatAgent,
    publicReportChatAgent,
  },
  bundler: {
    // @google-cloud/storage is reachable from @pufu-lens/storage's GcsObjectStorage.
    // It must be installed at runtime rather than bundled by the Mastra rollup analyzer.
    externals: ['@google-cloud/storage'],
  },
  server: {
    apiRoutes: [reportScheduleDispatcherRoute, sourceSyncDispatcherRoute, syntheticMonitorRoute],
  },
  workflows: { generateReportWorkflow, privateChatSearchWorkflow },
});

function createReportProvider(): ReportGenerationProvider {
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_CHAT_MODEL) {
    return createGeminiReportProviderWithExtractiveFallback({
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_CHAT_MODEL,
      onCountTokensFailure: (message) => {
        console.warn(
          'Gemini report countTokens failed in Mastra workflow; using conservative UTF-8 byte fallback.',
          message,
        );
      },
      onGenerateFailure: (message) => {
        console.warn(
          'Gemini report generation failed in Mastra workflow; falling back to extractive provider.',
          message,
        );
      },
    });
  }
  return createExtractiveReportProvider();
}

function createPostgresCrossProjectInvestigationRepository(
  db: postgres.Sql,
): CrossProjectInvestigationRepository {
  return {
    async dataSourceStatus({ limit, projectSlugs, sourceTypes }) {
      const rows = (await db`
        SELECT
          p.slug AS project_slug,
          p.name AS project_name,
          ds.source_type,
          ds.name,
          ds.enabled,
          ds.last_checked_at::text AS last_checked_at
        FROM public.data_sources ds
        JOIN public.projects p ON p.id = ds.project_id
        WHERE true
          ${projectSlugs?.length ? db`AND p.slug IN ${db(projectSlugs)}` : db``}
          ${sourceTypes?.length ? db`AND ds.source_type IN ${db(sourceTypes)}` : db``}
        ORDER BY p.slug, ds.source_type, ds.name
        LIMIT ${limit}
      `) as Array<{
        enabled: boolean;
        last_checked_at: string | null;
        name: string;
        project_name: string;
        project_slug: string;
        source_type: string;
      }>;
      return rows.map((row) => ({
        enabled: row.enabled,
        lastCheckedAt: row.last_checked_at,
        name: row.name,
        projectName: row.project_name,
        projectSlug: row.project_slug,
        sourceType: row.source_type,
      }));
    },
    async listProjects({ limit }) {
      const rows = (await db`
        SELECT
          p.slug,
          p.name,
          p.description,
          (
            SELECT count(*)::int
            FROM public.documents d
            WHERE d.project_id = p.id
          ) AS document_count,
          (
            SELECT count(*)::int
            FROM public.raw_documents rd
            WHERE rd.project_id = p.id
          ) AS raw_document_count,
          (
            SELECT count(*)::int
            FROM public.data_sources ds
            WHERE ds.project_id = p.id
              AND ds.enabled
          ) AS enabled_data_source_count
        FROM public.projects p
        ORDER BY p.slug
        LIMIT ${limit}
      `) as Array<{
        description: string | null;
        document_count: number;
        enabled_data_source_count: number;
        name: string;
        raw_document_count: number;
        slug: string;
      }>;
      return rows.map((row) => ({
        description: row.description,
        documentCount: row.document_count,
        enabledDataSourceCount: row.enabled_data_source_count,
        name: row.name,
        rawDocumentCount: row.raw_document_count,
        slug: row.slug,
      }));
    },
    async searchDocuments({ limit, projectSlugs, query, sourceTypes }) {
      const docTypes = projectDocTypes(sourceTypes);
      const escapedQuery = escapeIlikePattern(query);
      const likeQuery = `%${escapedQuery}%`;
      const rows = (await db`
        SELECT
          p.slug AS project_slug,
          p.name AS project_name,
          d.id::text AS document_id,
          d.doc_type,
          coalesce(d.title, 'Untitled') AS title,
          coalesce(d.summary, '') AS summary,
          coalesce(d.canonical_uri, '') AS canonical_uri,
          d.occurred_at::text AS occurred_at
        FROM public.documents d
        JOIN public.projects p ON p.id = d.project_id
        WHERE (
          d.title ILIKE ${likeQuery}
          OR d.summary ILIKE ${likeQuery}
          OR d.canonical_uri ILIKE ${likeQuery}
        )
          ${projectSlugs?.length ? db`AND p.slug IN ${db(projectSlugs)}` : db``}
          ${docTypes.length ? db`AND d.doc_type IN ${db(docTypes)}` : db``}
        ORDER BY d.occurred_at DESC NULLS LAST, d.updated_at DESC
        LIMIT ${limit}
      `) as Array<{
        canonical_uri: string;
        doc_type: string;
        document_id: string;
        occurred_at: string | null;
        project_name: string;
        project_slug: string;
        summary: string;
        title: string;
      }>;
      return rows.map((row) => ({
        canonicalUri: row.canonical_uri,
        docType: row.doc_type,
        documentId: row.document_id,
        occurredAt: row.occurred_at,
        projectName: row.project_name,
        projectSlug: row.project_slug,
        summary: row.summary,
        title: row.title,
      }));
    },
  };
}

function escapeIlikePattern(query: string): string {
  return query.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function projectDocTypes(sourceTypes: readonly string[] | undefined): string[] {
  const docTypes = new Set<string>();
  for (const sourceType of sourceTypes ?? []) {
    if (sourceType === 'drive') {
      docTypes.add('drive_doc');
    } else if (sourceType === 'github') {
      docTypes.add('issue');
      docTypes.add('pull_request');
    } else if (sourceType === 'gmail') {
      docTypes.add('email');
    } else if (sourceType === 'web') {
      docTypes.add('web_page');
    }
  }
  return [...docTypes];
}

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
    listPrivateChatHistoryForContext: unavailableMethod(envName),
    listPrivateChatHistoryForUi: unavailableMethod(envName),
    lookupProjectMember: unavailableMethod(envName),
    parsedDocFetch: unavailableMethod(envName),
    rawDocumentFetch: unavailableMethod(envName),
    rawReadViewFetch: unavailableMethod(envName),
    savePrivateChatTurn: unavailableMethod(envName),
    timelineSearch: unavailableMethod(envName),
    hybridSearch: unavailableMethod(envName),
  };
}

function unavailableReportRepository(envName: string): ReportRepository {
  return {
    insertReport: unavailableMethod(envName),
    listRecentDocuments: unavailableMethod(envName),
    listReports: unavailableMethod(envName),
    lookupProject: unavailableMethod(envName),
    lookupProjectMember: unavailableMethod(envName),
    readLatestScheduledReport: unavailableMethod(envName),
    readReportMetadata: unavailableMethod(envName),
    deleteReport: unavailableMethod(envName),
    setReportPublicState: unavailableMethod(envName),
  };
}

function unavailableCrossProjectInvestigationRepository(
  envName: string,
): CrossProjectInvestigationRepository {
  return {
    dataSourceStatus: unavailableMethod(envName),
    listProjects: unavailableMethod(envName),
    searchDocuments: unavailableMethod(envName),
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
