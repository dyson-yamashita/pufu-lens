import postgres from 'postgres';
import {
  fetchGitHubJson,
  reconcileGitHubLifecycleBatch,
  summarizeGitHubLifecycleBatchForCli,
} from '../packages/ingestion/dist/index.js';
import { createObjectStorageFromEnv } from '../packages/storage/dist/factory.js';
import { requiredEnv } from './lib/cli.ts';
import { resolveGitHubLifecycleToken } from './lib/collection-connection.ts';
import { PostgresGitHubLifecycleRepository } from './lib/github-lifecycle-backfill-repository.ts';
import { parseGitHubLifecycleCliOptions } from './lib/github-lifecycle-cli-options.ts';

async function main(): Promise<void> {
  const options = parseGitHubLifecycleCliOptions(process.argv.slice(2));
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });
  const storage = createObjectStorageFromEnv(process.env);
  const startedAt = Date.now();

  try {
    const project = await sql`
      SELECT id::text AS id, slug
      FROM public.projects
      WHERE slug = ${options.project}
    `;
    const projectId = project[0]?.id;
    if (!projectId || typeof projectId !== 'string') {
      throw new Error(`Project not found: ${options.project}`);
    }

    if (options.dataSourceId) {
      const scopedDataSource = await sql`
        SELECT id::text AS id
        FROM public.data_sources
        WHERE id = ${options.dataSourceId}::uuid
          AND project_id = ${projectId}::uuid
          AND source_type = 'github'
          AND enabled = true
      `;
      if (!scopedDataSource[0]?.id) {
        throw new Error('GitHub data source was not found in the project scope.');
      }
    }

    const repository = new PostgresGitHubLifecycleRepository(sql, {
      storage: options.dryRun ? undefined : storage,
    });
    const totalTargets = await repository.countOpenGitHubLifecycleTargets({
      dataSourceId: options.dataSourceId,
      projectId,
      resumeAfterLogicalSourceId: options.resumeAfter,
    });

    if (options.dryRun) {
      console.log(
        JSON.stringify(
          {
            dataSourceId: options.dataSourceId ?? null,
            dryRun: true,
            estimatedApiRequests: Math.min(options.limit, totalTargets),
            mode: options.mode,
            projectSlug: options.project,
            remaining: totalTargets,
            resumeAfter: options.resumeAfter ?? null,
          },
          null,
          2,
        ),
      );
      return;
    }

    const tokenCache = new Map<string, Promise<string>>();
    let resumeAfter = options.resumeAfter;
    let processed = 0;
    const summaries = [];
    let stoppedEarly: 'rate_limited' | undefined;
    while (processed < options.limit) {
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      if (elapsedSeconds >= options.maxRuntimeSeconds) {
        break;
      }
      const batch = await reconcileGitHubLifecycleBatch({
        dataSourceId: options.dataSourceId,
        fetcher: fetchGitHubJson,
        limit: Math.min(options.batchSize, options.limit - processed),
        projectId,
        repository,
        resolveToken: async (target) =>
          resolveGitHubLifecycleToken({
            connectionId: target.connectionId,
            dataSourceId: target.dataSourceId,
            projectSlug: options.project,
            sql,
            tokenCache,
          }),
        resumeAfterLogicalSourceId: resumeAfter,
      });
      summaries.push(summarizeGitHubLifecycleBatchForCli(batch));
      processed += batch.processed;
      resumeAfter = batch.resumeAfterLogicalSourceId ?? resumeAfter;
      stoppedEarly = batch.stoppedEarly ?? stoppedEarly;
      if (batch.processed === 0 || batch.stoppedEarly === 'rate_limited') {
        break;
      }
    }

    console.log(
      JSON.stringify(
        {
          batches: summaries,
          mode: options.mode,
          processed,
          projectSlug: options.project,
          remaining: summaries.at(-1)?.remaining ?? totalTargets,
          resumeAfter,
          resumeAfterMeaning:
            'completed-through logicalSourceId; rate-limited items remain in remaining and are retried on resume',
          ...(stoppedEarly ? { stoppedEarly } : {}),
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end();
  }
}

await main();
