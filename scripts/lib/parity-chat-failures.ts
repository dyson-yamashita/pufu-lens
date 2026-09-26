import { once } from 'node:events';
import { createServer } from 'node:http';
import { ProjectAccessDeniedError, runPrivateChat } from '../../apps/web/src/chat.ts';
import {
  PrivateChatWorkflowInvocationError,
  runPrivateChatSearchViaMastraWorkflow,
} from '../../apps/web/src/private-chat-workflow-client.ts';
import { localChatRepository, parityChatInputs } from './parity-chat.ts';

/** Normalizes observed error types/status only; never reads the fixture's expectedFailure. */
export function normalizeLocalChatError(error: unknown): string {
  if (error instanceof ProjectAccessDeniedError) return 'project_access_denied';
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof PrivateChatWorkflowInvocationError && error.status === 429)
    return 'overloaded';
  return 'unavailable';
}

/** Injects absent membership at the legacy Chat use-case boundary and 429/delayed HTTP responses
 * at the real workflow client boundary. No Next auth, provider quota or remote timeout is tested.
 * Unexpected success is preserved as a mismatch; raw messages and request content are not saved.
 */
export async function collectLocalChatFailures() {
  const observations = [];
  for (const input of parityChatInputs().filter(
    (test) => test.id.startsWith('failure-') && test.id !== 'failure-stale_read',
  )) {
    let actualError: string | null = null;
    let boundary = '';
    let requests = 0;
    let membershipLookups = 0;
    let downstreamCalls = 0;
    const start = performance.now();
    if (input.id === 'failure-project_access_denied') {
      boundary = 'legacy-runPrivateChat-membership-stub';
      const forbidden = async (): Promise<never> => {
        downstreamCalls++;
        throw new Error('Unexpected downstream call');
      };
      try {
        await runPrivateChat(
          { projectSlug: input.projectId, userId: 'synthetic-outsider', question: input.question },
          {
            repository: localChatRepository({
              async lookupProjectMember() {
                membershipLookups++;
                return undefined;
              },
            }),
            embeddingProvider: { model: 'not-executed', dimensions: 1536, embedTexts: forbidden },
            provider: { complete: forbidden },
          },
        );
      } catch (error) {
        actualError = normalizeLocalChatError(error);
      }
    } else {
      const delayed = input.id === 'failure-timeout';
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      boundary = delayed ? 'workflow-stream-delayed-loopback' : 'workflow-stream-429-loopback';
      const server = createServer(async (request, response) => {
        requests++;
        for await (const _chunk of request) {
          /* Drain the local request before fault injection. */
        }
        if (request.url === '/api/workflows/private-chat-search/create-run') {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ runId: 'fault' }));
        } else if (!delayed) {
          response.writeHead(429);
          response.end();
        } else {
          timer = setTimeout(
            () => controller.abort(new DOMException('Local deadline', 'TimeoutError')),
            25,
          );
        }
      });
      server.listen(0, '127.0.0.1');
      try {
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing local address');
        try {
          await runPrivateChatSearchViaMastraWorkflow({
            env: { MASTRA_SERVER_URL: `http://127.0.0.1:${address.port}` },
            graphName: null,
            history: [],
            projectId: input.projectId,
            projectSlug: input.projectId,
            question: input.question,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
          });
        } catch (error) {
          actualError = normalizeLocalChatError(error);
        }
      } finally {
        clearTimeout(timer);
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
    observations.push({
      id: input.id,
      actualError,
      boundary,
      requests,
      membershipLookups,
      downstreamCalls,
      latencyMs: [performance.now() - start],
      scopePass: null,
      mutationPass: null,
      rubricPass: null,
    });
  }
  return {
    qualityGate: false as const,
    observations,
    unmeasured: [
      'Next-HTTP-authorization',
      'real-provider-quota',
      'remote-timeout',
      'GCP-stale-read',
    ],
  };
}
