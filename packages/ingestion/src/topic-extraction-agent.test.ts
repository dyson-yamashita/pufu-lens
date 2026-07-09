import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGeminiTopicExtractionAgent,
  topicsFromGeminiJson,
} from './topic-extraction-agent.js';

test('topicsFromGeminiJson normalizes topic targets from JSON output', () => {
  assert.deepEqual(
    topicsFromGeminiJson('{"topics":["#AI","グラフ","https://example.test","AI"]}'),
    [
      { metadata: { source: 'llm' }, target: 'AI', topicType: 'keyword' },
      { metadata: { source: 'llm' }, target: 'グラフ', topicType: 'keyword' },
    ],
  );
});

test('Gemini TopicExtractionAgent sends document context and parses JSON topics', async () => {
  const requests: Array<{ body: unknown; url: string }> = [];
  const agent = createGeminiTopicExtractionAgent({
    apiKey: 'test-key',
    endpoint: 'https://gemini.example.test/model:generateContent',
    fetchImpl: async (url, init) => {
      requests.push({ body: JSON.parse(String(init?.body)), url: String(url) });
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '{"topics":["AI","本文全体を説明してしまう長い文章です"]}' }],
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
    bodyText: '本文',
    canonicalUri: 'https://note.example.test/n/abc',
    html: '<a data-active href="/hashtag/AI">#AI</a>',
    title: '記事',
  });

  assert.deepEqual(topics, [{ metadata: { source: 'llm' }, target: 'AI', topicType: 'keyword' }]);
  assert.equal(requests[0]?.url, 'https://gemini.example.test/model:generateContent?key=test-key');
  assert.match(JSON.stringify(requests[0]?.body), /TopicExtractionAgent/);
  assert.match(JSON.stringify(requests[0]?.body), /Candidate terms/);
  assert.match(JSON.stringify(requests[0]?.body), /hashtag/);
});

test('Gemini TopicExtractionAgent constrains LLM output to lexical candidates', async () => {
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
                    text: '{"topics":["プロジェクトリスク","共有"]}',
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

  const topics = await agent.extractTopics({
    bodyText: 'プロジェクトリスクを早めに共有することが重要です。',
    canonicalUri: 'https://docs.example.test/project-risk',
    html: '<html></html>',
    title: 'プロジェクトリスク共有',
  });

  assert.deepEqual(topics, [
    { metadata: { source: 'llm' }, target: 'プロジェクトリスク', topicType: 'keyword' },
    { metadata: { source: 'llm' }, target: '共有', topicType: 'keyword' },
  ]);
});

test('Gemini TopicExtractionAgent skips tokenization after candidate limit is reached', async () => {
  const agent = createGeminiTopicExtractionAgent({
    apiKey: 'test-key',
    endpoint: 'https://gemini.example.test/model:generateContent',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '{"topics":["AI"]}' }],
              },
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      ),
    maxCandidateTopics: 1,
    model: 'gemini-test',
    topicMorphologicalTokenizer: {
      tokenize() {
        throw new Error('tokenizer should not be called after candidate limit is reached');
      },
    },
  });

  const topics = await agent.extractTopics({
    bodyText: 'ユーザー調査の本文',
    canonicalUri: 'https://docs.example.test/ai',
    html: '<a href="/hashtag/AI">#AI</a>',
    title: 'ユーザー調査',
  });

  assert.deepEqual(topics, [{ metadata: { source: 'llm' }, target: 'AI', topicType: 'keyword' }]);
});

test('Gemini TopicExtractionAgent rejects sentence-like LLM topics without exact candidate matches', async () => {
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

  const topics = await agent.extractTopics({
    bodyText: 'プロジェクトリスクを早めに共有することが重要です。',
    canonicalUri: 'https://docs.example.test/project-risk',
    html: '<html></html>',
    title: 'プロジェクトリスク共有',
  });

  assert.deepEqual(topics, []);
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
