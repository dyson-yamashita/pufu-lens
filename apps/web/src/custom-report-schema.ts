export const CUSTOM_REPORT_LAYOUT_SCHEMA_VERSION = 'custom-report-layout-v1';
export const CUSTOM_REPORT_TEMPLATE_SCHEMA_VERSION = 'custom-report-template-v1';
export const CUSTOM_REPORT_TEMPLATE_EXPORT_SCHEMA_VERSION = 'custom-report-template-export-v1';
export const CUSTOM_REPORT_SNAPSHOT_SCHEMA_VERSION = 'custom-report-snapshot-v1';

const ALLOWED_PART_TYPES = new Set<CustomReportPartType>([
  'classification_result',
  'columns',
  'copyright',
  'divider',
  'fixed_image',
  'fixed_text',
  'pufu_board',
  'row',
  'slider_judgement',
  'title',
]);
const ALLOWED_IMAGE_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
]);
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_LAYOUT_DEPTH = 6;
const MAX_LAYOUT_PARTS = 200;
const MAX_PROMPT_LENGTH = 8000;
const MAX_TEXT_LENGTH = 4000;

export type CustomReportPartType =
  | 'classification_result'
  | 'columns'
  | 'copyright'
  | 'divider'
  | 'fixed_image'
  | 'fixed_text'
  | 'pufu_board'
  | 'row'
  | 'slider_judgement'
  | 'title';

export type CustomReportAssetContentType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/svg+xml'
  | 'image/webp';

export function isCustomReportAssetContentType(
  value: unknown,
): value is CustomReportAssetContentType {
  return typeof value === 'string' && ALLOWED_IMAGE_CONTENT_TYPES.has(value);
}

export interface CustomReportLayoutV1 {
  readonly root: CustomReportPart;
  readonly schema_version: typeof CUSTOM_REPORT_LAYOUT_SCHEMA_VERSION;
}

export type CustomReportPart =
  | ClassificationResultPart
  | ColumnsPart
  | CopyrightPart
  | DividerPart
  | FixedImagePart
  | FixedTextPart
  | PufuBoardPart
  | RowPart
  | SliderJudgementPart
  | TitlePart;

export interface BaseCustomReportPart {
  readonly id: string;
  readonly type: CustomReportPartType;
}

export interface TitlePart extends BaseCustomReportPart {
  readonly level?: 1 | 2 | 3;
  readonly text: string;
  readonly type: 'title';
}

export interface PufuBoardPart extends BaseCustomReportPart {
  readonly source?: 'report_pufu_sources' | 'report_sections';
  readonly type: 'pufu_board';
}

export interface SliderJudgementPart extends BaseCustomReportPart {
  readonly left_label: string;
  readonly prompt: string;
  readonly result_key: string;
  readonly right_label: string;
  readonly type: 'slider_judgement';
}

export interface ClassificationResultPart extends BaseCustomReportPart {
  readonly categories: readonly ClassificationCategory[];
  readonly prompt: string;
  readonly result_key: string;
  readonly type: 'classification_result';
}

export interface ClassificationCategory {
  readonly asset_ref?: string;
  readonly description: string;
  readonly key: string;
  readonly title: string;
}

export interface FixedTextPart extends BaseCustomReportPart {
  readonly markdown?: boolean;
  readonly text: string;
  readonly type: 'fixed_text';
}

export interface FixedImagePart extends BaseCustomReportPart {
  readonly alt_text: string;
  readonly asset_ref: string;
  readonly caption?: string;
  readonly type: 'fixed_image';
}

export interface ColumnsPart extends BaseCustomReportPart {
  readonly columns: readonly CustomReportColumn[];
  readonly type: 'columns';
}

export interface CustomReportColumn {
  readonly children: readonly CustomReportPart[];
  readonly width_fraction?: number;
}

export interface RowPart extends BaseCustomReportPart {
  readonly children: readonly CustomReportPart[];
  readonly type: 'row';
}

export interface DividerPart extends BaseCustomReportPart {
  readonly type: 'divider';
}

export interface CopyrightPart extends BaseCustomReportPart {
  readonly text: string;
  readonly type: 'copyright';
}

export interface CustomReportTemplateExportV1 {
  readonly assets: readonly CustomReportAssetManifestItem[];
  readonly exported_at: string;
  readonly schema_version: typeof CUSTOM_REPORT_TEMPLATE_EXPORT_SCHEMA_VERSION;
  readonly template: {
    readonly description?: string;
    readonly layout: CustomReportLayoutV1;
    readonly name: string;
    readonly schema_version: typeof CUSTOM_REPORT_TEMPLATE_SCHEMA_VERSION;
  };
}

