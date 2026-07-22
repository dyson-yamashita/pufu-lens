/** Asia/Tokyo offset used for deterministic chat search period boundaries. */
const TOKYO_OFFSET_MILLISECONDS = 9 * 60 * 60 * 1000;

/** Inclusive lower bound for trailing-year phrases such as `1年間`. */
export const CHAT_SEARCH_TRAILING_YEARS_MIN = 1;

/** Inclusive upper bound for trailing-year phrases such as `10年間`. */
export const CHAT_SEARCH_TRAILING_YEARS_MAX = 10;

/** Inclusive lower bound for explicit `YYYY年` calendar-year phrases. */
export const CHAT_SEARCH_CALENDAR_YEAR_MIN = 1900;

/** Inclusive upper bound for explicit `YYYY年` calendar-year phrases. */
export const CHAT_SEARCH_CALENDAR_YEAR_MAX = 2100;

/**
 * Maximum allowed span between `startAt` and `endAt`, aligned with the parser's 10 trailing years
 * plus leap-day allowance.
 */
export const CHAT_SEARCH_PERIOD_MAX_SPAN_DAYS = 3660;

const CHAT_SEARCH_PERIOD_MAX_SPAN_MS = CHAT_SEARCH_PERIOD_MAX_SPAN_DAYS * 24 * 60 * 60 * 1000;

/**
 * Strict ISO-8601 instant pattern: `YYYY-MM-DDTHH:mm:ss` with optional fractional seconds and
 * either `Z` or `±HH:mm`.
 */
export const CHAT_SEARCH_ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Bounded occurred_at filter for chat timeline retrieval.
 *
 * Both fields are ISO-8601 instants with an explicit `Z` or numeric UTC offset. `endAt` is
 * exclusive: matching documents satisfy `startAt <= occurred_at < endAt`.
 */
export interface ChatSearchPeriod {
  /** Exclusive upper bound as an ISO-8601 instant with explicit timezone. */
  readonly endAt: string;
  /** Inclusive lower bound as an ISO-8601 instant with explicit timezone. */
  readonly startAt: string;
}

export interface ParsedChatSearchPeriod {
  readonly period: ChatSearchPeriod;
  readonly topicQuery: string;
}

const PERIOD_AGGREGATE_NOISE = [
  '取り組み',
  '対応実績',
  '実績',
  '状況',
  '活動',
  '動き',
  '進捗',
  '成果',
  'まとめ',
  '概要',
] as const;

const PERIOD_REQUEST_NOISE = [
  '教えてください',
  '教えて下さい',
  '教えてほしい',
  '教えて',
  'ください',
  'について',
  'に関する',
  'を教えて',
  '知りたい',
  '説明して',
] as const;

/**
 * Returns whether a value matches the strict chat-search ISO-8601 instant format.
 *
 * @param value - Candidate instant string
 */
