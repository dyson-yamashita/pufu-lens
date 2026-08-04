import { containsPrivateText, redactSensitivePdfText } from './report-public-redaction.ts';
import { normalizeReportWhitespace, truncateCodePoints } from './report-text.ts';

export const PUFU_SCORE_SCHEMA_VERSION = 'pufu-score-v1' as const;

export const PUFU_SCORE_GOAL_MAX_CODE_POINTS = 500;
export const PUFU_SCORE_WIN_CONDITION_MAX_CODE_POINTS = 500;
export const PUFU_SCORE_PURPOSE_TEXT_MAX_CODE_POINTS = 300;
export const PUFU_SCORE_MEASURE_TEXT_MAX_CODE_POINTS = 300;
export const PUFU_SCORE_ELEMENT_TEXT_MAX_CODE_POINTS = 400;
export const PUFU_SCORE_MIN_PURPOSES = 1;
export const PUFU_SCORE_MAX_PURPOSES = 4;
export const PUFU_SCORE_MIN_MEASURES_PER_PURPOSE = 1;
export const PUFU_SCORE_MAX_MEASURES_PER_PURPOSE = 3;

export const PUFU_SCORE_MEASURE_COLORS = ['white', 'red', 'green', 'blue', 'yellow'] as const;

export type PufuScoreMeasureColor = (typeof PUFU_SCORE_MEASURE_COLORS)[number];

export interface PufuScoreMeasureSemanticV1 {
  readonly color: PufuScoreMeasureColor;
  readonly text: string;
}

export interface PufuScorePurposeSemanticV1 {
  readonly measures: readonly PufuScoreMeasureSemanticV1[];
  readonly text: string;
}

export interface PufuScoreElementsSemanticV1 {
  readonly businessScheme: string;
  readonly environment: string;
  readonly foreignEnemy: string;
  readonly money: string;
  readonly people: string;
  readonly quality: string;
  readonly rival: string;
  readonly time: string;
}

export interface PufuScoreSemanticV1 {
  readonly elements: PufuScoreElementsSemanticV1;
  readonly gainingGoal: string;
  readonly purposes: readonly PufuScorePurposeSemanticV1[];
  readonly schema_version: typeof PUFU_SCORE_SCHEMA_VERSION;
  readonly winCondition: string;
}

const PUFU_SCORE_ELEMENT_KEYS = [
  'businessScheme',
  'environment',
  'foreignEnemy',
  'money',
  'people',
  'quality',
  'rival',
  'time',
] as const satisfies readonly (keyof PufuScoreElementsSemanticV1)[];

const PUFU_SCORE_ROOT_KEYS = [
  'schema_version',
  'gainingGoal',
  'winCondition',
  'purposes',
  'elements',
] as const;

const PUFU_SCORE_PURPOSE_KEYS = ['text', 'measures'] as const;

const PUFU_SCORE_MEASURE_KEYS = ['text', 'color'] as const;

/**
 * Validates a persisted or provider-supplied Pufu score semantic payload.
 */
export function validatePufuScoreSemantic(value: unknown): asserts value is PufuScoreSemanticV1 {
  if (!isRecord(value)) {
    throw new Error('Pufu score must be an object.');
  }
  assertExactKeys(value, PUFU_SCORE_ROOT_KEYS, 'root');
  if (value.schema_version !== PUFU_SCORE_SCHEMA_VERSION) {
    throw new Error('Pufu score schema_version must be pufu-score-v1.');
  }
  validatePufuScoreField(value.gainingGoal, 'gainingGoal', PUFU_SCORE_GOAL_MAX_CODE_POINTS);
  validatePufuScoreField(
    value.winCondition,
    'winCondition',
    PUFU_SCORE_WIN_CONDITION_MAX_CODE_POINTS,
  );
  if (!Array.isArray(value.purposes)) {
    throw new Error('Pufu score purposes must be an array.');
  }
  if (
    value.purposes.length < PUFU_SCORE_MIN_PURPOSES ||
    value.purposes.length > PUFU_SCORE_MAX_PURPOSES
  ) {
    throw new Error('Pufu score purposes count is out of range.');
  }
  for (const purpose of value.purposes) {
    validatePufuScorePurpose(purpose);
  }
  validatePufuScoreElements(value.elements);
  assertPublicSafePufuScore({
    elements: value.elements as PufuScoreElementsSemanticV1,
    gainingGoal: value.gainingGoal as string,
    purposes: value.purposes as PufuScorePurposeSemanticV1[],
    schema_version: PUFU_SCORE_SCHEMA_VERSION,
    winCondition: value.winCondition as string,
  });
}