export interface CustomReportAssetManifestItem {
  readonly byte_size: number;
  readonly content_type: string;
  readonly display_name: string;
  readonly export_asset_key: string;
  readonly requires_upload: true;
}

export interface CustomReportSnapshotV1 {
  readonly layout: CustomReportLayoutV1;
  readonly results: Record<string, CustomReportResult>;
  readonly schema_version: typeof CUSTOM_REPORT_SNAPSHOT_SCHEMA_VERSION;
  readonly template_id: string;
  readonly template_snapshot_hash: string;
  readonly template_version: number;
}

export type CustomReportResult =
  | ClassificationResult
  | FixedImageResult
  | FixedTextResult
  | SliderJudgementResult;

export interface SliderJudgementResult {
  readonly left_label: string;
  readonly part_id: string;
  readonly reason: string;
  readonly right_label: string;
  readonly score: number;
  readonly type: 'slider_judgement';
}

export interface ClassificationResult {
  readonly asset_ref?: string;
  readonly category_key: string;
  readonly description: string;
  readonly part_id: string;
  readonly reason: string;
  readonly title: string;
  readonly type: 'classification_result';
}

export interface FixedTextResult {
  readonly part_id: string;
  readonly text: string;
  readonly type: 'fixed_text';
}

export interface FixedImageResult {
  readonly asset_ref: string;
  readonly part_id: string;
  readonly type: 'fixed_image';
}

export function validateCustomReportLayout(
  value: unknown,
  options: { readonly allowedAssetRefs?: readonly string[] } = {},
): asserts value is CustomReportLayoutV1 {
  if (!isRecord(value)) {
    throw new Error('Custom report layout must be an object.');
  }
  if (value.schema_version !== CUSTOM_REPORT_LAYOUT_SCHEMA_VERSION) {
    throw new Error('Custom report layout schema_version is invalid.');
  }
  const state: LayoutValidationState = {
    allowedAssetRefs: options.allowedAssetRefs ? new Set(options.allowedAssetRefs) : undefined,
    partCount: 0,
    partIds: new Set(),
  };
  validatePart(value.root, state, 0);
}

export function validateCustomReportTemplateExport(
  value: unknown,
): asserts value is CustomReportTemplateExportV1 {
  if (!isRecord(value)) {
    throw new Error('Custom report template export must be an object.');
  }
  if (value.schema_version !== CUSTOM_REPORT_TEMPLATE_EXPORT_SCHEMA_VERSION) {
    throw new Error('Custom report template export schema_version is invalid.');
  }
  if (typeof value.exported_at !== 'string' || Number.isNaN(Date.parse(value.exported_at))) {
    throw new Error('Custom report template export exported_at is invalid.');
  }
  const assetKeys = validateAssetManifest(value.assets);
  if (!isRecord(value.template)) {
    throw new Error('Custom report template export template must be an object.');
  }
  const { description, layout, name, schema_version } = value.template;
  if (schema_version !== CUSTOM_REPORT_TEMPLATE_SCHEMA_VERSION) {
    throw new Error('Custom report template schema_version is invalid.');
  }
  if (!isNonEmptyString(name, 120)) {
    throw new Error('Custom report template name is invalid.');
  }
  if (description !== undefined && !isStringWithin(description, 1000)) {
    throw new Error('Custom report template description is invalid.');
  }
  validateCustomReportLayout(layout, { allowedAssetRefs: [...assetKeys] });
}

export function validateCustomReportSnapshot(
  value: unknown,
): asserts value is CustomReportSnapshotV1 {
  if (!isRecord(value)) {
    throw new Error('Custom report snapshot must be an object.');
  }
  if (value.schema_version !== CUSTOM_REPORT_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error('Custom report snapshot schema_version is invalid.');
  }
  if (!isNonEmptyString(value.template_id, 120)) {
    throw new Error('Custom report snapshot template_id is invalid.');
  }
  if (!isPositiveInteger(value.template_version)) {
    throw new Error('Custom report snapshot template_version is invalid.');
  }
  if (!isNonEmptyString(value.template_snapshot_hash, 256)) {
    throw new Error('Custom report snapshot hash is invalid.');
  }
  validateCustomReportLayout(value.layout);
  if (!isRecord(value.results)) {
    throw new Error('Custom report snapshot results must be an object.');
  }
  for (const [resultKey, result] of Object.entries(value.results)) {
    if (!isSafeIdentifier(resultKey)) {
      throw new Error('Custom report result key is invalid.');
    }
    validateResult(result);
  }
}

