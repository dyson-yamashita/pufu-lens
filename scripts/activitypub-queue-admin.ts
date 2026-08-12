const MISSING_DATABASE_URL = 'missing DATABASE_URL';
const INVALID_ARGUMENTS = 'activitypub_queue_admin_invalid_arguments';
const CONFIRMATION_REQUIRED = 'activitypub_queue_admin_confirmation_required';
const MESSAGE_NOT_FOUND = 'activitypub_queue_admin_message_not_found';
const STALE_STATE = 'activitypub_queue_admin_stale_state';
const INVALID_STATUS = 'activitypub_queue_admin_invalid_status';
const ACTIVE_LEASE = 'activitypub_queue_admin_active_lease';
const OPERATION_FAILED = 'activitypub_queue_admin_failed';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type QueueAdminCommand = 'inspect' | 'requeue' | 'discard';

type ParsedArgs = {
  command?: QueueAdminCommand;
  messageId?: string;
  execute?: boolean;
  confirmMessageId?: string;
  expectedUpdatedAt?: string;
  changeRef?: string;
};

/** Parses ActivityPub queue admin CLI arguments without accepting DATABASE_URL overrides. */
function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const parsed: ParsedArgs = {};
  const positional = argv[2];
  if (positional && !positional.startsWith('--')) {
    if (positional === 'inspect' || positional === 'requeue' || positional === 'discard') {
      parsed.command = positional;
    } else {
      throw new Error(`unsupported command: ${positional}`);
    }
  }

  for (
    let index = positional && !positional.startsWith('--') ? 3 : 2;
    index < argv.length;
    index += 1
  ) {
    const key = argv[index];
    if (!key?.startsWith('--')) {
      throw new Error(`unsupported argument: ${key ?? '<empty>'}`);
    }
    if (flags.has(key)) {
      throw new Error(`duplicate argument: ${key}`);
    }
    flags.add(key);
    switch (key) {
      case '--execute':
        parsed.execute = true;
        break;
      case '--message-id':
      case '--confirm-message-id':
      case '--expected-updated-at':
      case '--change-ref': {
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) {
          throw new Error(`missing value for ${key}`);
        }
        if (key === '--message-id') {
          parsed.messageId = value;
        } else if (key === '--confirm-message-id') {
          parsed.confirmMessageId = value;
        } else if (key === '--expected-updated-at') {
          parsed.expectedUpdatedAt = value;
        } else {
          parsed.changeRef = value;
        }
        index += 1;
        break;
      }
      default:
        throw new Error(`unsupported argument: ${key}`);
    }
  }

  return parsed;
}

function writeSafeError(code: string): void {
  console.error(JSON.stringify({ error: code }));
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function serializeInspectView(
  message: NonNullable<
    Awaited<
      ReturnType<typeof import('@pufu-lens/activitypub/operations').inspectActivityPubQueueMessage>
    >
  >,
) {
  return {
    id: message.id,
    queueKind: message.queueKind,
    recipientOrigin: message.recipientOrigin,
    status: message.status,
    attemptCount: message.attemptCount,
    lastErrorCode: message.lastErrorCode,
    lastHttpStatus: message.lastHttpStatus,
    availableAt: message.availableAt.toISOString(),
    createdAt: message.createdAt.toISOString(),
    startedAt: message.startedAt?.toISOString() ?? null,
    completedAt: message.completedAt?.toISOString() ?? null,
    updatedAt: message.updatedAt.toISOString(),
  };
}

async function loadValidationHelpers() {
  const { isValidActivityPubQueueAdminChangeRef, parseCanonicalActivityPubQueueAdminTimestamp } =
    await import('@pufu-lens/activitypub/operations');
  return { isValidActivityPubQueueAdminChangeRef, parseCanonicalActivityPubQueueAdminTimestamp };
}

function validateMutationArgs(
  args: ParsedArgs,
  helpers: Awaited<ReturnType<typeof loadValidationHelpers>>,
): string | undefined {
  if (!args.messageId || !isUuid(args.messageId)) {
    return INVALID_ARGUMENTS;
  }
  if (
    !args.expectedUpdatedAt ||
    !helpers.parseCanonicalActivityPubQueueAdminTimestamp(args.expectedUpdatedAt)
  ) {
    return INVALID_ARGUMENTS;
  }
  if (!args.changeRef || !helpers.isValidActivityPubQueueAdminChangeRef(args.changeRef)) {
    return INVALID_ARGUMENTS;
  }
  if (!args.execute) {
    return CONFIRMATION_REQUIRED;
  }
  if (args.confirmMessageId !== args.messageId) {
    return CONFIRMATION_REQUIRED;
  }
  return undefined;
}

let args: ParsedArgs;
try {
  args = parseArgs(process.argv);
} catch {
  writeSafeError(INVALID_ARGUMENTS);
  process.exit(1);
}

if (!args.command) {
  writeSafeError(INVALID_ARGUMENTS);
  process.exit(1);
}

const validationHelpers = await loadValidationHelpers();

if (args.command === 'inspect') {
  if (!args.messageId || !isUuid(args.messageId)) {
    writeSafeError(INVALID_ARGUMENTS);
    process.exit(1);
  }
} else {
  const validationError = validateMutationArgs(args, validationHelpers);
  if (validationError) {
    writeSafeError(validationError);
    process.exit(1);
  }
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  writeSafeError(MISSING_DATABASE_URL);
  process.exit(1);
}

let exitCode = 0;

try {
  const postgres = (await import('postgres')).default;
  const {
    discardRetryExhaustedActivityPubQueueMessage,
    inspectActivityPubQueueMessage,
    requeueRetryExhaustedActivityPubQueueMessage,
  } = await import('@pufu-lens/activitypub/operations');

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    if (args.command === 'inspect') {
      const message = await inspectActivityPubQueueMessage(sql, args.messageId as string);
      if (!message) {
        writeSafeError(MESSAGE_NOT_FOUND);
        exitCode = 1;
      } else {
        console.log(JSON.stringify({ status: 'ok', message: serializeInspectView(message) }));
      }
    } else {
      const mutationInput = {
        messageId: args.messageId as string,
        expectedUpdatedAt: validationHelpers.parseCanonicalActivityPubQueueAdminTimestamp(
          args.expectedUpdatedAt as string,
        ) as Date,
        changeRef: args.changeRef as string,
      };
      const result =
        args.command === 'requeue'
          ? await requeueRetryExhaustedActivityPubQueueMessage(sql, mutationInput)
          : await discardRetryExhaustedActivityPubQueueMessage(sql, mutationInput);

      switch (result.status) {
        case 'updated':
          console.log(
            JSON.stringify({
              status: 'updated',
              action: result.action,
              auditActionId: result.auditActionId,
              message: serializeInspectView(result.message),
            }),
          );
          break;
        case 'not_found':
          writeSafeError(MESSAGE_NOT_FOUND);
          exitCode = 1;
          break;
        case 'stale_state':
          writeSafeError(STALE_STATE);
          exitCode = 1;
          break;
        case 'invalid_status':
          writeSafeError(INVALID_STATUS);
          exitCode = 1;
          break;
        case 'active_lease':
          writeSafeError(ACTIVE_LEASE);
          exitCode = 1;
          break;
        default:
          writeSafeError(OPERATION_FAILED);
          exitCode = 1;
      }
    }
  } finally {
    try {
      await sql.end({ timeout: 5 });
    } catch {
      writeSafeError(OPERATION_FAILED);
      exitCode = 1;
    }
  }
} catch {
  writeSafeError(OPERATION_FAILED);
  exitCode = 1;
}

process.exit(exitCode);
