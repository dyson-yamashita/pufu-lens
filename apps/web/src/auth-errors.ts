/**
 * Signals that a request requires an authenticated session and no fallback user is available.
 *
 * Callers that intentionally support anonymous access should catch this error and return
 * `null` or a redirect response. Unexpected auth configuration failures must not be masked.
 */
export class AuthRequiredError extends Error {
  constructor() {
    super('Authentication is required.');
    this.name = 'AuthRequiredError';
  }
}
