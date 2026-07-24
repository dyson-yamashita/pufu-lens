import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import {
  BUILT_IN_PARSER_ARTIFACT_HASH,
  BUILT_IN_PARSER_VERSION,
  ensureBuiltInParserProfileForDataSource,
  ensureBuiltInParserProfilesForProjectScope,
  LEGACY_BUILT_IN_PARSER_VERSION,
} from '../../packages/ingestion/dist/index.js';

const databaseUrl = process.env.DATABASE_URL?.trim();

type ParserProfileState = {
  activeVersion: string | null;
  v1ArtifactHash: string | null;
  v2ArtifactHash: string | null;
};

const fixture = {
  approvedByUserId: '10000000-0000-0000-0000-000000000658',
  dataSourceId: '10000000-0000-0000-0000-000000000650',
  legacyProfileId: '10000000-0000-0000-0000-000000000651',
  legacyV1VersionId: '10000000-0000-0000-0000-000000000652',
  newDataSourceId: '10000000-0000-0000-0000-000000000653',
  otherDataSourceId: '10000000-0000-0000-0000-000000000654',
  otherProfileId: '10000000-0000-0000-0000-000000000655',
  otherV1VersionId: '10000000-0000-0000-0000-000000000656',
  projectId: '10000000-0000-0000-0000-000000000657',
  projectSlug: 'issue-649-parser-active-v2',
  userId: '10000000-0000-0000-0000-000000000658',
  legacyV1ArtifactHash: 'issue-649-legacy-v1-artifact-hash',
} as const;

test('ensureBuiltInParserProfileForDataSource activates v2 while keeping v1 artifact hash immutable', {
  skip: !databaseUrl,
}, async () => {
  const sql = postgres(databaseUrl as string, { max: 1 });
  try {
    await resetFixture(sql);
    await seedLegacyV1Profile(sql);

    await ensureBuiltInParserProfileForDataSource({
      approvedByUserId: fixture.approvedByUserId,
      dataSourceId: fixture.dataSourceId,
      managedBy: 'scripts/lib/built-in-parser-profiles-db.test.ts',
      projectId: fixture.projectId,
      sourceType: 'github',
      sql,
    });

    const state = await readParserProfileState(sql, fixture.legacyProfileId);
    assert.equal(state.activeVersion, BUILT_IN_PARSER_VERSION);
    assert.equal(state.v1ArtifactHash, fixture.legacyV1ArtifactHash);
    assert.equal(state.v2ArtifactHash, BUILT_IN_PARSER_ARTIFACT_HASH);
  } finally {
    try {
      await resetFixture(sql);
    } finally {
      await sql.end();
    }
  }
});

test('ensureBuiltInParserProfileForDataSource activates v2 for a newly created parser profile', {
  skip: !databaseUrl,
}, async () => {
  const sql = postgres(databaseUrl as string, { max: 1 });
  try {
    await resetFixture(sql);
    await seedProjectAndDataSources(sql);

    await ensureBuiltInParserProfileForDataSource({
      approvedByUserId: fixture.approvedByUserId,
      dataSourceId: fixture.newDataSourceId,
      managedBy: 'scripts/lib/built-in-parser-profiles-db.test.ts',
      projectId: fixture.projectId,
      sourceType: 'github',
      sql,
    });

    const profileId = await readProfileId(sql, fixture.newDataSourceId);
    const state = await readParserProfileState(sql, profileId);
    assert.equal(state.activeVersion, BUILT_IN_PARSER_VERSION);
    assert.equal(state.v1ArtifactHash, null);
    assert.equal(state.v2ArtifactHash, BUILT_IN_PARSER_ARTIFACT_HASH);
  } finally {
    try {
      await resetFixture(sql);
    } finally {
      await sql.end();
    }
  }
});

