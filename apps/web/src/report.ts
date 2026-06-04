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

export interface PublicReportSource {
  readonly label: string;
  readonly public_source_id: string;
}

export interface PublicReportSection {
  readonly id: PrivateReportSection['id'];
  readonly items?: readonly Record<string, unknown>[];
  readonly markdown: string;
  readonly metrics?: Record<string, number>;
  readonly sources?: readonly PublicReportSource[];
  readonly title: string;
}

export interface PublicReportJsonV1 {
  readonly period: ReportPeriod;
  readonly published_at: string;
  readonly report_id: string;
  readonly schema_version: 'public-v1';
  readonly sections: readonly PublicReportSection[];
  readonly summary: string;
  readonly title: string;
}

export interface PublicContextBundleV1 {
  readonly report_id: string;
  readonly schema_version: 'public-context-v1';
  readonly sections: ReadonlyArray<{
    readonly id: PrivateReportSection['id'];
    readonly markdown: string;
    readonly public_source_ids: readonly string[];
    readonly title: string;
  }>;
}

export interface PublicReportManifestV1 {
  readonly artifact_version: string;
  readonly etag: string;
  readonly project_slug: string;
  readonly public_context_bundle_uri: string;
  readonly public_report_uri: string;
  readonly published_at: string;
  readonly report_id: string;
  readonly revoked_at: string | null;
  readonly schema_version: 'public-report-manifest-v1';
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
  setReportPublicState?(input: {
    readonly isPublic: boolean;
    readonly projectId: string;
    readonly reportId: string;
  }): Promise<void>;
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

export interface PublishReportOptions extends ReportAccessOptions {
  readonly storage: ObjectStorage;
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

export async function publishPublicReport(input: {
  readonly now?: Date;
  readonly options: PublishReportOptions;
  readonly projectSlug: string;
  readonly reportId: string;
  readonly userId: string;
}): Promise<{
  readonly manifest: PublicReportManifestV1;
  readonly publicReport: PublicReportJsonV1;
  readonly status: 'ok';
}> {
  if (!isReportDbAvailable(input.options)) {
    throw new Error('Cannot publish report outside DB business hours.');
  }
  const project = await lookupMemberOrThrow(input);
  const metadata = await input.options.repository.readReportMetadata({
    projectId: project.id,
    reportId: input.reportId,
  });
  if (!metadata) {
    throw new ReportNotFoundError(input.reportId);
  }

  const privateReport = JSON.parse(
    await input.options.storage.getText(metadata.storageUri),
  ) as unknown;
  validatePrivateReportJson(privateReport);
  const publishedAt = (input.now ?? input.options.now ?? new Date()).toISOString();
  const publicReport = buildPublicReport(privateReport, publishedAt);
  const contextBundle = buildPublicContextBundle(publicReport);
  const artifactVersion = buildArtifactVersion(publicReport, publishedAt);
  const baseUri = `${project.slug}/reports/public/${input.reportId}/${artifactVersion}`;
  const reportPut = await input.options.storage.put(
    `${baseUri}/report.json`,
    `${JSON.stringify(publicReport, null, 2)}\n`,
    {
      cacheControl: 'public, max-age=300',
      contentType: 'application/json; charset=utf-8',
    },
  );
  const contextPut = await input.options.storage.put(
    `${baseUri}/context-bundle.json`,
    `${JSON.stringify(contextBundle, null, 2)}\n`,
    {
      cacheControl: 'public, max-age=300',
      contentType: 'application/json; charset=utf-8',
    },
  );
  const manifest: PublicReportManifestV1 = {
    artifact_version: artifactVersion,
    etag: digestJson(publicReport),
    project_slug: project.slug,
    public_context_bundle_uri: contextPut.uri,
    public_report_uri: reportPut.uri,
    published_at: publishedAt,
    report_id: input.reportId,
    revoked_at: null,
    schema_version: 'public-report-manifest-v1',
  };
  validatePublicReportJson(publicReport);
  validatePublicReportManifest(manifest, project.slug, input.reportId);
  await input.options.storage.put(
    publicReportManifestPath(project.slug, input.reportId),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      cacheControl: 'no-store',
      contentType: 'application/json; charset=utf-8',
    },
  );
  await input.options.repository.setReportPublicState?.({
    isPublic: true,
    projectId: project.id,
    reportId: input.reportId,
  });

