import { ActivityPubAdminError } from './activitypub-admin.ts';

/**
 * Parses the federation enable/disable form field submitted by project admins.
 *
 * @param value - Raw `enabled` form value; only exact `true` or `false` strings are accepted.
 * @returns Parsed boolean federation state to apply.
 * @throws {ActivityPubAdminError} When the value is not an exact `true` or `false` string.
 */
export function parseFederationEnabledFormValue(value: string): boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new ActivityPubAdminError('invalid_body', 'enabled must be true or false', 400);
}
