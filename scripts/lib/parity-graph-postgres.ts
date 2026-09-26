import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPostgresRelationalGraphMutationRepository } from '@pufu-lens/graph/postgres-relational-mutation';
import { createPostgresRelationalGraphReadRepository } from '@pufu-lens/graph/postgres-relational-read';
import postgres from 'postgres';
import { validateKeywordEvalUrl } from './keyword-eval-local.ts';
import { collectGraphParity, parseGraphState } from './parity-graph.ts';

const projects = {
  alpha: '80000000-0000-0000-0000-000000000001',
  beta: '80000000-0000-0000-0000-000000000002',
};
function projectId(id: string) {
  if (id !== 'alpha' && id !== 'beta') throw new Error('Unknown local graph project');
  return projects[id];
}

/** Runs production relational adapters in an exclusively created disposable loopback database.
 * Requires CREATEDB on the existing keyword_eval connection. Never reuses/drops an existing DB;
 * creation collision fails, and only a DB successfully created by this invocation is cleaned up.
 */
export async function collectPostgresGraphParity(databaseUrl: string) {
  validateKeywordEvalUrl(databaseUrl);
  const admin = postgres(databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  const name = `parity_graph_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  let sql: postgres.Sql | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    const url = new URL(databaseUrl);
    url.pathname = `/${name}`;
    sql = postgres(url.toString(), {
      max: 1,
      connect_timeout: 10,
      onnotice: () => {},
      connection: { statement_timeout: 10000 },
    });
    await sql`CREATE TABLE public.projects (id uuid PRIMARY KEY)`;
    await sql.unsafe(
      await readFile(
        new URL('../../infra/db/migrations/0026_relational_graph_schema.sql', import.meta.url),
        'utf8',
      ),
    );
    await sql`INSERT INTO public.projects (id) VALUES (${projects.alpha}), (${projects.beta})`;
    const mutation = createPostgresRelationalGraphMutationRepository(sql);
    const read = createPostgresRelationalGraphReadRepository(sql, { strictUnavailable: true });
    const connection = sql;
    return await collectGraphParity({
      mutation: {
        ensureProjectGraph: (input) =>
          mutation.ensureProjectGraph({ ...input, projectId: projectId(input.projectId) }),
        deleteProjectGraph: (input) =>
          mutation.deleteProjectGraph({ ...input, projectId: projectId(input.projectId) }),
        upsertNode: (input) =>
          mutation.upsertNode({ ...input, projectId: projectId(input.projectId) }),
        upsertEdge: (input) =>
          mutation.upsertEdge({ ...input, projectId: projectId(input.projectId) }),
        deleteDocumentGraphNodes: (input) =>
          mutation.deleteDocumentGraphNodes({ ...input, projectId: projectId(input.projectId) }),
        mergeActorGraphNodes: (input) =>
          mutation.mergeActorGraphNodes({ ...input, projectId: projectId(input.projectId) }),
      },
      read: {
        findRelatedDocuments: (input) =>
          read.findRelatedDocuments({ ...input, projectId: projectId(input.projectId) }),
      },
      async snapshot(id) {
        const normalize = (values: readonly unknown[]) =>
          values.map((value) => {
            if (
              !value ||
              typeof value !== 'object' ||
              !('project_id' in value) ||
              typeof value.project_id !== 'string'
            )
              throw new Error('Invalid persisted project');
            const entry = Object.entries(projects).find(([, uuid]) => uuid === value.project_id);
            return { ...value, project_id: entry?.[0] ?? value.project_id };
          });
        const nodes: readonly unknown[] =
          await connection`SELECT project_id, node_key, kind, subtype, properties FROM public.graph_nodes WHERE project_id=${projectId(id)}`;
        const edges: readonly unknown[] =
          await connection`SELECT project_id, source_node_key, target_node_key, relation_type, properties FROM public.graph_edges WHERE project_id=${projectId(id)}`;
        return parseGraphState(normalize(nodes), normalize(edges));
      },
    });
  } finally {
    try {
      if (sql) await sql.end();
      if (created) await admin.unsafe(`DROP DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
  }
}
