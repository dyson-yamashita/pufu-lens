import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { executeActorMerge } from './actor-merge-use-case.ts';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for actor merge database tests.');
}

const sql = postgres(databaseUrl, { max: 1 });

const projectId = '10000000-0000-0000-0000-000000000611';
const userId = '10000000-0000-0000-0000-000000000612';
const primaryActorId = '10000000-0000-0000-0000-000000000613';
const secondaryActorId = '10000000-0000-0000-0000-000000000614';
const sharedDocumentId = '10000000-0000-0000-0000-000000000615';
const secondaryOnlyDocumentId = '10000000-0000-0000-0000-000000000616';
const sharedRawDocumentId = '10000000-0000-0000-0000-000000000617';
const secondaryOnlyRawDocumentId = '10000000-0000-0000-0000-000000000618';
const secondaryAliasId = '10000000-0000-0000-0000-000000000619';
const secondaryEmailQuoteId = '10000000-0000-0000-0000-000000000620';

const rollbackProjectId = '10000000-0000-0000-0000-000000000621';
const rollbackUserId = '10000000-0000-0000-0000-000000000622';
const rollbackPrimaryActorId = '10000000-0000-0000-0000-000000000623';
const rollbackSecondaryActorId = '10000000-0000-0000-0000-000000000624';
const rollbackAliasId = '10000000-0000-0000-0000-000000000625';
const rollbackRawDocumentId = '10000000-0000-0000-0000-000000000626';
const rollbackDocumentId = '10000000-0000-0000-0000-000000000627';
const rollbackEmailQuoteId = '10000000-0000-0000-0000-000000000628';

const graphName = 'graph_issue_611_actor_merge';
const rollbackGraphName = 'graph_issue_611_actor_merge_rb';

const primaryGraphNodeId = 'actor:issue-611-primary';
const secondaryGraphNodeId = 'actor:issue-611-secondary';
const sharedDocumentGraphNodeId = 'document:issue-611-shared';
const secondaryOnlyDocumentGraphNodeId = 'document:issue-611-secondary-only';

const rollbackPrimaryGraphNodeId = 'actor:issue-611-rollback-primary';
const rollbackSecondaryGraphNodeId = 'actor:issue-611-rollback-secondary';
const rollbackDocumentGraphNodeId = 'document:issue-611-rollback';

await main();

async function main() {
  try {
    assertParseAgtypeMap();
    await resetFixtureRows();
    await assertSuccessfulActorMerge();
    await resetFixtureRows();
    await assertActorMergeRollbackOnGraphFailure();
    console.log('web actor merge db tests passed');
  } finally {
    try {
      await resetFixtureRows();
    } finally {
      await sql.end();
    }
  }
}

async function assertSuccessfulActorMerge() {
  await seedSuccessFixture();
  await seedSuccessGraph();

  await sql.begin(async (tx) => {
    await executeActorMerge(tx, {
      adminUserId: userId,
      graphName,
      primaryActorId,
      projectId,
      reason: 'issue-611 integration',
      secondaryActorId,
    });
  });

  const secondaryActor = await readActor(secondaryActorId);
  assert.equal(secondaryActor.status, 'merged');
  assert.equal(secondaryActor.mergedIntoActorId, primaryActorId);

  const aliasActorId = await readAliasActorId(secondaryAliasId);
  assert.equal(aliasActorId, primaryActorId);

  const quoteSenderActorId = await readEmailQuoteSenderActorId(secondaryEmailQuoteId);
  assert.equal(quoteSenderActorId, primaryActorId);

  const decisionCount = await countMergeDecisions(projectId, primaryActorId, secondaryActorId);
  assert.equal(decisionCount, 1);

  assert.equal(await countGraphNode(graphName, secondaryGraphNodeId), 0);
  assert.equal(await countGraphNode(graphName, primaryGraphNodeId), 1);

  const sharedEdge = await readOutgoingEdgeProperties({
    edgeType: 'AUTHORED',
    graphName,
    sourceGraphNodeId: primaryGraphNodeId,
    targetGraphNodeId: sharedDocumentGraphNodeId,
  });
  assert.equal(sharedEdge.actorId, primaryActorId);
  assert.equal(sharedEdge.weight, 42);

  const migratedEdge = await readOutgoingEdgeProperties({
    edgeType: 'SENT',
    graphName,
    sourceGraphNodeId: primaryGraphNodeId,
    targetGraphNodeId: secondaryOnlyDocumentGraphNodeId,
  });
  assert.equal(migratedEdge.actorId, primaryActorId);
  assert.equal(migratedEdge.channel, 'secondary-only');
}

