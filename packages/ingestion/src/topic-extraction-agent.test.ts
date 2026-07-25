import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGeminiTopicExtractionAgent,
  topicsFromGeminiJson,
} from './topic-extraction-agent.js';

const SENTINEL_CANONICAL_URI = 'sentinel-canonical-uri-must-not-appear-in-prompt';
const SENTINEL_HTML_EXCERPT = '<sentinel-html-excerpt>must-not-appear</sentinel-html-excerpt>';
const SENTINEL_BODY_TEXT = 'sentinel-body-text-must-not-appear-in-prompt';

function promptTextFromRequest(body: unknown): string {
  const record = body as {
    contents?: Array<{ parts?: Array<{ text?: string }> }>;
  };
  return record.contents?.[0]?.parts?.[0]?.text ?? '';
}

function candidateTextsFromPrompt(promptText: string): string[] {
  const marker = 'Candidates: ';
  const start = promptText.indexOf(marker);
  if (start < 0) {
    return [];
  }
  const candidates = JSON.parse(promptText.slice(start + marker.length)) as Array<{
    text?: string;
  }>;
  return candidates.map((candidate) => candidate.text ?? '');
}

function candidateIdForText(promptText: string, target: string): string {
  const marker = 'Candidates: ';
  const start = promptText.indexOf(marker);
  const candidates = JSON.parse(promptText.slice(start + marker.length)) as Array<{
    id?: string;
    text?: string;
  }>;
  const match = candidates.find((candidate) => candidate.text === target);
  if (!match?.id) {
    throw new Error(`candidate not found for target: ${target}`);
  }
  return match.id;
}

test('topicsFromGeminiJson normalizes topic targets from JSON output', () => {
  assert.deepEqual(
    topicsFromGeminiJson('{"topics":["#AI","グラフ","https://example.test","AI"]}'),
    [
      { metadata: { source: 'llm' }, target: 'AI', topicType: 'keyword' },
      { metadata: { source: 'llm' }, target: 'グラフ', topicType: 'keyword' },
    ],
  );
});

test('topicsFromGeminiJson maps selected candidate IDs and ignores unknown or duplicate IDs', () => {
  const lexicon = {
    candidates: [
      {
        evidence: 'source=hashtag;sections=0;freq=1',
        frequency: 1,
        id: 'topic-1',
        sectionIndices: new Set<number>(),
        sourcePriority: 100,
        sources: new Set(['hashtag'] as const),
        target: 'AI',
      },
      {
        evidence: 'source=body_lexical;sections=1;freq=2',
        frequency: 2,
        id: 'topic-2',
        sectionIndices: new Set([1]),
        sourcePriority: 50,
        sources: new Set(['body_lexical'] as const),
        target: 'グラフ',
      },
    ],
    idToTarget: new Map([
      ['topic-1', 'AI'],
      ['topic-2', 'グラフ'],
    ]),
  };

  assert.deepEqual(
    topicsFromGeminiJson(
      '{"selectedCandidateIds":["topic-2","topic-unknown","topic-2","topic-1","topic-3"]}',
      2,
      lexicon,
    ),
    [
      { metadata: { source: 'llm' }, target: 'グラフ', topicType: 'keyword' },
      { metadata: { source: 'llm' }, target: 'AI', topicType: 'keyword' },
    ],
  );
});

test('topicsFromGeminiJson rejects free-form topics when a candidate lexicon is supplied', () => {
  const lexicon = {
    candidates: [
      {
        evidence: 'source=title;sections=0;freq=1',
        frequency: 1,
        id: 'topic-1',
        sectionIndices: new Set<number>(),
        sourcePriority: 80,
        sources: new Set(['title'] as const),
        target: 'プロジェクトリスク共有',
      },
    ],
    idToTarget: new Map([['topic-1', 'プロジェクトリスク共有']]),
  };

  assert.throws(
    () =>
      topicsFromGeminiJson(
        '{"topics":["プロジェクトリスクを早めに共有することが重要です"]}',
        10,
        lexicon,
      ),
    /selectedCandidateIds/,
  );
});

