import postgres from 'postgres';
import {
  createPostgresReportRepository,
  createReportStorageFromEnv,
  publishPublicReport,
  reportNowFromEnv,
  revokePublicReport,
} from '../apps/web/src/report.ts';
import { requiredEnv } from './lib/cli.ts';

/**
 * Runs the report publishing or revocation flow and outputs its result.
 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });
  try {
    const now = reportNowFromEnv(process.env) ?? new Date();
    const sharedOptions = {
      now,
      repository: createPostgresReportRepository(sql),
      storage: createReportStorageFromEnv(),
    };
    const result = options.revoke
      ? await revokePublicReport({
          now,
          options: sharedOptions,
          projectSlug: options.project,
          reportId: options.report,
          userId: options.userId,
        })
      : await publishPublicReport({
          now,
          options: sharedOptions,
          projectSlug: options.project,
          reportId: options.report,
          userId: options.userId,
        });
    console.log(
      JSON.stringify(
        {
          artifactVersion: result.manifest.artifact_version,
          manifestUri: `${options.project}/reports/public/${options.report}/manifest.json`,
          publicReportUri: result.manifest.public_report_uri,
          revokedAt: result.manifest.revoked_at,
          status: result.status,
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end();
  }
}

function parseArgs(argv: readonly string[]): {
  readonly project: string;
  readonly report: string;
  readonly revoke: boolean;
  readonly userId: string;
} {
  const options: { project?: string; report?: string; revoke: boolean; userId?: string } = {
    revoke: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      options.project = readOptionValue(argv, ++index, arg);
    } else if (arg === '--report') {
      options.report = readOptionValue(argv, ++index, arg);
    } else if (arg === '--user') {
      options.userId = readOptionValue(argv, ++index, arg);
    } else if (arg === '--revoke') {
      options.revoke = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!options.project) {
    throw new Error('--project is required.');
  }
  if (!options.report) {
    throw new Error('--report is required.');
  }
  return {
    project: options.project,
    report: options.report,
    revoke: options.revoke,
    userId: options.userId ?? requiredEnv('PUFU_LENS_REPORT_USER_ID'),
  };
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
