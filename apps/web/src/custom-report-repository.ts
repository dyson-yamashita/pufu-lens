import {
  CUSTOM_REPORT_TEMPLATE_SCHEMA_VERSION,
  type CustomReportAssetContentType,
  type CustomReportLayoutV1,
  isCustomReportAssetContentType,
  parseCustomReportLayout,
  parseJsonLikeRecord,
} from './custom-report-schema.ts';

export type CustomReportAssetStatus = 'active' | 'disabled';

export interface CustomReportAssetRow {
  readonly byte_size: number;
  readonly content_type: CustomReportAssetContentType;
  readonly created_at: Date | string;
  readonly created_by_user_id: string | null;
  readonly display_name: string;
  readonly id: string;
  readonly object_storage_uri: string;
  readonly project_id: string;
  readonly status: CustomReportAssetStatus;
  readonly updated_at: Date | string;
}

export interface CustomReportTemplateRow {
  readonly created_at: Date | string;
  readonly created_by_user_id: string | null;
  readonly description: string | null;
  readonly id: string;
  readonly is_active: boolean;
  readonly layout: CustomReportLayoutV1;
  readonly name: string;
  readonly project_id: string;
  readonly schema_version: typeof CUSTOM_REPORT_TEMPLATE_SCHEMA_VERSION;
  readonly template_version: number;
  readonly updated_at: Date | string;
  readonly updated_by_user_id: string | null;
}

export interface ReportTemplateRunRow {
  readonly created_at: Date | string;
  readonly id: string;
  readonly judgement_summary: Record<string, unknown>;
  readonly layout_snapshot: CustomReportLayoutV1;
  readonly project_id: string;
  readonly report_id: string;
  readonly template_id: string | null;
  readonly template_snapshot_hash: string;
  readonly template_version: number;
}

export function parseCustomReportAssetRow(value: unknown): CustomReportAssetRow {
  if (!isRecord(value)) {
    throw new Error('Invalid custom report asset row.');
  }
  const {
    byte_size,
    content_type,
    created_at,
    created_by_user_id,
    display_name,
    id,
    object_storage_uri,
    project_id,
    status,
    updated_at,
  } = value;
  if (typeof id !== 'string' || typeof project_id !== 'string') {
    throw new Error('Invalid custom report asset identity fields.');
  }
  if (typeof display_name !== 'string' || typeof object_storage_uri !== 'string') {
    throw new Error('Invalid custom report asset text fields.');
  }
  if (!isCustomReportAssetContentType(content_type)) {
    throw new Error('Invalid custom report asset content type.');
  }
  const byteSize = toPositiveSafeInteger(byte_size);
  if (byteSize === undefined) {
    throw new Error('Invalid custom report asset byte_size.');
  }
  if (status !== 'active' && status !== 'disabled') {
    throw new Error('Invalid custom report asset status.');
  }
  if (created_by_user_id !== null && typeof created_by_user_id !== 'string') {
    throw new Error('Invalid custom report asset created_by_user_id.');
  }
  if (!isDateLike(created_at) || !isDateLike(updated_at)) {
    throw new Error('Invalid custom report asset timestamp fields.');
  }
  return {
    byte_size: byteSize,
    content_type,
    created_at,
    created_by_user_id,
    display_name,
    id,
    object_storage_uri,
    project_id,
    status,
    updated_at,
  };
}

export function parseCustomReportTemplateRow(value: unknown): CustomReportTemplateRow {
  if (!isRecord(value)) {
    throw new Error('Invalid custom report template row.');
  }
  const {
    created_at,
    created_by_user_id,
    description,
    id,
    is_active,
    layout,
    name,
    project_id,
    schema_version,
    template_version,
    updated_at,
    updated_by_user_id,
  } = value;
  if (typeof id !== 'string' || typeof project_id !== 'string') {
    throw new Error('Invalid custom report template identity fields.');
  }
  if (typeof name !== 'string' || (description !== null && typeof description !== 'string')) {
    throw new Error('Invalid custom report template text fields.');
  }
  if (schema_version !== CUSTOM_REPORT_TEMPLATE_SCHEMA_VERSION) {
    throw new Error('Invalid custom report template schema_version.');
  }
  if (!isPositiveInteger(template_version) || typeof is_active !== 'boolean') {
    throw new Error('Invalid custom report template version or active fields.');
  }
  if (created_by_user_id !== null && typeof created_by_user_id !== 'string') {
    throw new Error('Invalid custom report template created_by_user_id.');
  }
  if (updated_by_user_id !== null && typeof updated_by_user_id !== 'string') {
    throw new Error('Invalid custom report template updated_by_user_id.');
  }
  if (!isDateLike(created_at) || !isDateLike(updated_at)) {
    throw new Error('Invalid custom report template timestamp fields.');
  }
  const parsedLayout = parseCustomReportLayout(layout, 'custom_report_templates.layout');
  return {
    created_at,
    created_by_user_id,
    description,
    id,
    is_active,
    layout: parsedLayout,
    name,
    project_id,
    schema_version,
    template_version,
    updated_at,
    updated_by_user_id,
  };
}

