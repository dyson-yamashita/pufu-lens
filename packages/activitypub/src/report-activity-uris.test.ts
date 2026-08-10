import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildStableAnnounceActivityUri,
  buildStableCreateActivityUri,
} from './report-activity-uris.ts';

test('report activity URIs are stable and idempotent for the same report', () => {
  const input = {
    canonicalOrigin: 'https://lens.test',
    reportId: '11111111-1111-1111-1111-111111111111',
  };
  assert.equal(
    buildStableCreateActivityUri(input),
    'https://lens.test/activitypub/activities/create/11111111-1111-1111-1111-111111111111',
  );
  assert.equal(
    buildStableAnnounceActivityUri(input),
    'https://lens.test/activitypub/activities/announce/11111111-1111-1111-1111-111111111111',
  );
  assert.equal(buildStableCreateActivityUri(input), buildStableCreateActivityUri(input));
  assert.equal(buildStableAnnounceActivityUri(input), buildStableAnnounceActivityUri(input));
});

test('report activity URIs normalize trailing slash origins and uppercase hostnames', () => {
  const reportId = '11111111-1111-1111-1111-111111111111';
  const normalized = {
    canonicalOrigin: 'https://LENS.TEST/',
    reportId,
  };
  assert.equal(
    buildStableCreateActivityUri(normalized),
    'https://lens.test/activitypub/activities/create/11111111-1111-1111-1111-111111111111',
  );
  assert.equal(
    buildStableAnnounceActivityUri(normalized),
    'https://lens.test/activitypub/activities/announce/11111111-1111-1111-1111-111111111111',
  );
});
