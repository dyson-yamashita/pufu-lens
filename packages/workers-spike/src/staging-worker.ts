import { record } from './d1/binding.js';
import {
  createStagingComposition,
  type StagingEnv,
  validateStagingEnv,
} from './staging/composition.js';
import { fixture, fixtureSnapshot } from './staging/fixture.js';

/** Compares a bounded bearer header with the configured operator secret without provider access. */
async function authenticated(request: Request, token: string): Promise<boolean> {
  const header = request.headers.get('authorization') ?? '';
  if (header.length > 256) return false;
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const actual = await digest(header);
  const expected = await digest(`Bearer ${token}`);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
  return difference === 0;
}

/** Reads a tiny control message with a streaming byte cap, including bodies without Content-Length. */
async function control(request: Request) {
  if (!request.body) throw new Error('Missing control');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 1024) {
      await reader.cancel();
      throw new Error('Control too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const input = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (
    Object.keys(input).some((k) => !['operation', 'projectId', 'document', 'revision'].includes(k))
  )
    throw new Error('Unexpected control');
  if (
    typeof input.projectId !== 'string' ||
    typeof input.document !== 'number' ||
    typeof input.revision !== 'number'
  )
    throw new Error('Invalid control');
  fixtureSnapshot(input.projectId, input.document, input.revision);
  if (
    !['health', 'seed', 'graph', 'dispatch', 'repair', 'inspect', 'query'].includes(
      String(input.operation),
    )
  )
    throw new Error('Unknown operation');
  return {
    operation: input.operation,
    projectId: input.projectId,
    document: input.document,
    revision: input.revision,
  };
}

/** Authenticated synthetic-only evaluation entrypoint. Never exposes SQL, arbitrary content, URLs,
 * provider selection or application credentials. Deployment still requires explicit remote approval.
 */
export default {
  async fetch(request: Request, env: StagingEnv): Promise<Response> {
    const reply = (body: unknown, status = 200) =>
      Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/evaluate')
      return reply({ error: 'not_found' }, 404);
    try {
      validateStagingEnv(env);
    } catch {
      return reply({ error: 'unavailable' }, 503);
    }
    if (!(await authenticated(request, env.EVAL_TOKEN)))
      return reply({ error: 'unauthorized' }, 401);
    let input: Awaited<ReturnType<typeof control>>;
    try {
      input = await control(request);
    } catch {
      return reply({ error: 'invalid_control' }, 400);
    }
    try {
      const composition = await createStagingComposition(env);
      const { projectId, document, revision } = input;
      let result: unknown = null;
      switch (input.operation) {
        case 'seed':
          await composition.seed(projectId, document, revision);
          break;
        case 'graph':
          await composition.seedGraph(projectId);
          break;
        case 'dispatch':
          result = await composition.dispatch(projectId);
          break;
        case 'repair':
          result = await composition.repair(projectId, document, revision);
          break;
        case 'inspect':
          result = await composition.inspect(projectId, document);
          break;
        case 'query':
          result = await composition.query(projectId, document);
          break;
      }
      return reply({
        fixture: fixture.version,
        schema: fixture.schema,
        model: fixture.model,
        dimensions: 1536,
        result,
      });
    } catch {
      return reply({ error: 'unavailable' }, 503);
    }
  },
};
