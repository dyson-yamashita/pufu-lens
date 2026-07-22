import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  DEFAULT_HYBRID_SEARCH_DOCUMENT_LIMIT,
  hybridSearchDocumentLimitFromSettings,
  MAX_HYBRID_SEARCH_DOCUMENT_LIMIT,
  MIN_HYBRID_SEARCH_DOCUMENT_LIMIT,
  requireHybridSearchDocumentLimit,
} from './project-chat-settings.ts';

test('project hybrid-search settings use five by default and accept bounded integers', () => {
  assert.equal(DEFAULT_HYBRID_SEARCH_DOCUMENT_LIMIT, 5);
  assert.equal(hybridSearchDocumentLimitFromSettings(undefined), 5);
  assert.equal(hybridSearchDocumentLimitFromSettings({}), 5);
  assert.equal(hybridSearchDocumentLimitFromSettings({ hybridSearchDocumentLimit: 8 }), 8);
  assert.equal(hybridSearchDocumentLimitFromSettings({ hybridSearchDocumentLimit: '8' }), 5);
  assert.equal(
    hybridSearchDocumentLimitFromSettings({
      hybridSearchDocumentLimit: MAX_HYBRID_SEARCH_DOCUMENT_LIMIT + 1,
    }),
    5,
  );
  assert.equal(requireHybridSearchDocumentLimit(String(MIN_HYBRID_SEARCH_DOCUMENT_LIMIT)), 1);
  assert.equal(requireHybridSearchDocumentLimit(String(MAX_HYBRID_SEARCH_DOCUMENT_LIMIT)), 20);
  assert.throws(() => requireHybridSearchDocumentLimit('0'), /must be between 1 and 20/);
  assert.throws(() => requireHybridSearchDocumentLimit('1.5'), /must be an integer/);
});

test('project settings action preserves unrelated JSON settings and settings UI exposes the limit', async () => {
  const [actionSource, pageSource] = await Promise.all([
    readFile(new URL('./admin-project-actions.ts', import.meta.url), 'utf8'),
    readFile(
      new URL('../app/projects/[projectSlug]/admin/settings/page.tsx', import.meta.url),
      'utf8',
    ),
  ]);
  assert.match(actionSource, /settings = jsonb_set\(/);
  assert.match(actionSource, /HYBRID_SEARCH_DOCUMENT_LIMIT_SETTING_KEY/);
  assert.match(pageSource, /name="hybridSearchDocumentLimit"/);
  assert.match(pageSource, /project-settings-hybrid-search-document-limit-input/);
});
