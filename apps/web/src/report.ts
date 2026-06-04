import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { LocalFsObjectStorage } from '../../../packages/storage/src/local-fs.ts';
import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import {
  type BusinessHoursConfig,
  isWithinBusinessHours,
  ProjectAccessDeniedError,
} from './chat.ts';

export type ReportPeriodKind = 'weekly';

export interface ReportPeriod {
  readonly end: string;
  readonly start: string;
}

export interface PrivateReportSource {
  readonly canonical_uri: string;
  readonly doc_type: string;
  readonly document_id: string;
  readonly snippet: string;
}

export interface PrivateReportSection {
  readonly id: 'activity' | 'issues' | 'progress' | 'risks';
  readonly items?: readonly Record<string, unknown>[];
  readonly markdown: string;
  readonly metrics?: Record<string, number>;
  readonly sources?: readonly PrivateReportSource[];
  readonly title: string;
}

export interface PrivateReportJsonV1 {
  readonly generated_at: string;
  readonly period: ReportPeriod;
  readonly project_id: string;
  readonly report_id: string;
  readonly schema_version: 'v1';
  readonly sections: readonly PrivateReportSection[];
  readonly summary: string;
  readonly title: string;
}

export interface ReportListItem {
  readonly createdAt: string;
  readonly id: string;
  readonly isPublic: boolean;
  readonly period: ReportPeriod;
  readonly schemaVersion: string;
  readonly storageUri: string;
  readonly summary: string;
  readonly title: string;
}

export interface ReportDocumentRecord {
  readonly canonicalUri: string;
  readonly docType: string;
  readonly documentId: string;
  readonly occurredAt: string | null;
  readonly summary: string;
  readonly title: string;
}

export interface ReportRepository {
  insertReport(input: {
    readonly chunks: readonly PreparedReportChunk[];
    readonly generatedBy: string;
    readonly projectId: string;
    readonly report: PrivateReportJsonV1;
    readonly storageUri: string;
  }): Promise<void>;
  listRecentDocuments(input: {
    readonly limit: number;
    readonly period: ReportPeriod;
    readonly projectId: string;
  }): Promise<readonly ReportDocumentRecord[]>;
  listReports(input: { readonly projectId: string }): Promise<readonly ReportListItem[]>;
  lookupProject(input: {
    readonly projectSlug: string;
  }): Promise<{ readonly id: string; readonly slug: string } | undefined>;
  lookupProjectMember(input: {
    readonly projectSlug: string;
    readonly userId: string;
  }): Promise<{ readonly id: string; readonly slug: string } | undefined>;
  readReportMetadata(input: {
    readonly projectId: string;
    readonly reportId: string;
  }): Promise<ReportListItem | undefined>;
}

export interface ReportGenerationProvider {
  generate(input: {
    readonly documents: readonly ReportDocumentRecord[];
    readonly period: ReportPeriod;
    readonly projectSlug: string;
  }): Promise<Pick<PrivateReportJsonV1, 'sections' | 'summary' | 'title'>>;
}

export interface RunGenerateReportOptions {
  readonly generatedBy?: string;
  readonly now?: Date;
  readonly periodKind?: ReportPeriodKind;
  readonly provider: ReportGenerationProvider;
  readonly repository: ReportRepository;
  readonly storage: ObjectStorage;
}

export interface GenerateReportResult {
  readonly report: PrivateReportJsonV1;
  readonly reportUrl: string;
  readonly storageUri: string;
}

export interface ReportAccessOptions {
  readonly businessHours?: BusinessHoursConfig;
  readonly now?: Date;
  readonly repository: ReportRepository;
  readonly storage?: ObjectStorage;
}

export interface PreparedReportChunk {
  readonly chunkIndex: number;
  readonly content: string;
  readonly embedding: readonly number[];
  readonly metadata: Record<string, unknown>;
}

const DEFAULT_BUSINESS_HOURS: BusinessHoursConfig = {
  enabled: false,
  endHour: 18,
  startHour: 9,
  timeZone: 'Asia/Tokyo',
};

