import postgres from 'postgres';
import {
  createExtractiveReportProvider,
  createGeminiReportProvider,
  createPostgresReportRepository,
  createReportStorageFromEnv,
  reportNowFromEnv,
  runGenerateReport,
} from '../apps/web/src/report.ts';
import { requiredEnv } from './lib/cli.ts';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });
  try {
    const provider =
      process.env.GEMINI_API_KEY && process.env.GEMINI_CHAT_MODEL
        ? createGeminiReportProvider({
            apiKey: process.env.GEMINI_API_KEY,
            model: process.env.GEMINI_CHAT_MODEL,
          })
        : createExtractiveReportProvider();
    const result = await runGenerateReport({
      options: {
        generatedBy: 'pnpm report:generate',
        now: reportNowFromEnv(process.env),
        provider,
        repository: createPostgresReportRepository(sql),
        storage: createReportStorageFromEnv(),
      },
      projectSlug: options.project,
    });
    console.log(
      JSON.stringify(
        {
          reportId: result.report.report_id,
          reportUrl: result.reportUrl,
          schemaVersion: result.report.schema_version,
          storageUri: result.storageUri,
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end();
  }
}

function parseArgs(argv: readonly string[]): { readonly project: string } {
  const options: { project?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      options.project = readOptionValue(argv, ++index, arg);
    } else if (arg === '--period') {
      const period = readOptionValue(argv, ++index, arg);
      if (period !== 'weekly') {
        throw new Error(`Unsupported --period: ${period}`);
      }
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!options.project) {
    throw new Error('--project is required.');
  }
  return { project: options.project };
}

function readOptionValue(argv: readonly string[], index: number, optionName: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
