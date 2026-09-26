import type { StagingEnv } from './staging/composition.js';
import staging from './staging-worker.js';

/** Local test transport only. Never deploy this harness or treat its fake as a remote Vectorize API. */
export default {
  async fetch(request: Request, env: StagingEnv): Promise<Response> {
    const fake = async (method: string, args: unknown) => {
      const response = await fetch(`https://vectorize-fake.invalid/${method}`, {
        method: 'POST',
        body: JSON.stringify(args),
      });
      if (!response.ok) throw new Error('Fake unavailable');
      return response.json();
    };
    return staging.fetch(request, {
      ...env,
      VECTORIZE: {
        describe: () => fake('describe', {}),
        query: (values, options) => fake('query', { values, options }),
        upsert: (vectors) => fake('upsert', vectors),
        deleteByIds: (ids) => fake('delete', ids),
      },
    });
  },
};