async function assertActorMergeRollbackOnGraphFailure() {
  await seedRollbackFixture();
  await seedRollbackGraphWithoutPrimary();

  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await executeActorMerge(tx, {
          adminUserId: rollbackUserId,
          graphName: rollbackGraphName,
          primaryActorId: rollbackPrimaryActorId,
          projectId: rollbackProjectId,
          reason: 'issue-611 rollback',
          secondaryActorId: rollbackSecondaryActorId,
        });
      }),
    /expected 1 primary actor graph node, found 0/,
  );

  const secondaryActor = await readActor(rollbackSecondaryActorId);
  assert.equal(secondaryActor.status, 'active');
  assert.equal(secondaryActor.mergedIntoActorId, null);

  const aliasActorId = await readAliasActorId(rollbackAliasId);
  assert.equal(aliasActorId, rollbackSecondaryActorId);

  const quoteSenderActorId = await readEmailQuoteSenderActorId(rollbackEmailQuoteId);
  assert.equal(quoteSenderActorId, rollbackSecondaryActorId);

  const decisionCount = await countMergeDecisions(
    rollbackProjectId,
    rollbackPrimaryActorId,
    rollbackSecondaryActorId,
  );
  assert.equal(decisionCount, 0);

  assert.equal(await countGraphNode(rollbackGraphName, rollbackSecondaryGraphNodeId), 1);
}

