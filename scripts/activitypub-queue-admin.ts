import { parseScriptArgv } from './lib/cli.ts';

const MISSING_DATABASE_URL = 'missing DATABASE_URL';
const INVALID_ARGUMENTS = 'activitypub_queue_admin_invalid_arguments';
const CONFIRMATION_REQUIRED = 'activitypub_queue_admin_confirmation_required';
const MESSAGE_NOT_FOUND = 'activitypub_queue_admin_message_not_found';
const STALE_STATE = 'activitypub_queue_admin_stale_state';
const INVALID_STATUS = 'activitypub_queue_admin_invalid_status';
const ACTIVE_LEASE = 'activitypub_queue_admin_active_lease';
const OPERATION_FAILED = 'activitypub_queue_admin_failed';
const CLEANUP_FAILED = 'activitypub_queue_admin_connection_close_failed';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSTGRES_CODE_PATTERN = /^[0-9A-Z]{5}$/;
const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;

type QueueAdminCommand = 'inspect' | 'requeue' | 'discard';

type ParsedArgs = {
  command?: QueueAdminCommand;
  messageId?: string;
  execute?: boolean;
  confirmMessageId?: string;
  expectedUpdatedAt?: string;
  changeRef?: string;
};

type SafeErrorDiagnostics = {
  errorName?: string;
  postgresCode?: string;
};

type ValidatedInspectArgs =
  | { readonly ok: false; readonly error: string }
  | { readonly ok: true; readonly messageId: string };

type ValidatedMutationArgs =
  | { readonly ok: false; readonly error: string }
  | {
      readonly ok: true;
      readonly messageId: string;
      readonly expectedUpdatedAt: Date;
      readonly changeRef: string;
    };

/** Parses ActivityPub queue admin CLI arguments without accepting DATABASE_URL overrides. */
function parseArgs(argv: string[]): ParsedArgs {
  const parsed = parseScriptArgv(
    argv,
    {
      commands: ['inspect', 'requeue', 'discard'],
      booleanFlags: ['--execute'],
      valueOptions: [
        '--message-id',
        '--confirm-message-id',
        '--expected-updated-at',
        '--change-ref',
      ],
    },
    2,
  );
  return {
    command: parsed.command,
    messageId: parsed.valueOptions.get('--message-id'),
    execute: parsed.booleanFlags.has('--execute'),
    confirmMessageId: parsed.valueOptions.get('--confirm-message-id'),
    expectedUpdatedAt: parsed.valueOptions.get('--expected-updated-at'),
    changeRef: parsed.valueOptions.get('--change-ref'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeErrorName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && ERROR_NAME_PATTERN.test(trimmed);
}

function writeSafeError(code: string, diagnostics: SafeErrorDiagnostics = {}): void {
  const payload: Record<string, string> = { error: code };
  if (diagnostics.errorName && isSafeErrorName(diagnostics.errorName)) {
    payload.errorName = diagnostics.errorName.trim();
  }
  if (diagnostics.postgresCode && POSTGRES_CODE_PATTERN.test(diagnostics.postgresCode)) {
    payload.postgresCode = diagnostics.postgresCode;
  }
  console.error(JSON.stringify(payload));
}

function extractSafeDiagnostics(error: unknown): SafeErrorDiagnostics {
  const diagnostics: SafeErrorDiagnostics = {};
  if (error instanceof Error && isSafeErrorName(error.name)) {
    diagnostics.errorName = error.name.trim();
  }
  if (isRecord(error) && typeof error.code === 'string' && POSTGRES_CODE_PATTERN.test(error.code)) {
    diagnostics.postgresCode = error.code;
  }
  return diagnostics;
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

function validateInspectArgs(args: ParsedArgs): ValidatedInspectArgs {
  if (!args.messageId || !isUuid(args.messageId)) {
    return { ok: false, error: INVALID_ARGUMENTS };
  }
  return { ok: true, messageId: args.messageId };
}

function validateMutationArgs(
  args: ParsedArgs,
  helpers: Awaited<ReturnType<typeof loadValidationHelpers>>,
): ValidatedMutationArgs {
  if (!args.messageId || !isUuid(args.messageId)) {
    return { ok: false, error: INVALID_ARGUMENTS };
  }
  const expectedUpdatedAt = args.expectedUpdatedAt
    ? helpers.parseCanonicalActivityPubQueueAdminTimestamp(args.expectedUpdatedAt)
    : undefined;
  if (!expectedUpdatedAt) {
    return { ok: false, error: INVALID_ARGUMENTS };
  }
  if (!args.changeRef || !helpers.isValidActivityPubQueueAdminChangeRef(args.changeRef)) {
    return { ok: false, error: INVALID_ARGUMENTS };
  }
  if (!args.execute) {
    return { ok: false, error: CONFIRMATION_REQUIRED };
  }
  if (args.confirmMessageId !== args.messageId) {
    return { ok: false, error: CONFIRMATION_REQUIRED };
  }
  return {
    ok: true,
    messageId: args.messageId,
    expectedUpdatedAt,
    changeRef: args.changeRef,
  };
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

let validatedInspect: ValidatedInspectArgs | undefined;
let validatedMutation: ValidatedMutationArgs | undefined;

if (args.command === 'inspect') {
  validatedInspect = validateInspectArgs(args);
  if (!validatedInspect.ok) {
    writeSafeError(validatedInspect.error);
    process.exit(1);
  }
} else {
  validatedMutation = validateMutationArgs(args, validationHelpers);
  if (!validatedMutation.ok) {
    writeSafeError(validatedMutation.error);
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
      if (!validatedInspect?.ok) {
        writeSafeError(INVALID_ARGUMENTS);
        exitCode = 1;
      } else {
        const message = await inspectActivityPubQueueMessage(sql, validatedInspect.messageId);
        if (!message) {
          writeSafeError(MESSAGE_NOT_FOUND);
          exitCode = 1;
        } else {
          console.log(JSON.stringify({ status: 'ok', message: serializeInspectView(message) }));
        }
      }
    } else if (validatedMutation?.ok) {
      const result =
        args.command === 'requeue'
          ? await requeueRetryExhaustedActivityPubQueueMessage(sql, validatedMutation)
          : await discardRetryExhaustedActivityPubQueueMessage(sql, validatedMutation);

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
      writeSafeError(CLEANUP_FAILED);
    }
  }
} catch (error) {
  writeSafeError(OPERATION_FAILED, extractSafeDiagnostics(error));
  exitCode = 1;
}

process.exit(exitCode);
