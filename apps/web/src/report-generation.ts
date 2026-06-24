import { createHash, randomUUID } from 'node:crypto';
import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import type { AgentRawReadViewEnvelope, RawReadViewRepository } from './raw-read-view.ts';
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
  readonly rawReadViewRepository?: Pick<RawReadViewRepository, 'fetchRawReadView'>;
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
  const providerDocuments = await supplementDocumentsWithRawReadViews({
    documents,
    projectId: project.id,
    rawReadViewRepository: input.options.rawReadViewRepository,
  });
  const generated = await input.options.provider.generate({
    documents: providerDocuments,
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

async function supplementDocumentsWithRawReadViews(input: {
  readonly documents: readonly ReportDocumentRecord[];
  readonly projectId: string;
  readonly rawReadViewRepository?: Pick<RawReadViewRepository, 'fetchRawReadView'>;
}): Promise<readonly ReportDocumentRecord[]> {
  if (!input.rawReadViewRepository) {
    return input.documents;
  }
  const rawReadViewRepository = input.rawReadViewRepository;
  return Promise.all(
    input.documents.map(async (document) => {
      if (!document.rawDocumentId) {
        return document;
      }
      const view = await rawReadViewRepository
        .fetchRawReadView({
          documentId: document.documentId,
          maxChars: 1400,
          maxSections: 3,
          projectId: input.projectId,
          rawDocumentId: document.rawDocumentId,
        })
        .catch(() => undefined);
      const rawSummary = view ? rawReadViewSummary(view) : '';
      if (!rawSummary) {
        return document;
      }
      return {
        ...document,
        summary: [document.summary, rawSummary].filter(Boolean).join('\n\n'),
      };
    }),
  );
}

function rawReadViewSummary(view: AgentRawReadViewEnvelope): string {
  const sections = Array.isArray(view.data.sections) ? view.data.sections : [];
  const sectionLines = sections
    .map((section) => {
      const text =
        typeof section.text === 'string' ? truncate(cleanWhitespace(section.text), 360) : '';
      const label = typeof section.label === 'string' && section.label ? section.label : 'section';
      return text ? `- ${label}: ${text}` : '';
    })
    .filter(Boolean)
    .slice(0, 3);
  return sectionLines.length > 0
    ? ['Raw read view supplement (untrusted source text, redacted):', ...sectionLines].join('\n')
    : '';
}

function cleanWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