async function seedSuccessFixture() {
  await sql`
    INSERT INTO public.users (id, email, name, role)
    VALUES (${userId}, 'issue-611-owner@example.test', 'Issue 611 Owner', 'admin')
  `;
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES (
      ${projectId},
      'issue-611-actor-merge',
      'Issue 611 Actor Merge',
      ${graphName},
      'issue-611-actor-merge',
      'private'
    )
  `;
  await sql`
    INSERT INTO public.actors (
      id, project_id, display_name, graph_node_id, status
    )
    VALUES
      (
        ${primaryActorId}, ${projectId}, 'Primary Actor', ${primaryGraphNodeId}, 'active'
      ),
      (
        ${secondaryActorId}, ${projectId}, 'Secondary Actor', ${secondaryGraphNodeId}, 'active'
      )
  `;
  await sql`
    INSERT INTO public.actor_aliases (
      id, project_id, actor_id, alias_type, alias_value
    )
    VALUES (
      ${secondaryAliasId}, ${projectId}, ${secondaryActorId}, 'email', 'secondary@example.test'
    )
  `;
  await sql`
    INSERT INTO public.raw_documents (
      id, project_id, source_type, source_id, logical_source_id, source_version,
      storage_uri, content_hash, ingest_status
    )
    VALUES
      (
        ${sharedRawDocumentId}, ${projectId}, 'web', 'issue-611-shared', 'issue-611-shared',
        'issue-611-shared-v1', 'raw/issue-611-shared.json', 'issue-611-shared-hash', 'indexed'
      ),
      (
        ${secondaryOnlyRawDocumentId}, ${projectId}, 'web', 'issue-611-secondary-only',
        'issue-611-secondary-only', 'issue-611-secondary-only-v1',
        'raw/issue-611-secondary-only.json', 'issue-611-secondary-only-hash', 'indexed'
      )
  `;
  await sql`
    INSERT INTO public.documents (
      id, project_id, raw_document_id, doc_type, logical_source_id,
      title, summary, canonical_uri, graph_node_id
    )
    VALUES
      (
        ${sharedDocumentId}, ${projectId}, ${sharedRawDocumentId}, 'web_page', 'issue-611-shared',
        'Shared Document', 'shared fixture', 'https://example.test/issue-611-shared',
        ${sharedDocumentGraphNodeId}
      ),
      (
        ${secondaryOnlyDocumentId}, ${projectId}, ${secondaryOnlyRawDocumentId}, 'web_page',
        'issue-611-secondary-only', 'Secondary Only Document', 'secondary-only fixture',
        'https://example.test/issue-611-secondary-only', ${secondaryOnlyDocumentGraphNodeId}
      )
  `;
  await sql`
    INSERT INTO public.email_quotes (
      id, project_id, document_id, quote_index, sender_actor_id, body
    )
    VALUES (
      ${secondaryEmailQuoteId}, ${projectId}, ${sharedDocumentId}, 0, ${secondaryActorId},
      'secondary quote fixture'
    )
  `;
}

async function seedSuccessGraph() {
  await ensureGraph(graphName);
  await runCypher(
    graphName,
    [
      'CREATE (primary {graphNodeId: $primaryGraphNodeId})',
      'CREATE (secondary {graphNodeId: $secondaryGraphNodeId})',
      'CREATE (sharedDoc {graphNodeId: $sharedDocumentGraphNodeId})',
      'CREATE (secondaryOnlyDoc {graphNodeId: $secondaryOnlyDocumentGraphNodeId})',
      'CREATE (primary)-[:AUTHORED {actorId: $primaryActorId, weight: 42}]->(sharedDoc)',
      'CREATE (secondary)-[:AUTHORED {actorId: $secondaryActorId, weight: 7}]->(sharedDoc)',
      'CREATE (secondary)-[:SENT {actorId: $secondaryActorId, channel: $secondaryChannel}]->(secondaryOnlyDoc)',
    ].join(' '),
    {
      primaryActorId,
      primaryGraphNodeId,
      secondaryActorId,
      secondaryChannel: 'secondary-only',
      secondaryGraphNodeId,
      secondaryOnlyDocumentGraphNodeId,
      sharedDocumentGraphNodeId,
    },
  );
}

async function seedRollbackFixture() {
  await sql`
    INSERT INTO public.users (id, email, name, role)
    VALUES (${rollbackUserId}, 'issue-611-rollback@example.test', 'Issue 611 Rollback', 'admin')
  `;
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES (
      ${rollbackProjectId},
      'issue-611-actor-merge-rollback',
      'Issue 611 Actor Merge Rollback',
      ${rollbackGraphName},
      'issue-611-actor-merge-rollback',
      'private'
    )
  `;
  await sql`
    INSERT INTO public.actors (
      id, project_id, display_name, graph_node_id, status
    )
    VALUES
      (
        ${rollbackPrimaryActorId}, ${rollbackProjectId}, 'Rollback Primary',
        ${rollbackPrimaryGraphNodeId}, 'active'
      ),
      (
        ${rollbackSecondaryActorId}, ${rollbackProjectId}, 'Rollback Secondary',
        ${rollbackSecondaryGraphNodeId}, 'active'
      )
  `;
  await sql`
    INSERT INTO public.actor_aliases (
      id, project_id, actor_id, alias_type, alias_value
    )
    VALUES (
      ${rollbackAliasId}, ${rollbackProjectId}, ${rollbackSecondaryActorId}, 'email',
      'rollback-secondary@example.test'
    )
  `;
  await sql`
    INSERT INTO public.raw_documents (
      id, project_id, source_type, source_id, logical_source_id, source_version,
      storage_uri, content_hash, ingest_status
    )
    VALUES (
      ${rollbackRawDocumentId}, ${rollbackProjectId}, 'web', 'issue-611-rollback',
      'issue-611-rollback', 'issue-611-rollback-v1', 'raw/issue-611-rollback.json',
      'issue-611-rollback-hash', 'indexed'
    )
  `;
  await sql`
    INSERT INTO public.documents (
      id, project_id, raw_document_id, doc_type, logical_source_id,
      title, summary, canonical_uri, graph_node_id
    )
    VALUES (
      ${rollbackDocumentId}, ${rollbackProjectId}, ${rollbackRawDocumentId}, 'web_page',
      'issue-611-rollback', 'Rollback Document', 'rollback fixture',
      'https://example.test/issue-611-rollback', ${rollbackDocumentGraphNodeId}
    )
  `;
  await sql`
    INSERT INTO public.email_quotes (
      id, project_id, document_id, quote_index, sender_actor_id, body
    )
    VALUES (
      ${rollbackEmailQuoteId}, ${rollbackProjectId}, ${rollbackDocumentId}, 0,
      ${rollbackSecondaryActorId}, 'rollback quote fixture'
    )
  `;
}

