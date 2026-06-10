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

test('Gemini TopicExtractionAgent sends web article context and parses JSON topics', async () => {
  const requests: Array<{ body: unknown; url: string }> = [];
  const agent = createGeminiTopicExtractionAgent({
    apiKey: 'test-key',
    endpoint: 'https://gemini.example.test/model:generateContent',
    fetchImpl: async (url, init) => {
      requests.push({ body: JSON.parse(String(init?.body)), url: String(url) });
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"topics":["AI","プ譜"]}' }] } }],
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
    },
    model: 'gemini-test',
  });

  const topics = await agent.extractTopics({
    bodyText: '本文',
    canonicalUri: 'https://note.example.test/n/abc',
    html: '<a href="/hashtag/AI">#AI</a>',
    title: '記事',
  });

  assert.deepEqual(topics, [
    { metadata: { source: 'llm' }, target: 'AI', topicType: 'keyword' },
    { metadata: { source: 'llm' }, target: 'プ譜', topicType: 'keyword' },
  ]);
  assert.equal(requests[0]?.url, 'https://gemini.example.test/model:generateContent?key=test-key');
  assert.match(JSON.stringify(requests[0]?.body), /TopicExtractionAgent/);
  assert.match(JSON.stringify(requests[0]?.body), /hashtag/);
});
