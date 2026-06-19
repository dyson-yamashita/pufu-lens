import {
  isProjectVisibility,
  isSourceType,
  type ProjectVisibility,
  type SourceType,
} from './admin-data.ts';
import type { AppMemberRole, ProjectMemberRole } from './admin-db';

export type AdminDbProjectRow = {
  readonly description: string | null;
  readonly failed_count: number | string | bigint;
  readonly held_count: number | string | bigint;
  readonly id: string;
  readonly ingested_count: number | string | bigint;
  readonly last_indexed: Date | string | null;
  readonly member_count: number | string | bigint;
  readonly name: string;
  readonly queue_count: number | string | bigint;
  readonly raw_count: number | string | bigint;
  readonly slug: string;
  readonly visibility: ProjectVisibility;
};

export type AdminDbPublicProjectReportRow = {
  readonly description: string | null;
  readonly name: string;
  readonly published_at: Date | string | null;
  readonly report_id: string | null;
  readonly report_summary: string | null;
  readonly report_title: string | null;
  readonly slug: string;
};

export type AdminDbAppMemberRow = {
  readonly created_at: Date | string;
  readonly email: string;
  readonly id: string;
  readonly name: string | null;
  readonly role: AppMemberRole;
};

export type AdminDbProjectMemberRow = AdminDbAppMemberRow & {
  readonly membership_created_at: Date | string | null;
  readonly project_role: ProjectMemberRole;
  readonly removable: boolean;
};

export type AdminDbOAuthConnectionRow = {
  readonly account_email: string | null;
  readonly account_login: string | null;
  readonly expires_at: Date | string | null;
  readonly metadata: unknown;
  readonly provider: 'google' | 'github';
  readonly scopes: readonly string[] | null;
  readonly updated_at: Date | string | null;
};

export type AdminDbActorRow = {
  readonly actor_type: string;
  readonly created_at: Date | string;
  readonly display_name: string;
  readonly graph_node_id: string;
  readonly id: string;
  readonly primary_email: string | null;
  readonly primary_login: string | null;
  readonly updated_at: Date | string;
};

export type AdminDbActorAliasRow = {
  readonly actor_id: string;
  readonly alias_type: string;
  readonly alias_value: string;
  readonly confidence: number | string;
  readonly source: string | null;
};

export type AdminDbDataSourceRow = {
  readonly config: unknown;
  readonly failed_count: number | string | bigint;
  readonly held_count: number | string | bigint;
  readonly id: string;
  readonly ingested_count: number | string | bigint;
  readonly last_checked_at: Date | string | null;
  readonly last_indexed: Date | string | null;
  readonly name: string;
  readonly project_id: string;
  readonly queue_count: number | string | bigint;
  readonly raw_count: number | string | bigint;
  readonly source_type: SourceType;
};

export type AdminDbParserProfileRow = {
  readonly active_version: string | null;
  readonly held_queue_count: number | string | bigint;
  readonly id: string;
  readonly name: string;
  readonly project_id: string;
  readonly review_status: string | null;
  readonly review_validation_report_uri: string | null;
  readonly review_version: string | null;
  readonly review_version_id: string | null;
  readonly source_type: SourceType;
};

export type AdminDbDataSourcePreviewScopeRow = {
  readonly id: string;
  readonly last_checked_at: Date | string | null;
  readonly project_id: string;
};

export type AdminDbDataSourcePreviewSummaryRow = {
  readonly failed_count: number | string | bigint;
  readonly held_count: number | string | bigint;
  readonly indexed_count: number | string | bigint;
  readonly last_checked_at: Date | string | null;
  readonly last_indexed: Date | string | null;
  readonly queue_count: number | string | bigint;
  readonly raw_count: number | string | bigint;
};

