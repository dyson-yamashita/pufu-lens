import { createHash, randomUUID } from 'node:crypto';
import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import {
  type ClassificationResultPart,
  CUSTOM_REPORT_SNAPSHOT_SCHEMA_VERSION,
  type CustomReportLayoutV1,
  type CustomReportPart,
  type CustomReportResult,
  type CustomReportSnapshotV1,
  type SliderJudgementPart,
} from './custom-report-schema.ts';
import type { AgentRawReadViewEnvelope, RawReadViewRepository } from './raw-read-view.ts';
import { editReportMaterials, REPORT_CANDIDATE_LIMIT } from './report-materials.ts';
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
  readonly customTemplateId?: string;
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

/**
 * Generates a report for a project and stores the private report record.
 *
 * @returns The generated report, the public report URL, and the storage URI for the private JSON.
 */
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

  const candidateDocuments = await input.options.repository.listRecentDocuments({
    limit: REPORT_CANDIDATE_LIMIT,
    period,
    projectId: project.id,
  });
  const editedMaterials = editReportMaterials(candidateDocuments);
  const hasOverflow =
    editedMaterials.totalDocumentCount > editedMaterials.representativeDocuments.length;
  const providerDocuments = await supplementDocumentsWithRawReadViews({
    documents: editedMaterials.representativeDocuments,
    projectId: project.id,
    rawReadViewRepository: input.options.rawReadViewRepository,
  });
  const generated = await input.options.provider.generate({
    documents: providerDocuments,
    ...(hasOverflow ? { materialGroups: editedMaterials.materialGroups } : {}),
    period,
    projectSlug: project.slug,
    totalDocumentCount: editedMaterials.totalDocumentCount,
  });
  const reportId = randomUUID();
  const customTemplate = input.options.customTemplateId
    ? await readCustomTemplateOrThrow({
        projectId: project.id,
        repository: input.options.repository,
        templateId: input.options.customTemplateId,
      })
    : undefined;
  const customSnapshot = customTemplate
    ? buildCustomReportSnapshot({
        layout: customTemplate.layout,
        reportContext: generated,
        templateId: customTemplate.id,
        templateVersion: customTemplate.templateVersion,
      })
    : undefined;
  const report: PrivateReportJsonV1 = {
    ...(customSnapshot ? { custom_layout: customSnapshot.snapshot } : {}),
    generated_at: now.toISOString(),
    period,
    project_id: project.id,
    pufu_sources: editedMaterials.representativeDocuments.map(pufuSourceFromDocument),
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
    ...(customSnapshot
      ? {
          customTemplateRun: {
            judgementSummary: customSnapshot.judgementSummary,
            layoutSnapshot: customSnapshot.snapshot.layout,
            templateId: customSnapshot.snapshot.template_id,
            templateSnapshotHash: customSnapshot.snapshot.template_snapshot_hash,
            templateVersion: customSnapshot.snapshot.template_version,
          },
        }
      : {}),
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

/**
 * Loads an active custom report template.
 *
 * @param input.projectId - The project identifier
 * @param input.repository - The report repository
 * @param input.templateId - The template identifier
 * @returns The active custom report template
 * @throws {CustomReportTemplateError} If custom report templates are unsupported or the template is missing or inactive
 */
async function readCustomTemplateOrThrow(input: {
  readonly projectId: string;
  readonly repository: ReportRepository;
  readonly templateId: string;
}) {
  if (!input.repository.readActiveCustomReportTemplate) {
    throw new CustomReportTemplateError(
      'Custom report templates are not supported by this repository.',
    );
  }
  const template = await input.repository.readActiveCustomReportTemplate({
    projectId: input.projectId,
    templateId: input.templateId,
  });
  if (!template) {
    throw new CustomReportTemplateError('Custom report template not found or inactive.');
  }
  return template;
}

export class CustomReportTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomReportTemplateError';
  }
}

/**
 * Builds a custom report snapshot and compact result summary.
 *
 * @param input - The custom layout, report context, and template metadata used to construct the snapshot
 * @returns The generated judgement summary and snapshot
 */
function buildCustomReportSnapshot(input: {
  readonly layout: CustomReportLayoutV1;
  readonly reportContext: Pick<PrivateReportJsonV1, 'sections' | 'summary' | 'title'>;
  readonly templateId: string;
  readonly templateVersion: number;
}): {
  readonly judgementSummary: Record<string, unknown>;
  readonly snapshot: CustomReportSnapshotV1;
} {
  const results: Record<string, CustomReportResult> = {};
  collectCustomResults(input.layout.root, input.reportContext, results);
  const snapshotHash = createHash('sha256')
    .update(
      JSON.stringify({
        layout: input.layout,
        templateId: input.templateId,
        version: input.templateVersion,
      }),
    )
    .digest('hex');
  return {
    judgementSummary: Object.fromEntries(
      Object.entries(results).map(([key, result]) => [key, summarizeCustomResult(result)]),
    ),
    snapshot: {
      layout: input.layout,
      results,
      schema_version: CUSTOM_REPORT_SNAPSHOT_SCHEMA_VERSION,
      template_id: input.templateId,
      template_snapshot_hash: snapshotHash,
      template_version: input.templateVersion,
    },
  };
}

