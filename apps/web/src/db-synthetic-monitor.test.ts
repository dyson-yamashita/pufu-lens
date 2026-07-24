import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { MemoryObjectStorage } from '../../../packages/storage/src/testing.ts';
import { createPostgresSyntheticMonitorRepository } from './synthetic-monitor-repository.ts';
import { runSyntheticMonitorObservations } from './synthetic-monitor-service.ts';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for synthetic monitor database tests.');
}

const sql = postgres(databaseUrl, { max: 1 });

const projectAId = '64600000-0000-0000-0000-000000000001';
const projectBId = '64600000-0000-0000-0000-000000000002';
const userId = '64600000-0000-0000-0000-000000000010';
const dataSourceAId = '64600000-0000-0000-0000-000000000011';
const rawDocumentAId = '64600000-0000-0000-0000-000000000003';
const documentAId = '64600000-0000-0000-0000-000000000004';
const graphNameA = 'graph_issue_646_monitor_a';
const graphNameB = 'graph_issue_646_monitor_b';
const graphNodeId = 'document:issue-646-monitor';
const threadId = 'thread-646-monitor';
const messageId = 'message-646-monitor';

await main();

async function main() {
  try {
    await resetFixtureRows();
    await seedFixture();
    await assertSuccessfulObservationRoundTrip();
    await assertProjectBoundary();
    await assertReadonlyObservations();
    console.log('web synthetic monitor db tests passed');
  } finally {
    try {
      await resetFixtureRows();
    } finally {
      await sql.end();
    }
  }
}

async function assertSuccessfulObservationRoundTrip() {
  const repository = createPostgresSyntheticMonitorRepository(sql);
  const response = await runSyntheticMonitorObservations({
    allowedProjectSlugs: ['issue-646-monitor-a'],
    repository,
    storage: new MemoryObjectStorage(),
    request: {
      projectSlug: 'issue-646-monitor-a',
      sources: [
        {
          kind: 'gmail',
          threadId,
          expectedMessageId: messageId,
          expectedRelations: [{ type: 'SENT', minCount: 1 }],
        },
      ],
    },
  });
  const observation = response.observations[0];
  assert.equal(observation?.raw.status, 'ok');
  assert.equal(observation?.currentDocument.status, 'ok');
  assert.equal(observation?.chunks.status, 'ok');
  assert.equal(observation?.chunks.embeddingComplete, true);
  assert.equal(observation?.graph.status, 'ok');
  assert.equal(observation?.graph.documentNodePresent, true);
  assert.equal(observation?.graph.relations.SENT, 1);
  assert.equal(observation?.schedule?.status, 'ok');
  assert.equal(observation?.schedule?.enabled, true);
  assert.equal(observation?.schedule?.retryCount, 0);
  assert.equal(observation?.schedule?.nextRunDue, false);
  assert.equal(JSON.stringify(response).includes(threadId), false);
}

async function assertProjectBoundary() {
  const repository = createPostgresSyntheticMonitorRepository(sql);
  const response = await runSyntheticMonitorObservations({
    allowedProjectSlugs: ['issue-646-monitor-b'],
    repository,
    storage: new MemoryObjectStorage(),
    request: {
      projectSlug: 'issue-646-monitor-b',
      sources: [{ kind: 'gmail', threadId, expectedMessageId: messageId }],
    },
  });
  assert.equal(response.observations[0]?.raw.status, 'not_found');
  assert.equal(response.observations[0]?.graph.status, 'not_found');
}

async function assertReadonlyObservations() {
  const before = await readFixtureSnapshot();
  const repository = createPostgresSyntheticMonitorRepository(sql);
  await runSyntheticMonitorObservations({
    allowedProjectSlugs: ['issue-646-monitor-a'],
    repository,
    storage: new MemoryObjectStorage(),
    request: {
      projectSlug: 'issue-646-monitor-a',
      sources: [{ kind: 'gmail', threadId, expectedMessageId: messageId }],
    },
  });
  const after = await readFixtureSnapshot();
  assert.deepEqual(after, before);
}