  return { manifest, publicReport, status: 'ok' };
}

export async function revokePublicReport(input: {
  readonly now?: Date;
  readonly options: PublishReportOptions;
  readonly projectSlug: string;
  readonly reportId: string;
  readonly userId: string;
}): Promise<{ readonly manifest: PublicReportManifestV1; readonly status: 'ok' }> {
  if (!isReportDbAvailable(input.options)) {
    throw new Error('Cannot revoke report outside DB business hours.');
  }
  const project = await lookupMemberOrThrow(input);
  const metadata = await input.options.repository.readReportMetadata({
    projectId: project.id,
    reportId: input.reportId,
  });
  if (!metadata) {
    throw new ReportNotFoundError(input.reportId);
  }

  const manifest = await readPublicReportManifest({
    projectSlug: project.slug,
    reportId: input.reportId,
    storage: input.options.storage,
  });
  const revokedAt = (input.now ?? input.options.now ?? new Date()).toISOString();
  const revokedManifest: PublicReportManifestV1 = manifest
    ? { ...manifest, revoked_at: revokedAt }
    : {
        artifact_version: 'revoked',
        etag: '',
        project_slug: project.slug,
        public_context_bundle_uri: '',
        public_report_uri: '',
        published_at: revokedAt,
        report_id: input.reportId,
        revoked_at: revokedAt,
        schema_version: 'public-report-manifest-v1',
      };
  await input.options.storage.put(
    publicReportManifestPath(project.slug, input.reportId),
    `${JSON.stringify(revokedManifest, null, 2)}\n`,
    {
      cacheControl: 'no-store',
      contentType: 'application/json; charset=utf-8',
    },
  );
  await input.options.repository.setReportPublicState?.({
    isPublic: false,
    projectId: project.id,
    reportId: input.reportId,
  });
  return { manifest: revokedManifest, status: 'ok' };
}

export async function getPublicReport(input: {
  readonly projectSlug: string;
  readonly reportId: string;
  readonly storage: ObjectStorage;
}): Promise<{ readonly report: PublicReportJsonV1; readonly status: 'ok' }> {
  const manifest = await readPublicReportManifest(input);
  if (!manifest || manifest.revoked_at !== null) {
    throw new PublicReportNotFoundError(input.reportId);
  }
  validatePublicReportManifest(manifest, input.projectSlug, input.reportId);
  const report = JSON.parse(await input.storage.getText(manifest.public_report_uri)) as unknown;
  validatePublicReportJson(report);
  if (digestJson(report) !== manifest.etag) {
    throw new PublicReportNotFoundError(input.reportId);
  }
  return { report, status: 'ok' };
}

export async function readPublicReportManifest(input: {
  readonly projectSlug: string;
  readonly reportId: string;
  readonly storage: ObjectStorage;
}): Promise<PublicReportManifestV1 | undefined> {
  if (!isSafePublicReportLocator(input)) {
    return undefined;
  }
  const path = publicReportManifestPath(input.projectSlug, input.reportId);
  if (!(await input.storage.exists(path))) {
    return undefined;
  }
  const manifest = JSON.parse(await input.storage.getText(path)) as unknown;
  validatePublicReportManifest(manifest, input.projectSlug, input.reportId);
  return manifest;
}

export class ReportNotFoundError extends Error {
  readonly reportId: string;

  constructor(reportId: string) {
    super(`Report not found: ${reportId}`);
    this.name = 'ReportNotFoundError';
    this.reportId = reportId;
  }
}

export class PublicReportNotFoundError extends Error {
  readonly reportId: string;

