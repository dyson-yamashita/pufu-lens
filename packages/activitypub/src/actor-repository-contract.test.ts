import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import {
  ActivityPubPreferredUsernameConflictError,
  ActivityPubProjectNotPublicError,
} from './activitypub-errors.ts';
import {
  createPostgresActivityPubRepository,
  createPostgresActivityPubTransactionRepository,
  lockProjectScopeForUpdate,
} from './actor-repository.ts';
import { createInMemoryActivityPubRepository } from './in-memory-actor-repository.ts';

const encryptionKey = Buffer.alloc(32, 5);
const projectId = '50000000-0000-0000-0000-000000000001';
const projectSlug = 'scope-project';
const customUsernameProjectId = '50000000-0000-0000-0000-000000000002';
const reservedProjectSlug = 'all';
const customPreferredUsername = 'scope-custom-username';

type ActorRow = {
  id: string;
  project_id: string;
  kind: 'project';
  preferred_username: string;
  display_name: string;
  icon_url: string | null;
  additional_prompt: string | null;
  enabled: boolean;
  public_key_pem: string;
  created_at: Date;
  updated_at: Date;
};

test('lockProjectScopeForUpdate issues FOR UPDATE and rejects scope crossing', async () => {
  const queries: string[] = [];
  const sql = createTrackingSql({
    scopeRows: [],
    onQuery: (query) => queries.push(query),
  });

  await assert.rejects(
    () => lockProjectScopeForUpdate({ sql, projectId, projectSlug: 'other-project' }),
    /scope mismatch|not found/i,
  );
  assert.match(queries.join('\n'), /FOR UPDATE/i);
});

test('enableProjectActor rejects private projects inside repository transaction', async () => {
  const repository = createPostgresActivityPubRepository({
    sql: createTrackingSql({
      scopeRows: [
        {
          id: projectId,
          slug: projectSlug,
          name: 'Scope Project',
          visibility: 'private',
        },
      ],
    }),
    encryptionKey,
  });

  await assert.rejects(
    () => repository.enableProjectActor({ projectId, projectSlug }),
    (error: unknown) => error instanceof ActivityPubProjectNotPublicError,
  );
});

