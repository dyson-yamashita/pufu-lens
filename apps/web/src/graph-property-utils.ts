/**
 * Reads a non-empty string graph property value.
 *
 * @param properties - The property bag to inspect.
 * @param key - The property key to read.
 * @returns The string value when present and non-empty.
 */
export function graphPropertyString(
  properties: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = properties[key];
  return typeof value === 'string' && value ? value : undefined;
}