export function isChatSearchIsoInstant(value: string): boolean {
  if (!CHAT_SEARCH_ISO_INSTANT_PATTERN.test(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

/**
 * Validates a chat search period before repository or tool execution.
 *
 * @param period - Candidate start/end instants
 * @throws When either instant lacks an explicit timezone, is non-finite, out of order, or exceeds {@link CHAT_SEARCH_PERIOD_MAX_SPAN_DAYS}
 */
export function validateChatSearchPeriod(period: ChatSearchPeriod): void {
  const startAt = parseChatSearchPeriodInstant(period.startAt, 'startAt');
  const endAt = parseChatSearchPeriodInstant(period.endAt, 'endAt');
  if (startAt >= endAt) {
    throw new Error('Chat search period requires startAt < endAt.');
  }
  if (endAt - startAt > CHAT_SEARCH_PERIOD_MAX_SPAN_MS) {
    throw new Error(
      `Chat search period span must not exceed ${CHAT_SEARCH_PERIOD_MAX_SPAN_DAYS} days.`,
    );
  }
}

/**
 * Parses deterministic calendar and trailing-year period phrases from a chat question.
 *
 * @param question - Raw user question text
 * @param nowIso - Explicit current instant supplied by the workflow caller
 * @returns A parsed period and normalized topic query, or `null` when no period phrase is recognized
 */
export function parseChatSearchPeriod(
  question: string,
  nowIso: string,
): ParsedChatSearchPeriod | null {
  const now = requireChatSearchNowIso(nowIso);
  const normalized = normalizeChatSearchQuestion(question);
  const calendarYearMatch = normalized.match(/(?<!\d)(\d{4})年(?!間)/u);
  if (calendarYearMatch?.[1]) {
    const year = Number(calendarYearMatch[1]);
    if (year < CHAT_SEARCH_CALENDAR_YEAR_MIN || year > CHAT_SEARCH_CALENDAR_YEAR_MAX) {
      return null;
    }
    return {
      period: calendarYearPeriod(year),
      topicQuery: normalizeTimelineTopicQuery(
        normalized,
        stripRecognizedPeriodPhrase(normalized, calendarYearMatch[0]),
      ),
    };
  }

  const trailingYearsMatch = normalized.match(/(?<!\d)([1-9]|10)年間/u);
  if (trailingYearsMatch?.[1]) {
    const years = Number(trailingYearsMatch[1]);
    if (years < CHAT_SEARCH_TRAILING_YEARS_MIN || years > CHAT_SEARCH_TRAILING_YEARS_MAX) {
      return null;
    }
    return {
      period: trailingYearsPeriod(now, years),
      topicQuery: normalizeTimelineTopicQuery(
        normalized,
        stripRecognizedPeriodPhrase(normalized, trailingYearsMatch[0]),
      ),
    };
  }

  if (normalized.includes('今年')) {
    const year = tokyoLocalDateTime(now).getUTCFullYear();
    return {
      period: calendarYearPeriod(year),
      topicQuery: normalizeTimelineTopicQuery(
        normalized,
        stripRecognizedPeriodPhrase(normalized, '今年'),
      ),
    };
  }

  if (normalized.includes('昨年')) {
    const year = tokyoLocalDateTime(now).getUTCFullYear() - 1;
    return {
      period: calendarYearPeriod(year),
      topicQuery: normalizeTimelineTopicQuery(
        normalized,
        stripRecognizedPeriodPhrase(normalized, '昨年'),
      ),
    };
  }

  return null;
}

/**
 * Returns whether a chat question contains a deterministic search period phrase.
 *
 * @param question - Raw user question text
 * @param nowIso - Explicit current instant supplied by the workflow caller
 */
export function hasChatSearchPeriod(question: string, nowIso: string): boolean {
  return parseChatSearchPeriod(question, nowIso) !== null;
}

/**
 * Strips recognized period wording and generic aggregate/request noise from a timeline topic query.
 *
 * @param question - Original question text
 * @param strippedQuestion - Question text with the recognized period phrase removed
 * @returns Topic text retained for optional timeline keyword search
 */
export function normalizeTimelineTopicQuery(question: string, strippedQuestion = question): string {
  let output = normalizeChatSearchQuestion(strippedQuestion);
  const noise = [...PERIOD_AGGREGATE_NOISE, ...PERIOD_REQUEST_NOISE].sort(
    (left, right) => right.length - left.length,
  );
  for (const phrase of noise) {
    output = output.replaceAll(phrase, ' ');
  }
  output = replaceInternalPunctuationWithSpaces(
    stripStructuralNoParticle(stripTrailingTopicPunctuation(output)),
  );
  return stripStructuralJapaneseParticles(normalizeChatSearchQuestion(output));
}

const TRAILING_TOPIC_PUNCTUATION = new Set(['？', '?', '。', '．', '!', '！']);
const INTERNAL_TOPIC_PUNCTUATION = new Set(['、', '。', '?', '？', '!', '！']);

function stripTrailingTopicPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && TRAILING_TOPIC_PUNCTUATION.has(value.charAt(end - 1))) {
    end -= 1;
  }
  return value.slice(0, end);
}

function stripStructuralNoParticle(value: string): string {
  const parts: string[] = [];
  let index = 0;
  while (index < value.length) {
    const char = value.charAt(index);
    if (isTopicQueryWhitespace(char)) {
      let whitespaceEnd = index;
      while (whitespaceEnd < value.length && isTopicQueryWhitespace(value.charAt(whitespaceEnd))) {
        whitespaceEnd += 1;
      }
      if (whitespaceEnd < value.length && value.charAt(whitespaceEnd) === 'の') {
        const afterNo = consumeStructuralNoSegment(value, whitespaceEnd);
        if (afterNo !== null) {
          appendNormalizedSeparator(parts);
          index = afterNo;
          continue;
        }
      }
      appendNormalizedSeparator(parts);
      index = whitespaceEnd;
      continue;
    }
    if (char === 'の') {
      const afterNo = consumeStructuralNoSegment(value, index);
      if (afterNo !== null) {
        appendNormalizedSeparator(parts);
        index = afterNo;
        continue;
      }
    }
    parts.push(char);
    index += 1;
  }
  return parts.join('');
}

function consumeStructuralNoSegment(value: string, noIndex: number): number | null {
  if (value.charAt(noIndex) !== 'の') {
    return null;
  }
  let afterNo = noIndex + 1;
  let hadWhitespaceAfterNo = false;
  while (afterNo < value.length && isTopicQueryWhitespace(value.charAt(afterNo))) {
    hadWhitespaceAfterNo = true;
    afterNo += 1;
  }
  if (afterNo >= value.length || hadWhitespaceAfterNo) {
    return afterNo;
  }
  return null;
}

function appendNormalizedSeparator(parts: string[]): void {
  if (parts.length > 0 && parts[parts.length - 1] !== ' ') {
    parts.push(' ');
  }
}

function replaceInternalPunctuationWithSpaces(value: string): string {
  const parts: string[] = [];
  for (const char of value) {
    parts.push(INTERNAL_TOPIC_PUNCTUATION.has(char) ? ' ' : char);
  }
  return parts.join('');
}

function isTopicQueryWhitespace(char: string): boolean {
  return char.trim() === '';
}

function stripStructuralJapaneseParticles(value: string): string {
  let output = value.trim();
  if (!output) {
    return '';
  }
  const particlePattern = /[のをにではがは]/u;
  while (output.length > 0 && particlePattern.test(output[0] ?? '')) {
    output = output.slice(1).trimStart();
  }
  while (output.length > 0 && particlePattern.test(output.at(-1) ?? '')) {
    output = output.slice(0, -1).trimEnd();
  }
  return output;
}

function calendarYearPeriod(year: number): ChatSearchPeriod {
  return {
    startAt: tokyoInstantFromLocalDate(year, 1, 1).toISOString(),
    endAt: tokyoInstantFromLocalDate(year + 1, 1, 1).toISOString(),
  };
}

function trailingYearsPeriod(now: Date, years: number): ChatSearchPeriod {
  const localNow = tokyoLocalDateTime(now);
  const localStart = subtractLocalYearsClamped(localNow, years);
  return {
    startAt: new Date(localStart.valueOf() - TOKYO_OFFSET_MILLISECONDS).toISOString(),
    endAt: now.toISOString(),
  };
}

function subtractLocalYearsClamped(localDate: Date, years: number): Date {
  const targetYear = localDate.getUTCFullYear() - years;
  const month = localDate.getUTCMonth();
  const day = localDate.getUTCDate();
  const hours = localDate.getUTCHours();
  const minutes = localDate.getUTCMinutes();
  const seconds = localDate.getUTCSeconds();
  const milliseconds = localDate.getUTCMilliseconds();
  let candidate = new Date(Date.UTC(targetYear, month, day, hours, minutes, seconds, milliseconds));
  if (candidate.getUTCMonth() !== month) {
    candidate = new Date(Date.UTC(targetYear, month + 1, 0, hours, minutes, seconds, milliseconds));
  }
  return candidate;
}

function tokyoInstantFromLocalDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0) - TOKYO_OFFSET_MILLISECONDS);
}

