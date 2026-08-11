import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const clientSource = readFileSync(
  resolve(import.meta.dirname, 'federated-report-client.tsx'),
  'utf8',
);

test('federated report client uses external report wording and response parser', () => {
  assert.match(clientSource, /外部レポート/u);
  assert.doesNotMatch(clientSource, /連携レポート/u);
  assert.match(clientSource, /parseFederatedReportsApiResponse/u);
  assert.match(clientSource, /rel="noopener noreferrer"/u);
  assert.match(clientSource, /target="_blank"/u);
  assert.doesNotMatch(clientSource, /escapeText/u);
});

test('federated report client exposes loading empty error and blocked states', () => {
  assert.match(clientSource, /federated-reports-loading/u);
  assert.match(clientSource, /federated-reports-empty/u);
  assert.match(clientSource, /federated-reports-error/u);
  assert.match(clientSource, /federated-reports-blocked/u);
  assert.match(clientSource, /federated-reports-mixed-blocked/u);
});
