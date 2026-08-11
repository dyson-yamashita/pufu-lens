import { parseCanonicalOrigin } from '@pufu-lens/activitypub';
import { parseActorKeyEncryptionKey } from '@pufu-lens/activitypub/key-encryption';
import postgres from 'postgres';

const ACTIVITYPUB_DELIVERY_FAILED = 'activitypub_delivery_failed';
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
  const flags = new Set<string>();
  const parsed: ParsedArgs = { once: false };
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) {
      throw new Error(`unsupported argument: ${key ?? '<empty>'}`);
    }
    if (flags.has(key)) {
      throw new Error(`duplicate argument: ${key}`);
    }
    flags.add(key);
    switch (key) {
      case '--once':
        parsed.once = true;
        break;
      case '--database-url': {
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) {
          throw new Error('missing value for --database-url');
        }
        parsed.databaseUrl = value;
        index += 1;
        break;
      }
      case '--actor-table': {
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) {
          throw new Error('missing value for --actor-table');
        }
        parsed.actorTable = value;
        index += 1;
        break;
      }
      case '--actor-id': {
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) {
          throw new Error('missing value for --actor-id');
        }
        parsed.actorId = value;
        index += 1;
        break;
      }
      default:
        throw new Error(`unsupported argument: ${key}`);
    }
  }
  return parsed;
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
    const { runActivityPubDispatcherOnce } = await import(
      '@pufu-lens/activitypub/postgres-dispatcher'
    );
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
  }
} catch {
  writeSafeError(ACTIVITYPUB_DELIVERY_FAILED);
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
