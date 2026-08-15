import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ActivityPubActorNotFoundError,
  ActivityPubActorProfileError,
} from '@pufu-lens/activitypub';
import {
  ActivityPubProfileAdminError,
  mapActivityPubProfileAdminError,
  setAggregateActivityPubEnabled,
  updateAggregateActivityPubProfile,
  updateProjectActivityPubProfile,
} from './activitypub-profile-admin.ts';

test('mapActivityPubProfileAdminError maps validation failures safely', () => {
  const mapped = mapActivityPubProfileAdminError(
    new ActivityPubActorProfileError('Icon URL path is invalid.'),
  );
  assert.equal(mapped.code, 'invalid_profile');
  assert.equal(mapped.status, 400);
});

test('mapActivityPubProfileAdminError maps typed missing actor errors to 404', () => {
  const mapped = mapActivityPubProfileAdminError(new ActivityPubActorNotFoundError('aggregate'));
  assert.equal(mapped.code, 'actor_not_found');
  assert.equal(mapped.status, 404);
  assert.equal(mapped.message, 'ActivityPub actor was not found.');
});

test('mapActivityPubProfileAdminError keeps explicit forbidden errors at 403', () => {
  const mapped = mapActivityPubProfileAdminError(
    new ActivityPubProfileAdminError('forbidden', 'Global admin access is required.', 403),
  );
  assert.equal(mapped.code, 'forbidden');
  assert.equal(mapped.status, 403);
});

test('mapActivityPubProfileAdminError maps ordinary error messages to generic 500', () => {
  for (const message of [
    'Aggregate ActivityPub actor was not found.',
    'Global admin access is required.',
    'Project admin access is required.',
    'authentication failed',
  ]) {
    const mapped = mapActivityPubProfileAdminError(new Error(message));
    assert.equal(mapped.code, 'activitypub_internal_error');
    assert.equal(mapped.status, 500);
    assert.equal(mapped.message, 'An unexpected error occurred');
  }
});

test('updateAggregateActivityPubProfile rejects non-global admins before use cases run', async () => {
  const previousKey = process.env.ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY;
  delete process.env.ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY;
  try {
    await assert.rejects(
      () =>
        updateAggregateActivityPubProfile({
          sql: createNoGlobalAdminSql(),
          userId: 'user-1',
          displayName: 'All Projects',
        }),
      (error: unknown) =>
        error instanceof ActivityPubProfileAdminError &&
        error.code === 'forbidden' &&
        error.status === 403,
    );
  } finally {
    if (previousKey !== undefined) {
      process.env.ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY = previousKey;
    }
  }
});

test('setAggregateActivityPubEnabled rejects non-global admins before use cases run', async () => {
  const previousKey = process.env.ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY;
  delete process.env.ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY;
  try {
    await assert.rejects(
      () =>
        setAggregateActivityPubEnabled({
          sql: createNoGlobalAdminSql(),
          userId: 'user-1',
          enabled: true,
        }),
      (error: unknown) =>
        error instanceof ActivityPubProfileAdminError &&
        error.code === 'forbidden' &&
        error.status === 403,
    );
  } finally {
    if (previousKey !== undefined) {
      process.env.ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY = previousKey;
    }
  }
});

test('updateProjectActivityPubProfile rejects users without project or global admin access', async () => {
  const validKey = Buffer.alloc(32, 7).toString('base64');
  const previousKey = process.env.ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY;
  process.env.ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY = validKey;
  const { sql, getBeginCalls } = createProjectAccessSql({
    id: 'sample-project-id',
    slug: 'sample-project',
    appRole: 'member',
    projectRole: 'member',
  });
  try {
    await assert.rejects(
      () =>
        updateProjectActivityPubProfile({
          sql,
          userId: 'user-1',
          projectSlug: 'sample-project',
          displayName: 'Sample Project',
        }),
      (error: unknown) =>
        error instanceof ActivityPubProfileAdminError &&
        error.code === 'forbidden' &&
        error.status === 403,
    );
    assert.equal(getBeginCalls(), 0);
  } finally {
    if (previousKey !== undefined) {
      process.env.ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY = previousKey;
    } else {
      delete process.env.ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY;
    }
  }
});

test('updateProjectActivityPubProfile rejects project admins for a different project slug', async () => {
  const validKey = Buffer.alloc(32, 7).toString('base64');
  const previousKey = process.env.ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY;
  process.env.ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY = validKey;
  const { sql, getBeginCalls } = createProjectAccessSql({
    id: 'project-a-id',
    slug: 'project-a',
    appRole: 'member',
    projectRole: 'admin',
  });
  try {
    await assert.rejects(
      () =>
        updateProjectActivityPubProfile({
          sql,
          userId: 'user-1',
          projectSlug: 'project-b',
          displayName: 'Project B',
        }),
      (error: unknown) =>
        error instanceof ActivityPubProfileAdminError &&
        error.code === 'forbidden' &&
        error.status === 403,
    );
    assert.equal(getBeginCalls(), 0);
  } finally {
    if (previousKey !== undefined) {
      process.env.ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY = previousKey;
    } else {
      delete process.env.ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY;
    }
  }
});

function createNoGlobalAdminSql() {
  return Object.assign(
    async (strings: TemplateStringsArray) => {
      const query = String(strings[0] ?? '');
      if (query.includes('FROM public.users')) {
        return [];
      }
      throw new Error(`Unexpected SQL in test: ${query}`);
    },
    { begin: async () => [] },
  ) as never;
}

function createProjectAccessSql(access: {
  id: string;
  slug: string;
  appRole: 'admin' | 'member';
  projectRole: 'admin' | 'member';
}) {
  let beginCalls = 0;
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = String.raw({ raw: strings }, ...values);
      if (query.includes('FROM public.projects p')) {
        const requestedSlug = values.at(-1);
        if (requestedSlug !== access.slug) {
          return [];
        }
        return [
          {
            id: access.id,
            slug: access.slug,
            name: access.slug,
            description: null,
            graphName: `graph_${access.slug.replaceAll('-', '_')}`,
            settings: {},
            visibility: 'public',
            appRole: access.appRole,
            projectRole: access.projectRole,
          },
        ];
      }
      throw new Error(`Unexpected SQL in test: ${query}`);
    },
    {
      begin: async () => {
        beginCalls += 1;
        return [];
      },
    },
  ) as never;

  return { sql, getBeginCalls: () => beginCalls };
}
