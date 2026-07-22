import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHAT_SEARCH_CALENDAR_YEAR_MAX,
  CHAT_SEARCH_CALENDAR_YEAR_MIN,
  CHAT_SEARCH_PERIOD_MAX_SPAN_DAYS,
  hasChatSearchPeriod,
  isChatSearchIsoInstant,
  normalizeTimelineTopicQuery,
  parseChatSearchPeriod,
  validateChatSearchPeriod,
} from './chat-search-period.ts';

const NOW_ISO = '2026-07-22T00:30:00.000Z';

test('parseChatSearchPeriod resolves YYYY年 as Asia/Tokyo calendar-year boundaries', () => {
  const parsed = parseChatSearchPeriod('2025年の取り組みについて', NOW_ISO);
  assert.ok(parsed);
  assert.deepEqual(parsed.period, {
    startAt: '2024-12-31T15:00:00.000Z',
    endAt: '2025-12-31T15:00:00.000Z',
  });
  assert.equal(parsed.topicQuery, '');
});

test('parseChatSearchPeriod resolves trailing 1年間 ending at nowIso', () => {
  const parsed = parseChatSearchPeriod('1年間の取り組みについて教えて', NOW_ISO);
  assert.ok(parsed);
  assert.deepEqual(parsed.period, {
    startAt: '2025-07-22T00:30:00.000Z',
    endAt: NOW_ISO,
  });
  assert.equal(parsed.topicQuery, '');
});

test('parseChatSearchPeriod clamps trailing one-year start across a Tokyo leap day', () => {
  const leapNowIso = '2024-02-29T06:00:00.000Z';
  const parsed = parseChatSearchPeriod('1年間の取り組み', leapNowIso);
  assert.ok(parsed);
  assert.deepEqual(parsed.period, {
    startAt: '2023-02-28T06:00:00.000Z',
    endAt: leapNowIso,
  });
});

test('parseChatSearchPeriod resolves 今年 and 昨年 using Asia/Tokyo calendar years', () => {
  const thisYear = parseChatSearchPeriod('今年の取り組みについて', NOW_ISO);
  assert.ok(thisYear);
  assert.deepEqual(thisYear.period, {
    startAt: '2025-12-31T15:00:00.000Z',
    endAt: '2026-12-31T15:00:00.000Z',
  });

  const lastYear = parseChatSearchPeriod('昨年の取り組みについて', NOW_ISO);
  assert.ok(lastYear);
  assert.deepEqual(lastYear.period, {
    startAt: '2024-12-31T15:00:00.000Z',
    endAt: '2025-12-31T15:00:00.000Z',
  });
});

test('parseChatSearchPeriod ignores explicit calendar years outside the supported range', () => {
  assert.equal(
    parseChatSearchPeriod(`${CHAT_SEARCH_CALENDAR_YEAR_MIN - 1}年の取り組み`, NOW_ISO),
    null,
  );
  assert.equal(
    parseChatSearchPeriod(`${CHAT_SEARCH_CALENDAR_YEAR_MAX + 1}年の取り組み`, NOW_ISO),
    null,
  );
});

test('parseChatSearchPeriod retains a scoped topic after stripping period aggregate noise', () => {
  const parsed = parseChatSearchPeriod('2025年の認証機能の取り組み', NOW_ISO);
  assert.ok(parsed);
  assert.equal(parsed.topicQuery, '認証機能');
});

test('parseChatSearchPeriod preserves internal particles in proper nouns', () => {
  const parsed = parseChatSearchPeriod('2025年のプ譜友の会の取り組み', NOW_ISO);
  assert.ok(parsed);
  assert.equal(parsed.topicQuery, 'プ譜友の会');
});

test('isChatSearchIsoInstant accepts strict ISO instants and rejects RFC-style strings', () => {
  assert.equal(isChatSearchIsoInstant('2026-07-22T00:30:00.000Z'), true);
  assert.equal(isChatSearchIsoInstant('2026-07-22T09:30:00+09:00'), true);
  assert.equal(isChatSearchIsoInstant('Thu, 01 Jan 2026 00:00:00 +00:00'), false);
  assert.equal(isChatSearchIsoInstant('2025-01-01'), false);
});

