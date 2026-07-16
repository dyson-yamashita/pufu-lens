import type postgres from 'postgres';
import { isProjectVisibility, type ProjectVisibility } from './admin-data.ts';
import { lookupProjectMemberAccess } from './authz.ts';
import { type CustomReportLayoutV1, parseCustomReportLayout } from './custom-report-schema.ts';
import { jsonParameter } from './postgres-json.ts';
import { isScheduledReportFrequency, type ScheduledReportFrequency } from './report-schedules.ts';
import type { PreparedReportChunk, PrivateReportJsonV1, ReportPeriod } from './report-schema.ts';

export type ReportGenerationKind = 'manual' | 'scheduled' | 'scheduled_backfill';

export type ReportGenerationMetadata =
  | {
      readonly generationKind: 'manual';
      readonly previousScheduledReportId?: never;
      readonly scheduleFrequency?: never;
      readonly schedulePeriodRunId?: never;
    }
  | {
      readonly generationKind: 'scheduled' | 'scheduled_backfill';
      readonly previousScheduledReportId?: string | null;
      readonly scheduleFrequency: ScheduledReportFrequency;
      readonly schedulePeriodRunId: string;
    };

export interface ReportListItem {
  readonly createdAt: string;
  readonly generationKind: ReportGenerationKind;
  readonly id: string;
  readonly isPublic: boolean;
  readonly period: ReportPeriod;
  readonly previousScheduledReportId: string | null;
  readonly scheduleFrequency: ScheduledReportFrequency | null;
  readonly schedulePeriodRunId: string | null;
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
  readonly rawDocumentId?: string;
  readonly summary: string;
  readonly title: string;
}

export interface ReportRepository {
  insertReport(input: {
    readonly customTemplateRun?: ReportTemplateRunInsert;
    readonly chunks: readonly PreparedReportChunk[];
    readonly generatedBy: string;
    readonly generationMetadata?: ReportGenerationMetadata;
    readonly projectId: string;
    readonly report: PrivateReportJsonV1;
    readonly storageUri: string;
  }): Promise<void>;
  listActiveCustomReportTemplates?(input: {
    readonly projectId: string;
  }): Promise<readonly ReportCustomTemplateSummary[]>;
  readActiveCustomReportTemplate?(input: {
    readonly projectId: string;
    readonly templateId: string;
  }): Promise<ReportCustomTemplate | undefined>;
  listRecentDocuments(input: {
    readonly limit: number;
    readonly period: ReportPeriod;
    readonly projectId: string;
  }): Promise<readonly ReportDocumentRecord[]>;
  listReports(input: { readonly projectId: string }): Promise<readonly ReportListItem[]>;
  lookupProject(input: { readonly projectSlug: string }): Promise<ProjectLookupResult | undefined>;
  lookupProjectMember(input: {
    readonly projectSlug: string;
    readonly userId: string;
  }): Promise<ProjectLookupResult | undefined>;
  readReportMetadata(input: {
    readonly projectId: string;
    readonly reportId: string;
  }): Promise<ReportListItem | undefined>;
  deleteReport(input: { readonly projectId: string; readonly reportId: string }): Promise<void>;
  setReportPublicState?(input: {
    readonly isPublic: boolean;
    readonly projectId: string;
    readonly reportId: string;
  }): Promise<void>;
}

export interface ReportCustomTemplateSummary {
  readonly id: string;
  readonly name: string;
  readonly templateVersion: number;
}

export interface ReportCustomTemplate extends ReportCustomTemplateSummary {
  readonly layout: CustomReportLayoutV1;
}

export interface ReportTemplateRunInsert {
  readonly judgementSummary: Record<string, unknown>;
  readonly layoutSnapshot: CustomReportLayoutV1;
  readonly templateId: string;
  readonly templateSnapshotHash: string;
  readonly templateVersion: number;
}

export type ProjectLookupResult = {
  readonly graphName: string | null;
  readonly id: string;
  readonly slug: string;
  readonly visibility: ProjectVisibility;
};

export function parseReportProjectLookupRow(value: unknown): ProjectLookupResult {
  if (!isRecord(value)) {
    throw new Error('Invalid project lookup row.');
  }
  const graphName = value.graphName ?? null;
  const { id, slug, visibility } = value;
  if (typeof id !== 'string') {
    throw new Error('Invalid project lookup field: id');
  }
  if (graphName !== null && typeof graphName !== 'string') {
    throw new Error('Invalid project lookup field: graphName');
  }
  if (typeof slug !== 'string') {
    throw new Error('Invalid project lookup field: slug');
  }
  if (!isProjectVisibility(visibility)) {
    throw new Error('Invalid project lookup field: visibility');
  }
  return {
    graphName,
    id,
    slug,
    visibility,
  };
}

