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
      const body = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
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
    const target = normalizeTopicTarget(value.replace(/^#/, ''));
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
  const parts = normalized
    .split(/[|｜：]|\s+[-–—:]\s+/)
    .map((part) => normalizeTopicTarget(part))
    .filter((part) => part.length >= 2);
  return [normalized, ...parts];
}

function* extractMetaKeywords(html: string): Generator<string> {
  for (const meta of html.matchAll(/<meta\s+[^>]*>/gi)) {
    const tag = meta[0];
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
    yield* content.split(/[,、]/);
  }
}

function* extractHashtagTopics(html: string): Generator<string> {
  for (const anchor of html.matchAll(/<a\s+[^>]*href=["'](?<href>[^"']+)["'][^>]*>/gi)) {
    const href = anchor.groups?.href ?? '';
    const match = href.match(/(?:^|\/)hashtag\/(?<tag>[^?#/]+)/i);
    const tag = match?.groups?.tag;
    if (!tag) {
      continue;
    }
    try {
      yield decodeURIComponent(tag).replace(/^#/, '');
    } catch {
      yield tag.replace(/^#/, '');
    }
  }
}

function* extractQuotedTopicPhrases(bodyText: string): Generator<string> {
  const regex = /"([^"]{2,80})"|「([^」]{2,80})」|『([^』]{2,80})』|“([^”]{2,80})”/g;
  for (const match of bodyText.matchAll(regex)) {
    yield match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
  }
}

function normalizeTopicTarget(value: string): string {
  return htmlEntityDecode(value)
    .replace(/[【】]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlEntityDecode(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(apos|#39);/g, "'");
}

function getHtmlAttribute(tag: string, attributeName: string): string | undefined {
  const pattern = new RegExp(
    `\\s${attributeName}\\s*=\\s*(?:"(?<double>[^"]*)"|'(?<single>[^']*)'|(?<unquoted>[^\\s>]+))`,
    'i',
  );
  const match = tag.match(pattern);
  return match?.groups?.double ?? match?.groups?.single ?? match?.groups?.unquoted;
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
