import type { CustomReportPart, CustomReportSnapshotV1 } from './custom-report-schema.ts';
import type { PrivateReportJsonV1 } from './report-schema.ts';

const PDF_TEXT_DENYLIST = [
  /raw[_-]?document[_-]?id/iu,
  /private[_-]?raw[_-]?locator/iu,
  /storage[_-]?uri/iu,
  /secret/iu,
  /api[_-]?key/iu,
  /token/iu,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu,
];

export interface ReportPdfFile {
  readonly bytes: ArrayBuffer;
  readonly fileName: string;
}

export function renderReportPdf(input: {
  readonly projectSlug: string;
  readonly report: PrivateReportJsonV1;
}): ReportPdfFile {
  const lines = safeReportPdfLines(input.report);
  return {
    bytes: createSimplePdf(lines),
    fileName: safePdfFileName(`${input.projectSlug}-${input.report.report_id}.pdf`),
  };
}

export function safeReportPdfLines(report: PrivateReportJsonV1): readonly string[] {
  const lines: string[] = [
    report.title,
    `Report ID: ${report.report_id}`,
    `Period: ${report.period.start} - ${report.period.end}`,
    `Generated: ${report.generated_at}`,
    '',
    'Summary',
    report.summary,
  ];
  if (report.custom_layout) {
    lines.push('', 'Custom layout', ...customLayoutLines(report.custom_layout));
  } else {
    for (const section of report.sections) {
      lines.push('', section.title, stripMarkdown(section.markdown));
      if (section.metrics && Object.keys(section.metrics).length > 0) {
        lines.push(
          `Metrics: ${Object.entries(section.metrics)
            .map(([key, value]) => `${key}=${value}`)
            .join(', ')}`,
        );
      }
    }
  }
  return lines.map(redactPdfText).flatMap(wrapPdfLine).slice(0, 850);
}

function customLayoutLines(snapshot: CustomReportSnapshotV1): readonly string[] {
  return partLines(snapshot.layout.root, snapshot);
}

function partLines(part: CustomReportPart, snapshot: CustomReportSnapshotV1): string[] {
  switch (part.type) {
    case 'title':
      return [part.text];
    case 'pufu_board':
      return ['Pufu board'];
    case 'slider_judgement': {
      const result = snapshot.results[part.result_key];
      return result?.type === 'slider_judgement'
        ? [`${result.left_label} / ${result.right_label}: ${result.score}`, result.reason]
        : [`Missing result: ${part.result_key}`];
    }
    case 'classification_result': {
      const result = snapshot.results[part.result_key];
      return result?.type === 'classification_result'
        ? [result.title, result.description, result.reason]
        : [`Missing result: ${part.result_key}`];
    }
    case 'fixed_text': {
      const result = snapshot.results[part.id];
      return [result?.type === 'fixed_text' ? result.text : part.text];
    }
    case 'fixed_image':
      return [`Image: ${part.alt_text}${part.caption ? ` (${part.caption})` : ''}`];
    case 'columns':
      return part.columns.flatMap((column) =>
        column.children.flatMap((child) => partLines(child, snapshot)),
      );
    case 'row':
      return part.children.flatMap((child) => partLines(child, snapshot));
    case 'divider':
      return ['---'];
    case 'copyright':
      return [part.text];
    default: {
      const _exhaustiveCheck: never = part;
      return [];
    }
  }
}

function redactPdfText(value: string): string {
  let text = stripControlCharacters(stripMarkdown(value)).trim();
  for (const pattern of PDF_TEXT_DENYLIST) {
    text = text.replace(pattern, '[redacted]');
  }
  return text;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wrapPdfLine(value: string): readonly string[] {
  if (!value) return [''];
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += 92) {
    chunks.push(value.slice(index, index + 92));
  }
  return chunks;
}

function safePdfFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function createSimplePdf(lines: readonly string[]): ArrayBuffer {
  const pageHeight = 792;
  const lineHeight = 14;
  const linesPerPage = 48;
  const pageLineGroups: readonly string[][] = chunk(lines, linesPerPage);
  const objects: string[] = [];
  const pageObjectIds: number[] = [];
  const fontObjectId = 3;
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '';
  objects[fontObjectId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let nextObjectId = 4;
  for (const pageLines of pageLineGroups) {
    const contentObjectId = nextObjectId++;
    const pageObjectId = nextObjectId++;
    const stream = pageContentStream(pageLines, pageHeight, lineHeight);
    objects[contentObjectId] = `<< /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`;
    objects[pageObjectId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${pageHeight}] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`;
    pageObjectIds.push(pageObjectId);
  }
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>`;
  const offsets = [0];
  let pdf = '%PDF-1.4\n';
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = byteLength(pdf);
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = byteLength(pdf);
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf).buffer as ArrayBuffer;
}

function pageContentStream(
  lines: readonly string[],
  pageHeight: number,
  lineHeight: number,
): string {
  const operations = ['BT', '/F1 11 Tf', `50 ${pageHeight - 56} Td`];
  lines.forEach((line, index) => {
    if (index > 0) operations.push(`0 -${lineHeight} Td`);
    operations.push(`(${escapePdfText(line)}) Tj`);
  });
  operations.push('ET');
  return operations.join('\n');
}

function escapePdfText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[^\u0020-\u007e]/g, '?')
    .replace(/([\\()])/g, '\\$1');
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push([...values.slice(index, index + size)]);
  }
  return chunks.length > 0 ? chunks : [[]];
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function stripControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('');
}