export type AdminDbDataSourcePreviewDocumentRow = {
  readonly canonical_uri: string | null;
  readonly doc_type: string | null;
  readonly document_id: string | null;
  readonly document_summary: string | null;
  readonly fetched_at: Date | string;
  readonly first_chunk_content: string | null;
  readonly indexed_at: Date | string | null;
  readonly ingest_status: string;
  readonly raw_document_id: string;
  readonly source_id: string;
  readonly title: string | null;
};

export type AdminDbDataSourcePreviewQueueRow = {
  readonly attempts: number | string | bigint;
  readonly id: string;
  readonly last_error: string | null;
  readonly status: string;
  readonly updated_at: Date | string;
};

export function parseAdminDbIdRow(value: unknown, context: string): string {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${context} row.`);
  }
  const id = value.id;
  if (typeof id !== 'string') {
    throw new Error(`Invalid ${context} row field: id`);
  }
  return id;
}

export function parseAppMemberRoleRow(value: unknown): AppMemberRole {
  if (!isRecord(value)) {
    throw new Error('Invalid app member role row.');
  }
  const role = value.role;
  if (role !== 'admin' && role !== 'member') {
    throw new Error('Invalid app member role row.');
  }
  return role;
}

export function parseAdminDbAppMemberRow(
  value: unknown,
  context = 'app member',
): AdminDbAppMemberRow {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${context} row.`);
  }
  const { created_at, email, id, name, role } = value;
  return {
    created_at: parseDateLike(created_at, context, 'created_at'),
    email: parseRequiredString(email, context, 'email'),
    id: parseRequiredString(id, context, 'id'),
    name: parseNullableString(name, context, 'name'),
    role: parseMemberRole(role, context, 'role'),
  };
}

export function parseAdminDbProjectMemberRow(value: unknown): AdminDbProjectMemberRow {
  if (!isRecord(value)) {
    throw new Error('Invalid project member row.');
  }
  const { membership_created_at, project_role, removable } = value;
  return {
    ...parseAdminDbAppMemberRow(value, 'project member'),
    membership_created_at: parseNullableDateLike(
      membership_created_at,
      'project member',
      'membership_created_at',
    ),
    project_role: parseMemberRole(project_role, 'project member', 'project_role'),
    removable: parseBoolean(removable, 'project member', 'removable'),
  };
}

export function parseAdminDbProjectRow(value: unknown): AdminDbProjectRow {
  const context = 'project';
  if (!isRecord(value)) {
    throw new Error(`Invalid ${context} row.`);
  }
  const {
    description,
    failed_count,
    held_count,
    id,
    ingested_count,
    last_indexed,
    member_count,
    name,
    queue_count,
    raw_count,
    slug,
    visibility,
  } = value;
  return {
    description: parseNullableString(description, context, 'description'),
    failed_count: parseCountLike(failed_count, context, 'failed_count'),
    held_count: parseCountLike(held_count, context, 'held_count'),
    id: parseRequiredString(id, context, 'id'),
    ingested_count: parseCountLike(ingested_count, context, 'ingested_count'),
    last_indexed: parseNullableDateLike(last_indexed, context, 'last_indexed'),
    member_count: parseCountLike(member_count, context, 'member_count'),
    name: parseRequiredString(name, context, 'name'),
    queue_count: parseCountLike(queue_count, context, 'queue_count'),
    raw_count: parseCountLike(raw_count, context, 'raw_count'),
    slug: parseRequiredString(slug, context, 'slug'),
    visibility: parseProjectVisibility(visibility, context, 'visibility'),
  };
}

export function parseAdminDbPublicProjectReportRow(value: unknown): AdminDbPublicProjectReportRow {
  const context = 'public project report';
  if (!isRecord(value)) {
    throw new Error(`Invalid ${context} row.`);
  }
  const { description, name, published_at, report_id, report_summary, report_title, slug } = value;
  return {
    description: parseNullableString(description, context, 'description'),
    name: parseRequiredString(name, context, 'name'),
    published_at: parseNullableDateLike(published_at, context, 'published_at'),
    report_id: parseNullableString(report_id, context, 'report_id'),
    report_summary: parseNullableString(report_summary, context, 'report_summary'),
    report_title: parseNullableString(report_title, context, 'report_title'),
    slug: parseRequiredString(slug, context, 'slug'),
  };
}

