import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFPage, type PDFFont, rgb } from 'pdf-lib';
import type { CustomReportPart, CustomReportSnapshotV1 } from './custom-report-schema.ts';
import { createPufuScoreFromReport, type PufuScoreModel } from './pufu-score.ts';
import { redactSensitivePdfText } from './report-public-redaction.ts';
import type { PrivateReportJsonV1 } from './report-schema.ts';

const MAX_LINE_CHARS = 2_000;
const MAX_WRAP_CHUNKS = 50;
const MAX_PDF_LINES = 850;

let cachedJapaneseFontPath: string | undefined;

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
  return {
    bytes: await createStyledPdf(input.report),
    fileName: safePdfFileName(`${input.projectSlug}-${input.report.report_id}.pdf`)
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
    report.summary
  ];
  if (report.custom_layout) {
    lines.push('', 'Custom layout', ...customLayoutLines(report.custom_layout));
  } else {
    for (const section of report.sections) {
      lines.push('', section.title, section.markdown);
      if (
        section.metrics &&
        typeof section.metrics === 'object' &&
        !Array.isArray(section.metrics) &&
        Object.keys(section.metrics).length > 0
      ) {
        lines.push(
          `Metrics: ${Object.entries(section.metrics)
            .map(([key, value]) => `${key}=${value}`)
            .join(', ')}`
        );
      }
    }
  }
  return lines
    .map(redactPdfText)
    .flatMap((line) => (line ? line.split(/\r?\n/) : ['']))
    .map((line) => line.slice(0, MAX_LINE_CHARS))
    .slice(0, MAX_PDF_LINES);
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
        ? [`${result.left_label} / ${result.right_label}: ${result.score}`, result.reason ?? '']
        : [`Missing result: ${part.result_key}`];
    }
    case 'classification_result': {
      const result = snapshot.results[part.result_key];
      return result?.type === 'classification_result'
        ? [result.title ?? '', result.description ?? '', result.reason ?? '']
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
        column.children.flatMap((child) => partLines(child, snapshot))
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
 * Sanitizes text for PDF output by removing formatting and redacting sensitive content.
 *
 * @param value - The text to sanitize.
 * @returns The sanitized text with sensitive substrings replaced by `[redacted]`.
 */
function redactPdfText(value: string | null | undefined): string {
  if (value == null) {
    return '';
  }
  let text = stripControlCharacters(value);
  text = redactSensitivePdfText(text);
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
  maxWidth: number
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
  return chunks.length > 0 ? chunks.slice(0, MAX_WRAP_CHUNKS) : [''];
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
    cachedFontBytes = new Uint8Array(await readFile(getJapaneseFontPath()));
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
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const PAGE_MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const COLORS = {
  accent: rgb(0.08, 0.34, 0.85),
  accentSoft: rgb(0.91, 0.94, 1),
  border: rgb(0.81, 0.85, 0.9),
  muted: rgb(0.32, 0.38, 0.46),
  paper: rgb(1, 1, 1),
  surface: rgb(0.96, 0.97, 0.985),
  text: rgb(0.07, 0.1, 0.16),
  white: rgb(1, 1, 1)
} as const;

type PdfContext = {
  font: PDFFont;
  page: PDFPage;
  pdfDoc: PDFDocument;
  y: number;
};

async function createStyledPdf(report: PrivateReportJsonV1): Promise<ArrayBuffer> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setAuthor('Pufu Lens');
  pdfDoc.setCreator('Pufu Lens');
  pdfDoc.setProducer('Pufu Lens Report Renderer');
  pdfDoc.setSubject('Project report with Pufu project score');
  pdfDoc.setTitle(redactPdfText(report.title));
  pdfDoc.registerFontkit(fontkit);
  const font = await pdfDoc.embedFont(await loadJapaneseFontBytes());
  const page = addPage(pdfDoc);
  const context: PdfContext = { font, page, pdfDoc, y: PAGE_HEIGHT - 58 };

  drawCover(context, report);
  if (!report.custom_layout) {
    drawPufuBoard(context, createPufuScoreFromReport(report));
  }
  drawReportContent(context, report);
  addPageFurniture(pdfDoc, font, report.title);
  return pdfDoc.save().then((bytes) => bytes.buffer as ArrayBuffer);
}

function addPage(pdfDoc: PDFDocument): PDFPage {
  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  page.drawRectangle({ color: COLORS.paper, height: PAGE_HEIGHT, width: PAGE_WIDTH, x: 0, y: 0 });
  return page;
}

function drawCover(context: PdfContext, report: PrivateReportJsonV1): void {
  context.page.drawRectangle({
    color: COLORS.accent,
    height: 8,
    width: PAGE_WIDTH,
    x: 0,
    y: PAGE_HEIGHT - 8
  });
  drawLabel(context, 'PUFU LENS  /  PROJECT REPORT', 10, COLORS.accent);
  context.y -= 18;
  drawWrappedText(context, redactPdfText(report.title), 25, 34, COLORS.text);
  context.y -= 18;
  const metaTop = context.y;
  context.page.drawRectangle({
    borderColor: COLORS.border,
    borderWidth: 0.8,
    color: COLORS.surface,
    height: 66,
    width: CONTENT_WIDTH,
    x: PAGE_MARGIN,
    y: metaTop - 66
  });
  drawMeta(
    context,
    '対象期間',
    `${report.period.start}  —  ${report.period.end}`,
    PAGE_MARGIN + 16,
    metaTop - 22
  );
  drawMeta(
    context,
    '生成日時',
    formatGeneratedAt(report.generated_at),
    PAGE_MARGIN + 184,
    metaTop - 22
  );
  drawMeta(context, 'REPORT ID', redactPdfText(report.report_id), PAGE_MARGIN + 338, metaTop - 22);
  context.y = metaTop - 92;
  drawSectionHeading(context, 'エグゼクティブサマリー', 'SUMMARY');
  drawCallout(context, redactPdfText(report.summary));
  context.y -= 24;
}

function drawReportContent(context: PdfContext, report: PrivateReportJsonV1): void {
  if (report.custom_layout) {
    ensureSpace(context, 100);
    drawSectionHeading(context, 'カスタムレイアウト', 'CUSTOM LAYOUT');
    drawBodyLines(context, customLayoutLines(report.custom_layout));
    return;
  }
  for (const section of report.sections) {
    ensureSpace(context, 100);
    drawSectionHeading(context, redactPdfText(section.title), section.id.toUpperCase());
    drawBodyLines(context, redactPdfText(section.markdown).split(/\r?\n/));
    if (section.metrics && Object.keys(section.metrics).length > 0) {
      drawMetricStrip(context, section.metrics);
    }
    context.y -= 18;
  }
}

function drawPufuBoard(context: PdfContext, score: PufuScoreModel): void {
  ensureSpace(context, 390);
  drawSectionHeading(context, 'プ譜', 'PROJECT SCORE');
  const boardTop = context.y;
  const boardHeight = 330;
  context.page.drawRectangle({
    borderColor: COLORS.border,
    borderWidth: 0.8,
    color: COLORS.surface,
    height: boardHeight,
    width: CONTENT_WIDTH,
    x: PAGE_MARGIN,
    y: boardTop - boardHeight
  });
  const innerX = PAGE_MARGIN + 14;
  const innerWidth = CONTENT_WIDTH - 28;
  drawScoreBanner(
    context,
    innerX,
    boardTop - 14,
    innerWidth,
    42,
    '獲得目標',
    score.gainingGoal.text,
    COLORS.accent
  );
  const elementLabels: ReadonlyArray<[string, keyof PufuScoreModel['elements']]> = [
    ['環境', 'environment'],
    ['人材', 'people'],
    ['時間', 'time'],
    ['予算', 'money'],
    ['品質', 'quality'],
    ['競合', 'rival'],
    ['外敵', 'foreignEnemy'],
    ['座組', 'businessScheme']
  ];
  const gap = 6;
  const cardWidth = (innerWidth - gap * 3) / 4;
  elementLabels.forEach(([label, key], index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    drawScoreCard(
      context,
      innerX + column * (cardWidth + gap),
      boardTop - 64 - row * 55,
      cardWidth,
      48,
      label,
      score.elements[key].text
    );
  });
  const purposeTop = boardTop - 180;
  const purposeWidth = (innerWidth - gap * 2) / 3;
  score.purposes.slice(0, 3).forEach((purpose, index) => {
    drawPurposeCard(
      context,
      innerX + index * (purposeWidth + gap),
      purposeTop,
      purposeWidth,
      92,
      purpose
    );
  });
  drawScoreBanner(
    context,
    innerX,
    boardTop - 284,
    innerWidth,
    32,
    '勝利条件',
    score.winCondition.text,
    rgb(0.03, 0.48, 0.34)
  );
  context.y = boardTop - boardHeight - 24;
}

function drawScoreBanner(
  context: PdfContext,
  x: number,
  top: number,
  width: number,
  height: number,
  label: string,
  text: string,
  color: ReturnType<typeof rgb>
): void {
  context.page.drawRectangle({ color, height, width, x, y: top - height });
  context.page.drawText(label, {
    color: COLORS.white,
    font: context.font,
    size: 7,
    x: x + 10,
    y: top - 13
  });
  drawTextInBox(
    context,
    redactPdfText(text),
    x + 10,
    top - 18,
    width - 20,
    height - 20,
    8.5,
    COLORS.white,
    11
  );
}

function drawScoreCard(
  context: PdfContext,
  x: number,
  top: number,
  width: number,
  height: number,
  label: string,
  text: string
): void {
  context.page.drawRectangle({
    borderColor: COLORS.border,
    borderWidth: 0.6,
    color: COLORS.white,
    height,
    width,
    x,
    y: top - height
  });
  context.page.drawText(label, {
    color: COLORS.accent,
    font: context.font,
    size: 7,
    x: x + 7,
    y: top - 11
  });
  drawTextInBox(
    context,
    redactPdfText(text),
    x + 7,
    top - 16,
    width - 14,
    height - 18,
    6.8,
    COLORS.text,
    8.5
  );
}

function drawPurposeCard(
  context: PdfContext,
  x: number,
  top: number,
  width: number,
  height: number,
  purpose: PufuScoreModel['purposes'][number]
): void {
  context.page.drawRectangle({
    borderColor: COLORS.border,
    borderWidth: 0.6,
    color: COLORS.white,
    height,
    width,
    x,
    y: top - height
  });
  drawTextInBox(
    context,
    redactPdfText(purpose.text),
    x + 8,
    top - 8,
    width - 16,
    25,
    7.6,
    COLORS.text,
    9.5
  );
  purpose.measures.slice(0, 2).forEach((measure, index) => {
    const y = top - 39 - index * 23;
    const color =
      measure.color === 'green'
        ? rgb(0.03, 0.48, 0.34)
        : measure.color === 'yellow'
          ? rgb(0.72, 0.45, 0.02)
          : COLORS.accent;
    context.page.drawCircle({ color, size: 2.4, x: x + 10, y: y - 3 });
    drawTextInBox(
      context,
      redactPdfText(measure.text),
      x + 17,
      y + 2,
      width - 24,
      19,
      6.5,
      COLORS.muted,
      8
    );
  });
}

function drawTextInBox(
  context: PdfContext,
  text: string,
  x: number,
  top: number,
  width: number,
  height: number,
  size: number,
  color: ReturnType<typeof rgb>,
  lineHeight: number
): void {
  const lines = wrapLineToWidth(text, context.font, size, width);
  const maxLines = Math.max(1, Math.floor(height / lineHeight));
  lines.slice(0, maxLines).forEach((line, index) => {
    let value = line;
    if (index === maxLines - 1 && lines.length > maxLines)
      value = `${line.slice(0, Math.max(0, line.length - 1))}…`;
    context.page.drawText(value, {
      color,
      font: context.font,
      size,
      x,
      y: top - size - index * lineHeight
    });
  });
}

function drawSectionHeading(context: PdfContext, title: string, eyebrow: string): void {
  drawLabel(context, eyebrow, 7.5, COLORS.accent);
  context.y -= 13;
  drawWrappedText(context, title, 16, 22, COLORS.text);
  context.y -= 12;
}

function drawCallout(context: PdfContext, text: string): void {
  const lines = wrapLineToWidth(text, context.font, 10.5, CONTENT_WIDTH - 34);
  const height = Math.max(58, lines.length * 16 + 28);
  ensureSpace(context, height);
  context.page.drawRectangle({
    color: COLORS.accentSoft,
    height,
    width: CONTENT_WIDTH,
    x: PAGE_MARGIN,
    y: context.y - height
  });
  context.page.drawRectangle({
    color: COLORS.accent,
    height,
    width: 4,
    x: PAGE_MARGIN,
    y: context.y - height
  });
  lines.forEach((line, index) =>
    context.page.drawText(line, {
      color: COLORS.text,
      font: context.font,
      size: 10.5,
      x: PAGE_MARGIN + 18,
      y: context.y - 24 - index * 16
    })
  );
  context.y -= height;
}

function drawBodyLines(context: PdfContext, lines: readonly string[]): void {
  for (const rawLine of lines) {
    const isListItem = /^\s*[-*]\s+/.test(rawLine);
    const line = redactPdfText(rawLine);
    if (!line) {
      context.y -= 7;
      continue;
    }
    const displayLine = isListItem ? `・${line}` : line;
    const wrapped = wrapLineToWidth(displayLine, context.font, 10, CONTENT_WIDTH);
    for (const value of wrapped) {
      ensureSpace(context, 17);
      context.page.drawText(value, {
        color: COLORS.text,
        font: context.font,
        size: 10,
        x: PAGE_MARGIN,
        y: context.y - 10
      });
      context.y -= 16;
    }
  }
}

function drawMetricStrip(context: PdfContext, metrics: Record<string, number>): void {
  const text = Object.entries(metrics)
    .map(([key, value]) => `${key}  ${value}`)
    .join('    /    ');
  ensureSpace(context, 34);
  context.page.drawRectangle({
    borderColor: COLORS.border,
    borderWidth: 0.6,
    color: COLORS.surface,
    height: 28,
    width: CONTENT_WIDTH,
    x: PAGE_MARGIN,
    y: context.y - 28
  });
  drawTextInBox(
    context,
    redactPdfText(text),
    PAGE_MARGIN + 10,
    context.y - 5,
    CONTENT_WIDTH - 20,
    20,
    8,
    COLORS.muted,
    10
  );
  context.y -= 34;
}

function drawLabel(
  context: PdfContext,
  text: string,
  size: number,
  color: ReturnType<typeof rgb>
): void {
  context.page.drawText(text, {
    color,
    font: context.font,
    size,
    x: PAGE_MARGIN,
    y: context.y - size
  });
  context.y -= size;
}

function drawWrappedText(
  context: PdfContext,
  text: string,
  size: number,
  lineHeight: number,
  color: ReturnType<typeof rgb>
): void {
  for (const line of wrapLineToWidth(text, context.font, size, CONTENT_WIDTH)) {
    ensureSpace(context, lineHeight);
    context.page.drawText(line, {
      color,
      font: context.font,
      size,
      x: PAGE_MARGIN,
      y: context.y - size
    });
    context.y -= lineHeight;
  }
}

function drawMeta(context: PdfContext, label: string, value: string, x: number, y: number): void {
  context.page.drawText(label, { color: COLORS.muted, font: context.font, size: 7, x, y });
  drawTextInBox(context, value, x, y - 7, 142, 22, 8.5, COLORS.text, 10);
}

function ensureSpace(context: PdfContext, requiredHeight: number): void {
  if (context.y - requiredHeight >= 54) return;
  context.page = addPage(context.pdfDoc);
  context.y = PAGE_HEIGHT - 58;
}

function addPageFurniture(pdfDoc: PDFDocument, font: PDFFont, title: string): void {
  const pages = pdfDoc.getPages();
  pages.forEach((page, index) => {
    page.drawLine({
      color: COLORS.border,
      end: { x: PAGE_WIDTH - PAGE_MARGIN, y: 34 },
      start: { x: PAGE_MARGIN, y: 34 },
      thickness: 0.5
    });
    page.drawText(redactPdfText(title).slice(0, 44), {
      color: COLORS.muted,
      font,
      size: 7,
      x: PAGE_MARGIN,
      y: 20
    });
    const pageNumber = `${index + 1} / ${pages.length}`;
    page.drawText(pageNumber, {
      color: COLORS.muted,
      font,
      size: 7,
      x: PAGE_WIDTH - PAGE_MARGIN - font.widthOfTextAtSize(pageNumber, 7),
      y: 20
    });
  });
}

function formatGeneratedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? redactPdfText(value)
    : date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
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

function getJapaneseFontPath(): string {
  if (!cachedJapaneseFontPath) {
    cachedJapaneseFontPath = resolveJapaneseFontPath();
  }
  return cachedJapaneseFontPath;
}

function resolveJapaneseFontPath(): string {
  const candidates = [
    join(process.cwd(), 'assets/fonts/IPAexGothic.ttf'),
    join(process.cwd(), 'apps/web/assets/fonts/IPAexGothic.ttf'),
    join(dirname(fileURLToPath(import.meta.url)), '../assets/fonts/IPAexGothic.ttf')
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? join(process.cwd(), 'assets/fonts/IPAexGothic.ttf');
}