test('Gemini TopicExtractionAgent sends candidate IDs without raw document excerpts', async () => {
  const requests: Array<{ body: unknown; url: string }> = [];
  const agent = createGeminiTopicExtractionAgent({
    apiKey: 'test-key',
    endpoint: 'https://gemini.example.test/model:generateContent',
    fetchImpl: async (url, init) => {
      requests.push({ body: JSON.parse(String(init?.body)), url: String(url) });
      const promptText = promptTextFromRequest(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      selectedCandidateIds: [candidateIdForText(promptText, 'AI')],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
    },
    model: 'gemini-test',
  });

  const topics = await agent.extractTopics({
    bodyText: SENTINEL_BODY_TEXT,
    canonicalUri: SENTINEL_CANONICAL_URI,
    html: `<a data-active href="/hashtag/AI">${SENTINEL_HTML_EXCERPT}</a>`,
    title: '記事',
  });

  assert.deepEqual(topics, [{ metadata: { source: 'llm' }, target: 'AI', topicType: 'keyword' }]);
  assert.equal(requests[0]?.url, 'https://gemini.example.test/model:generateContent?key=test-key');
  const promptText = promptTextFromRequest(requests[0]?.body);
  assert.match(promptText, /TopicExtractionAgent/);
  assert.match(promptText, /"id":"topic-1"/);
  assert.match(promptText, /selectedCandidateIds/);
  assert.doesNotMatch(promptText, /Canonical URI/);
  assert.doesNotMatch(promptText, /HTML excerpt/);
  assert.doesNotMatch(promptText, /Body text excerpt/);
  assert.doesNotMatch(promptText, /Title:/);
  assert.equal(promptText.includes(SENTINEL_CANONICAL_URI), false);
  assert.equal(promptText.includes(SENTINEL_HTML_EXCERPT), false);
  assert.equal(promptText.includes(SENTINEL_BODY_TEXT), false);
});

test('Gemini TopicExtractionAgent includes tail terms in candidate payload under a small analysis budget', async () => {
  const tailTerm = 'ゼンハイカンツウヨウ';
  const filler = '前置き'.repeat(4000);
  const requests: Array<{ body: unknown }> = [];
  const agent = createGeminiTopicExtractionAgent({
    apiKey: 'test-key',
    endpoint: 'https://gemini.example.test/model:generateContent',
    fetchImpl: async (_url, init) => {
      requests.push({ body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '{"selectedCandidateIds":["topic-1"]}' }],
              },
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
    },
    maxBodyCharacters: 1200,
    model: 'gemini-test',
    topicMorphologicalTokenizer: tailTermTokenizer,
  });

  await agent.extractTopics({
    bodyText: `${filler}\n\n${tailTerm}について説明します。`,
    canonicalUri: 'https://docs.example.test/tail-term',
    html: '<html></html>',
    title: '長文',
  });

  const promptText = promptTextFromRequest(requests[0]?.body);
  assert.ok(candidateTextsFromPrompt(promptText).includes(tailTerm));
});

test('Gemini TopicExtractionAgent constrains LLM output to lexical candidates', async () => {
  let promptText = '';
  const agent = createGeminiTopicExtractionAgent({
    apiKey: 'test-key',
    endpoint: 'https://gemini.example.test/model:generateContent',
    fetchImpl: async (_url, init) => {
      promptText = promptTextFromRequest(JSON.parse(String(init?.body)));
      const projectRiskId = candidateIdForText(promptText, 'プロジェクトリスク共有');
      const shareId = candidateIdForText(promptText, '共有');
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      selectedCandidateIds: [projectRiskId, shareId],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
    },
    model: 'gemini-test',
    topicMorphologicalTokenizer: projectRiskTokenizer,
  });

  const topics = await agent.extractTopics({
    bodyText: 'プロジェクトリスクを早めに共有することが重要です。',
    canonicalUri: 'https://docs.example.test/project-risk',
    html: '<html></html>',
    title: 'プロジェクトリスク共有',
  });

  assert.deepEqual(topics, [
    { metadata: { source: 'llm' }, target: 'プロジェクトリスク共有', topicType: 'keyword' },
    { metadata: { source: 'llm' }, target: '共有', topicType: 'keyword' },
  ]);
});