test('normalizeTimelineTopicQuery clears aggregate-only timeline questions', () => {
  assert.equal(normalizeTimelineTopicQuery('の取り組みについて'), '');
  assert.equal(normalizeTimelineTopicQuery('の取り組みについて教えて'), '');
  assert.equal(normalizeTimelineTopicQuery('認証機能の取り組み'), '認証機能');
});

test('normalizeTimelineTopicQuery strips trailing punctuation without regex backtracking', () => {
  const longTrailingPunctuation = `${'!'.repeat(10_000)}認証機能${'?'.repeat(10_000)}`;
  assert.equal(normalizeTimelineTopicQuery(longTrailingPunctuation), '認証機能');
});

test('normalizeTimelineTopicQuery strips structural の with long whitespace runs in linear time', () => {
  const longWhitespace = ' '.repeat(10_000);
  assert.equal(
    normalizeTimelineTopicQuery(`認証機能${longWhitespace}の${longWhitespace}`),
    '認証機能',
  );
  assert.equal(
    normalizeTimelineTopicQuery(`プ譜友${longWhitespace}の${longWhitespace}会の取り組み`),
    'プ譜友 会',
  );
  assert.equal(normalizeTimelineTopicQuery('プ譜友の会の取り組み'), 'プ譜友の会');
  assert.equal(normalizeTimelineTopicQuery(`認証機能${longWhitespace}詳細`), '認証機能 詳細');
});

test('normalizeTimelineTopicQuery preserves legacy structural-no normalization', () => {
  assert.equal(normalizeTimelineTopicQuery('認証機能の 詳細'), '認証機能 詳細');
  assert.equal(normalizeTimelineTopicQuery('認証機能   の   詳細'), '認証機能 詳細');
  assert.equal(normalizeTimelineTopicQuery('プ譜友   の   会の取り組み'), 'プ譜友 会');
  assert.equal(normalizeTimelineTopicQuery('プ譜友の会の取り組み'), 'プ譜友の会');
  assert.equal(normalizeTimelineTopicQuery('認証機能 の '), '認証機能');
});

test('hasChatSearchPeriod recognizes calendar and trailing-year phrases', () => {
  assert.equal(hasChatSearchPeriod('2025年の取り組みについて', NOW_ISO), true);
  assert.equal(hasChatSearchPeriod('1年間の取り組みについて教えて', NOW_ISO), true);
  assert.equal(hasChatSearchPeriod('認証機能の状況は?', NOW_ISO), false);
});

test('validateChatSearchPeriod rejects invalid, bare-date, and over-maximum ranges', () => {
  validateChatSearchPeriod({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2026-01-01T00:00:00.000Z',
  });
  assert.throws(
    () =>
      validateChatSearchPeriod({
        startAt: '2026-01-01T00:00:00.000Z',
        endAt: '2025-01-01T00:00:00.000Z',
      }),
    /startAt < endAt/,
  );
  assert.throws(
    () =>
      validateChatSearchPeriod({
        startAt: '2025-13-40T00:00:00.000Z',
        endAt: '2026-01-01T00:00:00.000Z',
      }),
    /YYYY-MM-DDTHH:mm:ss/,
  );
  assert.throws(
    () =>
      validateChatSearchPeriod({
        startAt: '2025-01-01',
        endAt: '2026-01-01T00:00:00.000Z',
      }),
    /YYYY-MM-DDTHH:mm:ss/,
  );
  assert.throws(
    () =>
      validateChatSearchPeriod({
        startAt: 'Thu, 01 Jan 2026 00:00:00 +00:00',
        endAt: '2026-07-22T00:30:00.000Z',
      }),
    /YYYY-MM-DDTHH:mm:ss/,
  );
  assert.throws(
    () =>
      validateChatSearchPeriod({
        startAt: '2015-01-01T00:00:00.000Z',
        endAt: '2026-01-01T00:00:00.000Z',
      }),
    new RegExp(`${CHAT_SEARCH_PERIOD_MAX_SPAN_DAYS} days`),
  );
});
