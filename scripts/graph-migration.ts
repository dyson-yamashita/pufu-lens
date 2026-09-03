import postgres from 'postgres';
import { requiredEnv } from './lib/cli.ts';
import {
  GraphMigrationCliValidationError,
  parseGraphMigrationCliOptions,
} from './lib/graph-migration-cli-options.ts';
import { runGraphCompare, runGraphRebuild } from './lib/postgres-graph-migration.ts';

/**
 * Runs bounded project-scoped graph migration commands and prints JSON results.
 * Rebuild initializes Object Storage from the environment; compare stays read-only without storage.
 * Always closes the SQL connection before exit.
 */
async function main(): Promise<void> {
  const options = parseGraphMigrationCliOptions(process.argv.slice(2));
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });

  try {
    if (options.command === 'rebuild') {
      const { createObjectStorageFromEnv } = await import('@pufu-lens/storage');
      const storage = createObjectStorageFromEnv(process.env);
      const result = await runGraphRebuild({
        dryRun: options.dryRun,
        limit: options.limit,
        projectSlug: options.project,
        resumeCursor: options.resumeCursor,
        sql,
        storage,
      });
      console.log(JSON.stringify(result));
      return;
    }

    const result = await runGraphCompare({
      limit: options.limit,
      projectSlug: options.project,
      sql,
    });
    console.log(JSON.stringify(result));
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown): void => {
  if (error instanceof GraphMigrationCliValidationError) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  if (error instanceof Error && error.message === 'DATABASE_URL is required.') {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  console.error('Graph migration failed.');
  process.exitCode = 1;
});
