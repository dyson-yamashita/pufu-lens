import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import type { PufuScoreReportInput } from './pufu-score-input.ts';
import { toPufuScoreReportInput } from './pufu-score-input.ts';
import {
  type PublicProjectOverviewV1,
  toPublicProjectOverview,
  validateProjectOverview,
} from './report-project-overview.ts';
import type { ReportListItem, ReportRepository } from './report-repository.ts';
import type { PrivateReportJsonV1, ReportPeriod } from './report-schema.ts';
import { validatePrivateReportJson } from './report-schema.ts';

export interface ProjectOverviewSnapshot {
  readonly generatedAt: string;
  readonly overview: PublicProjectOverviewV1;
  readonly period: ReportPeriod;
  readonly pufuInput: PufuScoreReportInput;
  readonly reportHref: string | null;
  readonly showReportLink: boolean;
}

export type ProjectOverviewLoadResult =
  | { readonly kind: 'empty' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly snapshot: ProjectOverviewSnapshot };

/**
 * Builds a public-safe Pufu component key for project overview rendering.
 */
export function buildProjectOverviewPufuReportKey(input: {
  readonly period: ReportPeriod;
  readonly projectSlug: string;
}): string {
  return `project-overview-${input.projectSlug}-${input.period.start}-${input.period.end}`;
}

/**
 * Loads the latest scheduled report overview for a project overview page.
 */
export async function loadLatestProjectOverview(input: {
  readonly isMember: boolean;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly repository: ReportRepository;
  readonly storage: ObjectStorage;
}): Promise<ProjectOverviewLoadResult> {
  try {
    const metadata = await input.repository.readLatestScheduledReport({
      projectId: input.projectId,
    });
    if (!metadata) {
      return { kind: 'empty' };
    }
    const snapshot = await loadOverviewSnapshotFromMetadata({
      isMember: input.isMember,
      metadata,
      projectId: input.projectId,
      projectSlug: input.projectSlug,
      storage: input.storage,
    });
    return snapshot ? { kind: 'ready', snapshot } : { kind: 'empty' };
  } catch {
    return { kind: 'error' };
  }
}

async function loadOverviewSnapshotFromMetadata(input: {
  readonly isMember: boolean;
  readonly metadata: ReportListItem;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly storage: ObjectStorage;
}): Promise<ProjectOverviewSnapshot | undefined> {
  const reportText = await input.storage.getText(input.metadata.storageUri);
  const parsed: unknown = JSON.parse(reportText);
  validatePrivateReportJson(parsed);
  const report = parsed as PrivateReportJsonV1;
  if (report.report_id !== input.metadata.id || report.project_id !== input.projectId) {
    throw new Error('Scheduled report JSON does not match metadata.');
  }
  if (!report.project_overview) {
    return undefined;
  }
  validateProjectOverview(report.project_overview);
  const showReportLink = input.isMember || input.metadata.isPublic;
  return {
    generatedAt: report.generated_at,
    overview: toPublicProjectOverview(report.project_overview),
    period: report.period,
    pufuInput: toPufuScoreReportInput(report, {
      reportKey: buildProjectOverviewPufuReportKey({
        period: report.period,
        projectSlug: input.projectSlug,
      }),
    }),
    reportHref: showReportLink ? resolveReportHref(input) : null,
    showReportLink,
  };
}

function resolveReportHref(input: {
  readonly isMember: boolean;
  readonly metadata: ReportListItem;
  readonly projectSlug: string;
}): string {
  if (input.isMember) {
    return `/projects/${input.projectSlug}/reports/${input.metadata.id}`;
  }
  return `/reports/public/${input.projectSlug}/${input.metadata.id}`;
}
