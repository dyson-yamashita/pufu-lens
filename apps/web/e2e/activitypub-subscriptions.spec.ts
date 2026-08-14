import { expect, test } from '@playwright/test';

test('scenario: activitypub subscription panel admin and member states @mobile', async ({
  page,
}) => {
  await page.goto('/dev/e2e/activitypub-subscriptions');

  const adminPanel = page.getByTestId('activitypub-subscription-e2e-admin-enabled');
  await expect(adminPanel).toBeVisible();
  await expect(adminPanel.getByTestId('activitypub-subscription-address-input')).toBeVisible();
  await expect(adminPanel.getByTestId('activitypub-subscription-follow-button')).toBeVisible();
  await expect(
    adminPanel.getByTestId(
      'activitypub-subscription-item-https%3A%2F%2Fremote.fixture.example%2Fusers%2Falice',
    ),
  ).toBeVisible();
  await expect(adminPanel.getByTestId('activitypub-federation-disable-button')).toBeVisible();

  const memberPanel = page.getByTestId('activitypub-subscription-e2e-member');
  await expect(memberPanel).toBeVisible();
  await expect(memberPanel.getByTestId('activitypub-subscription-address-input')).toHaveCount(0);
  await expect(memberPanel.getByTestId('activitypub-subscription-unfollow-form')).toHaveCount(0);
  await expect(memberPanel.getByTestId('activitypub-federation-form')).toHaveCount(0);
});

test('scenario: activitypub federation controls show enable, disable, and ineligible states', async ({
  page,
}) => {
  await page.goto('/dev/e2e/activitypub-subscriptions');

  const enabledAdmin = page.getByTestId('activitypub-subscription-e2e-admin-enabled');
  await expect(enabledAdmin.getByTestId('activitypub-federation-disable-button')).toBeVisible();
  await expect(enabledAdmin.getByTestId('activitypub-federation-enable-button')).toHaveCount(0);

  const disabledAdmin = page.getByTestId('activitypub-subscription-e2e-admin-disabled');
  await expect(disabledAdmin.getByTestId('activitypub-federation-enable-button')).toBeVisible();
  await expect(disabledAdmin.getByTestId('activitypub-federation-disable-button')).toHaveCount(0);
  await expect(disabledAdmin.getByTestId('activitypub-subscription-follow-form')).toHaveCount(0);

  const ineligibleAdmin = page.getByTestId('activitypub-subscription-e2e-admin-ineligible');
  await expect(ineligibleAdmin.getByTestId('activitypub-federation-enable-button')).toBeDisabled();
  await expect(
    ineligibleAdmin.getByTestId('activitypub-federation-public-required-hint'),
  ).toHaveText('This project must be public before ActivityPub can be enabled.');
});

test('scenario: activitypub federation enable shows pending submit state', async ({ page }) => {
  await page.goto('/dev/e2e/activitypub-subscriptions');

  const disabledAdmin = page.getByTestId('activitypub-subscription-e2e-admin-disabled');
  const enableButton = disabledAdmin.getByTestId('activitypub-federation-enable-button');
  await enableButton.click();
  await expect(enableButton).toBeDisabled();
});

test('scenario: activitypub federation enable shows safe action error from failing action', async ({
  page,
}) => {
  await page.goto('/dev/e2e/activitypub-subscriptions');

  const errorPanel = page.getByTestId('activitypub-subscription-e2e-federation-error');
  await errorPanel.getByTestId('activitypub-federation-enable-button').click();
  await expect(errorPanel.getByRole('alert')).toHaveText(
    'Project must be public to enable ActivityPub federation',
  );
});

test('scenario: activitypub subscription follow shows safe resolver error from failing action', async ({
  page,
}) => {
  await page.goto('/dev/e2e/activitypub-subscriptions');
  const errorPanel = page.getByTestId('activitypub-subscription-e2e-follow-error');
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

  const adminPanel = page.getByTestId('activitypub-subscription-e2e-admin-enabled');
  const addressInput = adminPanel.getByTestId('activitypub-subscription-address-input');
  await addressInput.fill('acct:alice@remote.fixture.example');
  await adminPanel.getByTestId('activitypub-subscription-follow-button').click();
  await expect(adminPanel.getByTestId('activitypub-subscription-follow-button')).toBeDisabled();
});

test('scenario: activitypub subscription unfollow shows pending submit state', async ({ page }) => {
  await page.goto('/dev/e2e/activitypub-subscriptions');
  const unfollowButton = page
    .getByTestId('activitypub-subscription-e2e-admin-enabled')
    .getByTestId(
      'activitypub-subscription-unfollow-https%3A%2F%2Fremote.fixture.example%2Fusers%2Falice',
    );
  await unfollowButton.click();
  await expect(unfollowButton).toBeDisabled();
});

test('scenario: activitypub subscription unfollow resolver error shows safe alert', async ({
  page,
}) => {
  await page.goto('/dev/e2e/activitypub-subscriptions');
  const errorPanel = page.getByTestId('activitypub-subscription-e2e-follow-error');
  await errorPanel
    .getByTestId(
      'activitypub-subscription-unfollow-https%3A%2F%2Fremote.fixture.example%2Fusers%2Fbob',
    )
    .click();
  await expect(errorPanel.getByRole('alert')).toHaveText(
    'The remote actor address could not be resolved.',
  );
});
