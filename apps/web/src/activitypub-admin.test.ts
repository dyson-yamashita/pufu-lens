import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityPubProjectNotPublicError, type ActivityPubUseCases } from '@pufu-lens/activitypub';
import type { ActivityPubActor } from '@pufu-lens/activitypub/schema';
import {
  ActivityPubAdminError,
  mapActivityPubAdminError,
  parseProjectFederationRequest,
  patchProjectFederation,
} from './activitypub-admin.ts';

const encryptionKey = Buffer.alloc(32, 4);
const projectId = '10000000-0000-0000-0000-000000000001';
const projectSlug = 'sample-project';
const actor: ActivityPubActor = {
  id: 'a0000000-0000-0000-0000-000000000001',
  projectId,
  kind: 'project',
  preferredUsername: projectSlug,
  displayName: projectSlug,
  iconUrl: null,
  additionalPrompt: null,
  enabled: true,
  publicKeyPem: 'test',
  createdAt: new Date(),
  updatedAt: new Date(),
};

function createUseCases(overrides?: Partial<ActivityPubUseCases>): ActivityPubUseCases {
  return {
    ensureAggregateActor: async () => actor,
    findAggregateActor: async () => undefined,
    findProjectActorByProjectId: async () => undefined,
    updateAggregateActorProfile: async () => actor,
    setAggregateActorEnabled: async () => actor,
    updateProjectActorProfile: async () => actor,
    enableProjectActor: async () => actor,
    disableProjectActor: async () => ({ ...actor, enabled: false }),
    getInstanceConfig: async () => ({
      id: 1,
      objectRepresentation: 'article',
      representationLockedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    updateInstanceRepresentation: async () => ({
      id: 1,
      objectRepresentation: 'article',
      representationLockedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    ...overrides,
  };
}

test('parseProjectFederationRequest rejects malformed bodies', () => {
  assert.throws(() => parseProjectFederationRequest(null), ActivityPubAdminError);
  assert.throws(() => parseProjectFederationRequest({ enabled: 'yes' }), ActivityPubAdminError);
  assert.throws(
    () => parseProjectFederationRequest({ enabled: false, preferredUsername: 'demo' }),
    /only allowed when enabling/i,
  );
  assert.throws(
    () => parseProjectFederationRequest({ enabled: true, preferredUsername: 'all' }),
    /cannot be all/i,
  );
  assert.throws(
    () => parseProjectFederationRequest({ enabled: true, preferredUsername: '' }),
    /must not be empty/i,
  );
  assert.throws(
    () => parseProjectFederationRequest({ enabled: true, extra: true }),
    /Unknown request field/i,
  );
});

test('patchProjectFederation rejects tenant crossing before use cases run', async () => {
  let useCaseCalled = false;
  const sql = createAuthSql({
    id: projectId,
    slug: 'other-project',
    appRole: 'member',
    projectRole: 'admin',
    visibility: 'public',
  });
  await assert.rejects(
    () =>
      patchProjectFederation({
        sql,
        userId: 'user-1',
        projectSlug,
        body: { enabled: true },
        encryptionKey,
        useCases: createUseCases({
          enableProjectActor: async () => {
            useCaseCalled = true;
            return actor;
          },
        }),
      }),
    (error: unknown) => error instanceof ActivityPubAdminError && error.status === 403,
  );
  assert.equal(useCaseCalled, false);
});

test('patchProjectFederation rejects invalid slug before repository calls', async () => {
  await assert.rejects(
    () =>
      patchProjectFederation({
        sql: createThrowingSql(),
        userId: 'user-1',
        projectSlug: 'a',
        body: { enabled: true },
        encryptionKey,
        useCases: createUseCases(),
      }),
    (error: unknown) =>
      error instanceof ActivityPubAdminError &&
      error.code === 'invalid_slug' &&
      error.status === 400,
  );
});

test('mapActivityPubAdminError maps unexpected public.projects errors to internal 500', () => {
  const mapped = mapActivityPubAdminError(new Error('relation "public.projects" does not exist'));
  assert.ok(mapped instanceof ActivityPubAdminError);
  assert.equal(mapped.code, 'activitypub_internal_error');
  assert.equal(mapped.message, 'An unexpected error occurred');
  assert.equal(mapped.status, 500);
  assert.equal(mapped.message.includes('public.projects'), false);
  assert.notEqual(mapped.code, 'project_not_public');
});

test('patchProjectFederation maps unexpected auth lookup failures to internal error', async () => {
  await assert.rejects(
    () =>
      patchProjectFederation({
        sql: createFailingAuthSql('relation "public.projects" does not exist'),
        userId: 'user-1',
        projectSlug,
        body: { enabled: true },
        encryptionKey,
        useCases: createUseCases(),
      }),
    (error: unknown) =>
      error instanceof ActivityPubAdminError &&
      error.code === 'activitypub_internal_error' &&
      error.status === 500,
  );
});

test('patchProjectFederation rejects non-admin users', async () => {
  const sql = createAuthSql(undefined);
  await assert.rejects(
    () =>
      patchProjectFederation({
        sql,
        userId: 'user-1',
        projectSlug,
        body: { enabled: true },
        encryptionKey,
        useCases: createUseCases(),
      }),
    (error: unknown) => error instanceof ActivityPubAdminError && error.status === 403,
  );
});

test('patchProjectFederation enables federation for project admins', async () => {
  const sql = createAuthSql({
    id: projectId,
    slug: projectSlug,
    appRole: 'member',
    projectRole: 'admin',
    visibility: 'public',
  });
  const response = await patchProjectFederation({
    sql,
    userId: 'user-1',
    projectSlug,
    body: { enabled: true },
    encryptionKey,
    useCases: createUseCases(),
  });
  assert.equal(response.enabled, true);
  assert.equal(response.preferredUsername, projectSlug);
});

test('patchProjectFederation allows app admins via authz contract', async () => {
  const sql = createAuthSql({
    id: projectId,
    slug: projectSlug,
    appRole: 'admin',
    projectRole: null,
    visibility: 'public',
  });
  const response = await patchProjectFederation({
    sql,
    userId: 'user-1',
    projectSlug,
    body: { enabled: true },
    encryptionKey,
    useCases: createUseCases(),
  });
  assert.equal(response.enabled, true);
});

test('patchProjectFederation rejects private project enable', async () => {
  const sql = createAuthSql({
    id: projectId,
    slug: projectSlug,
    appRole: 'member',
    projectRole: 'admin',
    visibility: 'private',
  });
  await assert.rejects(
    () =>
      patchProjectFederation({
        sql,
        userId: 'user-1',
        projectSlug,
        body: { enabled: true },
        encryptionKey,
        useCases: createUseCases({
          enableProjectActor: async () => {
            throw new ActivityPubProjectNotPublicError(projectId);
          },
        }),
      }),
    (error: unknown) =>
      error instanceof ActivityPubAdminError &&
      error.code === 'project_not_public' &&
      error.status === 400,
  );
});

test('patchProjectFederation returns disabled response', async () => {
  const sql = createAuthSql({
    id: projectId,
    slug: projectSlug,
    appRole: 'member',
    projectRole: 'admin',
    visibility: 'public',
  });
  const response = await patchProjectFederation({
    sql,
    userId: 'user-1',
    projectSlug,
    body: { enabled: false },
    encryptionKey,
    useCases: createUseCases(),
  });
  assert.equal(response.enabled, false);
});

function createFailingAuthSql(message: string) {
  return (async () => {
    throw new Error(message);
  }) as never;
}

function createThrowingSql(): never {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('SQL should not be called');
      },
    },
  ) as never;
}

function createAuthSql(access?: {
  id: string;
  slug: string;
  appRole: 'admin' | 'member';
  projectRole: 'admin' | 'member' | null;
  visibility: 'public' | 'private';
}) {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = String.raw({ raw: strings }, ...values);
    if (query.includes('FROM public.projects p')) {
      if (!access) {
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
          visibility: access.visibility,
          appRole: access.appRole,
          projectRole: access.projectRole,
        },
      ];
    }
    if (query.includes('FROM public.projects') && query.includes('visibility')) {
      if (!access) {
        throw new Error('Project scope mismatch');
      }
      return [{ visibility: access.visibility }];
    }
    throw new Error(`Unexpected SQL in test: ${query}`);
  }) as never;
}
