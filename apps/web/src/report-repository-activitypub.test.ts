import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresReportRepository } from './report-repository.ts';

test('setReportPublicState fails closed when ActivityPub is enabled without canonical origin', async () => {
  const previousEnabled = process.env.ACTIVITYPUB_ENABLED;
  const previousOrigin = process.env.ACTIVITYPUB_CANONICAL_ORIGIN;
  process.env.ACTIVITYPUB_ENABLED = '1';
  delete process.env.ACTIVITYPUB_CANONICAL_ORIGIN;
  let transactionStarted = false;
  const repository = createPostgresReportRepository({
    begin: async () => {
      transactionStarted = true;
      throw new Error('transaction must not start');
    },
  } as never);
  const setReportPublicState = repository.setReportPublicState;
  assert.ok(setReportPublicState);
  try {
    await assert.rejects(async () => {
      await setReportPublicState({
        isPublic: true,
        projectId: 'project-id',
        reportId: 'report-id',
        publishedAt: '2026-01-15T12:00:00.000Z',
        publicSummary: 'summary',
      });
    }, /ACTIVITYPUB_CANONICAL_ORIGIN is required/);
    assert.equal(transactionStarted, false);
  } finally {
    if (previousEnabled === undefined) {
      delete process.env.ACTIVITYPUB_ENABLED;
    } else {
      process.env.ACTIVITYPUB_ENABLED = previousEnabled;
    }
    if (previousOrigin === undefined) {
      delete process.env.ACTIVITYPUB_CANONICAL_ORIGIN;
    } else {
      process.env.ACTIVITYPUB_CANONICAL_ORIGIN = previousOrigin;
    }
  }
});

test('setReportPublicState rejects missing publishedAt before starting a transaction', async () => {
  const previousEnabled = process.env.ACTIVITYPUB_ENABLED;
  const previousOrigin = process.env.ACTIVITYPUB_CANONICAL_ORIGIN;
  process.env.ACTIVITYPUB_ENABLED = '1';
  process.env.ACTIVITYPUB_CANONICAL_ORIGIN = 'https://lens.test';
  let transactionStarted = false;
  const repository = createPostgresReportRepository({
    begin: async () => {
      transactionStarted = true;
      throw new Error('transaction must not start');
    },
  } as never);
  const setReportPublicState = repository.setReportPublicState;
  assert.ok(setReportPublicState);
  try {
    await assert.rejects(
      () =>
        setReportPublicState({
          isPublic: true,
          projectId: 'project-id',
          reportId: 'report-id',
          publicSummary: 'summary',
        }),
      /publishedAt is required/,
    );
    assert.equal(transactionStarted, false);
  } finally {
    if (previousEnabled === undefined) {
      delete process.env.ACTIVITYPUB_ENABLED;
    } else {
      process.env.ACTIVITYPUB_ENABLED = previousEnabled;
    }
    if (previousOrigin === undefined) {
      delete process.env.ACTIVITYPUB_CANONICAL_ORIGIN;
    } else {
      process.env.ACTIVITYPUB_CANONICAL_ORIGIN = previousOrigin;
    }
  }
});

test('readActivityPubPostPrompts returns null when project actor is missing or disabled', async () => {
  const missingRepository = createPostgresReportRepository(
    Object.assign(
      async (strings: TemplateStringsArray) => {
        const query = String(strings[0] ?? '');
        if (query.includes('project_actor.enabled')) {
          return [];
        }
        return [];
      },
      { begin: async () => [] },
    ) as never,
  );
  const readMissing = missingRepository.readActivityPubPostPrompts;
  assert.ok(readMissing);
  assert.equal(await readMissing({ projectId: 'project-id' }), null);

  const disabledRepository = createPostgresReportRepository(
    Object.assign(
      async (strings: TemplateStringsArray) => {
        const query = String(strings[0] ?? '');
        if (query.includes('project_actor.enabled')) {
          return [
            {
              project_enabled: false,
              project_prompt: 'project tone',
              server_prompt: 'server tone',
            },
          ];
        }
        return [];
      },
      { begin: async () => [] },
    ) as never,
  );
  const readDisabled = disabledRepository.readActivityPubPostPrompts;
  assert.ok(readDisabled);
  assert.equal(await readDisabled({ projectId: 'project-id' }), null);
});

test('readActivityPubPostPrompts returns both prompts for enabled project actors', async () => {
  const repository = createPostgresReportRepository(
    Object.assign(
      async (strings: TemplateStringsArray) => {
        const query = String(strings[0] ?? '');
        if (query.includes('project_actor.enabled')) {
          return [
            {
              project_enabled: true,
              project_prompt: 'project tone',
              server_prompt: 'server tone',
            },
          ];
        }
        return [];
      },
      { begin: async () => [] },
    ) as never,
  );
  const readActivityPubPostPrompts = repository.readActivityPubPostPrompts;
  assert.ok(readActivityPubPostPrompts);
  assert.deepEqual(await readActivityPubPostPrompts({ projectId: 'project-id' }), {
    serverPrompt: 'server tone',
    projectPrompt: 'project tone',
  });
});

test('readActivityPubPostPrompts returns serverPrompt from project actor row without aggregate enabled check', async () => {
  const repository = createPostgresReportRepository(
    Object.assign(
      async (strings: TemplateStringsArray) => {
        const query = String(strings[0] ?? '');
        if (query.includes('project_actor.enabled')) {
          return [
            {
              project_enabled: true,
              project_prompt: 'project tone',
              server_prompt: 'server tone from disabled aggregate',
            },
          ];
        }
        return [];
      },
      { begin: async () => [] },
    ) as never,
  );
  const readActivityPubPostPrompts = repository.readActivityPubPostPrompts;
  assert.ok(readActivityPubPostPrompts);
  assert.deepEqual(await readActivityPubPostPrompts({ projectId: 'project-id' }), {
    serverPrompt: 'server tone from disabled aggregate',
    projectPrompt: 'project tone',
  });
});

test('setReportPublicState rejects missing publicSummary before starting a transaction', async () => {
  const previousEnabled = process.env.ACTIVITYPUB_ENABLED;
  const previousOrigin = process.env.ACTIVITYPUB_CANONICAL_ORIGIN;
  process.env.ACTIVITYPUB_ENABLED = '1';
  process.env.ACTIVITYPUB_CANONICAL_ORIGIN = 'https://lens.test';
  let transactionStarted = false;
  const repository = createPostgresReportRepository({
    begin: async () => {
      transactionStarted = true;
      throw new Error('transaction must not start');
    },
  } as never);
  const setReportPublicState = repository.setReportPublicState;
  assert.ok(setReportPublicState);
  try {
    await assert.rejects(
      () =>
        setReportPublicState({
          isPublic: true,
          projectId: 'project-id',
          reportId: 'report-id',
          publishedAt: '2026-01-15T12:00:00.000Z',
        }),
      /publicSummary is required/,
    );
    assert.equal(transactionStarted, false);
  } finally {
    if (previousEnabled === undefined) {
      delete process.env.ACTIVITYPUB_ENABLED;
    } else {
      process.env.ACTIVITYPUB_ENABLED = previousEnabled;
    }
    if (previousOrigin === undefined) {
      delete process.env.ACTIVITYPUB_CANONICAL_ORIGIN;
    } else {
      process.env.ACTIVITYPUB_CANONICAL_ORIGIN = previousOrigin;
    }
  }
});