export async function runGenerateReport(input: {
  readonly options: RunGenerateReportOptions;
  readonly projectSlug: string;
}): Promise<GenerateReportResult> {
  const now = input.options.now ?? new Date();
  const period = resolveReportPeriod(now, input.options.periodKind ?? 'weekly');
  const project = await input.options.repository.lookupProject({
    projectSlug: input.projectSlug,
  });
  if (!project) {
    throw new Error(`Project not found: ${input.projectSlug}`);
  }

  const documents = await input.options.repository.listRecentDocuments({
    limit: 30,
    period,
    projectId: project.id,
  });
  const generated = await input.options.provider.generate({
    documents,
    period,
    projectSlug: project.slug,
  });
  const reportId = randomUUID();
  const report: PrivateReportJsonV1 = {
    generated_at: now.toISOString(),
    period,
    project_id: project.id,
    report_id: reportId,
    schema_version: 'v1',
    sections: generated.sections,
    summary: generated.summary,
    title: generated.title,
  };
  validatePrivateReportJson(report);

  const storageUri = `${project.slug}/reports/private/${reportId}.json`;
  const put = await input.options.storage.put(storageUri, `${JSON.stringify(report, null, 2)}\n`, {
    cacheControl: 'private, max-age=3600',
    contentType: 'application/json; charset=utf-8',
  });
  await input.options.repository.insertReport({
    chunks: prepareReportChunks(report),
    generatedBy: input.options.generatedBy ?? 'generate-report-job',
    projectId: project.id,
    report,
    storageUri: put.uri,
  });

  return {
    report,
    reportUrl: `/projects/${project.slug}/reports/${report.report_id}`,
    storageUri: put.uri,
  };
}

export async function listPrivateReports(input: {
  readonly options: ReportAccessOptions;
  readonly projectSlug: string;
  readonly userId: string;
}): Promise<
  | { readonly reports: readonly ReportListItem[]; readonly status: 'ok' }
  | { readonly reports: readonly []; readonly status: 'db_outside_business_hours' }
> {
  if (!isReportDbAvailable(input.options)) {
    return { reports: [], status: 'db_outside_business_hours' };
  }
  const project = await lookupMemberOrThrow(input);
  return {
    reports: await input.options.repository.listReports({ projectId: project.id }),
    status: 'ok',
  };
}

export async function getPrivateReport(input: {
  readonly options: ReportAccessOptions & { readonly storage: ObjectStorage };
  readonly projectSlug: string;
  readonly reportId: string;
  readonly userId: string;
}): Promise<
  | { readonly report: PrivateReportJsonV1; readonly status: 'ok' }
  | { readonly report: null; readonly status: 'db_outside_business_hours' }
> {
  if (!isReportDbAvailable(input.options)) {
    return { report: null, status: 'db_outside_business_hours' };
  }
  const project = await lookupMemberOrThrow(input);
  const metadata = await input.options.repository.readReportMetadata({
    projectId: project.id,
    reportId: input.reportId,
  });
  if (!metadata) {
    throw new ReportNotFoundError(input.reportId);
  }
  const report = JSON.parse(await input.options.storage.getText(metadata.storageUri)) as unknown;
  validatePrivateReportJson(report);
  return { report, status: 'ok' };
}

export class ReportNotFoundError extends Error {
  readonly reportId: string;

  constructor(reportId: string) {
    super(`Report not found: ${reportId}`);
    this.name = 'ReportNotFoundError';
    this.reportId = reportId;
  }
}

