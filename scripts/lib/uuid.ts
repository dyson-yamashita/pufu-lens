/** Canonical UUID structure (8-4-4-4-12 hex groups). */
export const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns true when `value` matches the canonical UUID structure. */
export function isCanonicalUuid(value: string): boolean {
  return CANONICAL_UUID_PATTERN.test(value);
}

/** Throws when `value` is not a canonical UUID. */
export function assertCanonicalUuid(value: string, name: string): void {
  if (!isCanonicalUuid(value)) {
    throw new Error(`${name} must be a valid UUID.`);
  }
}

/** Validates a CLI option value as a canonical UUID. */
export function readCanonicalUuid(value: string, optionName: string): string {
  if (!isCanonicalUuid(value)) {
    throw new Error(`${optionName} must be a valid UUID.`);
  }
  return value;
}

/** Parses optional SQL UUID columns, preserving null/undefined. */
export function parseOptionalCanonicalUuid(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || !isCanonicalUuid(value)) {
    throw new Error(`Invalid field: ${fieldName}`);
  }
  return value;
}
