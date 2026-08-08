import assert from 'node:assert/strict';
import test from 'node:test';
import type postgres from 'postgres';
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

  await assert.rejects(() => repository.enableProjectActor({ projectId, projectSlug }), /public/i);
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

test('enableProjectActor rolls back when project scope does not match id', async () => {
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
      input.updateActorEnabled?.(false);
      const row = input.getActorRows?.()[0];
      return row ? [{ ...row, enabled: false }] : [];
    }
    return [];
  }) as postgres.Sql;

  executor.begin = (async (callback: (tx: postgres.TransactionSql) => Promise<unknown>) => {
    input.onBegin?.();
    return callback(executor as unknown as postgres.TransactionSql);
  }) as postgres.Sql['begin'];
  return executor;
}