export function parseAdminDbOAuthConnectionRow(value: unknown): AdminDbOAuthConnectionRow {
  const context = 'oauth connection';
  if (!isRecord(value)) {
    throw new Error(`Invalid ${context} row.`);
  }
  const { account_email, account_login, expires_at, metadata, provider, scopes, updated_at } =
    value;
  return {
    account_email: parseNullableString(account_email, context, 'account_email'),
    account_login: parseNullableString(account_login, context, 'account_login'),
    expires_at: parseNullableDateLike(expires_at, context, 'expires_at'),
    metadata,
    provider: parseOAuthProvider(provider, context, 'provider'),
    scopes: parseNullableStringArray(scopes, context, 'scopes'),
    updated_at: parseNullableDateLike(updated_at, context, 'updated_at'),
  };
}

export function parseAdminDbActorRow(value: unknown): AdminDbActorRow {
  const context = 'actor';
  if (!isRecord(value)) {
    throw new Error(`Invalid ${context} row.`);
  }
  const {
    actor_type,
    created_at,
    display_name,
    graph_node_id,
    id,
    primary_email,
    primary_login,
    updated_at,
  } = value;
  return {
    actor_type: parseRequiredString(actor_type, context, 'actor_type'),
    created_at: parseDateLike(created_at, context, 'created_at'),
    display_name: parseRequiredString(display_name, context, 'display_name'),
    graph_node_id: parseRequiredString(graph_node_id, context, 'graph_node_id'),
    id: parseRequiredString(id, context, 'id'),
    primary_email: parseNullableString(primary_email, context, 'primary_email'),
    primary_login: parseNullableString(primary_login, context, 'primary_login'),
    updated_at: parseDateLike(updated_at, context, 'updated_at'),
  };
}

export function parseAdminDbActorAliasRow(value: unknown): AdminDbActorAliasRow {
  const context = 'actor alias';
  if (!isRecord(value)) {
    throw new Error(`Invalid ${context} row.`);
  }
  const { actor_id, alias_type, alias_value, confidence, source } = value;
  return {
    actor_id: parseRequiredString(actor_id, context, 'actor_id'),
    alias_type: parseRequiredString(alias_type, context, 'alias_type'),
    alias_value: parseRequiredString(alias_value, context, 'alias_value'),
    confidence: parseConfidenceLike(confidence, context, 'confidence'),
    source: parseNullableString(source, context, 'source'),
  };
}

export function parseAdminDbDataSourceRow(value: unknown): AdminDbDataSourceRow {
  const context = 'data source';
  if (!isRecord(value)) {
    throw new Error(`Invalid ${context} row.`);
  }
  const {
    config,
    failed_count,
    held_count,
    id,
    ingested_count,
    last_checked_at,
    last_indexed,
    name,
    project_id,
    queue_count,
    raw_count,
    source_type,
  } = value;
  return {
    config,
    failed_count: parseCountLike(failed_count, context, 'failed_count'),
    held_count: parseCountLike(held_count, context, 'held_count'),
    id: parseRequiredString(id, context, 'id'),
    ingested_count: parseCountLike(ingested_count, context, 'ingested_count'),
    last_checked_at: parseNullableDateLike(last_checked_at, context, 'last_checked_at'),
    last_indexed: parseNullableDateLike(last_indexed, context, 'last_indexed'),
    name: parseRequiredString(name, context, 'name'),
    project_id: parseRequiredString(project_id, context, 'project_id'),
    queue_count: parseCountLike(queue_count, context, 'queue_count'),
    raw_count: parseCountLike(raw_count, context, 'raw_count'),
    source_type: parseSourceType(source_type, context, 'source_type'),
  };
}