export function parseReportDocumentRow(value: unknown): ReportDocumentRow {
  if (!isRecord(value)) {
    throw new Error('Invalid report document row.');
  }
  const { canonical_uri, doc_type, document_id, occurred_at, raw_document_id, summary, title } =
    value;
  if (typeof document_id !== 'string') {
    throw new Error('Invalid report document field: document_id');
  }
  if (typeof doc_type !== 'string') {
    throw new Error('Invalid report document field: doc_type');
  }
  if (typeof title !== 'string') {
    throw new Error('Invalid report document field: title');
  }
  if (typeof summary !== 'string') {
    throw new Error('Invalid report document field: summary');
  }
  if (typeof canonical_uri !== 'string') {
    throw new Error('Invalid report document field: canonical_uri');
  }
  if (!isNullableDateLike(occurred_at)) {
    throw new Error('Invalid report document field: occurred_at');
  }
  return {
    canonical_uri,
    doc_type,
    document_id,
    occurred_at,
    ...(typeof raw_document_id === 'string' ? { raw_document_id } : {}),
    summary,
    title,
  };
}

export function parseReportMetadataRow(value: unknown): ReportMetadataRow {
  if (!isRecord(value)) {
    throw new Error('Invalid report metadata row.');
  }
  const {
    created_at,
    generation_kind,
    id,
    is_public,
    period_end,
    period_start,
    previous_scheduled_report_id,
    schedule_frequency,
    schedule_period_run_id,
    schema_version,
    storage_uri,
    summary,
    title,
  } = value;
  if (typeof id !== 'string') {
    throw new Error('Invalid report metadata field: id');
  }
  if (typeof title !== 'string') {
    throw new Error('Invalid report metadata field: title');
  }
  if (typeof summary !== 'string') {
    throw new Error('Invalid report metadata field: summary');
  }
  if (typeof storage_uri !== 'string') {
    throw new Error('Invalid report metadata field: storage_uri');
  }
  if (typeof schema_version !== 'string') {
    throw new Error('Invalid report metadata field: schema_version');
  }
  if (typeof period_start !== 'string') {
    throw new Error('Invalid report metadata field: period_start');
  }
  if (typeof period_end !== 'string') {
    throw new Error('Invalid report metadata field: period_end');
  }
  if (typeof is_public !== 'boolean') {
    throw new Error('Invalid report metadata field: is_public');
  }
  if (!isNullableDateLike(created_at)) {
    throw new Error('Invalid report metadata field: created_at');
  }
  if (!isReportGenerationKind(generation_kind)) {
    throw new Error('Invalid report metadata field: generation_kind');
  }
  if (schedule_frequency !== null && !isScheduledReportFrequency(schedule_frequency)) {
    throw new Error('Invalid report metadata field: schedule_frequency');
  }
  if (!isNullableIdentifier(previous_scheduled_report_id)) {
    throw new Error('Invalid report metadata field: previous_scheduled_report_id');
  }
  if (!isNullableIdentifier(schedule_period_run_id)) {
    throw new Error('Invalid report metadata field: schedule_period_run_id');
  }
  validateReportGenerationFields({
    generationKind: generation_kind,
    previousScheduledReportId: previous_scheduled_report_id,
    scheduleFrequency: schedule_frequency,
    schedulePeriodRunId: schedule_period_run_id,
  });
  return {
    created_at,
    generation_kind,
    id,
    is_public,
    period_end,
    period_start,
    previous_scheduled_report_id,
    schedule_frequency,
    schedule_period_run_id,
    schema_version,
    storage_uri,
    summary,
    title,
  };
}

/**
 * Creates a Postgres-backed report repository.
 *
 * @returns A report repository implementation that uses the provided SQL client for storage access.
 */