test('Gemini TopicExtractionAgent tokenizes every sampled section before final candidate cap', async () => {
  const tokenizedTexts: string[] = [];
  const agent = createGeminiTopicExtractionAgent({
    apiKey: 'test-key',
    endpoint: 'https://gemini.example.test/model:generateContent',
    fetchImpl: async (_url, init) => {
      const promptText = promptTextFromRequest(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      selectedCandidateIds: [candidateIdForText(promptText, 'AI')],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
    },
    model: 'gemini-test',
    topicMorphologicalTokenizer: {
      tokenize(text: string) {
        tokenizedTexts.push(text);
        return [];
      },
    },
  });

  await agent.extractTopics({
    bodyText: 'ユーザー調査の本文です。',
    canonicalUri: 'https://docs.example.test/ai',
    html: '<a href="/hashtag/AI">#AI</a>',
    title: 'ユーザー調査',
  });

  assert.ok(tokenizedTexts.some((text) => text.includes('ユーザー調査')));
  assert.ok(tokenizedTexts.some((text) => text.includes('ユーザー調査の本文')));
});

test('Gemini TopicExtractionAgent avoids Gemini when no candidates are available', async () => {
  let requestCount = 0;
  const agent = createGeminiTopicExtractionAgent({
    apiKey: 'test-key',
    endpoint: 'https://gemini.example.test/model:generateContent',
    fetchImpl: async () => {
      requestCount += 1;
      return new Response('{}', { headers: { 'content-type': 'application/json' }, status: 200 });
    },
    model: 'gemini-test',
  });

  const topics = await agent.extractTopics({
    bodyText: 'a',
    canonicalUri: 'https://docs.example.test/empty',
    html: '<html></html>',
    title: 'x',
  });

  assert.deepEqual(topics, []);
  assert.equal(requestCount, 0);
});

test('Gemini TopicExtractionAgent ranks and diversifies near-duplicate candidates deterministically', async () => {
  const requests: Array<{ body: unknown }> = [];
  const agent = createGeminiTopicExtractionAgent({
    apiKey: 'test-key',
    endpoint: 'https://gemini.example.test/model:generateContent',
    fetchImpl: async (_url, init) => {
      requests.push({ body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '{"selectedCandidateIds":["topic-1"]}' }],
              },
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
    },
    maxCandidateTopics: 4,
    model: 'gemini-test',
    topicMorphologicalTokenizer: diversityTokenizer,
  });

  await agent.extractTopics({
    bodyText:
      'クラウドネイティブ設計とクラウドネイティブアーキテクチャ、データ基盤、セキュリティ統制について説明します。',
    canonicalUri: 'https://docs.example.test/diversity',
    html: '<html></html>',
    title: 'クラウドネイティブ設計',
  });

  const promptText = promptTextFromRequest(requests[0]?.body);
  const candidateTexts = candidateTextsFromPrompt(promptText);
  assert.ok(candidateTexts.includes('クラウドネイティブ設計'));
  assert.ok(candidateTexts.includes('データ基盤'));
  assert.ok(candidateTexts.includes('セキュリティ統制'));
  assert.equal(candidateTexts.filter((text) => text.includes('クラウドネイティブ')).length, 1);

  requests.length = 0;
  await agent.extractTopics({
    bodyText:
      'クラウドネイティブ設計とクラウドネイティブアーキテクチャ、データ基盤、セキュリティ統制について説明します。',
    canonicalUri: 'https://docs.example.test/diversity',
    html: '<html></html>',
    title: 'クラウドネイティブ設計',
  });
  assert.equal(promptTextFromRequest(requests[0]?.body), promptText);
});

test('Gemini TopicExtractionAgent keeps tail candidates when early sections overflow the cap', async () => {
  const tailTerm = 'tail-priority-term';
  const requests: Array<{ body: unknown }> = [];
  const agent = createGeminiTopicExtractionAgent({
    apiKey: 'test-key',
    endpoint: 'https://gemini.example.test/model:generateContent',
    fetchImpl: async (_url, init) => {
      requests.push({ body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '{"selectedCandidateIds":["topic-1"]}' }],
              },
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
    },
    maxBodyCharacters: 1200,
    maxCandidateTopics: 3,
    model: 'gemini-test',
    topicMorphologicalTokenizer: sectionOverflowTokenizer,
  });

  await agent.extractTopics({
    bodyText: `${'section-zero '.repeat(1200)}\n\n${tailTerm} について説明します。`,
    canonicalUri: 'https://docs.example.test/section-balance',
    html: '<html></html>',
    title: '長文',
  });

  const promptText = promptTextFromRequest(requests[0]?.body);
  assert.ok(candidateTextsFromPrompt(promptText).includes(tailTerm));
});

test('Gemini TopicExtractionAgent rejects lexicon-bound free-form LLM topics', async () => {
  const agent = createGeminiTopicExtractionAgent({
    apiKey: 'test-key',
    endpoint: 'https://gemini.example.test/model:generateContent',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: '{"topics":["プロジェクトリスクを早めに共有することが重要です"]}',
                  },
                ],
              },
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      ),
    model: 'gemini-test',
    topicMorphologicalTokenizer: projectRiskTokenizer,
  });

  await assert.rejects(
    () =>
      agent.extractTopics({
        bodyText: 'プロジェクトリスクを早めに共有することが重要です。',
        canonicalUri: 'https://docs.example.test/project-risk',
        html: '<html></html>',
        title: 'プロジェクトリスク共有',
      }),
    /selectedCandidateIds/,
  );
});

