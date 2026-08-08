import { expect, test } from '@playwright/test';

test('scenario: activitypub subscription panel admin and member states @mobile', async ({
  page,
}) => {
  await page.goto('/dev/e2e/activitypub-subscriptions');

  const adminPanel = page.getByTestId('activitypub-subscription-panel').first();
  await expect(adminPanel).toBeVisible();
  await expect(page.getByTestId('activitypub-subscription-address-input').first()).toBeVisible();
  await expect(page.getByTestId('activitypub-subscription-follow-button').first()).toBeVisible();
  await expect(
    page
      .getByTestId(
        'activitypub-subscription-item-https%3A%2F%2Fremote.fixture.example%2Fusers%2Falice',
      )
      .first(),
  ).toBeVisible();

  const memberPanel = page.getByTestId('activitypub-subscription-panel').nth(1);
  await expect(memberPanel).toBeVisible();
  await expect(memberPanel.getByTestId('activitypub-subscription-address-input')).toHaveCount(0);
  await expect(memberPanel.getByTestId('activitypub-subscription-unfollow-form')).toHaveCount(0);
});

test('scenario: activitypub subscription follow shows safe resolver error from failing action', async ({
  page,
}) => {
  await page.goto('/dev/e2e/activitypub-subscriptions');
  const errorPanel = page.getByTestId('activitypub-subscription-panel').nth(2);
  await errorPanel
    .getByTestId('activitypub-subscription-address-input')
    .fill('acct:alice@remote.fixture.example');
  await errorPanel.getByTestId('activitypub-subscription-follow-button').click();
  await expect(errorPanel.getByRole('alert')).toHaveText(
    'The remote actor address could not be resolved.',
  );
});

test('scenario: activitypub subscription follow shows pending submit state', async ({ page }) => {
  await page.goto('/dev/e2e/activitypub-subscriptions');

  const addressInput = page.getByTestId('activitypub-subscription-address-input').first();
  await addressInput.fill('acct:alice@remote.fixture.example');
  await page.getByTestId('activitypub-subscription-follow-button').first().click();
  await expect(page.getByTestId('activitypub-subscription-follow-button').first()).toBeDisabled();
});

test('scenario: activitypub subscription unfollow shows pending submit state', async ({ page }) => {
  await page.goto('/dev/e2e/activitypub-subscriptions');
  const unfollowButton = page
    .getByTestId(
      'activitypub-subscription-unfollow-https%3A%2F%2Fremote.fixture.example%2Fusers%2Falice',
    )
    .first();
  await unfollowButton.click();
  await expect(unfollowButton).toBeDisabled();
});

test('scenario: activitypub subscription unfollow resolver error shows safe alert', async ({
  page,
}) => {
  await page.goto('/dev/e2e/activitypub-subscriptions');
  const errorPanel = page.getByTestId('activitypub-subscription-panel').nth(2);
  await errorPanel
    .getByTestId(
      'activitypub-subscription-unfollow-https%3A%2F%2Fremote.fixture.example%2Fusers%2Fbob',
    )
    .click();
  await expect(errorPanel.getByRole('alert')).toHaveText(
    'The remote actor address could not be resolved.',
  );
});
