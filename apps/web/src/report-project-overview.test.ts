import assert from 'node:assert/strict';
import {
  buildExtractiveProjectOverview,
  normalizeProjectOverview,
  PROJECT_OVERVIEW_SCHEMA_VERSION,
  validateProjectOverview,
} from './report-project-overview.ts';

const validOverview = {
  assets: [
    {
      description: 'イベントで得た来場者の反応を次の改善に活かせる。',
      title: '出展フィードバック',
    },
  ],
  issues: [
    {
      description: '初見の人に価値が伝わり切らない可能性がある。',
      next_action: '説明の短文化とデモ導線の見直し',
      title: '説明の難しさ',
    },
  ],
  schema_version: PROJECT_OVERVIEW_SCHEMA_VERSION,
  status_summary: 'イベント出展を通じて、来場者との接点を増やしている。',
};

validateProjectOverview(validOverview);
assert.deepEqual(normalizeProjectOverview(validOverview), validOverview);

const redacted = normalizeProjectOverview({
  ...validOverview,
  status_summary: 'contact@example.com へ follow up',
});
assert.match(redacted.status_summary, /\[redacted-email\]/);
assert.doesNotMatch(JSON.stringify(redacted), /contact@example.com/);

assert.throws(
  () =>
    validateProjectOverview({
      ...validOverview,
      status_summary: 'secret=abc123',
    }),
  /private text/,
);

assert.throws(
  () =>
    validateProjectOverview({
      ...validOverview,
      status_summary: `token${' '.repeat(380)}secret-value`,
    }),
  /private text/,
);

const extractive = buildExtractiveProjectOverview({
  sections: [
    { id: 'activity', markdown: '概況', title: '概況' },
    {
      id: 'progress',
      markdown: '- プ譜エディターの改善を進めた\n- 出展準備を進めた',
      title: '進行状況',
    },
    {
      id: 'risks',
      markdown: '- 来場者への説明負荷が高い',
      title: '課題・次のアクション',
    },
  ],
  summary: '当期間は改善と出展準備が並行して進んだ。',
});
assert.equal(extractive.schema_version, PROJECT_OVERVIEW_SCHEMA_VERSION);
assert.equal(extractive.assets.length, 2);
assert.equal(extractive.issues.length, 1);
assert.match(extractive.status_summary, /改善と出展準備/);
assert.equal(extractive.assets[0]?.title, 'アセット 1');

assert.throws(
  () =>
    normalizeProjectOverview({
      assets: [],
      issues: [],
      schema_version: PROJECT_OVERVIEW_SCHEMA_VERSION,
      status_summary: '   ',
    }),
  /status_summary is empty/,
);

const uuidOverview = {
  ...validOverview,
  status_summary:
    'report 00000000-0000-4000-8000-000000000101 and 00000000-0000-4000-8000-000000000102',
};
assert.throws(() => validateProjectOverview(uuidOverview), /private text/);
assert.throws(() => validateProjectOverview(uuidOverview), /private text/);
assert.throws(() => validateProjectOverview(uuidOverview), /private text/);