export function createExtractiveReportProvider(): ReportGenerationProvider {
  return {
    async generate({ documents, period }) {
      const sourceDocuments = documents.slice(0, 8);
      const issueDocuments = documents.filter((document) => document.docType === 'issue');
      const pullRequests = documents.filter((document) => document.docType === 'pull_request');
      const risks = documents.filter((document) =>
        `${document.title} ${document.summary}`
          .toLowerCase()
          .match(/risk|block|fail|error|遅延|障害/),
      );
      const sources = sourceDocuments.map((document) => ({
        canonical_uri: document.canonicalUri,
        doc_type: document.docType,
        document_id: document.documentId,
        snippet: truncate(document.summary || document.title, 220),
      }));
      return {
        sections: [
          {
            id: 'activity',
            markdown: sourceDocuments.length
              ? sourceDocuments.map((document) => `- ${document.title}`).join('\n')
              : '- 対象期間の indexed document はありません。',
            sources,
            title: 'アクティビティ',
          },
          {
            id: 'issues',
            items: issueDocuments.map((document) => ({
              document_id: document.documentId,
              title: document.title,
            })),
            markdown: issueDocuments.length
              ? issueDocuments.map((document) => `- ${document.title}`).join('\n')
              : '- 未解決 Issue 候補は見つかりませんでした。',
            title: '未解決 Issue',
          },
          {
            id: 'progress',
            markdown: `対象期間 ${period.start} から ${period.end} に ${documents.length} 件の document を確認しました。`,
            metrics: {
              documents: documents.length,
              merged_prs: pullRequests.length,
              open_issues: issueDocuments.length,
            },
            title: '進捗',
          },
          {
            id: 'risks',
            items: risks.map((document) => ({
              document_id: document.documentId,
              title: document.title,
            })),
            markdown: risks.length
              ? risks.map((document) => `- ${document.title}`).join('\n')
              : '- 重大なリスク候補は見つかりませんでした。',
            title: 'リスク',
          },
        ],
        summary:
          documents.length > 0
            ? `${documents.length} 件の indexed document から週次レポートを生成しました。`
            : '対象期間の indexed document はありません。',
        title: `週次レポート ${period.start} - ${period.end}`,
      };
    },
  };
}

export function createGeminiReportProvider(input: {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly model: string;
}): ReportGenerationProvider {
  if (!input.apiKey) {
    throw new Error('GEMINI_API_KEY is required for Gemini report generation.');
  }
  if (!input.model) {
    throw new Error('GEMINI_CHAT_MODEL is required for Gemini report generation.');
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint =
    input.endpoint ??
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      input.model,
    )}:generateContent`;
  return {
    async generate({ documents, period, projectSlug }) {
      const response = await fetchImpl(`${endpoint}?key=${encodeURIComponent(input.apiKey)}`, {
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: [
                    'Return only JSON for Pufu Lens private report schema v1 fields: title, summary, sections.',
                    'Sections must include activity, issues, progress, risks.',
                    `Project: ${projectSlug}`,
                    `Period: ${period.start} to ${period.end}`,
                    `Documents: ${JSON.stringify(documents)}`,
                  ].join('\n'),
                },
              ],
            },
          ],
          generationConfig: { responseMimeType: 'application/json' },
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error(`Gemini report request failed: HTTP ${response.status}`);
      }
      const body = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
      if (!text) {
        throw new Error('Gemini report response did not include JSON text.');
      }
      let generated: Pick<PrivateReportJsonV1, 'sections' | 'summary' | 'title'>;
      try {
        generated = JSON.parse(text) as Pick<PrivateReportJsonV1, 'sections' | 'summary' | 'title'>;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to parse Gemini report response as JSON: ${reason}. Raw text prefix: ${text.slice(
            0,
            500,
          )}`,
        );
      }
      validateGeneratedReport(generated);
      return generated;
    },
  };
}

export function createReportStorageFromEnv(): ObjectStorage {
  const driver = process.env.STORAGE_DRIVER ?? process.env.OBJECT_STORAGE_DRIVER ?? 'local';
  if (driver !== 'local') {
    throw new Error(`Unsupported object storage driver for report API: ${driver}`);
  }
  const root = process.env.STORAGE_ROOT ?? process.env.LOCAL_STORAGE_ROOT;
  if (!root) {
    throw new Error('STORAGE_ROOT or LOCAL_STORAGE_ROOT is required for local object storage.');
  }
  return new LocalFsObjectStorage(root);
}

