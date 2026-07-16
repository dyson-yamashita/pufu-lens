export function normalizeReportWhitespace(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

export function countCodePoints(value: string): number {
  return [...value].length;
}

export function truncateCodePoints(value: string, maxCodePoints: number): string {
  const codePoints = [...value];
  if (codePoints.length <= maxCodePoints) {
    return value;
  }
  if (maxCodePoints <= 1) {
    return '…';
  }
  return `${codePoints.slice(0, maxCodePoints - 1).join('')}…`;
}

export function truncateReportText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
