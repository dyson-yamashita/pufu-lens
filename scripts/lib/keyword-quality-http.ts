import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { ChatResponse } from '../../apps/web/src/chat.ts';

/**
 * Round-trips real retrieval output through the production workflow HTTP client and a loopback stub.
 * Only the Mastra protocol/synthesis is stubbed; this does not execute Next auth or an LLM.
 * Uses an OS-assigned port, no credentials, and always closes only its own listener.
 */
export async function verifyQualityWorkflowHttp(input: {
  readonly response: ChatResponse;
  readonly projectId: string;
  readonly question: string;
}): Promise<void> {
  const { runPrivateChatSearchViaMastraWorkflow } = await import(
    '../../apps/web/src/private-chat-workflow-client.ts'
  );
  const requests: string[] = [];
  let serverError: unknown;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, undefined);
      requests.push(request.url ?? '');
      let raw = '';
      for await (const chunk of request) raw += chunk;
      if (request.url === '/api/workflows/private-chat-search/create-run') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ runId: 'quality-run' }));
        return;
      }
      assert.equal(request.url, '/api/workflows/private-chat-search/stream?runId=quality-run');
      const body = JSON.parse(raw);
      assert.equal(body.inputData.projectId, input.projectId);
      assert.equal(body.inputData.question, input.question);
      assert.equal(body.inputData.hybridSearchDocumentLimit, 5);
      response.setHeader('content-type', 'application/octet-stream');
      response.write(
        `${JSON.stringify({ type: 'workflow-step-start', payload: { id: 'private-chat-retrieving' } })}\x1e`,
      );
      response.end(
        `${JSON.stringify({ type: 'workflow-step-result', payload: { id: 'private-chat-synthesis', output: input.response } })}\x1e`,
      );
    } catch (error) {
      serverError = error;
      response.statusCode = 500;
      response.end('synthetic protocol failure');
    }
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const stages: string[] = [];
    const actual = await runPrivateChatSearchViaMastraWorkflow({
      env: { MASTRA_SERVER_URL: `http://127.0.0.1:${address.port}` },
      graphName: null,
      history: [],
      hybridSearchDocumentLimit: 5,
      projectId: input.projectId,
      projectSlug: input.response.projectSlug,
      question: input.question,
      nowIso: '2026-09-24T00:00:00Z',
      signal: AbortSignal.timeout(5000),
      onStage: (stage) => {
        stages.push(stage);
      },
    });
    assert.equal(serverError, undefined);
    assert.deepEqual(actual, input.response);
    assert.deepEqual(stages, ['retrieving']);
    assert.equal(requests.length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
