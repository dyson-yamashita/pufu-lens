import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createObjectStorageFromEnv } from '../../../packages/storage/src/factory.ts';
import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import {
  type BusinessHoursConfig,
  isWithinBusinessHours,
  ProjectAccessDeniedError,
} from './chat.ts';
import {
  buildArtifactVersion,
  buildPublicContextBundle,
  buildPublicReport,
  digestJson,
  isProjectPublic,
  type PublicContextBundleV1,
  type PublicReportJsonV1,
  type PublicReportManifestV1,
  publicReportManifestPath,
  readPublicReportManifest,
  validatePublicContextBundle,
  validatePublicReportJson,
  validatePublicReportManifest,
  writePublicProjectManifest,
} from './report-public-artifacts.ts';
import type {
  ProjectLookupResult,
  ReportDocumentRecord,
  ReportListItem,
  ReportRepository,
} from './report-repository.ts';

export {
  isProjectPublic,
  isSafePublicReportLocator,
  type PublicContextBundleV1,
  type PublicProjectManifestV1,
  type PublicReportJsonV1,
  type PublicReportManifestV1,
  type PublicReportSection,
  type PublicReportSource,
  readPublicReportManifest,
  validatePublicContextBundle,
  validatePublicReportJson,
  writePublicProjectManifest,
} from './report-public-artifacts.ts';
export {
  createPostgresReportRepository,
  type ProjectLookupResult,
  parseReportDocumentRow,
  parseReportMetadataRow,
  parseReportProjectLookupRow,
  type ReportDocumentRecord,
  type ReportListItem,
  type ReportRepository,
} from './report-repository.ts';

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

export interface PrivateReportPufuSource extends PrivateReportSource {
  readonly occurred_at: string | null;
  readonly title: string;
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
  readonly pufu_sources?: readonly PrivateReportPufuSource[];
  readonly report_id: string;
  readonly schema_version: 'v1';
  readonly sections: readonly PrivateReportSection[];
  readonly summary: string;
  readonly title: string;
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
  readonly period?: ReportPeriod;
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
  const period =
    input.options.period ?? resolveReportPeriod(now, input.options.periodKind ?? 'weekly');
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
    pufu_sources: documents.map(pufuSourceFromDocument),
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
  if (project.visibility === 'public') {
    await publishGeneratedPublicReport({
      project,
      publishedAt: now.toISOString(),
      report,
      repository: input.options.repository,
      storage: input.options.storage,
    });
  }

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
  await writePublicProjectManifest({
    projectSlug: project.slug,
    publishedAt: project.visibility === 'public' ? publishedAt : null,
    storage: input.options.storage,
    visibility: project.visibility,
  });
  const { manifest, publicReport } = await publishGeneratedPublicReport({
    project,
    publishedAt,
    report: privateReport,
    repository: input.options.repository,
    storage: input.options.storage,
  });

  return { manifest, publicReport, status: 'ok' };
}

async function publishGeneratedPublicReport(input: {
  readonly project: ProjectLookupResult;
  readonly publishedAt: string;
  readonly report: PrivateReportJsonV1;
  readonly repository: ReportRepository;
  readonly storage: ObjectStorage;
}): Promise<{
  readonly manifest: PublicReportManifestV1;
  readonly publicReport: PublicReportJsonV1;
}> {
  await writePublicProjectManifest({
    projectSlug: input.project.slug,
    publishedAt: input.project.visibility === 'public' ? input.publishedAt : null,
    storage: input.storage,
    visibility: input.project.visibility,
  });
  const publicReport = buildPublicReport(input.report, input.publishedAt);
  const contextBundle = buildPublicContextBundle(publicReport);
  const artifactVersion = buildArtifactVersion(publicReport, input.publishedAt);
  const baseUri = `${input.project.slug}/reports/public/${input.report.report_id}/${artifactVersion}`;
  const reportPut = await input.storage.put(
    `${baseUri}/report.json`,
    `${JSON.stringify(publicReport, null, 2)}\n`,
    {
      cacheControl: 'public, max-age=300',
      contentType: 'application/json; charset=utf-8',
    },
  );
  const contextPut = await input.storage.put(
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
    project_slug: input.project.slug,
    public_context_bundle_uri: contextPut.uri,
    public_report_uri: reportPut.uri,
    published_at: input.publishedAt,
    report_id: input.report.report_id,
    revoked_at: null,
    schema_version: 'public-report-manifest-v1',
  };
  validatePublicReportJson(publicReport);
  validatePublicReportManifest(manifest, input.project.slug, input.report.report_id);
  await input.storage.put(
    publicReportManifestPath(input.project.slug, input.report.report_id),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      cacheControl: 'no-store',
      contentType: 'application/json; charset=utf-8',
    },
  );
  await input.repository.setReportPublicState?.({
    isPublic: true,
    projectId: input.project.id,
    reportId: input.report.report_id,
  });
  return { manifest, publicReport };
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
  const artifacts = await getPublicReportArtifacts(input);
  return { report: artifacts.report, status: 'ok' };
}

