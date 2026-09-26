import assert from 'node:assert/strict';
import test from 'node:test';
import { portableKeywordTerms, portableKeywordTypoPattern } from './portable-keyword-query.ts';

test('literal punctuation is never sent to trigram or typo approximation', () => {
  for (const query of ['80%', 'x_y', 'D:\\logs', '.*', 'a|b', '3.14']) {
    const [term] = portableKeywordTerms(query);
    assert.ok(term);
    assert.equal(term.approximate, '');
    assert.equal(term.pattern, '');
  }
});

test('PostgreSQL boundary preserves LIKE escaping and POSIX spaces after shared term parsing', () => {
  assert.equal(portableKeywordTerms('x_y')[0]?.literal, '%x\\_y%');
  assert.equal(portableKeywordTerms('80%')[0]?.literal, '%80\\%%');
  assert.equal(portableKeywordTerms('D:\\logs')[0]?.literal, '%D:\\\\logs%');
  assert.ok(portableKeywordTerms('release 12')[0]?.pattern.includes('[[:space:]]+12'));
});

test('label-number phrases preserve role and cannot bypass boundary via substring matching', () => {
  const terms = portableKeywordTerms('deployment 42 cycle 17');
  assert.equal(terms.length, 2);
  assert.ok(terms.every((term) => term.literal === '' && term.approximate === ''));
  assert.match(terms[0]?.pattern ?? '', /42\(\[\^0-9\]\|\$\)/);
  assert.match(terms[1]?.pattern ?? '', /17\(\[\^0-9\]\|\$\)/);
  assert.equal(portableKeywordTerms('42 17').length, 2);
  assert.equal(portableKeywordTerms(' ').length, 0);
});

test('typo variants are bounded and cannot become arbitrary regex or edits to digits', () => {
  assert.ok(new RegExp(portableKeywordTypoPattern('deplyoment')).test('deployment'));
  assert.ok(new RegExp(portableKeywordTypoPattern('機設計能')).test('機能設計'));
  assert.ok(new RegExp(portableKeywordTypoPattern('サクヲ')).test('サクラ'));
  for (const query of ['ab', 'サヲ', 'x'.repeat(13), '123', 'ab.*', 'a(b)', 'ééé']) {
    assert.equal(portableKeywordTypoPattern(query), '');
  }
  assert.ok(portableKeywordTypoPattern('一二三四五六七八九十百千').length < 2100);
});
