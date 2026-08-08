import { processOneQueuedOutboxMessage } from '@pufu-lens/activitypub/postgres';
import postgres from 'postgres';

type ParsedArgs = {
  databaseUrl?: string;
  actorTable?: string;
  actorId?: string;
};

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

const ACTIVITYPUB_DELIVERY_FAILED = 'activitypub_delivery_failed';

function writeSafeError(message: string): void {
  console.error(JSON.stringify({ error: message.slice(0, 120) }));
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

if ((args.actorTable || args.actorId) && process.env.ACTIVITYPUB_RUN_DB_TESTS !== '1') {
  writeSafeError('actor arguments require ACTIVITYPUB_RUN_DB_TESTS=1');
  process.exit(1);
}

if (!args.actorTable || !args.actorId) {
  writeSafeError('missing --actor-table or --actor-id');
  process.exit(1);
}

const canonicalOrigin = process.env.ACTIVITYPUB_CANONICAL_ORIGIN?.trim() ?? 'https://lens.test';

let exitCode = 0;
let sql: ReturnType<typeof postgres> | undefined;

try {
  sql = postgres(args.databaseUrl, { max: 1 });

  const result = await processOneQueuedOutboxMessage({
    sql,
    canonicalOrigin,
    actorTable: args.actorTable,
    actorId: args.actorId,
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
