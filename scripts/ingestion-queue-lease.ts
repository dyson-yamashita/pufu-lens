import type postgres from 'postgres';

const INGESTION_QUEUE_LEASE_INDEX = 'ingestion_queue_project_lease_idx';

export async function ensureIngestionQueueLeaseColumn(sql: postgres.Sql): Promise<void> {
  if (!(await hasIngestionQueueLeaseColumn(sql))) {
    await sql`
      ALTER TABLE public.ingestion_queue
      ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ
    `;
  }
  if (!(await hasIngestionQueueLeaseIndex(sql))) {
    await sql`
      CREATE INDEX IF NOT EXISTS ingestion_queue_project_lease_idx
      ON public.ingestion_queue (project_id, status, lease_expires_at)
      WHERE status = 'parsing'
    `;
  }
}

async function hasIngestionQueueLeaseColumn(sql: postgres.Sql): Promise<boolean> {
  const columns = await sql`
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = to_regclass('public.ingestion_queue')
      AND attname = 'lease_expires_at'
      AND NOT attisdropped
  `;
  return columns.length > 0;
}

async function hasIngestionQueueLeaseIndex(sql: postgres.Sql): Promise<boolean> {
  const indexes = await sql`
    SELECT 1
    FROM pg_class idx
    JOIN pg_namespace ns ON ns.oid = idx.relnamespace
    WHERE ns.nspname = 'public'
      AND idx.relname = ${INGESTION_QUEUE_LEASE_INDEX}
      AND idx.relkind = 'i'
  `;
  return indexes.length > 0;
}
