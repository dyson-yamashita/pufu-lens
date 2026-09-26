/** Symmetric NFKC/case/trim normalization for portable keyword writes and queries. */
export function normalizeKeyword(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim();
}

/** Produces distinct, unpadded code-point n-grams, retaining punctuation and short terms. */
export function keywordNgrams(value: string, width: number): string[] {
  const points = [...value];
  if (!points.length) return [];
  if (points.length < width) return [value];
  return [
    ...new Set(
      points.slice(0, points.length - width + 1).map((_, i) => points.slice(i, i + width).join('')),
    ),
  ];
}
