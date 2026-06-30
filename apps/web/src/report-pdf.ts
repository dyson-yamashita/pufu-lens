import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont } from 'pdf-lib';
import type { CustomReportPart, CustomReportSnapshotV1 } from './custom-report-schema.ts';
import type { PrivateReportJsonV1 } from './report-schema.ts';

const PDF_TEXT_DENYLIST = [
  /raw[_-]?document[_-]?id/giu,
  /private[_-]?raw[_-]?locator/giu,
  /storage[_-]?uri/giu,
  /secret/giu,
  /api[_-]?key/giu,
  /token/giu,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,
];

const JAPANESE_FONT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../assets/fonts/IPAexGothic.ttf',
);

export interface ReportPdfFile {
  readonly bytes: ArrayBuffer;
  readonly fileName: string;
}

let cachedFontBytes: Uint8Array | undefined;

/**
 * Generates a sanitized PDF file for a report.
 *
 * @param input.projectSlug - Project slug used in the output file name.
 * @param input.report - Report data used to build the PDF content.
 * @returns The generated PDF bytes and sanitized file name.
 */
export async function renderReportPdf(input: {
  readonly projectSlug: string;
  readonly report: PrivateReportJsonV1;
}): Promise<ReportPdfFile> {
  const lines = safeReportPdfLines(input.report);
  return {
    bytes: await createSimplePdf(lines),
    fileName: safePdfFileName(`${input.projectSlug}-${input.report.report_id}.pdf`),
  };
}

/**
 * Builds the text lines used to render a report PDF.
 *
 * The output includes the report metadata and summary, then either the custom layout content or each section's text,
 * with sensitive text redacted and markdown formatting removed.
 *
 * @param report - The report to convert into PDF-ready lines.
 * @returns The processed text lines for the PDF.
 */
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
      lines.push('', section.title, section.markdown);
      if (section.metrics && Object.keys(section.metrics).length > 0) {
        lines.push(
          `Metrics: ${Object.entries(section.metrics)
            .map(([key, value]) => `${key}=${value}`)
            .join(', ')}`,
        );
      }
    }
  }
  return lines
    .map(redactPdfText)
    .flatMap((line) => (line ? line.split(/\r?\n/) : ['']))
    .slice(0, 850);
}

/**
 * Converts a custom report layout snapshot into text lines.
 *
 * @param snapshot - The report snapshot containing the layout tree and related results.
 * @returns The text lines for the layout root.
 */
function customLayoutLines(snapshot: CustomReportSnapshotV1): readonly string[] {
  return partLines(snapshot.layout.root, snapshot);
}

/**
 * Converts a custom report part into text lines for PDF output.
 *
 * @param part - The report part to convert.
 * @param snapshot - The report snapshot used to resolve part results.
 * @returns The text lines generated for the part.
 */
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

/**
 * Redacts sensitive text and removes formatting from PDF content.
 *
 * @param value - The input text to sanitize
 * @returns The sanitized text with sensitive substrings replaced by `[redacted]`
 */
function redactPdfText(value: string): string {
  let text = stripControlCharacters(value);
  for (const pattern of PDF_TEXT_DENYLIST) {
    text = text.replace(pattern, '[redacted]');
  }
  return stripMarkdown(text).trim();
}

/**
 * Removes markdown formatting and link syntax from text.
 *
 * @param value - The input text
 * @returns The text with fenced code blocks, inline code markers, links, images, and markdown punctuation removed
 */
function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~|-]+/g, ' ')
    .replace(/[^\S\r\n]+/g, ' ')
    .trim();
}

/**
 * Wraps a line into segments that fit within a maximum width.
 *
 * @param line - The text to wrap.
 * @param font - The font used to measure text width.
 * @param fontSize - The font size used for width measurement.
 * @param maxWidth - The maximum width for each segment.
 * @returns The wrapped line segments.
 */
function wrapLineToWidth(
  line: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
): readonly string[] {
  if (!line) return [''];
  const chunks: string[] = [];
  let current = '';
  for (const character of line) {
    const candidate = `${current}${character}`;
    if (font.widthOfTextAtSize(candidate, fontSize) > maxWidth && current) {
      chunks.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks.length > 0 ? chunks : [''];
}

/**
 * Sanitizes a PDF file name.
 *
 * @param value - The file name to sanitize
 * @returns The file name with unsupported characters replaced by `-`
 */
function safePdfFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

/**
 * Loads the embedded Japanese font bytes.
 *
 * @returns The cached font bytes.
 */
async function loadJapaneseFontBytes(): Promise<Uint8Array> {
  if (!cachedFontBytes) {
    cachedFontBytes = new Uint8Array(await readFile(JAPANESE_FONT_PATH));
  }
  return cachedFontBytes;
}

/**
 * Creates a text-only PDF from the provided lines.
 *
 * Lines are wrapped to fit the page width and continued onto additional pages as needed.
 *
 * @param lines - The text lines to render into the PDF
 * @returns The generated PDF bytes as an `ArrayBuffer`
 */
async function createSimplePdf(lines: readonly string[]): Promise<ArrayBuffer> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const font = await pdfDoc.embedFont(await loadJapaneseFontBytes());

  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 50;
  const fontSize = 11;
  const lineHeight = 14;
  const maxWidth = pageWidth - margin * 2;

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  for (const line of lines) {
    for (const wrappedLine of wrapLineToWidth(line, font, fontSize, maxWidth)) {
      if (y < margin) {
        page = pdfDoc.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      }
      if (wrappedLine) {
        page.drawText(wrappedLine, {
          font,
          size: fontSize,
          x: margin,
          y: y - fontSize,
        });
      }
      y -= lineHeight;
    }
  }

  return pdfDoc.save().then((bytes) => bytes.buffer as ArrayBuffer);
}

/**
 * Replaces control characters with spaces.
 *
 * @param value - The input text to normalize
 * @returns The text with control characters replaced by spaces
 */
function stripControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && code !== 10 && code !== 13) || code === 127 ? ' ' : character;
    })
    .join('');
}
