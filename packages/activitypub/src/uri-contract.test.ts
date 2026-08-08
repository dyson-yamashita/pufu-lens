import assert from 'node:assert/strict';
import test from 'node:test';
import { buildActivityPubUriContract } from './uri-contract.ts';

const canonicalOrigin = 'https://lens.test';

test('buildActivityPubUriContract preserves canonical slugs and UUIDs', () => {
  const uri = buildActivityPubUriContract(canonicalOrigin);
  const reportId = '30000000-0000-0000-0000-000000000001';

  assert.equal(uri.actorUrl('all'), `${canonicalOrigin}/activitypub/actors/all`);
  assert.equal(
    uri.actorUrl('sample-project'),
    `${canonicalOrigin}/activitypub/actors/sample-project`,
  );
  assert.equal(
    uri.reportArticleUrl(reportId),
    `${canonicalOrigin}/activitypub/reports/${reportId}`,
  );
  assert.equal(
    uri.publicReportUrl('sample-project', reportId),
    `${canonicalOrigin}/reports/public/sample-project/${reportId}`,
  );
});

test('buildActivityPubUriContract encodes special characters in path segments', () => {
  const uri = buildActivityPubUriContract(canonicalOrigin);
  const username = 'a/b%c';
  const projectSlug = 'proj/slug';
  const reportId = 'rep/id';

  assert.equal(
    uri.actorUrl(username),
    `${canonicalOrigin}/activitypub/actors/${encodeURIComponent(username)}`,
  );
  assert.equal(
    uri.personalInboxUrl(username),
    `${canonicalOrigin}/activitypub/actors/${encodeURIComponent(username)}/inbox`,
  );
  assert.equal(
    uri.publicReportUrl(projectSlug, reportId),
    `${canonicalOrigin}/reports/public/${encodeURIComponent(projectSlug)}/${encodeURIComponent(reportId)}`,
  );
});
