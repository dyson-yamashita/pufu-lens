import type { ParsedTopic } from './ingestion-fixtures.js';

export interface TopicExtractionInput {
  bodyText: string;
  canonicalUri: string;
  html: string;
  title: string;
}

export interface TopicExtractionAgent {
  extractTopics(input: TopicExtractionInput): Promise<ParsedTopic[]>;
}

export interface GeminiTopicExtractionAgentOptions {
  apiKey: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  maxBodyCharacters?: number;
  maxTopics?: number;
  model: string;
}

export function createDeterministicTopicExtractionAgent(): TopicExtractionAgent {
  return {
    async extractTopics(input) {
      return deterministicWebTopics(input);
    },
  };
}

export function createGeminiTopicExtractionAgent(
  options: GeminiTopicExtractionAgentOptions,
): TopicExtractionAgent {
  if (!options.apiKey) {
    throw new Error('GEMINI_API_KEY is required for topic extraction.');
  }
  if (!options.model) {
    throw new Error('GEMINI_CHAT_MODEL is required for topic extraction.');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxTopics = options.maxTopics ?? 10;
  const maxBodyCharacters = options.maxBodyCharacters ?? 12000;
  const endpoint =
    options.endpoint ??
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      options.model,
    )}:generateContent`;

  return {
    async extractTopics(input) {
      const response = await fetchImpl(`${endpoint}?key=${encodeURIComponent(options.apiKey)}`, {
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: [
                    'You are TopicExtractionAgent for Pufu Lens.',
                    'Extract semantic topics for a web article.',
                    'Return only JSON: {"topics":["topic1","topic2"]}.',
                    `Return 1 to ${maxTopics} concise topics.`,
                    'Prefer explicit article tags/hashtags such as note.com hashtag tags when present.',
                    'Prefer project/product names, technical concepts, and domain keywords.',
                    'Do not return generic UI words, navigation labels, login/signup links, or quoted phrases unless they are actual article topics.',
                    'Do not return URLs.',
                    'Keep Japanese topics in Japanese.',
                    `Title: ${input.title}`,
                    `Canonical URI: ${input.canonicalUri}`,
                    `HTML excerpt: ${input.html.slice(0, maxBodyCharacters)}`,
                    `Body text excerpt: ${input.bodyText.slice(0, maxBodyCharacters)}`,
                  ].join('\n'),
                },
              ],
            },
          ],
          generationConfig: { responseMimeType: 'application/json' },
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error(`Gemini topic extraction request failed: HTTP ${response.status}`);
      }
      const body = (await response.json()) as unknown;
      if (!isRecord(body)) {
        throw new Error('Gemini topic extraction response is not a valid JSON object.');
      }
      const text = geminiResponseText(body);
      if (!text) {
        throw new Error('Gemini topic extraction response did not include JSON text.');
      }
      return topicsFromGeminiJson(text, maxTopics);
    },
  };
}

export function topicsFromGeminiJson(text: string, maxTopics = 10): ParsedTopic[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to parse Gemini topic extraction response as JSON: ${reason}. Raw text prefix: ${text.slice(
        0,
        500,
      )}`,
    );
  }
  const topicsValue = isRecord(value) ? value.topics : undefined;
  if (!Array.isArray(topicsValue)) {
    throw new Error('Gemini topic extraction response must include topics array.');
  }
  return normalizeTopicTargets(topicsValue, 'llm', maxTopics);
}

function deterministicWebTopics(input: TopicExtractionInput): ParsedTopic[] {
  const topics: ParsedTopic[] = [];
  const seen = new Set<string>();

  const addCandidates = (candidates: Iterable<string>, source: string) => {
    for (const candidate of candidates) {
      if (topics.length >= 10) {
        break;
      }
      const target = normalizeTopicTarget(candidate);
      const key = target.toLowerCase();
      if (!target || seen.has(key)) {
        continue;
      }
      seen.add(key);
      topics.push({
        metadata: { source },
        target,
        topicType: 'keyword',
      });
    }
  };

  addCandidates(extractHashtagTopics(input.html), 'hashtag');
  if (topics.length < 10) {
    addCandidates(titleTopicCandidates(input.title), 'title');
  }
  if (topics.length < 10) {
    addCandidates(extractMetaKeywords(input.html), 'meta_keywords');
  }
  if (topics.length < 10) {
    addCandidates(extractQuotedTopicPhrases(input.bodyText), 'quoted_phrase');
  }

  return topics;
}

