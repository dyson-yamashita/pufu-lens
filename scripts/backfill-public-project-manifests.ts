import postgres from 'postgres';
import { createReportStorageFromEnv, writePublicProjectManifest } from '../apps/web/src/report.ts';
import { requiredEnv } from './lib/cli.ts';

type PublicProjectRow = {
  last_published_at: Date | string | null;
  slug: string;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });
  try {
    const rows = (await sql`
      SELECT
        p.slug,
        max(r.created_at) AS last_published_at
      FROM public.projects p
      LEFT JOIN public.reports r
        ON r.project_id = p.id
        AND r.is_public = true
      WHERE COALESCE(p.visibility, 'private') = 'public'
      GROUP BY p.slug
      ORDER BY p.slug
    `) as PublicProjectRow[];

    const storage = createReportStorageFromEnv();
    const results: Array<{
      action: 'dry_run' | 'written';
      projectSlug: string;
      publishedAt: string;
    }> = [];

    for (const row of rows) {
      const publishedAt = formatPublishedAt(row.last_published_at);
      if (!options.dryRun) {
        await writePublicProjectManifest({
          projectSlug: row.slug,
          publishedAt,
          storage,
          visibility: 'public',
        });
      }
      results.push({
        action: options.dryRun ? 'dry_run' : 'written',
        projectSlug: row.slug,
        publishedAt,
      });
    }

    console.log(JSON.stringify({ count: results.length, results }, null, 2));
  } finally {
    await sql.end();
  }
}

function parseArgs(argv: readonly string[]): { readonly dryRun: boolean } {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return { dryRun };
}

function formatPublishedAt(value: Date | string | null): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