test('ensureBuiltInParserProfilesForProjectScope only updates the requested data source', {
  skip: !databaseUrl,
}, async () => {
  const sql = postgres(databaseUrl as string, { max: 1 });
  try {
    await resetFixture(sql);
    await seedProjectAndDataSources(sql);
    await seedLegacyV1Profile(sql);
    await seedOtherLegacyV1Profile(sql);

    await ensureBuiltInParserProfilesForProjectScope({
      approvedByUserId: fixture.approvedByUserId,
      dataSourceId: fixture.dataSourceId,
      managedBy: 'scripts/lib/built-in-parser-profiles-db.test.ts',
      projectSlug: fixture.projectSlug,
      sourceType: 'github',
      sql,
    });

    const targeted = await readParserProfileState(sql, fixture.legacyProfileId);
    const untouched = await readParserProfileState(sql, fixture.otherProfileId);

    assert.equal(targeted.activeVersion, BUILT_IN_PARSER_VERSION);
    assert.equal(targeted.v1ArtifactHash, fixture.legacyV1ArtifactHash);
    assert.equal(untouched.activeVersion, LEGACY_BUILT_IN_PARSER_VERSION);
    assert.equal(untouched.v1ArtifactHash, 'issue-649-other-v1-artifact-hash');
    assert.equal(untouched.v2ArtifactHash, null);
  } finally {
    try {
      await resetFixture(sql);
    } finally {
      await sql.end();
    }
  }
});