  constructor(reportId: string) {
    super(`Public report not found: ${reportId}`);
    this.name = 'PublicReportNotFoundError';
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
    async setReportPublicState({ isPublic, projectId, reportId }) {
      await sql`
        UPDATE public.reports
        SET is_public = ${isPublic}
        WHERE project_id = ${projectId}
          AND id = ${reportId}
      `;
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

export function isSafePublicReportLocator(input: {
  readonly projectSlug: string;
  readonly reportId: string;
}): boolean {
  return (
    PROJECT_SLUG_PATTERN.test(input.projectSlug) && PUBLIC_REPORT_ID_PATTERN.test(input.reportId)
  );
}

export function validatePublicReportJson(value: unknown): asserts value is PublicReportJsonV1 {
  if (!isRecord(value)) {
    throw new Error('Public report JSON must be an object.');
  }
  if (value.schema_version !== 'public-v1') {
    throw new Error('Public report schema_version must be public-v1.');
  }
  for (const key of ['report_id', 'title', 'published_at', 'summary']) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new Error(`Public report ${key} must be a non-empty string.`);
    }
  }
  if ('project_id' in value || 'document_id' in value || 'storage_uri' in value) {
    throw new Error('Public report must not include private identifiers.');
  }
  if (
    !isRecord(value.period) ||
    typeof value.period.start !== 'string' ||
    typeof value.period.end !== 'string'
  ) {
    throw new Error('Public report period must include start and end.');
  }
  if (!Array.isArray(value.sections) || value.sections.length === 0) {
    throw new Error('Public report sections must be a non-empty array.');
  }
  const serialized = JSON.stringify(value);
  if (containsPrivateText(serialized)) {
    throw new Error('Public report contains private text.');
  }
  for (const section of value.sections) {
    if (!isRecord(section) || typeof section.id !== 'string' || typeof section.title !== 'string') {
      throw new Error('Public report section must include id and title.');
    }
    if (typeof section.markdown !== 'string') {
      throw new Error(`Public report section ${section.id} markdown must be a string.`);
    }
    if (section.sources !== undefined && !Array.isArray(section.sources)) {
      throw new Error('Public report section sources must be an array.');
    }
    if (section.sources) {
      for (const source of section.sources) {
        if (!isRecord(source) || typeof source.public_source_id !== 'string') {
          throw new Error('Public report source must include public_source_id.');
        }
        if ('document_id' in source || 'canonical_uri' in source || 'snippet' in source) {
          throw new Error('Public report source must not include private source fields.');
        }
      }
    }
  }
}

function validatePublicReportManifest(
  value: unknown,
  projectSlug: string,
  reportId: string,
): asserts value is PublicReportManifestV1 {
  if (!isRecord(value)) {
    throw new Error('Public report manifest must be an object.');
  }
  if (value.schema_version !== 'public-report-manifest-v1') {
    throw new Error('Public report manifest schema_version is invalid.');
  }
  if (value.project_slug !== projectSlug || value.report_id !== reportId) {
    throw new Error('Public report manifest target mismatch.');
  }
  if (
    typeof value.artifact_version !== 'string' ||
    typeof value.published_at !== 'string' ||
    typeof value.etag !== 'string'
  ) {
    throw new Error('Public report manifest metadata is invalid.');
  }
  if (value.revoked_at !== null && typeof value.revoked_at !== 'string') {
    throw new Error('Public report manifest revoked_at is invalid.');
  }
  if (value.revoked_at !== null) {
    return;
  }
  const allowedPrefix = `${projectSlug}/reports/public/${reportId}/${value.artifact_version}/`;
  for (const key of ['public_report_uri', 'public_context_bundle_uri']) {
    const uri = value[key];
    if (typeof uri !== 'string' || !storageUriHasAllowedPublicPrefix(uri, allowedPrefix)) {
      throw new Error(`Public report manifest ${key} is outside the allowed prefix.`);
    }
  }
}

function buildPublicReport(report: PrivateReportJsonV1, publishedAt: string): PublicReportJsonV1 {
  return {
    period: report.period,
    published_at: publishedAt,
    report_id: report.report_id,
    schema_version: 'public-v1',
    sections: report.sections.map((section) => ({
      id: section.id,
      items: redactItems(section.items),
      markdown: redactText(section.markdown),
      metrics: section.metrics,
      sources: section.sources?.map((source, index) => ({
        label: publicSourceLabel(source.doc_type, index),
        public_source_id: `src_${section.id}_${String(index + 1).padStart(3, '0')}`,
      })),
      title: redactText(section.title),
    })),
    summary: redactText(report.summary),
    title: redactText(report.title),
  };
}

function buildPublicContextBundle(report: PublicReportJsonV1): PublicContextBundleV1 {
  return {
    report_id: report.report_id,
    schema_version: 'public-context-v1',
    sections: report.sections.map((section) => ({
      id: section.id,
      markdown: section.markdown,
      public_source_ids: section.sources?.map((source) => source.public_source_id) ?? [],
      title: section.title,
    })),
  };
}

function buildArtifactVersion(report: PublicReportJsonV1, publishedAt: string): string {
  const time = publishedAt.replace(/[^0-9]/g, '').slice(0, 14);
  return `${time}-${digestJson(report).slice(0, 12)}`;
}

function publicReportManifestPath(projectSlug: string, reportId: string): string {
  return `${projectSlug}/reports/public/${reportId}/manifest.json`;
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function redactItems(items: readonly Record<string, unknown>[] | undefined) {
  return items?.map((item) => redactRecord(item));
}

function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PRIVATE_PUBLIC_REPORT_KEYS.has(key))
      .map(([key, fieldValue]) => [key, redactUnknown(fieldValue)]),
  );
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactUnknown);
  }
  if (isRecord(value)) {
    return redactRecord(value);
  }
  return value;
}

function redactText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(
      /https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+|192\.168\.\d+\.\d+|[^/\s]*(?:internal|corp|intranet|local)[^/\s]*)[^\s)]*/gi,
      '[redacted-url]',
    )
    .replace(/\b(?:file|gs):\/\/[^\s)]*/gi, '[redacted-uri]');
}

function containsPrivateText(value: string): boolean {
  return (
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value) ||
    /\b(?:file|gs):\/\//i.test(value) ||
    /https?:\/\/(?:localhost|127\.0\.0\.1|10\.|172\.(?:1[6-9]|2\d|3[0-1])\.|192\.168\.|[^/\s]*(?:internal|corp|intranet|local))/i.test(
      value,
    )
  );
}

function publicSourceLabel(docType: string, index: number): string {
  return `公開ソース ${index + 1} (${redactText(docType)})`;
}

function storageUriHasAllowedPublicPrefix(uri: string, allowedPrefix: string): boolean {
  if (uri.includes('/../') || uri.endsWith('/..')) {
    return false;
  }
  if (uri.startsWith('file://') || uri.startsWith('/') || uri.includes('://')) {
    return uri.includes(`/${allowedPrefix}`);
  }
  return uri.startsWith(allowedPrefix);
}

const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const PUBLIC_REPORT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const PRIVATE_PUBLIC_REPORT_KEYS = new Set([
  'canonical_uri',
  'document_id',
  'parsed_uri',
  'project_id',
  'raw_uri',
  'snippet',
  'storage_uri',
]);

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