async function readFixtureSnapshot() {
  const rawRows = (await sql`
    SELECT ingest_status AS "ingestStatus", source_version AS "sourceVersion"
    FROM public.raw_documents
    WHERE id = ${rawDocumentAId}::uuid
  `) as Array<{ ingestStatus: string; sourceVersion: string }>;
  const documentRows = (await sql`
    SELECT graph_node_id AS "graphNodeId"
    FROM public.documents
    WHERE id = ${documentAId}::uuid
  `) as Array<{ graphNodeId: string | null }>;
  const chunkRows = (await sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE embedding IS NOT NULL)::int AS "withEmbedding"
    FROM public.document_chunks
    WHERE project_id = ${projectAId}::uuid
      AND document_id = ${documentAId}::uuid
  `) as Array<{ total: number; withEmbedding: number }>;
  return {
    raw: rawRows[0] ?? null,
    document: documentRows[0] ?? null,
    chunks: chunkRows[0] ?? { total: 0, withEmbedding: 0 },
    graphNodeCount: await countGraphDocumentNode(graphNameA, graphNodeId),
    sentRelationCount: await countGraphRelation(graphNameA, graphNodeId, 'SENT'),
  };
}

async function seedFixture() {
  await sql`
    INSERT INTO public.users (id, email, name, role)
    VALUES (${userId}, 'issue-646-monitor@example.test', 'Issue 646 Monitor', 'admin')
  `;
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES
      (
        ${projectAId},
        'issue-646-monitor-a',
        'Issue 646 Monitor A',
        ${graphNameA},
        'issue-646-monitor-a',
        'private'
      ),
      (
        ${projectBId},
        'issue-646-monitor-b',
        'Issue 646 Monitor B',
        ${graphNameB},
        'issue-646-monitor-b',
        'private'
      )
  `;
  await sql`
    INSERT INTO public.data_sources (
      id, project_id, owner_user_id, source_type, name, config, ingest_window
    )
    VALUES (
      ${dataSourceAId}, ${projectAId}, ${userId}, 'gmail', 'Issue 646 Monitor Gmail',
      ${sql.json({ fixture: true })}, ${sql.json({})}
    )
  `;
  await sql`
    INSERT INTO public.raw_documents (
      id, project_id, source_type, source_id, logical_source_id, source_version,
      storage_uri, content_hash, ingest_status, fetched_at
    )
    VALUES (
      ${rawDocumentAId}, ${projectAId}, 'gmail', ${threadId}, ${threadId}, ${messageId},
      'raw/issue-646-monitor.json', 'issue-646-monitor-hash', 'indexed', now()
    )
  `;
  await sql`
    INSERT INTO public.raw_document_data_sources (
      raw_document_id, data_source_id, project_id
    )
    VALUES (${rawDocumentAId}, ${dataSourceAId}, ${projectAId})
  `;
  await sql`
    INSERT INTO public.data_source_schedules (
      project_id, data_source_id, enabled, next_run_at
    )
    VALUES (
      ${projectAId}, ${dataSourceAId}, true, '2099-01-01T01:00:00.000Z'::timestamptz
    )
  `;
  await sql`
    INSERT INTO public.documents (
      id, project_id, raw_document_id, doc_type, logical_source_id,
      title, summary, canonical_uri, graph_node_id
    )
    VALUES (
      ${documentAId}, ${projectAId}, ${rawDocumentAId}, 'email', ${threadId},
      'Issue 646 Monitor', 'fixture', 'mailto:issue-646-monitor@example.test', ${graphNodeId}
    )
  `;
  const embedding = [1, ...Array.from({ length: 1535 }, () => 0)];
  const vector = `[${embedding.join(',')}]`;
  await sql.unsafe(
    `INSERT INTO public.document_chunks (
      project_id, document_id, chunk_index, content, content_hash, embedding, embedding_model
    )
    VALUES ($1::uuid, $2::uuid, 0, 'fixture chunk', 'issue-646-monitor-chunk', $3::vector, 'gemini-test')`,
    [projectAId, documentAId, vector],
  );
  await ensureGraph(graphNameA);
  await runCypher(
    graphNameA,
    [
      'CREATE (doc:Document {graphNodeId: $graphNodeId})',
      'CREATE (peer:Document {graphNodeId: $peerGraphNodeId})',
      'CREATE (doc)-[:SENT]->(peer)',
    ].join(' '),
    {
      graphNodeId,
      peerGraphNodeId: 'document:issue-646-peer',
    },
  );
}