async function seedProjectAndDataSources(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO public.users (id, email, name, role)
    VALUES (${fixture.userId}, 'issue-649-parser@example.test', 'Issue 649 Parser', 'admin')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES (
      ${fixture.projectId},
      ${fixture.projectSlug},
      'Issue 649 Parser Active v2',
      'graph_issue_649_parser_active_v2',
      'issue-649-parser-active-v2',
      'private'
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.data_sources (
      id, project_id, owner_user_id, source_type, name, config, enabled
    )
    VALUES
      (
        ${fixture.dataSourceId},
        ${fixture.projectId},
        ${fixture.userId},
        'github',
        'Issue 649 Legacy GitHub',
        ${sql.json({ repository: 'example-org/pufu-sample' })},
        true
      ),
      (
        ${fixture.newDataSourceId},
        ${fixture.projectId},
        ${fixture.userId},
        'github',
        'Issue 649 New GitHub',
        ${sql.json({ repository: 'example-org/pufu-new' })},
        true
      ),
      (
        ${fixture.otherDataSourceId},
        ${fixture.projectId},
        ${fixture.userId},
        'github',
        'Issue 649 Other GitHub',
        ${sql.json({ repository: 'example-org/pufu-other' })},
        true
      )
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedLegacyV1Profile(sql: postgres.Sql): Promise<void> {
  await seedProjectAndDataSources(sql);
  await sql`
    INSERT INTO public.parser_profiles (
      id, project_id, data_source_id, source_type, name, active_version_id, metadata
    )
    VALUES (
      ${fixture.legacyProfileId},
      ${fixture.projectId},
      ${fixture.dataSourceId},
      'github',
      'Built-in github parser',
      NULL,
      ${sql.json({ managedBy: 'fixture' })}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.parser_versions (
      id,
      parser_profile_id,
      version,
      schema_version,
      artifact_hash,
      contract,
      status,
      approved_by_user_id,
      approved_at
    )
    VALUES (
      ${fixture.legacyV1VersionId},
      ${fixture.legacyProfileId},
      ${LEGACY_BUILT_IN_PARSER_VERSION},
      1,
      ${fixture.legacyV1ArtifactHash},
      ${sql.json({ requiredPaths: ['kind', 'repository', 'number', 'title', 'html_url', 'created_at'] })},
      'approved',
      ${fixture.approvedByUserId},
      now()
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    UPDATE public.parser_profiles
    SET active_version_id = ${fixture.legacyV1VersionId}
    WHERE id = ${fixture.legacyProfileId}
  `;
}

async function seedOtherLegacyV1Profile(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO public.parser_profiles (
      id, project_id, data_source_id, source_type, name, active_version_id, metadata
    )
    VALUES (
      ${fixture.otherProfileId},
      ${fixture.projectId},
      ${fixture.otherDataSourceId},
      'github',
      'Built-in github parser',
      NULL,
      ${sql.json({ managedBy: 'fixture' })}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.parser_versions (
      id,
      parser_profile_id,
      version,
      schema_version,
      artifact_hash,
      contract,
      status,
      approved_by_user_id,
      approved_at
    )
    VALUES (
      ${fixture.otherV1VersionId},
      ${fixture.otherProfileId},
      ${LEGACY_BUILT_IN_PARSER_VERSION},
      1,
      'issue-649-other-v1-artifact-hash',
      ${sql.json({ requiredPaths: ['kind', 'repository', 'number', 'title', 'html_url', 'created_at'] })},
      'approved',
      ${fixture.approvedByUserId},
      now()
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    UPDATE public.parser_profiles
    SET active_version_id = ${fixture.otherV1VersionId}
    WHERE id = ${fixture.otherProfileId}
  `;
}

async function readProfileId(sql: postgres.Sql, dataSourceId: string): Promise<string> {
  const rows = await sql`
    SELECT id::text AS id
    FROM public.parser_profiles
    WHERE project_id = ${fixture.projectId}
      AND data_source_id = ${dataSourceId}
      AND source_type = 'github'
      AND name = 'Built-in github parser'
  `;
  return parseProfileIdRow(rows);
}

async function readParserProfileState(
  sql: postgres.Sql,
  profileId: string,
): Promise<ParserProfileState> {
  const rows = await sql`
    SELECT
      active.version AS "activeVersion",
      v1.artifact_hash AS "v1ArtifactHash",
      v2.artifact_hash AS "v2ArtifactHash"
    FROM public.parser_profiles pp
    LEFT JOIN public.parser_versions active ON active.id = pp.active_version_id
    LEFT JOIN public.parser_versions v1
      ON v1.parser_profile_id = pp.id
      AND v1.version = ${LEGACY_BUILT_IN_PARSER_VERSION}
    LEFT JOIN public.parser_versions v2
      ON v2.parser_profile_id = pp.id
      AND v2.version = ${BUILT_IN_PARSER_VERSION}
    WHERE pp.id = ${profileId}
  `;
  return parseParserProfileStateRow(rows);
}

function parseProfileIdRow(rows: readonly unknown[]): string {
  const row = rows[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('Invalid parser profile id row.');
  }
  const id = (row as { id?: unknown }).id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('Invalid parser profile id row.');
  }
  return id;
}

function parseParserProfileStateRow(rows: readonly unknown[]): ParserProfileState {
  const row = rows[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('Invalid parser profile state row.');
  }
  const record = row as {
    activeVersion?: unknown;
    v1ArtifactHash?: unknown;
    v2ArtifactHash?: unknown;
  };
  return {
    activeVersion: parseNullableStringField(record.activeVersion, 'activeVersion'),
    v1ArtifactHash: parseNullableStringField(record.v1ArtifactHash, 'v1ArtifactHash'),
    v2ArtifactHash: parseNullableStringField(record.v2ArtifactHash, 'v2ArtifactHash'),
  };
}

function parseNullableStringField(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Invalid parser profile state field: ${fieldName}`);
  }
  return value;
}

async function resetFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    DELETE FROM public.parser_versions
    WHERE parser_profile_id IN (
      SELECT id
      FROM public.parser_profiles
      WHERE project_id = ${fixture.projectId}
    )
  `;
  await sql`
    DELETE FROM public.parser_profiles
    WHERE project_id = ${fixture.projectId}
  `;
  await sql`
    DELETE FROM public.data_sources
    WHERE project_id = ${fixture.projectId}
  `;
  await sql`
    DELETE FROM public.projects
    WHERE id = ${fixture.projectId}
  `;
  await sql`
    DELETE FROM public.users
    WHERE id = ${fixture.userId}
  `;
}
