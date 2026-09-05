import { createPostgresGraphTransitionMutationRepository } from '@pufu-lens/graph/postgres-transition-mutation';
import postgres from 'postgres';
import type { GraphTargetTransactionRunner } from '../packages/ingestion/dist/index.js';
import { storeGraphRelations } from '../packages/ingestion/dist/index.js';
import { createObjectStorageFromEnv } from '../packages/storage/dist/factory.js';
import { requiredEnv } from './lib/cli.ts';
import {
  createPostgresGraphIndexingRepository,
  createPostgresGraphProjectResolver,
  parseIndexGraphRelationsCliArgs,
} from './lib/postgres-graph-indexing-adapter.ts';

async function main(): Promise<void> {
  const options = parseIndexGraphRelationsCliArgs(process.argv.slice(2));
  const projectSlug = requiredOption(options.project, '--project');
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });
  const storage = createObjectStorageFromEnv(process.env);
  const projectResolver = createPostgresGraphProjectResolver(sql);
  const indexingOptions = {
    dataSourceId: options.dataSourceId,
    sourceType: options.source,
  };
  const indexingRepository = createPostgresGraphIndexingRepository(sql, storage, indexingOptions);
  const mutationRepository = createPostgresGraphTransitionMutationRepository(sql);
  const runInTargetTransaction: GraphTargetTransactionRunner = async (callback) => {
    const result = await sql.begin(async (tx) =>
      callback({
        indexingRepository: createPostgresGraphIndexingRepository(tx, storage, indexingOptions),
        mutationRepository: createPostgresGraphTransitionMutationRepository(tx),
      }),
    );
    return result;
  };

  try {
    const result = await storeGraphRelations({
      indexingRepository,
      limit: options.limit ?? 10,
      mutationRepository,
      projectResolver,
      projectSlug,
      runInTargetTransaction,
    });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

function requiredOption(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
