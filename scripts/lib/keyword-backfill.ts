import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { parseScriptArgv } from './cli.ts';

type Cursor = { documentId: string; chunkId: string };
export type KeywordBackfillOptions = {
  projectId: string;
  documentFrom: string | null;
  documentThrough: string | null;
  limit: number;
  dryRun: boolean;
  status: boolean;
  cursor: Cursor | null;
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Validates bounded operator scope and a scope-bound resume token before connecting to a DB. */
export function parseKeywordBackfillOptions(argv: readonly string[]): KeywordBackfillOptions {
  const parsed = parseScriptArgv(argv, {
    booleanFlags: ['--dry-run', '--execute', '--status'],
    valueOptions: [
      '--project',
      '--document-from',
      '--document-through',
      '--limit',
      '--resume-cursor',
    ],
  });
  const id = (flag: string, required = false) => {
    const value = parsed.valueOptions.get(flag)?.toLowerCase() ?? null;
    if ((required && !value) || (value !== null && !uuidPattern.test(value))) {
      throw new Error(`${flag} must be a UUID.`);
    }
    return value;
  };
  const projectId = id('--project', true);
  if (!projectId) throw new Error('--project is required.');
  const documentFrom = id('--document-from');
  const documentThrough = id('--document-through');
  if (documentFrom && documentThrough && documentFrom > documentThrough) {
    throw new Error('Document range is reversed.');
  }
  const modes = ['--dry-run', '--execute', '--status'].filter((f) => parsed.booleanFlags.has(f));
  if (modes.length !== 1) throw new Error('Choose exactly one of --dry-run, --execute, --status.');
  const limitText = parsed.valueOptions.get('--limit') ?? '100';
  const limit = Number(limitText);
  if (!/^\d+$/.test(limitText) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('--limit must be 1..1000.');
  }
  const options: KeywordBackfillOptions = {
    projectId,
    documentFrom,
    documentThrough,
    limit,
    dryRun: parsed.booleanFlags.has('--dry-run'),
    status: parsed.booleanFlags.has('--status'),
    cursor: null,
  };
  const token = parsed.valueOptions.get('--resume-cursor');
  if (token) {
    if (options.status || token.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(token)) {
      throw new Error('Invalid resume cursor.');
    }
    const value: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      !('scope' in value) ||
      value.scope !== scope(options) ||
      !('documentId' in value) ||
      typeof value.documentId !== 'string' ||
      !uuidPattern.test(value.documentId) ||
      !('chunkId' in value) ||
      typeof value.chunkId !== 'string' ||
      !uuidPattern.test(value.chunkId) ||
      (documentFrom && value.documentId < documentFrom) ||
      (documentThrough && value.documentId > documentThrough)
    ) {
      throw new Error('Resume cursor does not match scope.');
    }
    options.cursor = { documentId: value.documentId, chunkId: value.chunkId };
  }
  return options;
}

/**
 * Executes one bounded atomic batch using current locked content; NULL alone means pending.
 * Dry-run/status use read-only transactions. The returned cursor is valid only after commit.
 * Progress covers the whole range, including rows behind the cursor; restart without it if needed.
 * No query/content/snippet is logged. Caller owns DB authorization and scheduling of further batches.
 */
export async function backfillKeywords(sql: postgres.Sql, options: KeywordBackfillOptions) {
  return sql.begin(options.dryRun || options.status ? 'read only' : '', async (tx) => {
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx`SET LOCAL lock_timeout = '5s'`;
    const projects = await tx`SELECT id FROM public.projects WHERE id = ${options.projectId}`;
    if (!projects.length) throw new Error('Unknown project.');
    const range = tx`project_id = ${options.projectId}
      AND (${options.documentFrom}::uuid IS NULL OR document_id >= ${options.documentFrom}::uuid)
      AND (${options.documentThrough}::uuid IS NULL OR document_id <= ${options.documentThrough}::uuid)`;
    let selected: Cursor[] = [];
    if (!options.status) {
      const rows: readonly unknown[] = await tx`
        SELECT document_id::text, id::text FROM public.document_chunks
        WHERE ${range} AND keyword_content IS NULL
          AND (${options.cursor?.documentId ?? null}::uuid IS NULL
            OR (document_id, id) > (${options.cursor?.documentId ?? null}::uuid, ${options.cursor?.chunkId ?? null}::uuid))
        ORDER BY document_id, id LIMIT ${options.limit}
        ${options.dryRun ? tx`` : tx`FOR UPDATE`}
      `;
      selected = rows.map((row) => {
        if (
          !row ||
          typeof row !== 'object' ||
          !('id' in row) ||
          typeof row.id !== 'string' ||
          !('document_id' in row) ||
          typeof row.document_id !== 'string'
        ) {
          throw new Error('Invalid keyword backfill row.');
        }
        return { documentId: row.document_id, chunkId: row.id };
      });
      if (!options.dryRun && selected.length) {
        // Trigger derives from current content while row locks serialize ingest/reprocessing.
        await tx`UPDATE public.document_chunks SET keyword_content = content
          WHERE ${range} AND id = ANY(${tx.array(selected.map((r) => r.chunkId))}::uuid[])
            AND keyword_content IS NULL`;
      }
    }
    const counts: readonly unknown[] = await tx`
      SELECT count(*)::text AS total,
        count(*) FILTER (WHERE keyword_content IS NULL)::text AS pending
      FROM public.document_chunks WHERE ${range}
    `;
    const row = counts[0];
    if (
      !row ||
      typeof row !== 'object' ||
      !('total' in row) ||
      typeof row.total !== 'string' ||
      !('pending' in row) ||
      typeof row.pending !== 'string'
    ) {
      throw new Error('Invalid keyword progress row.');
    }
    const last = options.dryRun ? options.cursor : (selected.at(-1) ?? options.cursor);
    return {
      total: row.total,
      pending: row.pending,
      selected: selected.length,
      updated: options.dryRun || options.status ? 0 : selected.length,
      dryRun: options.dryRun,
      resumeCursor: last
        ? Buffer.from(JSON.stringify({ scope: scope(options), ...last })).toString('base64url')
        : null,
    };
  });
}

function scope(options: KeywordBackfillOptions): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'keyword-v1',
        options.projectId,
        options.documentFrom,
        options.documentThrough,
      ]),
    )
    .digest('hex');
}