/**
 * Normalizes provider or stored Pufu score text into a public-safe semantic payload.
 */
export function normalizePufuScore(value: unknown): PufuScoreSemanticV1 {
  const gainingGoal = sanitizePufuScoreField(
    readPufuScoreString(value, 'gainingGoal'),
    PUFU_SCORE_GOAL_MAX_CODE_POINTS,
  );
  const winCondition = sanitizePufuScoreField(
    readPufuScoreString(value, 'winCondition'),
    PUFU_SCORE_WIN_CONDITION_MAX_CODE_POINTS,
  );
  if (!gainingGoal) {
    throw new Error('Pufu score gainingGoal is empty after normalization.');
  }
  if (!winCondition) {
    throw new Error('Pufu score winCondition is empty after normalization.');
  }
  const purposes = normalizePufuScorePurposes(readPufuScoreArray(value, 'purposes'));
  const elements = normalizePufuScoreElements(readPufuScoreRecord(value, 'elements'));
  const score: PufuScoreSemanticV1 = {
    elements,
    gainingGoal,
    purposes,
    schema_version: PUFU_SCORE_SCHEMA_VERSION,
    winCondition,
  };
  validatePufuScoreSemantic(score);
  return score;
}

/**
 * Projects a stored Pufu score into a public-safe semantic payload for anonymous artifacts.
 */
export function toPublicPufuScore(score: PufuScoreSemanticV1): PufuScoreSemanticV1 {
  return normalizePufuScore(score);
}

function validatePufuScorePurpose(value: unknown): asserts value is PufuScorePurposeSemanticV1 {
  if (!isRecord(value)) {
    throw new Error('Pufu score purpose must be an object.');
  }
  assertExactKeys(value, PUFU_SCORE_PURPOSE_KEYS, 'purpose');
  validatePufuScoreField(value.text, 'purpose text', PUFU_SCORE_PURPOSE_TEXT_MAX_CODE_POINTS);
  if (!Array.isArray(value.measures)) {
    throw new Error('Pufu score purpose measures must be an array.');
  }
  if (
    value.measures.length < PUFU_SCORE_MIN_MEASURES_PER_PURPOSE ||
    value.measures.length > PUFU_SCORE_MAX_MEASURES_PER_PURPOSE
  ) {
    throw new Error('Pufu score purpose measures count is out of range.');
  }
  for (const measure of value.measures) {
    validatePufuScoreMeasure(measure);
  }
}

function validatePufuScoreMeasure(value: unknown): asserts value is PufuScoreMeasureSemanticV1 {
  if (!isRecord(value)) {
    throw new Error('Pufu score measure must be an object.');
  }
  assertExactKeys(value, PUFU_SCORE_MEASURE_KEYS, 'measure');
  if (
    typeof value.color !== 'string' ||
    !PUFU_SCORE_MEASURE_COLORS.includes(value.color as PufuScoreMeasureColor)
  ) {
    throw new Error('Pufu score measure color is invalid.');
  }
  validatePufuScoreField(value.text, 'measure text', PUFU_SCORE_MEASURE_TEXT_MAX_CODE_POINTS);
}

function validatePufuScoreElements(value: unknown): asserts value is PufuScoreElementsSemanticV1 {
  if (!isRecord(value)) {
    throw new Error('Pufu score elements must be an object.');
  }
  assertExactKeys(value, PUFU_SCORE_ELEMENT_KEYS, 'elements');
  for (const key of PUFU_SCORE_ELEMENT_KEYS) {
    validatePufuScoreField(value[key], `elements.${key}`, PUFU_SCORE_ELEMENT_TEXT_MAX_CODE_POINTS);
  }
}

function normalizePufuScorePurposes(value: unknown): readonly PufuScorePurposeSemanticV1[] {
  if (!Array.isArray(value)) {
    throw new Error('Pufu score purposes must be an array.');
  }
  const purposes = value
    .map((item) => normalizePufuScorePurpose(item))
    .filter((item): item is PufuScorePurposeSemanticV1 => item !== undefined)
    .slice(0, PUFU_SCORE_MAX_PURPOSES);
  if (purposes.length < PUFU_SCORE_MIN_PURPOSES) {
    throw new Error('Pufu score purposes are empty after normalization.');
  }
  return purposes;
}

