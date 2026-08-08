import { parseCanonicalOrigin } from '@pufu-lens/activitypub';
import { parseActorKeyEncryptionKey } from '@pufu-lens/activitypub/key-encryption';
import postgres from 'postgres';

type ParsedArgs = {
  databaseUrl?: string;
  actorTable?: string;
  actorId?: string;
};

const ACTIVITYPUB_DELIVERY_FAILED = 'activitypub_delivery_failed';
const MISSING_CANONICAL_ORIGIN = 'missing ACTIVITYPUB_CANONICAL_ORIGIN';
const INVALID_CANONICAL_ORIGIN = 'invalid ACTIVITYPUB_CANONICAL_ORIGIN';
const ACTOR_ARGS_INCOMPLETE = 'actor arguments require both --actor-table and --actor-id';
const ACTOR_ARGS_FORBIDDEN = 'actor arguments require ACTIVITYPUB_RUN_DB_TESTS=1';

/** Parses the supported ActivityPub one-shot dispatch CLI arguments. */
function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) {
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for ${key}`);
    }
    switch (key) {
      case '--database-url':
        parsed.databaseUrl = value;
        break;
      case '--actor-table':
        parsed.actorTable = value;
        break;
      case '--actor-id':
        parsed.actorId = value;
        break;
      default:
        throw new Error(`unsupported argument: ${key}`);
    }
    index += 1;
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

if (!args.databaseUrl) {
  writeSafeError('missing --database-url');
  process.exit(1);
}

const isDbTestPath = process.env.ACTIVITYPUB_RUN_DB_TESTS === '1';
const hasActorTable = Boolean(args.actorTable);
const hasActorId = Boolean(args.actorId);

if (hasActorTable !== hasActorId) {
  writeSafeError(ACTOR_ARGS_INCOMPLETE);
  process.exit(1);
}

if ((hasActorTable || hasActorId) && !isDbTestPath) {
  writeSafeError(ACTOR_ARGS_FORBIDDEN);
  process.exit(1);
}

let canonicalOrigin: string;
try {
  canonicalOrigin = resolveCanonicalOrigin(hasActorTable && hasActorId);
} catch (error) {
  const message = error instanceof Error ? error.message : INVALID_CANONICAL_ORIGIN;
  writeSafeError(message);
  process.exit(1);
}

let exitCode = 0;
let sql: ReturnType<typeof postgres> | undefined;

try {
  sql = postgres(args.databaseUrl, { max: 1 });

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
    } else {
      console.log(
        JSON.stringify({
          processor: result.processor,
          messageId: result.messageId,
        }),
      );
    }
  } else {
    const { createPostgresActivityPubRepository } = await import(
      '@pufu-lens/activitypub/actor-repository'
    );
    const { processOneQueuedMessage } = await import('@pufu-lens/activitypub/postgres');
    const encryptionKey = parseActorKeyEncryptionKey(
      process.env.ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY,
    );
    const actorRepository = createPostgresActivityPubRepository({
      sql,
      encryptionKey,
    });
    const result = await processOneQueuedMessage({
      sql,
      canonicalOrigin,
      encryptionKey,
      actorRepository,
      testOnlyAllowPrivateAddress: isDbTestPath ? true : undefined,
    });
    if (result.status === 'no-op') {
      console.log(JSON.stringify({ status: 'no-op' }));
    } else {
      console.log(
        JSON.stringify({
          processor: result.processor,
          messageId: result.messageId,
        }),
      );
    }
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