async function resetFixtureRows() {
  await deleteGraphIfExists(graphNameA);
  await deleteGraphIfExists(graphNameB);
  await sql`DELETE FROM public.document_chunks WHERE project_id IN (${projectAId}, ${projectBId})`;
  await sql`DELETE FROM public.documents WHERE project_id IN (${projectAId}, ${projectBId})`;
  await sql`DELETE FROM public.raw_document_data_sources WHERE project_id IN (${projectAId}, ${projectBId})`;
  await sql`DELETE FROM public.data_source_schedules WHERE project_id IN (${projectAId}, ${projectBId})`;
  await sql`DELETE FROM public.raw_documents WHERE project_id IN (${projectAId}, ${projectBId})`;
  await sql`DELETE FROM public.data_sources WHERE project_id IN (${projectAId}, ${projectBId})`;
  await sql`DELETE FROM public.projects WHERE id IN (${projectAId}, ${projectBId})`;
  await sql`DELETE FROM public.users WHERE id = ${userId}`;
}

async function ensureGraph(targetGraphName: string): Promise<void> {
  await sql`LOAD 'age'`;
  await sql`SET search_path = ag_catalog, "$user", public`;
  await sql.unsafe(
    `SELECT create_graph(${sqlString(targetGraphName)}) WHERE NOT EXISTS (
      SELECT 1 FROM ag_catalog.ag_graph WHERE name = ${sqlString(targetGraphName)}
    )`,
  );
}

async function deleteGraphIfExists(targetGraphName: string): Promise<void> {
  await sql`LOAD 'age'`;
  await sql`SET search_path = ag_catalog, "$user", public`;
  await sql.unsafe(
    `SELECT drop_graph(${sqlString(targetGraphName)}, true) WHERE EXISTS (
      SELECT 1 FROM ag_catalog.ag_graph WHERE name = ${sqlString(targetGraphName)}
    )`,
  );
}

async function runCypher(
  targetGraphName: string,
  cypher: string,
  params: Record<string, string>,
): Promise<void> {
  await sql`LOAD 'age'`;
  await sql`SET search_path = ag_catalog, "$user", public`;
  await sql.unsafe(
    `SELECT * FROM cypher(${sqlString(targetGraphName)}, ${dollarQuote(cypher)}, $1::agtype) AS (value agtype)`,
    [JSON.stringify(params)],
  );
}

async function countGraphDocumentNode(targetGraphName: string, nodeId: string): Promise<number> {
  const repository = createPostgresSyntheticMonitorRepository(sql);
  return repository.countGraphDocumentNode({ graphName: targetGraphName, graphNodeId: nodeId });
}

async function countGraphRelation(
  targetGraphName: string,
  nodeId: string,
  relationType: string,
): Promise<number> {
  const repository = createPostgresSyntheticMonitorRepository(sql);
  const counts = await repository.countGraphRelations({
    graphName: targetGraphName,
    graphNodeId: nodeId,
  });
  return counts[relationType] ?? 0;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function dollarQuote(value: string): string {
  const tag = `$pufu_${createHash('sha256').update(value).digest('hex')}$`;
  return `${tag}${value}${tag}`;
}