async function seedRollbackGraphWithoutPrimary() {
  await ensureGraph(rollbackGraphName);
  await runCypher(
    rollbackGraphName,
    'CREATE (secondary {graphNodeId: $secondaryGraphNodeId}) RETURN secondary',
    { secondaryGraphNodeId: rollbackSecondaryGraphNodeId },
  );
}

async function resetFixtureRows() {
  await deleteGraphIfExists(graphName);
  await deleteGraphIfExists(rollbackGraphName);

  await sql`DELETE FROM public.actor_merge_decisions WHERE project_id IN (${projectId}, ${rollbackProjectId})`;
  await sql`DELETE FROM public.email_quotes WHERE project_id IN (${projectId}, ${rollbackProjectId})`;
  await sql`DELETE FROM public.actor_aliases WHERE project_id IN (${projectId}, ${rollbackProjectId})`;
  await sql`DELETE FROM public.documents WHERE project_id IN (${projectId}, ${rollbackProjectId})`;
  await sql`DELETE FROM public.raw_documents WHERE project_id IN (${projectId}, ${rollbackProjectId})`;
  await sql`DELETE FROM public.actors WHERE project_id IN (${projectId}, ${rollbackProjectId})`;
  await sql`DELETE FROM public.projects WHERE id IN (${projectId}, ${rollbackProjectId})`;
  await sql`DELETE FROM public.users WHERE id IN (${userId}, ${rollbackUserId})`;
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

async function countGraphNode(targetGraphName: string, graphNodeId: string): Promise<number> {
  await sql`LOAD 'age'`;
  await sql`SET search_path = ag_catalog, "$user", public`;
  const rows = (await sql.unsafe(
    `SELECT * FROM cypher(${sqlString(targetGraphName)}, ${dollarQuote(
      'MATCH (node {graphNodeId: $graphNodeId}) RETURN count(node) AS nodeCount',
    )}, $1::agtype) AS (value agtype)`,
    [JSON.stringify({ graphNodeId })],
  )) as readonly unknown[];
  return parseAgeCount(rows);
}

async function readOutgoingEdgeProperties(input: {
  readonly edgeType: string;
  readonly graphName: string;
  readonly sourceGraphNodeId: string;
  readonly targetGraphNodeId: string;
}): Promise<Record<string, string | number>> {
  await sql`LOAD 'age'`;
  await sql`SET search_path = ag_catalog, "$user", public`;
  const rows = (await sql.unsafe(
    `SELECT * FROM cypher(${sqlString(input.graphName)}, ${dollarQuote(
      [
        'MATCH (source {graphNodeId: $sourceGraphNodeId})',
        `-[relation:${input.edgeType}]->`,
        '(target {graphNodeId: $targetGraphNodeId})',
        'RETURN properties(relation) AS edgeProperties',
      ].join(' '),
    )}, $1::agtype) AS (edgeProperties agtype)`,
    [
      JSON.stringify({
        sourceGraphNodeId: input.sourceGraphNodeId,
        targetGraphNodeId: input.targetGraphNodeId,
      }),
    ],
  )) as readonly unknown[];
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row && typeof row === 'object' && !Array.isArray(row));
  const edgeProperties = Reflect.get(row, 'edgeproperties') ?? Reflect.get(row, 'edgeProperties');
  return parseAgtypeMap(edgeProperties);
}

