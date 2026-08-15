import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseAggregateActivityPubProfileRow,
  parseProjectActivityPubProfileRow,
  readProjectActivityPubProfileSettings,
  readServerActivityPubProfileSettings,
} from './activitypub-profile-settings.ts';

function createSqlMock(rows: readonly unknown[]) {
  return Object.assign(async () => rows, { begin: async () => [] }) as never;
}

test('parseAggregateActivityPubProfileRow parses nullable profile columns', () => {
  const parsed = parseAggregateActivityPubProfileRow({
    id: 'actor-id',
    preferred_username: 'all',
    display_name: 'All Projects',
    icon_url: null,
    additional_prompt: 'server tone',
    enabled: false,
  });
  assert.equal(parsed.enabled, false);
  assert.equal(parsed.additional_prompt, 'server tone');
});

test('readServerActivityPubProfileSettings keeps disabled aggregate profile editable', async () => {
  const settings = await readServerActivityPubProfileSettings(
    createSqlMock([
      {
        id: 'aggregate-id',
        preferred_username: 'all',
        display_name: 'All Projects',
        icon_url: '/logo.png',
        additional_prompt: 'server tone',
        enabled: false,
      },
    ]),
  );
  assert.equal(settings.federationEnabled, false);
  assert.equal(settings.profileSavePendingHint, null);
  assert.equal(settings.canEditProfile, true);
});

test('readServerActivityPubProfileSettings pending save only when aggregate actor is missing', async () => {
  const settings = await readServerActivityPubProfileSettings(createSqlMock([]));
  assert.match(settings.profileSavePendingHint ?? '', /before saving profile settings/i);
});

test('readProjectActivityPubProfileSettings hides prompt from members', async () => {
  const settings = await readProjectActivityPubProfileSettings(
    createSqlMock([
      {
        id: 'project-actor-id',
        project_id: 'project-id',
        preferred_username: 'sample-a',
        display_name: 'Sample A',
        icon_url: null,
        additional_prompt: 'secret prompt',
        enabled: true,
      },
    ]),
    { projectSlug: 'sample-a', canManage: false },
  );
  assert.equal(settings.additionalPrompt, null);
  assert.equal(settings.canEditPrompt, false);
});

test('readProjectActivityPubProfileSettings keeps disabled project actor profile editable', async () => {
  const settings = await readProjectActivityPubProfileSettings(
    createSqlMock([
      {
        id: 'project-actor-id',
        project_id: 'project-id',
        preferred_username: 'sample-a',
        display_name: 'Sample A',
        icon_url: null,
        additional_prompt: 'project tone',
        enabled: false,
      },
    ]),
    { projectSlug: 'sample-a', canManage: true },
  );
  assert.equal(settings.federationEnabled, false);
  assert.equal(settings.profileSavePendingHint, null);
  assert.equal(settings.additionalPrompt, 'project tone');
});

test('readProjectActivityPubProfileSettings pending save only when project actor is missing', async () => {
  const settings = await readProjectActivityPubProfileSettings(
    createSqlMock([
      {
        id: null,
        project_id: 'project-id',
      },
    ]),
    { projectSlug: 'sample-a', canManage: true },
  );
  assert.match(settings.profileSavePendingHint ?? '', /before saving profile settings/i);
});

test('parseProjectActivityPubProfileRow requires project_id', () => {
  assert.throws(
    () =>
      parseProjectActivityPubProfileRow({
        id: 'actor-id',
        preferred_username: 'sample-a',
        display_name: 'Sample',
        icon_url: null,
        additional_prompt: null,
        enabled: true,
      }),
    /project_id/,
  );
});