export function createPostgresReportRepository(sql: postgres.Sql): ReportRepository {
  return {
    async lookupProjectMember({ projectSlug, userId }) {
      const access = await lookupProjectMemberAccess(sql, { projectSlug, userId });
      return access
        ? {
            graphName: access.graphName ?? null,
            id: access.id,
            slug: access.slug,
            visibility: access.visibility,
          }
        : undefined;
    },
    async lookupProject({ projectSlug }) {
      const rows = (await sql`
        SELECT
          p.id::text AS id,
          p.graph_name AS "graphName",
          p.slug,
          COALESCE(p.visibility, 'private') AS visibility
        FROM public.projects p
        WHERE p.slug = ${projectSlug}
      `) as readonly unknown[];
      if (rows.length === 0) {
        return undefined;
      }
      return parseReportProjectLookupRow(rows[0]);
    },
    async listRecentDocuments({ limit, period, projectId }) {
      const rows = (await sql`
        SELECT
          d.id::text AS document_id,
          d.raw_document_id::text AS raw_document_id,
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
      `) as readonly unknown[];
      return rows.map((row) => documentFromRow(parseReportDocumentRow(row)));
    },
    async insertReport({
      chunks,
      customTemplateRun,
      generatedBy,
      generationMetadata,
      projectId,
      report,
      storageUri,
    }) {
      const generation = normalizeReportGenerationMetadata(generationMetadata);
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
            generated_by,
            generation_kind,
            schedule_frequency,
            previous_scheduled_report_id,
            schedule_period_run_id
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
            ${generatedBy},
            ${generation.generationKind},
            ${generation.scheduleFrequency},
            ${generation.previousScheduledReportId},
            ${generation.schedulePeriodRunId}
          )
        `;
        if (customTemplateRun) {
          await transaction`
            INSERT INTO public.report_template_runs (
              project_id, report_id, template_id, template_version, template_snapshot_hash,
              layout_snapshot, judgement_summary
            )
            VALUES (
              ${projectId}, ${report.report_id}, ${customTemplateRun.templateId},
              ${customTemplateRun.templateVersion}, ${customTemplateRun.templateSnapshotHash},
              ${jsonParameter(transaction, customTemplateRun.layoutSnapshot)}::jsonb,
              ${jsonParameter(transaction, customTemplateRun.judgementSummary)}::jsonb
            )
          `;
        }
        await Promise.all(
          chunks.map(
            (chunk) => transaction`
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
                ${jsonParameter(transaction, chunk.metadata)}::jsonb
              )
            `,
          ),
        );
      });
    },
    async listActiveCustomReportTemplates({ projectId }) {
      const rows = (await sql`
        SELECT id::text AS id, name, template_version
        FROM public.custom_report_templates
        WHERE project_id = ${projectId} AND is_active = true
        ORDER BY updated_at DESC, name ASC
      `) as readonly unknown[];
      return rows.map((row) => customTemplateSummaryFromRow(parseCustomTemplateSummaryRow(row)));
    },
    async readActiveCustomReportTemplate({ projectId, templateId }) {
      const rows = (await sql`
        SELECT id::text AS id, name, template_version, layout
        FROM public.custom_report_templates
        WHERE project_id = ${projectId} AND id = ${templateId} AND is_active = true
      `) as readonly unknown[];
      return rows[0] ? customTemplateFromRow(parseCustomTemplateRow(rows[0])) : undefined;
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
          generation_kind,
          schedule_frequency,
          previous_scheduled_report_id::text,
          schedule_period_run_id::text,
          created_at
        FROM public.reports
        WHERE project_id = ${projectId}
        ORDER BY created_at DESC
      `) as readonly unknown[];
      return rows.map((row) => reportFromRow(parseReportMetadataRow(row)));
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
          generation_kind,
          schedule_frequency,
          previous_scheduled_report_id::text,
          schedule_period_run_id::text,
          created_at
        FROM public.reports
        WHERE project_id = ${projectId}
          AND id = ${reportId}
      `) as readonly unknown[];
      return rows[0] ? reportFromRow(parseReportMetadataRow(rows[0])) : undefined;
    },
    async deleteReport({ projectId, reportId }) {
      await sql.begin(async (transaction) => {
        await transaction`
          DELETE FROM public.report_chunks
          WHERE project_id = ${projectId}
            AND report_id = ${reportId}
        `;
        await transaction`
          DELETE FROM public.reports
          WHERE project_id = ${projectId}
            AND id = ${reportId}
        `;
      });
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

function documentFromRow(row: ReportDocumentRow): ReportDocumentRecord {
  return {
    canonicalUri: row.canonical_uri,
    docType: row.doc_type,
    documentId: row.document_id,
    occurredAt: formatNullableDate(row.occurred_at),
    rawDocumentId: typeof row.raw_document_id === 'string' ? row.raw_document_id : undefined,
    summary: row.summary,
    title: row.title,
  };
}

function reportFromRow(row: ReportMetadataRow): ReportListItem {
  return {
    createdAt: formatNullableDate(row.created_at) ?? '',
    generationKind: row.generation_kind,
    id: row.id,
    isPublic: row.is_public,
    period: { end: row.period_end, start: row.period_start },
    previousScheduledReportId: row.previous_scheduled_report_id,
    scheduleFrequency: row.schedule_frequency,
    schedulePeriodRunId: row.schedule_period_run_id,
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

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNullableDateLike(value: unknown): value is Date | string | null {
  return value === null || value instanceof Date || typeof value === 'string';
}

interface ReportDocumentRow {
  readonly canonical_uri: string;
  readonly doc_type: string;
  readonly document_id: string;
  readonly occurred_at: Date | string | null;
  readonly raw_document_id?: unknown;
  readonly summary: string;
  readonly title: string;
}

interface ReportMetadataRow {
  readonly created_at: Date | string | null;
  readonly generation_kind: ReportGenerationKind;
  readonly id: string;
  readonly is_public: boolean;
  readonly period_end: string;
  readonly period_start: string;
  readonly previous_scheduled_report_id: string | null;
  readonly schedule_frequency: ScheduledReportFrequency | null;
  readonly schedule_period_run_id: string | null;
  readonly schema_version: string;
  readonly storage_uri: string;
  readonly summary: string;
  readonly title: string;
}

export function isReportGenerationKind(value: unknown): value is ReportGenerationKind {
  return value === 'manual' || value === 'scheduled' || value === 'scheduled_backfill';
}

function normalizeReportGenerationMetadata(
  value: ReportGenerationMetadata | undefined,
): NormalizedReportGenerationMetadata {
  if (!value || value.generationKind === 'manual') {
    return {
      generationKind: 'manual',
      previousScheduledReportId: null,
      scheduleFrequency: null,
      schedulePeriodRunId: null,
    };
  }
  const normalized: NormalizedReportGenerationMetadata = {
    generationKind: value.generationKind,
    previousScheduledReportId: value.previousScheduledReportId ?? null,
    scheduleFrequency: value.scheduleFrequency,
    schedulePeriodRunId: value.schedulePeriodRunId,
  };
  validateReportGenerationFields(normalized);
  return normalized;
}

function validateReportGenerationFields(value: NormalizedReportGenerationMetadata): void {
  if (value.generationKind === 'manual') {
    if (
      value.scheduleFrequency !== null ||
      value.previousScheduledReportId !== null ||
      value.schedulePeriodRunId !== null
    ) {
      throw new Error('Manual report metadata cannot include schedule fields.');
    }
    return;
  }
  if (!isScheduledReportFrequency(value.scheduleFrequency)) {
    throw new Error('Scheduled report metadata requires a valid schedule frequency.');
  }
  if (typeof value.schedulePeriodRunId !== 'string' || value.schedulePeriodRunId.length === 0) {
    throw new Error('Scheduled report metadata requires a period run id.');
  }
  if (
    value.previousScheduledReportId !== null &&
    (typeof value.previousScheduledReportId !== 'string' ||
      value.previousScheduledReportId.length === 0)
  ) {
    throw new Error('Scheduled report metadata has an invalid previous report id.');
  }
}

function isNullableIdentifier(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0);
}

interface NormalizedReportGenerationMetadata {
  readonly generationKind: ReportGenerationKind;
  readonly previousScheduledReportId: string | null;
  readonly scheduleFrequency: ScheduledReportFrequency | null;
  readonly schedulePeriodRunId: string | null;
}

interface CustomTemplateSummaryRow {
  readonly id: string;
  readonly name: string;
  readonly template_version: number;
}
interface CustomTemplateRow extends CustomTemplateSummaryRow {
  readonly layout: CustomReportLayoutV1;
}

/**
 * Parses a custom report template summary row.
 *
 * @param value - The database row to parse.
 * @returns The normalized custom template summary row.
 */
function parseCustomTemplateSummaryRow(value: unknown): CustomTemplateSummaryRow {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.template_version !== 'number'
  ) {
    throw new Error('Invalid custom report template summary row.');
  }
  return { id: value.id, name: value.name, template_version: value.template_version };
}

/**
 * Parses a custom report template row.
 *
 * @param value - The row to parse
 * @returns The parsed template summary and layout
 */
function parseCustomTemplateRow(value: unknown): CustomTemplateRow {
  const summary = parseCustomTemplateSummaryRow(value);
  if (!isRecord(value)) {
    throw new Error('Invalid custom report template layout row.');
  }
  const layout = parseCustomReportLayout(value.layout, 'active custom_report_templates.layout');
  return { ...summary, layout };
}

/**
 * Converts a custom template summary row to a template summary object.
 *
 * @returns The template summary with camel-cased property names.
 */
function customTemplateSummaryFromRow(row: CustomTemplateSummaryRow): ReportCustomTemplateSummary {
  return { id: row.id, name: row.name, templateVersion: row.template_version };
}

/**
 * Converts a custom template row into a report template object.
 *
 * @returns The custom template summary with its layout attached.
 */
function customTemplateFromRow(row: CustomTemplateRow): ReportCustomTemplate {
  return { ...customTemplateSummaryFromRow(row), layout: row.layout };
}