function tokyoLocalDateTime(instant: Date): Date {
  return new Date(instant.valueOf() + TOKYO_OFFSET_MILLISECONDS);
}

function parseChatSearchIsoInstant(value: string, fieldLabel: string): number {
  if (!isChatSearchIsoInstant(value)) {
    throw new Error(
      `${fieldLabel} must use YYYY-MM-DDTHH:mm:ss with optional fractional seconds and Z or ±HH:mm.`,
    );
  }
  return Date.parse(value);
}

function parseChatSearchPeriodInstant(value: string, fieldName: 'endAt' | 'startAt'): number {
  return parseChatSearchIsoInstant(value, `Chat search period ${fieldName}`);
}

function requireChatSearchNowIso(nowIso: string): Date {
  return new Date(parseChatSearchIsoInstant(nowIso, 'nowIso'));
}

function normalizeChatSearchQuestion(value: string): string {
  let output = '';
  let pendingSpace = false;
  for (const char of value.trim()) {
    if (char.trim() === '') {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && output.length > 0) {
      output += ' ';
    }
    output += char;
    pendingSpace = false;
  }
  return output;
}

function stripRecognizedPeriodPhrase(question: string, phrase: string): string {
  return normalizeChatSearchQuestion(question.replace(phrase, ' '));
}
