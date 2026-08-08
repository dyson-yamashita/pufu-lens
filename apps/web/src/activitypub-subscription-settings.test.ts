import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activityPubSubscriptionStatusLabel,
  createDefaultActivityPubSubscriptionSettingsView,
} from './activitypub-subscription-presentation.ts';
import { readProjectActivityPubSubscriptionSettings } from './activitypub-subscription-settings.ts';

test('readProjectActivityPubSubscriptionSettings rejects malformed actor SQL row', async () => {
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = String.raw({ raw: strings }, ...values);
    if (query.includes('FROM public.projects p')) {
      return [
        {
          id: 'a0000000-0000-0000-0000-000000000001',
          enabled: true,
          preferred_username: 123,
          project_id: '10000000-0000-0000-0000-000000000001',
        },
      ];
    }
    throw new Error(`Unexpected SQL in test: ${query}`);
  }) as never;

  await assert.rejects(
    () => readProjectActivityPubSubscriptionSettings(sql, { projectSlug: 'sample-project' }),
    /preferred_username must be a non-empty string/,
  );
});

test('createDefaultActivityPubSubscriptionSettingsView returns deterministic fixture data', () => {
  const view = createDefaultActivityPubSubscriptionSettingsView();
  assert.equal(view.federationEnabled, true);
  assert.equal(view.preferredUsername, 'sample-a');
  assert.equal(view.subscriptions.length, 2);
  assert.equal(view.subscriptions[0]?.status, 'accepted');
});

test('activityPubSubscriptionStatusLabel maps follow statuses', () => {
  assert.equal(activityPubSubscriptionStatusLabel('pending'), 'Pending');
  assert.equal(activityPubSubscriptionStatusLabel('accepted'), 'Accepted');
  assert.equal(activityPubSubscriptionStatusLabel('undone'), 'Undone');
});