export function createPostgresReportRepository(sql: postgres.Sql): ReportRepository {
  return {
    async lookupProjectMember({ projectSlug, userId }) {
      const rows = (await sql`
        SELECT p.id::text AS id, p.slug
        FROM public.projects p
        JOIN public.project_members pm ON pm.project_id = p.id
        WHERE p.slug = ${projectSlug}
          AND pm.user_id = ${userId}
      `) as Array<{ id: string; slug: string }>;
      return rows[0];
    },
    async lookupProject({ projectSlug }) {
      const rows = (await sql`
        SELECT p.id::text AS id, p.slug
        FROM public.projects p
        WHERE p.slug = ${projectSlug}
      `) as Array<{ id: string; slug: string }>;
      return rows[0];
    },
    async listRecentDocuments({ limit, period, projectId }) {
      const rows = (await sql`
        SELECT
          d.id::text AS document_id,
          d.doc_type,
          coalesce(d.title, 'Untitled') AS title,
          coalesce(d.summary, '') AS summary,
          coalesce(d.canonical_uri, '') AS canonical_uri,
          d.occurred_at
        FROM public.documents d
        WHERE d.project_id = ${projectId}
          AND (
            d.occurred_at IS NULL
            OR (
              d.occurred_at >= ${period.start}::timestamptz
              AND d.occurred_at < ${period.end}::timestamptz + interval '1 day'
            )
          )
        ORDER BY d.occurred_at DESC NULLS LAST, d.updated_at DESC
        LIMIT ${limit}
      `) as ReportDocumentRow[];
      return rows.map(documentFromRow);
    },
    async insertReport({ chunks, generatedBy, projectId, report, storageUri }) {
      await sql.begin(async (transaction) => {
        await transaction`
          INSERT INTO public.reports (
            id,
            project_id,
            title,
            summary,
            storage_uri,
            schema_version,
            period,
            is_public,
            generated_by
          )
          VALUES (
            ${report.report_id},
            ${projectId},
            ${report.title},
            ${report.summary},
            ${storageUri},
            ${report.schema_version},
            daterange(${report.period.start}::date, ${report.period.end}::date, '[]'),
            false,
            ${generatedBy}
          )
        `;
        for (const chunk of chunks) {
          await transaction`
            INSERT INTO public.report_chunks (
              project_id,
              report_id,
              chunk_index,
              content,
              embedding,
              metadata
            )
            VALUES (
              ${projectId},
              ${report.report_id},
              ${chunk.chunkIndex},
              ${chunk.content},
              ${vectorLiteral(chunk.embedding)}::vector,
              ${JSON.stringify(chunk.metadata)}::jsonb
            )
          `;
        }
      });
    },
    async listReports({ projectId }) {
      const rows = (await sql`
        SELECT
          id::text,
          title,
          coalesce(summary, '') AS summary,
          storage_uri,
          schema_version,
          lower(period)::text AS period_start,
          (upper(period) - 1)::text AS period_end,
          is_public,
          created_at
        FROM public.reports
        WHERE project_id = ${projectId}
        ORDER BY created_at DESC
      `) as ReportMetadataRow[];
      return rows.map(reportFromRow);
    },
    async readReportMetadata({ projectId, reportId }) {
      const rows = (await sql`
        SELECT
          id::text,
          title,
          coalesce(summary, '') AS summary,
          storage_uri,
          schema_version,
          lower(period)::text AS period_start,
          (upper(period) - 1)::text AS period_end,
          is_public,
          created_at
        FROM public.reports
        WHERE project_id = ${projectId}
          AND id = ${reportId}
      `) as ReportMetadataRow[];
      return rows[0] ? reportFromRow(rows[0]) : undefined;
    },
  };
}

export function reportNowFromEnv(env?: NodeJS.ProcessEnv): Date | undefined {
  const value = env?.PUFU_LENS_REPORT_NOW?.trim();
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('PUFU_LENS_REPORT_NOW must be an ISO 8601 datetime.');
  }
  return date;
}

export function resolveReportPeriod(now: Date, periodKind: ReportPeriodKind): ReportPeriod {
  if (periodKind !== 'weekly') {
    throw new Error(`Unsupported report period: ${periodKind}`);
  }
  const day = now.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { end: formatDate(end), start: formatDate(start) };
}

