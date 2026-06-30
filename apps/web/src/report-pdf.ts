import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument } from 'pdf-lib';
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

const JAPANESE_FONT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../assets/fonts/IPAexGothic.ttf',
);

export interface ReportPdfFile {
  readonly bytes: ArrayBuffer;
  readonly fileName: string;
}

let cachedFontBytes: Uint8Array | undefined;

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
    .replace(/[^\S\r\n]+/g, ' ')
    .trim();
}

function wrapPdfLine(value: string): readonly string[] {
  if (!value) return [''];
  return value.split(/\r?\n/).flatMap((line) => {
    if (!line) return [''];
    const chunks: string[] = [];
    for (let index = 0; index < line.length; index += 92) {
      chunks.push(line.slice(index, index + 92));
    }
    return chunks;
  });
}

function safePdfFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

async function loadJapaneseFontBytes(): Promise<Uint8Array> {
  if (!cachedFontBytes) {
    cachedFontBytes = new Uint8Array(await readFile(JAPANESE_FONT_PATH));
  }
  return cachedFontBytes;
}

async function createSimplePdf(lines: readonly string[]): Promise<ArrayBuffer> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const font = await pdfDoc.embedFont(await loadJapaneseFontBytes());

  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 50;
  const fontSize = 11;
  const lineHeight = 14;

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  for (const line of lines) {
    if (y < margin) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
    if (line) {
      page.drawText(line, {
        font,
        maxWidth: pageWidth - margin * 2,
        size: fontSize,
        x: margin,
        y: y - fontSize,
      });
    }
    y -= lineHeight;
  }

  return pdfDoc.save().then((bytes) => bytes.buffer as ArrayBuffer);
}

function stripControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && code !== 10 && code !== 13) || code === 127 ? ' ' : character;
    })
    .join('');
}
