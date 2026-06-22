import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import {
  type BusinessHoursConfig,
  isWithinBusinessHours,
  ProjectAccessDeniedError,
} from './chat.ts';
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
  type GenerateReportResult,
  type RunGenerateReportOptions,
  runGenerateReport,
} from './report-generation.ts';
export {
  createExtractiveReportProvider,
  createGeminiReportProvider,
  type ReportGenerationProvider,
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
export {
  type PreparedReportChunk,
  type PrivateReportJsonV1,
  type PrivateReportPufuSource,
  type PrivateReportSection,
  type PrivateReportSource,
  type ReportPeriod,
  type ReportPeriodKind,
  reportNowFromEnv,
  resolveReportPeriod,
  validatePrivateReportJson,
} from './report-schema.ts';
export { createReportStorageFromEnv } from './report-storage.ts';

export interface ReportAccessOptions {
  readonly businessHours?: BusinessHoursConfig;
  readonly now?: Date;
  readonly repository: ReportRepository;
  readonly storage?: ObjectStorage;
}

export interface PublishReportOptions extends ReportAccessOptions {
  readonly storage: ObjectStorage;
}

const DEFAULT_BUSINESS_HOURS: BusinessHoursConfig = {
  enabled: false,
  endHour: 18,
  startHour: 9,
  timeZone: 'Asia/Tokyo',
};

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

export async function deletePrivateReport(input: {
  readonly options: ReportAccessOptions & { readonly storage?: ObjectStorage };
  readonly projectSlug: string;
  readonly reportId: string;
  readonly userId: string;
}): Promise<{ readonly status: 'ok' }> {
  if (!isReportDbAvailable(input.options)) {
    throw new Error('Cannot delete report outside DB business hours.');
  }
  const project = await lookupMemberOrThrow(input);
  const metadata = await input.options.repository.readReportMetadata({
    projectId: project.id,
    reportId: input.reportId,
  });
  if (!metadata) {
    throw new ReportNotFoundError(input.reportId);
  }
  if (metadata.isPublic && input.options.storage) {
    try {
      await revokePublicReport({
        options: {
          ...input.options,
          storage: input.options.storage,
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