test('disableProjectActor requires exact locked scope but allows private projects', async () => {
  const state = {
    actorRows: [
      {
        id: 'a0000000-0000-0000-0000-000000000001',
        project_id: projectId,
        kind: 'project' as const,
        preferred_username: projectSlug,
        display_name: 'Scope Project',
        icon_url: null,
        additional_prompt: null,
        enabled: true,
        public_key_pem: 'pem',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ] as ActorRow[],
  };
  const repository = createPostgresActivityPubRepository({
    sql: createTrackingSql({
      scopeRows: [
        {
          id: projectId,
          slug: projectSlug,
          name: 'Scope Project',
          visibility: 'private',
        },
      ],
      getActorRows: () => state.actorRows,
      updateActorEnabled: (enabled: boolean) => {
        const current = state.actorRows[0];
        if (!current) {
          return;
        }
        state.actorRows[0] = { ...current, enabled };
      },
    }),
    encryptionKey,
  });
  const actor = await repository.disableProjectActor({ projectId, projectSlug });
  assert.equal(actor.enabled, false);
});

test('enableProjectActor rejects when project scope does not match id', async () => {
  const repository = createPostgresActivityPubRepository({
    sql: createTrackingSql({
      scopeRows: [
        {
          id: 'other-id',
          slug: projectSlug,
          name: 'Scope Project',
          visibility: 'public',
        },
      ],
    }),
    encryptionKey,
  });

  await assert.rejects(
    () => repository.enableProjectActor({ projectId, projectSlug }),
    /scope mismatch|not found/i,
  );
});

test('in-memory enableProjectActor reuses stored username when preferredUsername is omitted', async () => {
  const repository = createInMemoryActivityPubRepository({
    encryptionKey,
    canonicalOrigin: 'https://lens.test',
  });
  repository.seedProject({
    id: customUsernameProjectId,
    slug: reservedProjectSlug,
    name: 'Reserved Slug Project',
    visibility: 'public',
  });

  const enabled = await repository.enableProjectActor({
    projectId: customUsernameProjectId,
    projectSlug: reservedProjectSlug,
    preferredUsername: customPreferredUsername,
  });
  const disabled = await repository.disableProjectActor({
    projectId: customUsernameProjectId,
    projectSlug: reservedProjectSlug,
  });
  const reenabled = await repository.enableProjectActor({
    projectId: customUsernameProjectId,
    projectSlug: reservedProjectSlug,
  });

  assert.equal(disabled.enabled, false);
  assert.equal(reenabled.id, enabled.id);
  assert.equal(reenabled.preferredUsername, customPreferredUsername);
  assert.equal(reenabled.publicKeyPem, enabled.publicKeyPem);
});

test('in-memory enableProjectActor rejects cross-project preferred username collisions', async () => {
  const repository = createInMemoryActivityPubRepository({
    encryptionKey,
    canonicalOrigin: 'https://lens.test',
  });
  const secondaryProjectId = '50000000-0000-0000-0000-000000000003';
  const secondaryProjectSlug = 'scope-project-2';
  const sharedPreferredUsername = 'scope-shared-username';

  repository.seedProject({
    id: projectId,
    slug: projectSlug,
    name: 'Scope Project',
    visibility: 'public',
  });
  repository.seedProject({
    id: secondaryProjectId,
    slug: secondaryProjectSlug,
    name: 'Scope Project 2',
    visibility: 'public',
  });

  const first = await repository.enableProjectActor({
    projectId,
    projectSlug,
    preferredUsername: sharedPreferredUsername,
  });

  await assert.rejects(
    () =>
      repository.enableProjectActor({
        projectId: secondaryProjectId,
        projectSlug: secondaryProjectSlug,
        preferredUsername: sharedPreferredUsername,
      }),
    (error: unknown) => error instanceof ActivityPubPreferredUsernameConflictError,
  );

  const lookup = await repository.findRemotelyVisibleActorByUsername(sharedPreferredUsername);
  assert.equal(lookup?.id, first.id);
  assert.equal(lookup?.preferredUsername, sharedPreferredUsername);
});

test('in-memory enableProjectActor rejects explicit username changes for existing actors', async () => {
  const repository = createInMemoryActivityPubRepository({
    encryptionKey,
    canonicalOrigin: 'https://lens.test',
  });
  repository.seedProject({
    id: customUsernameProjectId,
    slug: projectSlug,
    name: 'Scope Project',
    visibility: 'public',
  });
  await repository.enableProjectActor({
    projectId: customUsernameProjectId,
    projectSlug,
    preferredUsername: customPreferredUsername,
  });

  await assert.rejects(
    () =>
      repository.enableProjectActor({
        projectId: customUsernameProjectId,
        projectSlug,
        preferredUsername: 'another-username',
      }),
    /immutable/i,
  );
});

test('in-memory runInTransaction rolls back actor mutations on rejection', async () => {
  const repository = createInMemoryActivityPubRepository({
    encryptionKey,
    canonicalOrigin: 'https://lens.test',
  });
  const rollbackUsername = 'tx-rollback-username';
  repository.seedProject({
    id: projectId,
    slug: projectSlug,
    name: 'Scope Project',
    visibility: 'public',
  });

  await assert.rejects(
    () =>
      repository.runInTransaction(async (tx) => {
        await tx.enableProjectActor({
          projectId,
          projectSlug,
          preferredUsername: rollbackUsername,
        });
        throw new Error('rollback requested');
      }),
    /rollback requested/,
  );

  assert.equal(await repository.findRemotelyVisibleActorByUsername(rollbackUsername), undefined);

  const enabled = await repository.enableProjectActor({
    projectId,
    projectSlug,
    preferredUsername: rollbackUsername,
  });
  assert.equal(enabled.preferredUsername, rollbackUsername);
  assert.equal(enabled.enabled, true);
  assert.equal(
    (await repository.findRemotelyVisibleActorByUsername(rollbackUsername))?.id,
    enabled.id,
  );
});

test('findRemotelyVisibleActorByUsername SELECT includes actor profile columns', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./actor-repository.ts', import.meta.url)),
    'utf8',
  );
  const match = source.match(
    /async function findRemotelyVisibleActorByUsername[\s\S]*?SELECT([\s\S]*?)FROM public\.activitypub_actors a/,
  );
  assert.ok(match, 'findRemotelyVisibleActorByUsername SELECT must exist');
  const selectClause = match[1] ?? '';
  assert.match(selectClause, /\ba\.icon_url\b/);
  assert.match(selectClause, /\ba\.additional_prompt\b/);
});