export function parseAdminDbParserProfileRow(value: unknown): AdminDbParserProfileRow {
  const context = 'parser profile';
  if (!isRecord(value)) {
    throw new Error(`Invalid ${context} row.`);
  }
  const {
    active_version,
    held_queue_count,
    id,
    name,
    project_id,
    review_status,
    review_validation_report_uri,
    review_version,
    review_version_id,
    source_type,
  } = value;
  return {
    active_version: parseNullableString(active_version, context, 'active_version'),
    held_queue_count: parseCountLike(held_queue_count, context, 'held_queue_count'),
    id: parseRequiredString(id, context, 'id'),
    name: parseRequiredString(name, context, 'name'),
    project_id: parseRequiredString(project_id, context, 'project_id'),
    review_status: parseNullableString(review_status, context, 'review_status'),
    review_validation_report_uri: parseNullableString(
      review_validation_report_uri,
      context,
      'review_validation_report_uri',
    ),
    review_version: parseNullableString(review_version, context, 'review_version'),
    review_version_id: parseNullableString(review_version_id, context, 'review_version_id'),
    source_type: parseSourceType(source_type, context, 'source_type'),
  };
}

export function parseAdminDbDataSourcePreviewScopeRow(
  value: unknown,
): AdminDbDataSourcePreviewScopeRow {
  const context = 'data source preview scope';
  if (!isRecord(value)) {
    throw new Error(`Invalid ${context} row.`);
  }
  const { id, last_checked_at, project_id } = value;
  return {
    id: parseRequiredString(id, context, 'id'),
    last_checked_at: parseNullableDateLike(last_checked_at, context, 'last_checked_at'),
    project_id: parseRequiredString(project_id, context, 'project_id'),
  };
}

export function parseAdminDbDataSourcePreviewSummaryRow(
  value: unknown,
): AdminDbDataSourcePreviewSummaryRow {
  const context = 'data source preview summary';
  if (!isRecord(value)) {
    throw new Error(`Invalid ${context} row.`);
  }
  const {
    failed_count,
    held_count,
    indexed_count,
    last_checked_at,
    last_indexed,
    queue_count,
    raw_count,
  } = value;
  return {
    failed_count: parseCountLike(failed_count, context, 'failed_count'),
    held_count: parseCountLike(held_count, context, 'held_count'),
    indexed_count: parseCountLike(indexed_count, context, 'indexed_count'),
    last_checked_at: parseNullableDateLike(last_checked_at, context, 'last_checked_at'),
    last_indexed: parseNullableDateLike(last_indexed, context, 'last_indexed'),
    queue_count: parseCountLike(queue_count, context, 'queue_count'),
    raw_count: parseCountLike(raw_count, context, 'raw_count'),
  };
}

export function parseAdminDbDataSourcePreviewDocumentRow(
  value: unknown,
): AdminDbDataSourcePreviewDocumentRow {
  const context = 'data source preview document';
  if (!isRecord(value)) {
    throw new Error(`Invalid ${context} row.`);
  }
  const {
    canonical_uri,
    doc_type,
    document_id,
    document_summary,
    fetched_at,
    first_chunk_content,
    indexed_at,
    ingest_status,
    raw_document_id,
    source_id,
    title,
  } = value;
  return {
    canonical_uri: parseNullableString(canonical_uri, context, 'canonical_uri'),
    doc_type: parseNullableString(doc_type, context, 'doc_type'),
    document_id: parseNullableString(document_id, context, 'document_id'),
    document_summary: parseNullableString(document_summary, context, 'document_summary'),
    fetched_at: parseDateLike(fetched_at, context, 'fetched_at'),
    first_chunk_content: parseNullableString(first_chunk_content, context, 'first_chunk_content'),
    indexed_at: parseNullableDateLike(indexed_at, context, 'indexed_at'),
    ingest_status: parseRequiredString(ingest_status, context, 'ingest_status'),
    raw_document_id: parseRequiredString(raw_document_id, context, 'raw_document_id'),
    source_id: parseRequiredString(source_id, context, 'source_id'),
    title: parseNullableString(title, context, 'title'),
  };
}

