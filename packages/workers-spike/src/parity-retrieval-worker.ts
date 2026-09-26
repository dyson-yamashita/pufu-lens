import type { D1Binding } from './d1/binding.js';
import graph from './d1-worker.js';
import keyword from './keyword-worker.js';
import document from './parity-document-worker.js';
import semantic from './semantic-worker.js';

/** Local-only routing for shared-fixture adapter tests on one real D1 binding; never deploy. */
export default {
  fetch(request: Request, env: { DB: D1Binding }): Promise<Response> {
    if (new URL(request.url).pathname === '/graph') return graph.fetch(request, env);
    if (new URL(request.url).pathname === '/document') return document.fetch(request, env);
    return new URL(request.url).pathname === '/keyword'
      ? keyword.fetch(request, env)
      : semantic.fetch(request, env);
  },
};
