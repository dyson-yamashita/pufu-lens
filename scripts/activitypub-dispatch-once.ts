import { parseCanonicalOrigin } from '@pufu-lens/activitypub';
import { parseActorKeyEncryptionKey } from '@pufu-lens/activitypub/key-encryption';
import postgres from 'postgres';
import { parseScriptArgv } from './lib/cli.ts';

const ACTIVITYPUB_DELIVERY_FAILED = 'activitypub_delivery_failed';
const ACTIVITYPUB_OPERATIONS_SNAPSHOT_FAILED = 'activitypub_operations_snapshot_failed';
const MISSING_CANONICAL_ORIGIN = 'missing ACTIVITYPUB_CANONICAL_ORIGIN';
const INVALID_CANONICAL_ORIGIN = 'invalid ACTIVITYPUB_CANONICAL_ORIGIN';
const MISSING_DATABASE_URL = 'missing DATABASE_URL';
const ACTOR_ARGS_INCOMPLETE = 'actor arguments require both --actor-table and --actor-id';
const ACTOR_ARGS_FORBIDDEN = 'actor arguments require ACTIVITYPUB_RUN_DB_TESTS=1';

type ParsedArgs = {
  once: boolean;
  databaseUrl?: string;
  actorTable?: string;
  actorId?: string;
};

/** Parses the production ActivityPub one-shot dispatch CLI arguments. */
function parseArgs(argv: string[]): ParsedArgs {
  const parsed = parseScriptArgv(
    argv,
    {
      booleanFlags: ['--once'],
      valueOptions: ['--database-url', '--actor-table', '--actor-id'],
    },
    2,
  );
  return {
    once: parsed.booleanFlags.has('--once'),
    databaseUrl: parsed.valueOptions.get('--database-url'),
    actorTable: parsed.valueOptions.get('--actor-table'),
    actorId: parsed.valueOptions.get('--actor-id'),
  };
}

function writeSafeError(message: string): void {
  console.error(JSON.stringify({ error: message.slice(0, 120) }));
}

function resolveCanonicalOrigin(isDbTestPath: boolean): string {
  const configured = process.env.ACTIVITYPUB_CANONICAL_ORIGIN?.trim();
  if (!configured) {
    if (isDbTestPath) {
      return 'https://lens.test';
    }
    throw new Error(MISSING_CANONICAL_ORIGIN);
  }
  return parseCanonicalOrigin(configured).origin;
}

let args: ParsedArgs;
try {
  args = parseArgs(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : 'invalid arguments';
  writeSafeError(message);
  process.exit(1);
}

if (!args.once) {
  writeSafeError('missing --once');
  process.exit(1);
}

const isDbTestPath =
  process.env.ACTIVITYPUB_RUN_DB_TESTS === '1' && process.env.NODE_ENV === 'test';
const hasActorTable = Boolean(args.actorTable);
const hasActorId = Boolean(args.actorId);

if (hasActorTable !== hasActorId) {
  writeSafeError(ACTOR_ARGS_INCOMPLETE);
  process.exit(1);
}

if ((hasActorTable || hasActorId || args.databaseUrl) && !isDbTestPath) {
  writeSafeError(ACTOR_ARGS_FORBIDDEN);
  process.exit(1);
}

const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  writeSafeError(MISSING_DATABASE_URL);
  process.exit(1);
}

let canonicalOrigin: string;
try {
  canonicalOrigin = resolveCanonicalOrigin(isDbTestPath);
} catch (error) {
  const message = error instanceof Error ? error.message : INVALID_CANONICAL_ORIGIN;
  writeSafeError(message);
  process.exit(1);
}

let exitCode = 0;
let sql: ReturnType<typeof postgres> | undefined;

try {
  sql = postgres(databaseUrl, { max: 1 });

  if (hasActorTable && hasActorId) {
    const { processOneQueuedOutboxMessage } = await import('@pufu-lens/activitypub/postgres');
    const result = await processOneQueuedOutboxMessage({
      sql,
      canonicalOrigin,
      actorTable: args.actorTable as string,
      actorId: args.actorId as string,
      testOnlyAllowPrivateAddress: true,
    });
    if (result.status === 'no-op') {
      console.log(JSON.stringify({ status: 'no-op' }));
    } else if (result.status === 'processed') {
      console.log(
        JSON.stringify({
          processor: result.processor,
          messageId: result.messageId,
          queueKind: result.queueKind,
        }),
      );
    } else {
      console.log(
        JSON.stringify({
          status: result.status,
          messageId: result.messageId,
          queueKind: result.queueKind,
        }),
      );
    }
  } else {
    const { createPostgresActivityPubRepository } = await import(
      '@pufu-lens/activitypub/actor-repository'
    );
    const { parseBlockedDomainsFromEnv } = await import('@pufu-lens/activitypub');
    const {
      fetchActivityPubOperationsSnapshot,
      serializeActivityPubOriginFailureMetricsEvent,
      serializeActivityPubQueueMetricsEvent,
    } = await import('@pufu-lens/activitypub/operations');
    const { runActivityPubDispatcherOnce } = await import(
      '@pufu-lens/activitypub/postgres-dispatcher'
    );
    const dispatcherStartedAt = Date.now();
    const encryptionKey = parseActorKeyEncryptionKey(
      process.env.ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY,
    );
    const actorRepository = createPostgresActivityPubRepository({
      sql,
      encryptionKey,
    });
    const result = await runActivityPubDispatcherOnce({
      sql,
      canonicalOrigin,
      encryptionKey,
      actorRepository,
      isDomainBlocked: parseBlockedDomainsFromEnv(process.env.ACTIVITYPUB_BLOCKED_DOMAINS),
      testOnlyAllowPrivateAddress: isDbTestPath ? true : undefined,
    });
    console.log(
      JSON.stringify({
        status: result.status,
        activitiesMaterialized: result.activitiesMaterialized,
        queueProcessed: result.queueProcessed,
        queueNoOps: result.queueNoOps,
      }),
    );

    let snapshot: Awaited<ReturnType<typeof fetchActivityPubOperationsSnapshot>>;
    try {
      snapshot = await fetchActivityPubOperationsSnapshot(sql);
    } catch {
      throw new Error(ACTIVITYPUB_OPERATIONS_SNAPSHOT_FAILED);
    }
    console.log(
      JSON.stringify(
        serializeActivityPubQueueMetricsEvent({
          snapshot,
          dispatcherDurationMs: Date.now() - dispatcherStartedAt,
        }),
      ),
    );
    for (const originSummary of snapshot.originFailureSummaries) {
      console.log(JSON.stringify(serializeActivityPubOriginFailureMetricsEvent(originSummary)));
    }
  }
} catch (error) {
  if (error instanceof Error && error.message === ACTIVITYPUB_OPERATIONS_SNAPSHOT_FAILED) {
    writeSafeError(ACTIVITYPUB_OPERATIONS_SNAPSHOT_FAILED);
  } else {
    writeSafeError(ACTIVITYPUB_DELIVERY_FAILED);
  }
  exitCode = 1;
} finally {
  if (sql) {
    try {
      await sql.end({ timeout: 5 });
    } catch {
      writeSafeError(ACTIVITYPUB_DELIVERY_FAILED);
      exitCode = 1;
    }
  }
}

process.exit(exitCode);