export function parseAdminDbDataSourcePreviewQueueRow(
  value: unknown,
): AdminDbDataSourcePreviewQueueRow {
  const context = 'data source preview queue';
  if (!isRecord(value)) {
    throw new Error(`Invalid ${context} row.`);
  }
  const { attempts, id, last_error, status, updated_at } = value;
  return {
    attempts: parseCountLike(attempts, context, 'attempts'),
    id: parseRequiredString(id, context, 'id'),
    last_error: parseNullableString(last_error, context, 'last_error'),
    status: parseRequiredString(status, context, 'status'),
    updated_at: parseDateLike(updated_at, context, 'updated_at'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRequiredString(value: unknown, context: string, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${context} row field: ${fieldName}`);
  }
  return value;
}

function parseNullableString(value: unknown, context: string, fieldName: string): string | null {
  return value === null ? null : parseRequiredString(value, context, fieldName);
}

function parseDateLike(value: unknown, context: string, fieldName: string): Date | string {
  if (value instanceof Date || typeof value === 'string') {
    return value;
  }
  throw new Error(`Invalid ${context} row field: ${fieldName}`);
}

function parseNullableDateLike(
  value: unknown,
  context: string,
  fieldName: string,
): Date | string | null {
  return value === null ? null : parseDateLike(value, context, fieldName);
}

function parseBoolean(value: unknown, context: string, fieldName: string): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  throw new Error(`Invalid ${context} row field: ${fieldName}`);
}

function parseMemberRole(value: unknown, context: string, fieldName: string): 'admin' | 'member' {
  if (value === 'admin' || value === 'member') {
    return value;
  }
  throw new Error(`Invalid ${context} row field: ${fieldName}`);
}

function parseCountLike(
  value: unknown,
  context: string,
  fieldName: string,
): number | string | bigint {
  if (
    (typeof value === 'number' && Number.isInteger(value) && value >= 0) ||
    (typeof value === 'string' && /^\d+$/.test(value)) ||
    (typeof value === 'bigint' && value >= 0n)
  ) {
    return value;
  }
  throw new Error(`Invalid ${context} row field: ${fieldName}`);
}

function parseProjectVisibility(
  value: unknown,
  context: string,
  fieldName: string,
): ProjectVisibility {
  if (!isProjectVisibility(value)) {
    throw new Error(`Invalid ${context} row field: ${fieldName}`);
  }
  return value;
}

function parseSourceType(value: unknown, context: string, fieldName: string): SourceType {
  if (!isSourceType(value)) {
    throw new Error(`Invalid ${context} row field: ${fieldName}`);
  }
  return value;
}

function parseOAuthProvider(
  value: unknown,
  context: string,
  fieldName: string,
): 'google' | 'github' {
  if (value === 'google' || value === 'github') {
    return value;
  }
  throw new Error(`Invalid ${context} row field: ${fieldName}`);
}

function parseNullableStringArray(
  value: unknown,
  context: string,
  fieldName: string,
): readonly string[] | null {
  if (value === null) {
    return null;
  }
  if (value === undefined || !Array.isArray(value)) {
    throw new Error(`Invalid ${context} row field: ${fieldName}`);
  }
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`Invalid ${context} row field: ${fieldName}`);
    }
  }
  return value;
}

function parseConfidenceLike(value: unknown, context: string, fieldName: string): number | string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid ${context} row field: ${fieldName}`);
    }
    return value;
  }
  if (typeof value === 'string') {
    if (value.trim() === '' || !Number.isFinite(Number(value))) {
      throw new Error(`Invalid ${context} row field: ${fieldName}`);
    }
    return value;
  }
  throw new Error(`Invalid ${context} row field: ${fieldName}`);
}