export function parseReportTemplateRunRow(value: unknown): ReportTemplateRunRow {
  if (!isRecord(value)) {
    throw new Error('Invalid report template run row.');
  }
  const {
    created_at,
    id,
    judgement_summary,
    layout_snapshot,
    project_id,
    report_id,
    template_id,
    template_snapshot_hash,
    template_version,
  } = value;
  if (typeof id !== 'string' || typeof project_id !== 'string' || typeof report_id !== 'string') {
    throw new Error('Invalid report template run identity fields.');
  }
  if (template_id !== null && typeof template_id !== 'string') {
    throw new Error('Invalid report template run template_id.');
  }
  if (!isPositiveInteger(template_version) || typeof template_snapshot_hash !== 'string') {
    throw new Error('Invalid report template run template snapshot fields.');
  }
  const parsedLayoutSnapshot = parseCustomReportLayout(
    layout_snapshot,
    'report_template_runs.layout_snapshot',
  );
  const parsedJudgementSummary = parseJsonLikeRecord(judgement_summary, 'judgement_summary');
  if (!isDateLike(created_at)) {
    throw new Error('Invalid report template run created_at.');
  }
  return {
    created_at,
    id,
    judgement_summary: parsedJudgementSummary,
    layout_snapshot: parsedLayoutSnapshot,
    project_id,
    report_id,
    template_id,
    template_snapshot_hash,
    template_version,
  };
}

type SqlExecutor = import('postgres').Sql | import('postgres').TransactionSql;

export interface InsertCustomReportTemplateInput {
  readonly createdByUserId: string;
  readonly description: string | null;
  readonly layout: CustomReportLayoutV1;
  readonly name: string;
  readonly projectId: string;
}

export interface UpdateCustomReportTemplateInput {
  readonly description: string | null;
  readonly layout: CustomReportLayoutV1;
  readonly name: string;
  readonly projectId: string;
  readonly templateId: string;
  readonly updatedByUserId: string;
}

export interface DisableCustomReportTemplateInput {
  readonly projectId: string;
  readonly templateId: string;
  readonly updatedByUserId: string;
}

export async function insertCustomReportTemplate(
  sql: SqlExecutor,
  input: InsertCustomReportTemplateInput,
): Promise<void> {
  await sql`
    INSERT INTO public.custom_report_templates (
      project_id, name, description, schema_version, layout, created_by_user_id, updated_by_user_id
    )
    VALUES (
      ${input.projectId}, ${input.name}, ${input.description}, ${CUSTOM_REPORT_TEMPLATE_SCHEMA_VERSION},
      ${JSON.stringify(input.layout)}::jsonb, ${input.createdByUserId}, ${input.createdByUserId}
    )
  `;
}

export async function updateCustomReportTemplate(
  sql: SqlExecutor,
  input: UpdateCustomReportTemplateInput,
): Promise<void> {
  const result = await sql`
    UPDATE public.custom_report_templates
    SET name = ${input.name},
        description = ${input.description},
        layout = ${JSON.stringify(input.layout)}::jsonb,
        template_version = template_version + 1,
        updated_by_user_id = ${input.updatedByUserId}
    WHERE project_id = ${input.projectId} AND id = ${input.templateId}
  `;
  if (result.count === 0) {
    throw new Error('Template not found or access denied.');
  }
}

export async function disableCustomReportTemplate(
  sql: SqlExecutor,
  input: DisableCustomReportTemplateInput,
): Promise<void> {
  const result = await sql`
    UPDATE public.custom_report_templates
    SET is_active = false, updated_by_user_id = ${input.updatedByUserId}
    WHERE project_id = ${input.projectId} AND id = ${input.templateId}
  `;
  if (result.count === 0) {
    throw new Error('Template not found or access denied.');
  }
}

export async function listCustomReportTemplates(
  sql: SqlExecutor,
  projectId: string,
): Promise<readonly CustomReportTemplateRow[]> {
  const rawRows = (await sql`
    SELECT
      id::text AS id,
      project_id::text AS project_id,
      name,
      description,
      schema_version,
      template_version,
      layout,
      is_active,
      created_by_user_id::text AS created_by_user_id,
      updated_by_user_id::text AS updated_by_user_id,
      created_at,
      updated_at
    FROM public.custom_report_templates
    WHERE project_id = ${projectId}
    ORDER BY is_active DESC, updated_at DESC, name ASC
  `) as readonly unknown[];
  return rawRows.map((row) => parseCustomReportTemplateRow(row));
}

export async function listCustomReportAssets(
  sql: SqlExecutor,
  projectId: string,
): Promise<readonly CustomReportAssetRow[]> {
  const rawRows = (await sql`
    SELECT
      id::text AS id,
      project_id::text AS project_id,
      display_name,
      object_storage_uri,
      content_type,
      byte_size,
      status,
      created_by_user_id::text AS created_by_user_id,
      created_at,
      updated_at
    FROM public.custom_report_assets
    WHERE project_id = ${projectId}
    ORDER BY status ASC, created_at DESC, display_name ASC
  `) as readonly unknown[];
  return rawRows.map((row) => parseCustomReportAssetRow(row));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDateLike(value: unknown): value is Date | string {
  return value instanceof Date || typeof value === 'string';
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function toPositiveSafeInteger(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value === 'bigint') {
    return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}