function normalizeTopicTargets(
  values: unknown[],
  source: string,
  maxTopics: number,
): ParsedTopic[] {
  const topics: ParsedTopic[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (topics.length >= maxTopics) {
      break;
    }
    if (typeof value !== 'string') {
      continue;
    }
    const target = normalizeTopicTarget(stripHashPrefix(value));
    const key = target.toLowerCase();
    if (!target || seen.has(key) || looksLikeUrl(target)) {
      continue;
    }
    seen.add(key);
    topics.push({ metadata: { source }, target, topicType: 'keyword' });
  }
  return topics;
}

function titleTopicCandidates(title: string): string[] {
  const normalized = normalizeTopicTarget(title);
  if (!normalized) {
    return [];
  }
  const parts = splitTitleTopicParts(normalized)
    .map((part) => normalizeTopicTarget(part))
    .filter((part) => part.length >= 2);
  return [normalized, ...parts];
}

function* extractMetaKeywords(html: string): Generator<string> {
  for (const tag of htmlTags(html, 'meta')) {
    const key =
      getHtmlAttribute(tag, 'name')?.toLowerCase() ??
      getHtmlAttribute(tag, 'property')?.toLowerCase();
    if (key !== 'keywords' && key !== 'article:tag') {
      continue;
    }
    const content = getHtmlAttribute(tag, 'content');
    if (!content) {
      continue;
    }
    yield* splitListContent(content);
  }
}

function* extractHashtagTopics(html: string): Generator<string> {
  for (const anchor of htmlTags(html, 'a')) {
    const href = getHtmlAttribute(anchor, 'href') ?? '';
    const tag = hashtagPathSegment(href);
    if (!tag) {
      continue;
    }
    try {
      yield stripHashPrefix(decodeURIComponent(tag));
    } catch {
      yield stripHashPrefix(tag);
    }
  }
}

function* extractQuotedTopicPhrases(bodyText: string): Generator<string> {
  const pairs = [
    ['"', '"'],
    ['「', '」'],
    ['『', '』'],
    ['“', '”'],
  ] as const;
  for (let index = 0; index < bodyText.length; index += 1) {
    const pair = pairs.find(([open]) => open === bodyText[index]);
    if (!pair) {
      continue;
    }
    const end = bodyText.indexOf(pair[1], index + 1);
    if (end < 0) {
      continue;
    }
    const phrase = bodyText.slice(index + 1, end);
    if (phrase.length >= 2 && phrase.length <= 80) {
      yield phrase;
    }
    index = end;
  }
}

function normalizeTopicTarget(value: string): string {
  return normalizeWhitespace(replaceBrackets(htmlEntityDecode(value)));
}

function htmlEntityDecode(value: string): string {
  const entities = new Map([
    ['nbsp', ' '],
    ['amp', '&'],
    ['lt', '<'],
    ['gt', '>'],
    ['quot', '"'],
    ['apos', "'"],
    ['#39', "'"],
  ]);
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value.charAt(index) !== '&') {
      output += value.charAt(index);
      continue;
    }
    const semicolon = value.indexOf(';', index + 1);
    if (semicolon < 0 || semicolon - index > 12) {
      output += value.charAt(index);
      continue;
    }
    const decoded = entities.get(value.slice(index + 1, semicolon).toLowerCase());
    output += decoded ?? value.slice(index, semicolon + 1);
    index = semicolon;
  }
  return output;
}

function getHtmlAttribute(tag: string, attributeName: string): string | undefined {
  const wanted = attributeName.toLowerCase();
  let index = 0;
  while (index < tag.length) {
    while (index < tag.length && tag.charAt(index).trim() !== '') {
      index += 1;
    }
    while (index < tag.length && tag.charAt(index).trim() === '') {
      index += 1;
    }
    const nameStart = index;
    while (index < tag.length && isHtmlAttributeNameChar(tag.charAt(index))) {
      index += 1;
    }
    const name = tag.slice(nameStart, index).toLowerCase();
    const afterName = index;
    if (!name) {
      index += 1;
      continue;
    }
    while (index < tag.length && tag.charAt(index).trim() === '') {
      index += 1;
    }
    if (tag.charAt(index) !== '=') {
      if (name === wanted) {
        return '';
      }
      index = afterName;
      continue;
    }
    index += 1;
    while (index < tag.length && tag.charAt(index).trim() === '') {
      index += 1;
    }
    const value = readHtmlAttributeValue(tag, index);
    if (name === wanted) {
      return value.value;
    }
    index = value.end;
  }
  return undefined;
}