export function validatePrivateReportJson(value: unknown): asserts value is PrivateReportJsonV1 {
  if (!isRecord(value)) {
    throw new Error('Report JSON must be an object.');
  }
  if (value.schema_version !== 'v1') {
    throw new Error('Report schema_version must be v1.');
  }
  for (const key of ['report_id', 'project_id', 'title', 'generated_at', 'summary']) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new Error(`Report ${key} must be a non-empty string.`);
    }
  }
  if (
    !isRecord(value.period) ||
    typeof value.period.start !== 'string' ||
    typeof value.period.end !== 'string'
  ) {
    throw new Error('Report period must include start and end.');
  }
  if (!Array.isArray(value.sections) || value.sections.length === 0) {
    throw new Error('Report sections must be a non-empty array.');
  }
  for (const section of value.sections) {
    if (!isRecord(section) || typeof section.id !== 'string' || typeof section.title !== 'string') {
      throw new Error('Report section must include id and title.');
    }
    if (typeof section.markdown !== 'string') {
      throw new Error(`Report section ${section.id} markdown must be a string.`);
    }
  }
}

function validateGeneratedReport(
  value: Pick<PrivateReportJsonV1, 'sections' | 'summary' | 'title'>,
): void {
  validatePrivateReportJson({
    generated_at: new Date().toISOString(),
    period: { end: '2026-01-04', start: '2025-12-29' },
    project_id: '00000000-0000-0000-0000-000000000000',
    report_id: '00000000-0000-0000-0000-000000000000',
    schema_version: 'v1',
    ...value,
  });
}

async function lookupMemberOrThrow(input: {
  readonly options: ReportAccessOptions;
  readonly projectSlug: string;
  readonly userId: string;
}) {
  const project = await input.options.repository.lookupProjectMember({
    projectSlug: input.projectSlug,
    userId: input.userId,
  });
  if (!project) {
    throw new ProjectAccessDeniedError(input.projectSlug);
  }
  return project;
}

function isReportDbAvailable(options: ReportAccessOptions): boolean {
  return isWithinBusinessHours(
    options.now ?? new Date(),
    options.businessHours ?? DEFAULT_BUSINESS_HOURS,
  );
}

function prepareReportChunks(report: PrivateReportJsonV1): PreparedReportChunk[] {
  return report.sections.map((section, index) => {
    const content = [`# ${section.title}`, section.markdown, JSON.stringify(section.metrics ?? {})]
      .filter(Boolean)
      .join('\n\n');
    return {
      chunkIndex: index,
      content,
      embedding: deterministicVector(content, 1536),
      metadata: { sectionId: section.id, schemaVersion: report.schema_version },
    };
  });
}

function deterministicVector(text: string, dimensions: number): number[] {
  const hash = createHash('sha256').update(text).digest();
  let seed = hash.readUInt32BE(0);
  return Array.from({ length: dimensions }, () => {
    seed = (seed * 1664525 + 1013904223) | 0;
    return ((seed >>> 0) / 0xffffffff) * 2 - 1;
  });
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

function documentFromRow(row: ReportDocumentRow): ReportDocumentRecord {
  return {
    canonicalUri: row.canonical_uri,
    docType: row.doc_type,
    documentId: row.document_id,
    occurredAt: formatNullableDate(row.occurred_at),
    summary: row.summary,
    title: row.title,
  };
}

function reportFromRow(row: ReportMetadataRow): ReportListItem {
  return {
    createdAt: formatNullableDate(row.created_at) ?? '',
    id: row.id,
    isPublic: row.is_public,
    period: { end: row.period_end, start: row.period_start },
    schemaVersion: row.schema_version,
    storageUri: row.storage_uri,
    summary: row.summary,
    title: row.title,
  };
}

function formatNullableDate(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface ReportDocumentRow {
  readonly canonical_uri: string;
  readonly doc_type: string;
  readonly document_id: string;
  readonly occurred_at: Date | string | null;
  readonly summary: string;
  readonly title: string;
}

interface ReportMetadataRow {
  readonly created_at: Date | string | null;
  readonly id: string;
  readonly is_public: boolean;
  readonly period_end: string;
  readonly period_start: string;
  readonly schema_version: string;
  readonly storage_uri: string;
  readonly summary: string;
  readonly title: string;
}