/**
 * Collects custom report results from a custom report part tree.
 *
 * @param part - The custom report part to traverse
 * @param reportContext - The report content used to derive result values
 * @param results - The result map to populate
 */
function collectCustomResults(
  part: CustomReportPart,
  reportContext: Pick<PrivateReportJsonV1, 'sections' | 'summary' | 'title'>,
  results: Record<string, CustomReportResult>,
): void {
  switch (part.type) {
    case 'classification_result':
      setCustomResult(results, part.result_key, classificationResult(part, reportContext));
      break;
    case 'columns':
      part.columns.forEach((column) => {
        column.children.forEach((child) => {
          collectCustomResults(child, reportContext, results);
        });
      });
      break;
    case 'fixed_image':
      setCustomResult(results, part.id, {
        asset_ref: part.asset_ref,
        part_id: part.id,
        type: 'fixed_image',
      });
      break;
    case 'fixed_text':
      setCustomResult(results, part.id, { part_id: part.id, text: part.text, type: 'fixed_text' });
      break;
    case 'row':
      part.children.forEach((child) => {
        collectCustomResults(child, reportContext, results);
      });
      break;
    case 'slider_judgement':
      setCustomResult(results, part.result_key, sliderResult(part, reportContext));
      break;
  }
}

/**
 * Adds a custom report result under a unique key.
 *
 * @param results - The result map to update
 * @param key - The result key to add
 * @param result - The result value to store
 * @throws Error if `key` already exists in `results`
 */
function setCustomResult(
  results: Record<string, CustomReportResult>,
  key: string,
  result: CustomReportResult,
): void {
  if (key in results) {
    throw new Error(`Duplicate custom report result key: ${key}`);
  }
  results[key] = result;
}

/**
 * Creates a slider judgment result from the report context.
 *
 * @param part - The slider judgment definition.
 * @param reportContext - The report data used to derive the score.
 * @returns A `slider_judgement` result with labels, score, reason, and part ID.
 */
function sliderResult(
  part: SliderJudgementPart,
  reportContext: Pick<PrivateReportJsonV1, 'sections' | 'summary' | 'title'>,
): CustomReportResult {
  const signal = `${part.prompt}\n${reportContext.title}\n${reportContext.summary}\n${reportContext.sections
    .map((section) => section.markdown)
    .join('\n')}`;
  const score = Math.round(Math.min(100, Math.max(0, 50 + sentimentSignal(signal) * 10)));
  return {
    left_label: part.left_label,
    part_id: part.id,
    reason: `標準レポート本文と判定指示から ${score}/100 と判定しました。`,
    right_label: part.right_label,
    score,
    type: 'slider_judgement',
  };
}

/**
 * Builds a classification result for a custom report part.
 *
 * @param part - The classification part definition and available categories.
 * @param reportContext - The report title and summary used to select a category.
 * @returns The selected classification result, including the chosen category details.
 * @throws Error if the classification part has no categories.
 */
function classificationResult(
  part: ClassificationResultPart,
  reportContext: Pick<PrivateReportJsonV1, 'sections' | 'summary' | 'title'>,
): CustomReportResult {
  const signal = `${part.prompt}\n${reportContext.title}\n${reportContext.summary}`;
  const index = Math.abs(hashNumber(signal)) % part.categories.length;
  const category = part.categories[index];
  if (!category) {
    throw new Error('Custom report classification_result must have categories.');
  }
  return {
    ...(category.asset_ref ? { asset_ref: category.asset_ref } : {}),
    category_key: category.key,
    description: category.description,
    part_id: part.id,
    reason: '標準レポートの要約と分類指示に最も近いカテゴリとして選択しました。',
    title: category.title,
    type: 'classification_result',
  };
}

/**
 * Measures the sentiment signal in a text string.
 *
 * @param value - The text to evaluate
 * @returns The difference between positive and negative keyword matches
 */
function sentimentSignal(value: string): number {
  const lower = value.toLowerCase();
  const positive = (lower.match(/progress|done|success|解決|完了|進捗|成功/g) ?? []).length;
  const negative = (lower.match(/risk|block|fail|error|遅延|障害|課題/g) ?? []).length;
  return positive - negative;
}

/**
 * Computes a stable 32-bit integer hash for a string.
 *
 * @param value - The input string
 * @returns A signed 32-bit integer derived from the SHA-256 digest of `value`
 */
function hashNumber(value: string): number {
  return createHash('sha256').update(value).digest().readInt32BE(0);
}

/**
 * Creates a compact summary of a custom report result.
 *
 * @param result - The custom report result to summarize
 * @returns A compact object containing the key fields for the result type
 */
function summarizeCustomResult(result: CustomReportResult): Record<string, unknown> {
  if (result.type === 'slider_judgement') {
    return { score: result.score, type: result.type };
  }
  if (result.type === 'classification_result') {
    return { category_key: result.category_key, type: result.type };
  }
  return { type: result.type };
}

/**
 * Builds embedding chunks from the sections of a report.
 *
 * @param report - The report to convert into chunks
 * @returns The prepared chunk data for each report section
 */
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