function validatePart(value: unknown, state: LayoutValidationState, depth: number): void {
  if (depth > MAX_LAYOUT_DEPTH) {
    throw new Error('Custom report layout nesting is too deep.');
  }
  if (!isRecord(value)) {
    throw new Error('Custom report part must be an object.');
  }
  if (
    typeof value.type !== 'string' ||
    !ALLOWED_PART_TYPES.has(value.type as CustomReportPartType)
  ) {
    throw new Error('Custom report part type is not allowed.');
  }
  if (!isSafeIdentifier(value.id)) {
    throw new Error('Custom report part id is invalid.');
  }
  if (state.partIds.has(value.id)) {
    throw new Error('Custom report part id must be unique.');
  }
  state.partIds.add(value.id);
  state.partCount += 1;
  if (state.partCount > MAX_LAYOUT_PARTS) {
    throw new Error('Custom report layout has too many parts.');
  }

  switch (value.type) {
    case 'classification_result':
      validateClassificationPart(value);
      validateAssetRefs(
        (Array.isArray(value.categories) ? value.categories : [])
          .map((category) => (isRecord(category) ? category.asset_ref : undefined))
          .filter((assetRef): assetRef is string => typeof assetRef === 'string'),
        state,
      );
      break;
    case 'columns':
      validateColumnsPart(value, state, depth);
      break;
    case 'copyright':
      if (!isNonEmptyString(value.text, MAX_TEXT_LENGTH)) {
        throw new Error('Custom report copyright text is invalid.');
      }
      break;
    case 'divider':
      break;
    case 'fixed_image':
      if (!isNonEmptyString(value.alt_text, 500) || !isNonEmptyString(value.asset_ref, 200)) {
        throw new Error('Custom report fixed_image is invalid.');
      }
      if (value.caption !== undefined && !isStringWithin(value.caption, 500)) {
        throw new Error('Custom report fixed_image caption is invalid.');
      }
      validateAssetRefs([value.asset_ref], state);
      break;
    case 'fixed_text':
      if (!isNonEmptyString(value.text, MAX_TEXT_LENGTH)) {
        throw new Error('Custom report fixed_text text is invalid.');
      }
      if (value.markdown !== undefined && typeof value.markdown !== 'boolean') {
        throw new Error('Custom report fixed_text markdown is invalid.');
      }
      break;
    case 'pufu_board':
      if (
        value.source !== undefined &&
        value.source !== 'report_pufu_sources' &&
        value.source !== 'report_sections'
      ) {
        throw new Error('Custom report pufu_board source is invalid.');
      }
      break;
    case 'row':
      validateChildren(value.children, state, depth);
      break;
    case 'slider_judgement':
      if (
        !isNonEmptyString(value.prompt, MAX_PROMPT_LENGTH) ||
        !isNonEmptyString(value.left_label, 200) ||
        !isNonEmptyString(value.right_label, 200) ||
        !isSafeIdentifier(value.result_key)
      ) {
        throw new Error('Custom report slider_judgement is invalid.');
      }
      break;
    case 'title':
      if (!isNonEmptyString(value.text, 500)) {
        throw new Error('Custom report title text is invalid.');
      }
      if (
        value.level !== undefined &&
        value.level !== 1 &&
        value.level !== 2 &&
        value.level !== 3
      ) {
        throw new Error('Custom report title level is invalid.');
      }
      break;
  }
}

function validateColumnsPart(
  value: Record<string, unknown>,
  state: LayoutValidationState,
  depth: number,
): void {
  if (!Array.isArray(value.columns) || value.columns.length < 2 || value.columns.length > 4) {
    throw new Error('Custom report columns must include 2 to 4 columns.');
  }
  let totalFraction = 0;
  for (const column of value.columns) {
    if (!isRecord(column)) {
      throw new Error('Custom report column must be an object.');
    }
    if (
      column.width_fraction !== undefined &&
      (typeof column.width_fraction !== 'number' ||
        !Number.isFinite(column.width_fraction) ||
        column.width_fraction <= 0 ||
        column.width_fraction > 1)
    ) {
      throw new Error('Custom report column width_fraction is invalid.');
    }
    if (column.width_fraction !== undefined) {
      totalFraction += column.width_fraction;
    }
    validateChildren(column.children, state, depth);
  }
  if (totalFraction > 1.001) {
    throw new Error('Custom report column width_fraction sum is invalid.');
  }
}

function validateChildren(value: unknown, state: LayoutValidationState, depth: number): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Custom report container children must be a non-empty array.');
  }
  for (const child of value) {
    validatePart(child, state, depth + 1);
  }
}

