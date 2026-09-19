import postgres from 'postgres';
import { requiredEnv } from './lib/cli.ts';
import { backfillKeywords, parseKeywordBackfillOptions } from './lib/keyword-backfill.ts';

/** Runs one operator-approved batch; emits only counts and opaque cursor after commit. */
async function main(): Promise<void> {
  const options = parseKeywordBackfillOptions(process.argv.slice(2));
  const sql = postgres(requiredEnv('DATABASE_URL'), {
    max: 1,
    connect_timeout: 10,
    onnotice: () => {},
  });
  try {
    console.log(JSON.stringify(await backfillKeywords(sql, options)));
  } finally {
    await sql.end();
  }
}

main().catch(() => {
  // Database errors may contain source content or credentials; operator can inspect sanitized state.
  console.error(
    'Keyword backfill failed; verify options, schema and connectivity. No cursor advanced.',
  );
  process.exitCode = 1;
});
