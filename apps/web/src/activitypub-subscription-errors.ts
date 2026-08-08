/**
 * Stable subscription mutation error with machine-readable `code` for API/UI mapping.
 * Callers must expose only sanitized `message` values to end users.
 */
export class ActivityPubSubscriptionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Maps known ActivityPub subscription failures to safe user-facing messages.
 * Unexpected remote payloads, database errors, and raw error.message values are never returned.
 */
export function mapActivityPubSubscriptionErrorMessage(error: unknown): string {
  if (error instanceof ActivityPubSubscriptionError) {
    return error.message;
  }
  if (error instanceof Error) {
    const normalized = error.message.toLowerCase();
    if (normalized.includes('blocked')) {
      return 'This remote domain cannot be subscribed.';
    }
    if (normalized.includes('timed out') || normalized.includes('abort')) {
      return 'The remote actor could not be reached. Try again later.';
    }
    if (normalized.includes('webfinger') || normalized.includes('actor document')) {
      return 'The remote actor address could not be resolved.';
    }
    if (normalized.includes('https')) {
      return 'Remote actor addresses must use HTTPS.';
    }
    if (normalized.includes('canonical origin')) {
      return 'Cannot subscribe to this local actor address.';
    }
    if (normalized.includes('invalid remote actor')) {
      return 'The remote actor address is invalid.';
    }
  }
  return 'Unable to update ActivityPub subscription. Try again later.';
}
