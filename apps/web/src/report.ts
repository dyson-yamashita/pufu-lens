import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import { ProjectAccessDeniedError } from './chat.ts';
import {
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
import { publishGeneratedPublicReport } from './report-publication.ts';
import type { ReportListItem, ReportRepository } from './report-repository.ts';
import { type PrivateReportJsonV1, validatePrivateReportJson } from './report-schema.ts';

export {
  buildProjectOverviewPufuReportKey,
  loadLatestProjectOverview,
  type ProjectOverviewSnapshot,
} from './project-overview-data.ts';
export {
  assertPufuScoreReportInputSafe,
  type PufuScorePublicSource,
  toPufuScoreReportInput,
} from './pufu-score-input.ts';
export {
  type GenerateReportResult,
  type RunGenerateReportOptions,
  runGenerateReport,
} from './report-generation.ts';
export {
  type EditedReportMaterials,
  editReportMaterials,
  REPORT_CANDIDATE_LIMIT,
  REPORT_REPRESENTATIVE_LIMIT,
  type ReportEditorialRole,
  type ReportMaterialGroup,
} from './report-materials.ts';
export {
  buildPreviousReportProviderContext,
  countProviderTokensConservative,
  extractContinuedRisks,
  type PreviousReportProviderContext,
  serializePreviousReportContext,
} from './report-previous-context.ts';
export {
  loadTrustedPreviousScheduledReport,
  PreviousScheduledReportNotFoundError,
  validatePairedScheduleInputs,
} from './report-previous-report.ts';
export {
  buildExtractiveProjectOverview,
  normalizeProjectOverview,
  PROJECT_OVERVIEW_SCHEMA_VERSION,
  type ProjectOverviewAssetV1,
  type ProjectOverviewIssueV1,
  type ProjectOverviewV1,
  type PublicProjectOverviewV1,
  validateProjectOverview,
} from './report-project-overview.ts';
export {
  buildReportGenerationPrompt,
  countGeminiProviderTokens,
  createExtractiveReportProvider,
  createGeminiReportProvider,
  createGeminiReportProviderWithExtractiveFallback,
  type GeneratedReportContent,
  type ReportGenerationProvider,
  resolveProviderCountTokens,
} from './report-provider.ts';
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
export { buildTrustedReportRecurrence, hasProviderRecurrenceDelta } from './report-recurrence.ts';
export {
  type ConflictingScheduledReportRow,
  createPostgresReportRepository,
  isReportGenerationKind,
  type ProjectLookupResult,
  parseConflictingScheduledReportRow,
  parseReportDocumentRow,
  parseReportMetadataRow,
  parseReportProjectLookupRow,
  type ReportCustomTemplate,
  type ReportCustomTemplateSummary,
  type ReportDocumentRecord,
  type ReportGenerationKind,
  type ReportGenerationMetadata,
  type ReportInsertResult,
  type ReportListItem,
  type ReportRepository,
  type ReportTemplateRunInsert,
} from './report-repository.ts';
export { PartialScheduleInputError } from './report-schedule-input.ts';
export {
  type DueScheduledReportPeriod,
  type DueScheduledReportPeriodEnumeration,
  enumerateDueScheduledReportPeriods,
  MAX_REPORT_PERIOD_ENUMERATION,
  resolveInitialAggregateBackfillPeriod,
  resolveNextScheduledReportRunAt,
  resolveScheduledReportPeriod,
  type ScheduledReportPeriod,
  shouldEnqueueInitialReportBackfill,
} from './report-schedule-periods.ts';
export {
  hasScheduledReportForFrequency,
  type PreviousScheduledReport,
  parsePreviousScheduledReportRow,
  readPreviousScheduledReport,
  readProjectReportAvailableFrom,
} from './report-schedule-planning.ts';
export {
  isReportScheduleFrequency,
  isReportScheduleRunKind,
  isReportScheduleRunStatus,
  isScheduledReportFrequency,
  listReportSchedulePeriodRuns,
  type ProjectReportSchedule,
  parseProjectReportScheduleRow,
  parseReportSchedulePeriodRunRow,
  type ReportScheduleFrequency,
  type ReportSchedulePeriodRun,
  type ReportScheduleRunKind,
  type ReportScheduleRunStatus,
  readOldestIncompleteReportSchedulePeriodRun,
  readProjectReportSchedule,
  readReportSchedulePeriodRun,
  type ScheduledReportFrequency,
} from './report-schedules.ts';
export {
  assertProviderRecurrenceDeltaShape,
  type PreparedReportChunk,
  type PrivateReportJsonV1,
  type PrivateReportPufuSource,
  type PrivateReportRecurrenceV1,
  type PrivateReportSection,
  type PrivateReportSource,
  type ProviderRecurrenceDelta,
  type ReportPeriod,
  type ReportPeriodKind,
  reportNowFromEnv,
  resolveReportPeriod,
  validateGeneratedReport,
  validatePrivateReportJson,
} from './report-schema.ts';
export { createReportStorageFromEnv } from './report-storage.ts';

export interface ReportAccessOptions {
  readonly now?: Date;
  readonly repository: ReportRepository;
  readonly storage?: ObjectStorage;
}

export interface PublishReportOptions extends ReportAccessOptions {
  readonly storage: ObjectStorage;
}

/**
 * Lists reports available to an authorized project member.
 *
 * @param input - The project, user, and report repository access details
 * @returns The available reports and an `ok` status
 */
export async function listPrivateReports(input: {
  readonly options: ReportAccessOptions;
  readonly projectSlug: string;
  readonly userId: string;
}): Promise<{ readonly reports: readonly ReportListItem[]; readonly status: 'ok' }> {
  const project = await lookupMemberOrThrow(input);
  return {
    reports: await input.options.repository.listReports({ projectId: project.id }),
    status: 'ok',
  };
}

/**
 * Retrieves a private report for an authorized project member.
 *
 * @returns The validated private report and an `ok` status.
 */
export async function getPrivateReport(input: {
  readonly options: ReportAccessOptions & { readonly storage: ObjectStorage };
  readonly projectSlug: string;
  readonly reportId: string;
  readonly userId: string;
}): Promise<{ readonly report: PrivateReportJsonV1; readonly status: 'ok' }> {
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
  if (report.report_id !== input.reportId || report.project_id !== project.id) {
    throw new ReportNotFoundError(input.reportId);
  }
  return { report, status: 'ok' };
}

/**
 * Deletes a private report and revokes its public artifact when applicable.
 *
 * @throws `ReportNotFoundError` if the report does not exist
 * @returns An object with an `ok` status
 */
export async function deletePrivateReport(input: {
  readonly options: ReportAccessOptions & { readonly storage: ObjectStorage };
  readonly projectSlug: string;
  readonly reportId: string;
  readonly userId: string;
}): Promise<{ readonly status: 'ok' }> {
  const project = await lookupMemberOrThrow(input);
  const metadata = await input.options.repository.readReportMetadata({
    projectId: project.id,
    reportId: input.reportId,
  });
  if (!metadata) {
    throw new ReportNotFoundError(input.reportId);
  }
  if (metadata.isPublic) {
    try {
      await revokePublicReport({
        options: {
          ...input.options,
        },
        projectSlug: input.projectSlug,
        reportId: input.reportId,
        userId: input.userId,
      });
    } catch (error) {
      if (!(error instanceof PublicReportNotFoundError)) {
        throw error;
      }
    }
  }
  await input.options.repository.deleteReport({
    projectId: project.id,
    reportId: input.reportId,
  });
  return { status: 'ok' };
}

/**
 * Publishes a private report as a public report.
 *
 * @param input - The report, project, user, storage, and repository details.
 * @returns The public manifest and report.
 * @throws `ReportNotFoundError` if the report metadata does not exist.
 */
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

/**
 * Revokes public access to a report and records the revocation manifest.
 *
 * @param now - Optional timestamp to use for the revocation.
 * @throws `ReportNotFoundError` if the report does not exist.
 * @returns The revoked report manifest and an `ok` status.
 */
export async function revokePublicReport(input: {
  readonly now?: Date;
  readonly options: PublishReportOptions;
  readonly projectSlug: string;
  readonly reportId: string;
  readonly userId: string;
}): Promise<{ readonly manifest: PublicReportManifestV1; readonly status: 'ok' }> {
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

/**
 * Retrieves a publicly accessible report.
 *
 * @param input - The project, report, repository, and storage used to locate the report
 * @returns The validated report with an `ok` status
 * @throws PublicReportNotFoundError If the report is unavailable or its identifiers do not match
 */
export async function getPublicReport(input: {
  readonly options: ReportAccessOptions & { readonly storage: ObjectStorage };
  readonly projectSlug: string;
  readonly reportId: string;
}): Promise<{ readonly report: PrivateReportJsonV1; readonly status: 'ok' }> {
  const { metadata, project } = await assertPublicReportAccess({
    projectSlug: input.projectSlug,
    reportId: input.reportId,
    repository: input.options.repository,
  });
  const report = JSON.parse(await input.options.storage.getText(metadata.storageUri)) as unknown;
  validatePrivateReportJson(report);
  if (report.report_id !== input.reportId || report.project_id !== project.id) {
    throw new PublicReportNotFoundError(input.reportId);
  }
  return { report, status: 'ok' };
}

export async function assertPublicReportAccess(input: {
  readonly projectSlug: string;
  readonly reportId: string;
  readonly repository: ReportRepository;
}): Promise<{
  readonly metadata: ReportListItem;
  readonly project: NonNullable<Awaited<ReturnType<ReportRepository['lookupProject']>>>;
}> {
  const project = await input.repository.lookupProject({ projectSlug: input.projectSlug });
  if (project?.visibility !== 'public') {
    throw new PublicReportNotFoundError(input.reportId);
  }
  const metadata = await input.repository.readReportMetadata({
    projectId: project.id,
    reportId: input.reportId,
  });
  if (!metadata?.isPublic) {
    throw new PublicReportNotFoundError(input.reportId);
  }
  return { metadata, project };
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

/**
 * Retrieves the project accessible to a user.
 *
 * @param input - The project slug, user ID, and repository options used for access lookup
 * @returns The accessible project
 * @throws ProjectAccessDeniedError if the user has no access to the project
 */
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