function normalizePufuScorePurpose(value: unknown): PufuScorePurposeSemanticV1 | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const text = sanitizePufuScoreField(
    readPufuScoreString(value, 'text'),
    PUFU_SCORE_PURPOSE_TEXT_MAX_CODE_POINTS,
  );
  if (!text) {
    return undefined;
  }
  const measures = normalizePufuScoreMeasures(readPufuScoreArray(value, 'measures'));
  if (measures.length < PUFU_SCORE_MIN_MEASURES_PER_PURPOSE) {
    return undefined;
  }
  return { measures, text };
}

function normalizePufuScoreMeasures(value: unknown): readonly PufuScoreMeasureSemanticV1[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizePufuScoreMeasure(item))
    .filter((item): item is PufuScoreMeasureSemanticV1 => item !== undefined)
    .slice(0, PUFU_SCORE_MAX_MEASURES_PER_PURPOSE);
}

function normalizePufuScoreMeasure(value: unknown): PufuScoreMeasureSemanticV1 | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const color = readPufuScoreMeasureColor(value.color);
  if (!color) {
    return undefined;
  }
  const text = sanitizePufuScoreField(
    readPufuScoreString(value, 'text'),
    PUFU_SCORE_MEASURE_TEXT_MAX_CODE_POINTS,
  );
  if (!text) {
    return undefined;
  }
  return { color, text };
}

function normalizePufuScoreElements(value: unknown): PufuScoreElementsSemanticV1 {
  if (!isRecord(value)) {
    throw new Error('Pufu score elements must be an object.');
  }
  const elements: Record<keyof PufuScoreElementsSemanticV1, string> = {
    businessScheme: '',
    environment: '',
    foreignEnemy: '',
    money: '',
    people: '',
    quality: '',
    rival: '',
    time: '',
  };
  for (const key of PUFU_SCORE_ELEMENT_KEYS) {
    const text = sanitizePufuScoreField(
      readPufuScoreString(value, key),
      PUFU_SCORE_ELEMENT_TEXT_MAX_CODE_POINTS,
    );
    if (!text) {
      throw new Error(`Pufu score elements.${key} is empty after normalization.`);
    }
    elements[key] = text;
  }
  return elements;
}

function validatePufuScoreField(
  value: unknown,
  field: string,
  maxCodePoints: number,
): asserts value is string {
  if (typeof value !== 'string' || normalizeReportWhitespace(value).length === 0) {
    throw new Error(`Pufu score ${field} must be a non-empty string.`);
  }
  if ([...value].length > maxCodePoints) {
    throw new Error(`Pufu score ${field} exceeds code point limit.`);
  }
  if (containsUnsafePufuScoreText(value)) {
    throw new Error(`Pufu score ${field} contains private text.`);
  }
}

function sanitizePufuScoreField(value: string, maxCodePoints: number): string {
  const sanitized = truncateCodePoints(
    redactSensitivePdfText(normalizeReportWhitespace(value)),
    maxCodePoints,
  );
  if (!sanitized || containsUnsafePufuScoreText(sanitized)) {
    return '';
  }
  return sanitized;
}

function assertPublicSafePufuScore(score: PufuScoreSemanticV1): void {
  const serialized = JSON.stringify(score);
  if (containsPrivateText(serialized)) {
    throw new Error('Pufu score contains private text.');
  }
}

function containsUnsafePufuScoreText(value: string): boolean {
  return containsPrivateText(value);
}

function readPufuScoreString(value: unknown, field: string): string {
  if (!isRecord(value) || typeof value[field] !== 'string') {
    return '';
  }
  return value[field];
}

function readPufuScoreArray(value: unknown, field: string): unknown {
  if (!isRecord(value)) {
    return [];
  }
  return value[field];
}

function readPufuScoreRecord(value: unknown, field: string): unknown {
  if (!isRecord(value)) {
    return {};
  }
  return value[field];
}

function readPufuScoreMeasureColor(value: unknown): PufuScoreMeasureColor | undefined {
  return typeof value === 'string' &&
    PUFU_SCORE_MEASURE_COLORS.includes(value as PufuScoreMeasureColor)
    ? (value as PufuScoreMeasureColor)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Pufu score ${label} contains unknown key: ${key}.`);
    }
  }
}
