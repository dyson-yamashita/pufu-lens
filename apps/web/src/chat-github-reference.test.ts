import assert from 'node:assert/strict';
import { test } from 'node:test';
import type postgres from 'postgres';
import {
  findChatGitHubReferenceDocumentIds,
  matchesChatGitHubReference,
  parseChatGitHubReference,
  prioritizeChatGitHubReference,
} from './chat-github-reference.ts';
import { sampleChatSource } from './test-fixtures.ts';

test('explicit references retain exact type and number without widening ambiguous inputs', () => {
  assert.deepEqual(parseChatGitHubReference('PR #770で修正した問題は？'), {
    kind: 'pull_request',
    number: '770',
  });
  assert.deepEqual(parseChatGitHubReference('Ｉｓｓｕｅ ＃７７９の状況'), {
    kind: 'issue',
    number: '779',
  });
  for (const question of [
    '#770',
    'PR #7700x',
    'PR #0',
    'PR #770 と #771',
    'PR #770とIssue #771',
    'other/repo#770 PR #770',
    'https://github.com/a/b/pull/770 PR #770',
  ]) {
    assert.equal(parseChatGitHubReference(question), undefined, question);
  }
  const target = {
    ...sampleChatSource,
    docType: 'pull_request',
    canonicalUri: 'https://github.com/example/project/pull/770',
  };
  assert.ok(matchesChatGitHubReference('PR #770の修正', target));
  for (const canonicalUri of [
    'https://github.com/example/project/pull/7700',
    'https://github.com/example/project/issues/770',
    'https://evil.test/example/project/pull/770',
  ]) {
    assert.equal(matchesChatGitHubReference('PR #770の修正', { ...target, canonicalUri }), false);
  }
  assert.deepEqual(
    prioritizeChatGitHubReference('PR #770の修正', [
      { ...sampleChatSource, documentId: 'other' },
      target,
    ]).map((s) => s.documentId),
    [target.documentId, 'other'],
  );
});

test('lookup binds project and canonical pattern, rejects ambiguous and malformed rows', async () => {
  let rows: readonly unknown[] = [{ document_id: 'target' }];
  let calls = 0;
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls++;
    assert.match(strings.join('?'), /d.project_id = \?/);
    assert.match(strings.join('?'), /LIMIT 2/);
    assert.equal(values[0], 'project-a');
    assert.equal(values[1], 'pull_request');
    const pattern = values[2];
    assert.equal(typeof pattern, 'string');
    assert.ok(new RegExp(String(pattern)).test('https://github.com/a/b/pull/770'));
    assert.ok(!new RegExp(String(pattern)).test('https://github.com/a/b/pull/7700'));
    return rows;
  }) as unknown as postgres.Sql;
  const input = { projectId: 'project-a', question: 'PR #770の修正' };
  assert.deepEqual(await findChatGitHubReferenceDocumentIds(sql, input), ['target']);
  rows = [{ document_id: 'a' }, { document_id: 'b' }];
  assert.deepEqual(await findChatGitHubReferenceDocumentIds(sql, input), []);
  rows = [{ document_id: 4 }];
  await assert.rejects(findChatGitHubReferenceDocumentIds(sql, input), /Invalid referenced/);
  assert.deepEqual(
    await findChatGitHubReferenceDocumentIds(sql, { ...input, question: '通常の質問' }),
    [],
  );
  assert.equal(calls, 3);
});