test('Gemini TopicExtractionAgent passes configured request timeout to fetch', async () => {
  let capturedSignal: AbortSignal | undefined;
  const customTimeoutMs = 50;
  const agent = createGeminiTopicExtractionAgent({
    apiKey: 'test-key',
    endpoint: 'https://gemini.example.test/model:generateContent',
    fetchImpl: async (_url, init) => {
      capturedSignal = init?.signal ?? undefined;
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: '{"selectedCandidateIds":["topic-1"]}',
                  },
                ],
              },
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
    },
    model: 'gemini-test',
    requestTimeoutMs: customTimeoutMs,
  });

  await agent.extractTopics({
    bodyText: '本文',
    canonicalUri: 'https://docs.example.test/timeout',
    html: '<a href="/hashtag/AI">#AI</a>',
    title: '記事',
  });

  assert.ok(capturedSignal);
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + customTimeoutMs + 200;
    const waitForAbort = () => {
      if (capturedSignal?.aborted) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('AbortSignal was not aborted within the configured deadline'));
        return;
      }
      setTimeout(waitForAbort, 5);
    };
    waitForAbort();
  });
});

test('Gemini TopicExtractionAgent rejects non-object JSON responses safely', async () => {
  const agent = createGeminiTopicExtractionAgent({
    apiKey: 'test-key',
    endpoint: 'https://gemini.example.test/model:generateContent',
    fetchImpl: async () =>
      new Response('null', { headers: { 'content-type': 'application/json' }, status: 200 }),
    model: 'gemini-test',
  });

  await assert.rejects(
    () =>
      agent.extractTopics({
        bodyText: '本文',
        canonicalUri: 'https://note.example.test/n/abc',
        html: '<html></html>',
        title: '記事',
      }),
    /Gemini topic extraction response is not a valid JSON object/,
  );
});

const sectionOverflowTokenizer = {
  tokenize(text: string) {
    const tokens = [];
    if (text.includes('section-zero')) {
      for (let index = 0; index < 8; index += 1) {
        tokens.push({
          normalizedForm: `early-term-${index}`,
          partOfSpeech: ['名詞', '普通名詞', '一般', '*', '*', '*'],
          surface: `early-term-${index}`,
        });
      }
    }
    if (text.includes('tail-priority-term')) {
      tokens.push({
        normalizedForm: 'tail-priority-term',
        partOfSpeech: ['名詞', '普通名詞', '一般', '*', '*', '*'],
        surface: 'tail-priority-term',
      });
    }
    return tokens;
  },
};

const projectRiskTokenizer = {
  tokenize(text: string) {
    if (text.includes('プロジェクトリスク')) {
      return [
        {
          normalizedForm: 'プロジェクトリスク',
          partOfSpeech: ['名詞', '普通名詞', '一般', '*', '*', '*'],
          surface: 'プロジェクトリスク',
        },
        {
          dictionaryForm: '共有',
          partOfSpeech: ['動詞', '一般', '*', '*', '*', '*'],
          surface: '共有する',
        },
        {
          normalizedForm: '早い',
          partOfSpeech: ['形容詞', '一般', '*', '*', '*', '*'],
          surface: '早め',
        },
        {
          normalizedForm: 'こと',
          partOfSpeech: ['名詞', '普通名詞', '一般', '*', '*', '*'],
          surface: 'こと',
        },
        {
          normalizedForm: 'を',
          partOfSpeech: ['助詞', '格助詞', '*', '*', '*', '*'],
          surface: 'を',
        },
      ];
    }
    return [];
  },
};

const tailTermTokenizer = {
  tokenize(text: string) {
    if (text.includes('ゼンハイカンツウヨウ')) {
      return [
        {
          normalizedForm: 'ゼンハイカンツウヨウ',
          partOfSpeech: ['名詞', '普通名詞', '一般', '*', '*', '*'],
          surface: 'ゼンハイカンツウヨウ',
        },
      ];
    }
    return [];
  },
};

const diversityTokenizer = {
  tokenize(text: string) {
    const tokens = [];
    if (text.includes('クラウドネイティブ設計')) {
      tokens.push({
        normalizedForm: 'クラウドネイティブ設計',
        partOfSpeech: ['名詞', '普通名詞', '一般', '*', '*', '*'],
        surface: 'クラウドネイティブ設計',
      });
    }
    if (text.includes('クラウドネイティブアーキテクチャ')) {
      tokens.push({
        normalizedForm: 'クラウドネイティブアーキテクチャ',
        partOfSpeech: ['名詞', '普通名詞', '一般', '*', '*', '*'],
        surface: 'クラウドネイティブアーキテクチャ',
      });
    }
    if (text.includes('データ基盤')) {
      tokens.push({
        normalizedForm: 'データ基盤',
        partOfSpeech: ['名詞', '普通名詞', '一般', '*', '*', '*'],
        surface: 'データ基盤',
      });
    }
    if (text.includes('セキュリティ統制')) {
      tokens.push({
        normalizedForm: 'セキュリティ統制',
        partOfSpeech: ['名詞', '普通名詞', '一般', '*', '*', '*'],
        surface: 'セキュリティ統制',
      });
    }
    return tokens;
  },
};