test('in-memory findRemotelyVisibleActorByUsername returns stored profile fields', async () => {
  const repository = createInMemoryActivityPubRepository({
    encryptionKey,
    canonicalOrigin: 'https://lens.test',
  });
  await repository.seedAggregateActor();
  await repository.updateAggregateActorProfile({
    displayName: 'All Streams',
    iconUrl: '/icons/all.png',
    additionalPrompt: 'server tone',
  });

  const lookup = await repository.findRemotelyVisibleActorByUsername('all');
  assert.equal(lookup?.displayName, 'All Streams');
  assert.equal(lookup?.iconUrl, '/icons/all.png');
  assert.equal(lookup?.additionalPrompt, 'server tone');
});

test('postgres transaction repository does not start a nested root transaction', async () => {
  let beginCalls = 0;
  const state = {
    actorRows: [
      {
        id: 'a0000000-0000-0000-0000-000000000001',
        project_id: projectId,
        kind: 'project' as const,
        preferred_username: projectSlug,
        display_name: 'Scope Project',
        icon_url: null,
        additional_prompt: null,
        enabled: true,
        public_key_pem: 'pem',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ] as ActorRow[],
  };
  const sql = createTrackingSql({
    scopeRows: [
      {
        id: projectId,
        slug: projectSlug,
        name: 'Scope Project',
        visibility: 'public',
      },
    ],
    getActorRows: () => state.actorRows,
    updateActorEnabled: (enabled: boolean) => {
      const current = state.actorRows[0];
      if (!current) {
        return;
      }
      state.actorRows[0] = { ...current, enabled };
    },
    onBegin: () => {
      beginCalls += 1;
    },
  });
  const transactionRepository = createPostgresActivityPubTransactionRepository({
    sql: sql as unknown as postgres.TransactionSql,
    encryptionKey,
  });

  await transactionRepository.disableProjectActor({ projectId, projectSlug });
  assert.equal(beginCalls, 0);
});

function createTrackingSql(input: {
  scopeRows: Array<{
    id: string;
    slug: string;
    name: string;
    visibility: 'public' | 'private';
  }>;
  getActorRows?: () => ActorRow[];
  updateActorEnabled?: (enabled: boolean) => void;
  onQuery?: (query: string) => void;
  onBegin?: () => void;
}) {
  const executor = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = String.raw({ raw: strings }, ...values);
    input.onQuery?.(query);
    if (query.includes('FROM public.projects') && query.includes('FOR UPDATE')) {
      const projectIdValue = String(values[0]);
      const slugValue = String(values[1]);
      const row = input.scopeRows.find(
        (entry) => entry.id === projectIdValue && entry.slug === slugValue,
      );
      return row ? [row] : [];
    }
    if (query.includes('FROM public.activitypub_actors') && query.includes('project_id')) {
      return input.getActorRows?.() ?? [];
    }
    if (query.includes('UPDATE public.activitypub_actors')) {
      const enabledMatch = query.match(/enabled = (true|false)/i);
      const enabled = enabledMatch?.[1] === 'true';
      input.updateActorEnabled?.(enabled);
      const row = input.getActorRows?.()[0];
      return row ? [{ ...row, enabled }] : [];
    }
    return [];
  }) as postgres.Sql;

  executor.begin = (async (callback: (tx: postgres.TransactionSql) => Promise<unknown>) => {
    input.onBegin?.();
    return callback(executor as unknown as postgres.TransactionSql);
  }) as postgres.Sql['begin'];
  return executor;
}
