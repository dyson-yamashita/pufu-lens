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