function looksLikeUrl(value: string): boolean {
  const lowerValue = value.toLowerCase();
  return lowerValue.startsWith('http://') || lowerValue.startsWith('https://');
}

function splitTitleTopicParts(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (char === '|' || char === '｜' || char === '：' || isSpacedDashSeparator(value, index)) {
      if (current.trim()) {
        parts.push(current);
      }
      current = '';
      if (isSpacedDashSeparator(value, index)) {
        index += 1;
      }
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    parts.push(current);
  }
  return parts;
}

function isSpacedDashSeparator(value: string, index: number): boolean {
  const char = value.charAt(index);
  if (char !== '-' && char !== '–' && char !== '—' && char !== ':') {
    return false;
  }
  return value[index - 1]?.trim() === '' && value[index + 1]?.trim() === '';
}

function* splitListContent(value: string): Generator<string> {
  let current = '';
  for (const char of value) {
    if (char === ',' || char === '、') {
      yield current;
      current = '';
      continue;
    }
    current += char;
  }
  yield current;
}

function hashtagPathSegment(href: string): string | undefined {
  const path = href.split('?')[0]?.split('#')[0] ?? href;
  const segments = path.split('/').filter(Boolean);
  const hashtagIndex = segments.findIndex((segment) => segment.toLowerCase() === 'hashtag');
  return hashtagIndex >= 0 ? segments[hashtagIndex + 1] : undefined;
}

function stripHashPrefix(value: string): string {
  return value.startsWith('#') ? value.slice(1) : value;
}

function replaceBrackets(value: string): string {
  let output = '';
  for (const char of value) {
    output += char === '【' || char === '】' ? ' ' : char;
  }
  return output;
}

function normalizeWhitespace(value: string): string {
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

function htmlTags(html: string, tagName: string): string[] {
  const tags: string[] = [];
  const wanted = tagName.toLowerCase();
  for (let index = 0; index < html.length; index += 1) {
    if (html[index] !== '<' || html[index + 1] === '/') {
      continue;
    }
    if (readHtmlTagName(html, index + 1) !== wanted) {
      continue;
    }
    const tagEnd = findHtmlTagEnd(html, index + 1);
    if (tagEnd < 0) {
      continue;
    }
    tags.push(html.slice(index, tagEnd + 1));
    index = tagEnd;
  }
  return tags;
}

function findHtmlTagEnd(value: string, startIndex: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = startIndex; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') {
      return index;
    }
  }
  return -1;
}

function readHtmlTagName(value: string, startIndex: number): string {
  let index = startIndex;
  if (value.charAt(index) === '/') {
    index += 1;
  }
  while (index < value.length && value.charAt(index).trim() === '') {
    index += 1;
  }
  let name = '';
  while (index < value.length) {
    const char = value.charAt(index).toLowerCase();
    if (char < 'a' || char > 'z') {
      break;
    }
    name += char;
    index += 1;
  }
  return name;
}

function isHtmlAttributeNameChar(char: string): boolean {
  return (
    (char >= 'a' && char <= 'z') ||
    (char >= 'A' && char <= 'Z') ||
    (char >= '0' && char <= '9') ||
    char === '-' ||
    char === ':' ||
    char === '_'
  );
}

function readHtmlAttributeValue(tag: string, startIndex: number): { end: number; value: string } {
  const quote = tag[startIndex];
  if (quote === '"' || quote === "'") {
    const end = tag.indexOf(quote, startIndex + 1);
    return end < 0
      ? { end: tag.length, value: tag.slice(startIndex + 1) }
      : { end: end + 1, value: tag.slice(startIndex + 1, end) };
  }
  let end = startIndex;
  while (end < tag.length && tag.charAt(end).trim() !== '' && tag.charAt(end) !== '>') {
    end += 1;
  }
  return { end, value: tag.slice(startIndex, end) };
}

function geminiResponseText(body: Record<string, unknown>): string {
  const candidates = body.candidates;
  if (!Array.isArray(candidates)) {
    return '';
  }
  const [first] = candidates;
  if (!isRecord(first) || !isRecord(first.content)) {
    return '';
  }
  const parts = first.content.parts;
  if (!Array.isArray(parts)) {
    return '';
  }
  return parts
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