async function readActor(actorId: string): Promise<{
  readonly mergedIntoActorId: string | null;
  readonly status: string;
}> {
  const rows = (await sql`
    SELECT
      status,
      merged_into_actor_id::text AS "mergedIntoActorId"
    FROM public.actors
    WHERE id = ${actorId}
  `) as readonly unknown[];
  const row = singleRow(rows);
  const status = stringField(row, 'status');
  const mergedIntoActorId = row.mergedIntoActorId;
  return {
    mergedIntoActorId: typeof mergedIntoActorId === 'string' ? mergedIntoActorId : null,
    status,
  };
}

async function readAliasActorId(aliasId: string): Promise<string> {
  const rows = (await sql`
    SELECT actor_id::text AS "actorId"
    FROM public.actor_aliases
    WHERE id = ${aliasId}
  `) as readonly unknown[];
  return stringField(singleRow(rows), 'actorId');
}

async function readEmailQuoteSenderActorId(quoteId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT sender_actor_id::text AS "senderActorId"
    FROM public.email_quotes
    WHERE id = ${quoteId}
  `) as readonly unknown[];
  const row = singleRow(rows);
  const senderActorId = row.senderActorId;
  return typeof senderActorId === 'string' ? senderActorId : null;
}

async function countMergeDecisions(
  projectIdToCount: string,
  primaryId: string,
  secondaryId: string,
): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS count
    FROM public.actor_merge_decisions
    WHERE project_id = ${projectIdToCount}
      AND primary_actor_id = ${primaryId}
      AND secondary_actor_id = ${secondaryId}
      AND decision_type = 'merge'
  `) as readonly unknown[];
  const count = singleRow(rows).count;
  if (typeof count === 'number') {
    return count;
  }
  if (typeof count === 'string' && /^\d+$/.test(count)) {
    return Number(count);
  }
  throw new Error('Expected merge decision count to be numeric.');
}

function parseAgeCount(rows: readonly unknown[]): number {
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row && typeof row === 'object' && !Array.isArray(row));
  const value = Reflect.get(row, 'value');
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  throw new Error('Expected AGE count row.');
}

function assertParseAgtypeMap(): void {
  assert.deepEqual(parseAgtypeMap('{"actorId":"primary","weight":42}'), {
    actorId: 'primary',
    weight: 42,
  });
  for (const invalidJson of ['null', '[]', '"scalar"', '1', 'true']) {
    assert.throws(() => parseAgtypeMap(invalidJson), /Expected AGE edge properties map\./);
  }
}

function parseAgtypeMap(value: unknown): Record<string, string | number> {
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      throw new Error('Expected AGE edge properties map.');
    }
    return normalizeAgtypeMap(parsed);
  }
  if (isRecord(value)) {
    return normalizeAgtypeMap(value);
  }
  throw new Error('Expected AGE edge properties map.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeAgtypeMap(value: Record<string, unknown>): Record<string, string | number> {
  const normalized: Record<string, string | number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' || typeof entry === 'number') {
      normalized[key] = entry;
      continue;
    }
    throw new Error(`Unexpected AGE property value for ${key}.`);
  }
  return normalized;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function dollarQuote(value: string): string {
  const tag = `$pufu_${createHash('sha256').update(value).digest('hex')}$`;
  return `${tag}${value}${tag}`;
}

function singleRow(rows: readonly unknown[]): Record<string, unknown> {
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row && typeof row === 'object' && !Array.isArray(row));
  return row as Record<string, unknown>;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected ${key} to be a string.`);
  }
  return value;
}