function validateClassificationPart(value: Record<string, unknown>): void {
  if (!isNonEmptyString(value.prompt, MAX_PROMPT_LENGTH) || !isSafeIdentifier(value.result_key)) {
    throw new Error('Custom report classification_result is invalid.');
  }
  if (
    !Array.isArray(value.categories) ||
    value.categories.length < 2 ||
    value.categories.length > 20
  ) {
    throw new Error('Custom report classification_result categories are invalid.');
  }
  const categoryKeys = new Set<string>();
  for (const category of value.categories) {
    if (!isRecord(category)) {
      throw new Error('Custom report classification category must be an object.');
    }
    if (
      !isSafeIdentifier(category.key) ||
      !isNonEmptyString(category.title, 200) ||
      !isStringWithin(category.description, 1000)
    ) {
      throw new Error('Custom report classification category is invalid.');
    }
    if (category.asset_ref !== undefined && !isNonEmptyString(category.asset_ref, 200)) {
      throw new Error('Custom report classification category asset_ref is invalid.');
    }
    if (categoryKeys.has(category.key)) {
      throw new Error('Custom report classification category key must be unique.');
    }
    categoryKeys.add(category.key);
  }
}

function validateAssetManifest(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    throw new Error('Custom report asset manifest must be an array.');
  }
  const keys = new Set<string>();
  for (const asset of value) {
    if (!isRecord(asset)) {
      throw new Error('Custom report asset manifest item must be an object.');
    }
    if (
      !isSafeIdentifier(asset.export_asset_key) ||
      !isNonEmptyString(asset.display_name, 255) ||
      !isSafeAssetDisplayName(asset.display_name) ||
      !isCustomReportAssetContentType(asset.content_type) ||
      typeof asset.byte_size !== 'number' ||
      !Number.isInteger(asset.byte_size) ||
      asset.byte_size <= 0 ||
      asset.byte_size > MAX_ASSET_BYTES ||
      asset.requires_upload !== true
    ) {
      throw new Error('Custom report asset manifest item is invalid.');
    }
    if (keys.has(asset.export_asset_key)) {
      throw new Error('Custom report asset manifest key must be unique.');
    }
    keys.add(asset.export_asset_key);
  }
  return keys;
}

function validateAssetRefs(assetRefs: readonly string[], state: LayoutValidationState): void {
  if (!state.allowedAssetRefs) {
    return;
  }
  for (const assetRef of assetRefs) {
    if (!state.allowedAssetRefs.has(assetRef)) {
      throw new Error('Custom report asset reference is unknown.');
    }
  }
}

function isSafeAssetDisplayName(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized.includes('/') ||
    normalized === '.' ||
    normalized.includes('..') ||
    /^[a-z][a-z0-9+.-]*:/iu.test(normalized) ||
    containsControlCharacter(normalized)
  ) {
    return false;
  }
  return true;
}

function containsControlCharacter(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional detection of ASCII control chars in asset names
  return /[\u0000-\u001F\u007F]/u.test(value);
}

function validateResult(value: unknown): void {
  if (!isRecord(value) || !isSafeIdentifier(value.part_id) || typeof value.type !== 'string') {
    throw new Error('Custom report result is invalid.');
  }
  if (value.type === 'slider_judgement') {
    if (
      typeof value.score !== 'number' ||
      !Number.isFinite(value.score) ||
      value.score < 0 ||
      value.score > 100 ||
      !isNonEmptyString(value.left_label, 200) ||
      !isNonEmptyString(value.right_label, 200) ||
      !isStringWithin(value.reason, 1000)
    ) {
      throw new Error('Custom report slider result is invalid.');
    }
    return;
  }
  if (value.type === 'classification_result') {
    if (
      !isSafeIdentifier(value.category_key) ||
      !isNonEmptyString(value.title, 200) ||
      !isStringWithin(value.description, 1000) ||
      !isStringWithin(value.reason, 1000)
    ) {
      throw new Error('Custom report classification result is invalid.');
    }
    if (value.asset_ref !== undefined && !isNonEmptyString(value.asset_ref, 200)) {
      throw new Error('Custom report classification result asset_ref is invalid.');
    }
    return;
  }
  if (value.type === 'fixed_text') {
    if (!isStringWithin(value.text, MAX_TEXT_LENGTH)) {
      throw new Error('Custom report fixed_text result is invalid.');
    }
    return;
  }
  if (value.type === 'fixed_image') {
    if (!isNonEmptyString(value.asset_ref, 200)) {
      throw new Error('Custom report fixed_image result is invalid.');
    }
    return;
  }
  throw new Error('Custom report result type is invalid.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isStringWithin(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

type LayoutValidationState = {
  allowedAssetRefs?: Set<string>;
  partCount: number;
  partIds: Set<string>;
};
