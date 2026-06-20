import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import {
  buildArtifactVersion,
  buildPublicContextBundle,
  buildPublicReport,
  digestJson,
  type PublicReportJsonV1,
  type PublicReportManifestV1,
  publicReportManifestPath,
  validatePublicReportJson,
  validatePublicReportManifest,
  writePublicProjectManifest,
} from './report-public-artifacts.ts';
import type { ProjectLookupResult, ReportRepository } from './report-repository.ts';
import type { PrivateReportJsonV1 } from './report-schema.ts';

export async function publishGeneratedPublicReport(input: {
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
