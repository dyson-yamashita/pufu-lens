import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('global navigation orders Projects, Accounts, then Settings for app admins', () => {
  const source = readFileSync(fileURLToPath(new URL('./ui.tsx', import.meta.url)), 'utf8');
  const projectsIndex = source.indexOf('data-testid="global-nav-projects"');
  const accountsIndex = source.indexOf('data-testid="global-nav-members"');
  const settingsIndex = source.indexOf('data-testid="global-nav-app-settings"');
  assert.ok(projectsIndex >= 0);
  assert.ok(accountsIndex > projectsIndex);
  assert.ok(settingsIndex > accountsIndex);
});
