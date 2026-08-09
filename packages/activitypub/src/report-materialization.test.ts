import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAnnounceActivityJsonLd,
  buildCreateActivityJsonLd,
  buildReportObjectJsonLd,
} from './report-materialization.ts';

const canonicalOrigin = 'https://lens.test';
const publishedAt = new Date('2026-01-15T12:00:00.000Z');

const baseContext = {
  canonicalOrigin,
  reportId: 'report-1',
  projectSlug: 'sample-project',
  title: 'Quarterly Update',
  publicSummary: 'A concise public summary.',
  publishedAt,
  projectPreferredUsername: 'sample-project',
  aggregatePreferredUsername: 'pufu',
};

test('buildCreateActivityJsonLd produces stable Article structure and audience', () => {
  const activityUri = `${canonicalOrigin}/activitypub/activities/create/report-1`;
  const activity = buildCreateActivityJsonLd({
    ...baseContext,
    activityUri,
    objectRepresentation: 'article',
  });
  assert.equal(activity.id, activityUri);
  assert.equal(activity.type, 'Create');
  assert.equal(activity.actor, `${canonicalOrigin}/activitypub/actors/sample-project`);
  assert.deepEqual(activity.to, ['https://www.w3.org/ns/activitystreams#Public']);
  assert.deepEqual(activity.cc, [`${canonicalOrigin}/activitypub/actors/sample-project/followers`]);
  const object = activity.object as Record<string, unknown>;
  assert.equal(object.type, 'Article');
  assert.equal(object.id, `${canonicalOrigin}/activitypub/reports/report-1`);
  assert.equal(object.summary, 'A concise public summary.');
  assert.equal(object.content, 'A concise public summary.');
  assert.deepEqual(object.to, ['https://www.w3.org/ns/activitystreams#Public']);
  assert.deepEqual(object.cc, [`${canonicalOrigin}/activitypub/actors/sample-project/followers`]);
});

test('buildCreateActivityJsonLd supports empty summary and Note representation', () => {
  const activityUri = `${canonicalOrigin}/activitypub/activities/create/report-1`;
  const noteObject = buildReportObjectJsonLd({
    ...baseContext,
    publicSummary: '',
    objectRepresentation: 'note',
  });
  assert.equal(noteObject.type, 'Note');
  assert.equal((noteObject as Record<string, unknown>).content, expectNoteContent(''));
  const activity = buildCreateActivityJsonLd({
    ...baseContext,
    publicSummary: '',
    activityUri,
    objectRepresentation: 'note',
  });
  assert.equal((activity.object as Record<string, unknown>).type, 'Note');
});

test('buildAnnounceActivityJsonLd preserves stable object URI and aggregate audience', () => {
  const activityUri = `${canonicalOrigin}/activitypub/activities/announce/report-1`;
  const objectUri = `${canonicalOrigin}/activitypub/reports/report-1`;
  const activity = buildAnnounceActivityJsonLd({
    canonicalOrigin,
    activityUri,
    objectUri,
    publishedAt,
    aggregatePreferredUsername: 'pufu',
  });
  assert.equal(activity.type, 'Announce');
  assert.equal(activity.actor, `${canonicalOrigin}/activitypub/actors/pufu`);
  assert.equal(activity.object, objectUri);
  assert.deepEqual(activity.cc, [`${canonicalOrigin}/activitypub/actors/pufu/followers`]);
});

function expectNoteContent(summary: string): string {
  return `<p><strong>Quarterly Update</strong></p><p>${summary}</p><p><a href="${canonicalOrigin}/reports/public/sample-project/report-1">${canonicalOrigin}/reports/public/sample-project/report-1</a></p>`;
}
