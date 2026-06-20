import { createHash, randomUUID } from 'node:crypto';
import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import type { ReportGenerationProvider } from './report-provider.ts';
import { publishGeneratedPublicReport } from './report-publication.ts';
import type { ReportDocumentRecord, ReportRepository } from './report-repository.ts';
import {
  type PreparedReportChunk,
  type PrivateReportJsonV1,
  type PrivateReportPufuSource,
  type ReportPeriod,
  type ReportPeriodKind,
  resolveReportPeriod,
  validatePrivateReportJson,
} from './report-schema.ts';

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

function prepareReportChunks(report: PrivateReportJsonV1): PreparedReportChunk[] {
  return report.sections.map((section, index) => {
    const content = [`# ${section.title}`, section.markdown, metricsContent(section.metrics)]
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

function metricsContent(metrics: Record<string, number> | undefined): string {
  return metrics && Object.keys(metrics).length > 0 ? JSON.stringify(metrics) : '';
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

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
