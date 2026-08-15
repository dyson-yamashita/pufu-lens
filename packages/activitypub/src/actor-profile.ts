/** Raised when ActivityPub actor profile input fails validation or normalization. */
export class ActivityPubActorProfileError extends Error {}

const DISPLAY_NAME_MIN_CODE_POINTS = 1;
const DISPLAY_NAME_MAX_CODE_POINTS = 100;
const ICON_URL_MAX_CODE_POINTS = 2048;
const ADDITIONAL_PROMPT_MAX_CODE_POINTS = 2000;

function countUnicodeCodePoints(value: string): number {
  return [...value].length;
}

function containsControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeSameOriginIconPath(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//')) {
    throw new ActivityPubActorProfileError('Icon URL path is invalid.');
  }
  if (value.includes('\\')) {
    throw new ActivityPubActorProfileError('Icon URL path is invalid.');
  }
  return value;
}

/**
 * Normalizes and validates an ActivityPub actor display name.
 *
 * @throws {ActivityPubActorProfileError} When the display name is empty after trim or exceeds 100 code points.
 */
export function normalizeActivityPubDisplayName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ActivityPubActorProfileError('Display name must not be empty.');
  }
  const codePoints = countUnicodeCodePoints(trimmed);
  if (codePoints < DISPLAY_NAME_MIN_CODE_POINTS || codePoints > DISPLAY_NAME_MAX_CODE_POINTS) {
    throw new ActivityPubActorProfileError('Display name must be between 1 and 100 characters.');
  }
  return trimmed;
}

/**
 * Normalizes and validates an ActivityPub actor icon URL.
 *
 * Accepts absolute HTTPS URLs or same-origin paths beginning with exactly one `/`.
 * Blank values normalize to `null`.
 *
 * @throws {ActivityPubActorProfileError} When the icon URL is unsafe or too long.
 */
export function normalizeActivityPubIconUrl(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalText(value);
  if (normalized === null) {
    return null;
  }
  if (containsControlCharacters(normalized)) {
    throw new ActivityPubActorProfileError('Icon URL contains invalid characters.');
  }
  if (countUnicodeCodePoints(normalized) > ICON_URL_MAX_CODE_POINTS) {
    throw new ActivityPubActorProfileError('Icon URL is too long.');
  }
  if (normalized.startsWith('//')) {
    throw new ActivityPubActorProfileError('Icon URL must not use a protocol-relative path.');
  }
  if (normalized.includes('#')) {
    throw new ActivityPubActorProfileError('Icon URL must not include a fragment.');
  }
  if (normalized.startsWith('/')) {
    return normalizeSameOriginIconPath(normalized);
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new ActivityPubActorProfileError(
      'Icon URL must be an absolute HTTPS URL or a site path.',
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new ActivityPubActorProfileError('Icon URL must use HTTPS.');
  }
  if (parsed.username || parsed.password) {
    throw new ActivityPubActorProfileError('Icon URL must not include credentials.');
  }
  if (parsed.hash) {
    throw new ActivityPubActorProfileError('Icon URL must not include a fragment.');
  }
  return parsed.toString();
}

/**
 * Normalizes and validates an ActivityPub actor additional prompt.
 *
 * Blank values normalize to `null`. Prompt content is never echoed in error messages.
 *
 * @throws {ActivityPubActorProfileError} When the prompt exceeds 2000 code points.
 */
export function normalizeActivityPubAdditionalPrompt(
  value: string | null | undefined,
): string | null {
  const normalized = normalizeOptionalText(value);
  if (normalized === null) {
    return null;
  }
  if (countUnicodeCodePoints(normalized) > ADDITIONAL_PROMPT_MAX_CODE_POINTS) {
    throw new ActivityPubActorProfileError('Additional prompt is too long.');
  }
  return normalized;
}

/** Input for aggregate or project actor profile updates after field-level normalization. */
export type NormalizedActivityPubActorProfile = {
  readonly displayName: string;
  readonly iconUrl: string | null;
  readonly additionalPrompt: string | null;
};

/**
 * Normalizes display name, icon URL, and additional prompt for actor profile persistence.
 *
 * @throws {ActivityPubActorProfileError} When any field fails validation.
 */
export function normalizeActivityPubActorProfile(input: {
  readonly displayName: string;
  readonly iconUrl?: string | null;
  readonly additionalPrompt?: string | null;
}): NormalizedActivityPubActorProfile {
  return {
    displayName: normalizeActivityPubDisplayName(input.displayName),
    iconUrl: normalizeActivityPubIconUrl(input.iconUrl),
    additionalPrompt: normalizeActivityPubAdditionalPrompt(input.additionalPrompt),
  };
}

/**
 * Resolves a stored icon URL for federation output.
 *
 * Same-origin paths are resolved against the configured canonical origin; absolute HTTPS URLs remain unchanged.
 *
 * @throws {ActivityPubActorProfileError} When a same-origin path resolves outside the canonical origin.
 */
export function resolveActivityPubIconUrl(input: {
  readonly canonicalOrigin: string;
  readonly iconUrl: string;
}): string {
  if (input.iconUrl.startsWith('/')) {
    const canonicalOrigin = new URL(input.canonicalOrigin);
    const resolved = new URL(input.iconUrl, input.canonicalOrigin);
    if (resolved.origin !== canonicalOrigin.origin) {
      throw new ActivityPubActorProfileError(
        'Icon URL path resolves outside the canonical origin.',
      );
    }
    return resolved.toString();
  }
  return input.iconUrl;
}