export async function getPublicReportArtifacts(input: {
  readonly projectSlug: string;
  readonly reportId: string;
  readonly storage: ObjectStorage;
}): Promise<{
  readonly contextBundle: PublicContextBundleV1;
  readonly manifest: PublicReportManifestV1;
  readonly report: PublicReportJsonV1;
  readonly status: 'ok';
}> {
  if (!(await isProjectPublic({ projectSlug: input.projectSlug, storage: input.storage }))) {
    throw new PublicReportNotFoundError(input.reportId);
  }
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
  const contextBundle = JSON.parse(
    await input.storage.getText(manifest.public_context_bundle_uri),
  ) as unknown;
  validatePublicContextBundle(contextBundle, report);
  return { contextBundle, manifest, report, status: 'ok' };
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
              ? [
                  `対象期間に確認できた情報は ${documents.length} 件です。直近の材料から見ると、プロジェクトは次の文脈で動いています。`,
                  '',
                  ...sourceDocuments.map(
                    (document) =>
                      `- ${document.title}: ${truncate(document.summary || '要約は未設定です。', 180)}`,
                  ),
                ].join('\n')
              : '対象期間の indexed document はありません。現時点では概況を判断する材料が不足しています。',
            sources,
            title: '概況',
          },
          {
            id: 'issues',
            items: issueDocuments.map((document) => ({
              document_id: document.documentId,
              title: document.title,
            })),
            markdown: issueDocuments.length
              ? issueDocuments.map((document) => `- ${document.title}`).join('\n')
              : '現時点で大きな論点候補は抽出されていません。ただし、情報量が少ない場合は未検出の論点が残る可能性があります。',
            title: '論点',
          },
          {
            id: 'progress',
            markdown:
              documents.length > 0
                ? [
                    `${period.start} から ${period.end} の情報を見る限り、プロジェクトは情報収集と状況把握を継続できている状態です。`,
                    `確認できた document は ${documents.length} 件で、判断材料は蓄積されつつあります。`,
                    '今後は、個別タスクの消化数よりも、目指す状態に近づいているか、次の意思決定に十分な材料が揃っているかを確認する必要があります。',
                  ].join('\n')
                : `${period.start} から ${period.end} の期間には indexed document がなく、進行状況を判断できる材料がありません。`,
            metrics: {
              documents: documents.length,
              discussion_points: issueDocuments.length,
              risk_signals: risks.length,
            },
            title: '進行状況',
          },
          {
            id: 'risks',
            items: risks.map((document) => ({
              document_id: document.documentId,
              title: document.title,
            })),
            markdown: risks.length
              ? risks.map((document) => `- ${document.title}`).join('\n')
              : '重大なリスク候補は抽出されていません。とはいえ、情報が少ない場合は不確実性そのものがリスクになります。',
            title: '不確実性・リスク',
          },
        ],
        summary:
          documents.length > 0
            ? `${documents.length} 件の indexed document から、プロジェクトの概況と進行状況を整理しました。`
            : '対象期間の indexed document がないため、プロジェクト概況は未判定です。',
        title: `プロジェクト状況レポート ${period.start} - ${period.end}`,
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
                    'This report is for understanding the project situation, not checking task completion.',
                    'Summarize the overall context, current movement, decisions implied by the information, uncertainty, and signals that matter.',
                    'Do not make the report primarily about GitHub issues, PR counts, task lists, or TODO tracking.',
                    'Sections must include exactly these ids:',
                    '- activity: title "概況"; summarize what kind of project state the documents indicate.',
                    '- progress: title "進行状況"; explain how the project appears to be moving or not moving.',
                    '- issues: title "論点"; summarize open questions, tensions, or decisions to clarify.',
                    '- risks: title "不確実性・リスク"; summarize blockers, risk signals, and unknowns.',
                    'Use markdown prose and concise bullets. metrics are optional and should support situation understanding, not task management.',
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
  return createObjectStorageFromEnv({
    ...process.env,
    STORAGE_DRIVER: driver,
    STORAGE_ROOT:
      driver === 'local'
        ? (process.env.STORAGE_ROOT ?? process.env.LOCAL_STORAGE_ROOT ?? localDevStorageRoot())
        : process.env.STORAGE_ROOT,
  });
}

function localDevStorageRoot(): string | undefined {
  if (process.env.NODE_ENV === 'production') {
    return undefined;
  }
  const candidates = [
    resolve(process.cwd(), '.data/volumes/pufu-lens-data'),
    resolve(process.cwd(), '../../.data/volumes/pufu-lens-data'),
    resolve(process.cwd(), 'infra/volumes/pufu-lens-data'),
    resolve(process.cwd(), '../../infra/volumes/pufu-lens-data'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
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
  if (value.pufu_sources !== undefined) {
    if (!Array.isArray(value.pufu_sources)) {
      throw new Error('Report pufu_sources must be an array.');
    }
    for (const source of value.pufu_sources) {
      if (
        !isRecord(source) ||
        typeof source.document_id !== 'string' ||
        typeof source.doc_type !== 'string' ||
        typeof source.title !== 'string' ||
        typeof source.snippet !== 'string' ||
        typeof source.canonical_uri !== 'string' ||
        (source.occurred_at !== null && typeof source.occurred_at !== 'string')
      ) {
        throw new Error('Report pufu source is invalid.');
      }
    }
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

function pufuSourceFromDocument(document: ReportDocumentRecord): PrivateReportPufuSource {
  return {
    canonical_uri: document.canonicalUri,
    doc_type: document.docType,
    document_id: document.documentId,
    occurred_at: document.occurredAt,
    snippet: truncate(document.summary || document.title, 220),
    title: document.title,
  };
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
