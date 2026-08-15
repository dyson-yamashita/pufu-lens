import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ActivityPubActorProfileError,
  normalizeActivityPubActorProfile,
  normalizeActivityPubAdditionalPrompt,
  normalizeActivityPubDisplayName,
  normalizeActivityPubIconUrl,
  resolveActivityPubIconUrl,
} from './actor-profile.ts';

test('normalizeActivityPubIconUrl accepts blank, https, same-origin paths, and harmless @ in URL', () => {
  assert.equal(normalizeActivityPubIconUrl(''), null);
  assert.equal(normalizeActivityPubIconUrl('  '), null);
  assert.equal(
    normalizeActivityPubIconUrl('https://cdn.example.test/icon.png'),
    'https://cdn.example.test/icon.png',
  );
  assert.equal(normalizeActivityPubIconUrl('/icons/all.png'), '/icons/all.png');
  assert.equal(
    normalizeActivityPubIconUrl('https://cdn.example.test/users/@alice/icon.png'),
    'https://cdn.example.test/users/@alice/icon.png',
  );
  assert.equal(normalizeActivityPubIconUrl('/pufu-lens-logo.png'), '/pufu-lens-logo.png');
  assert.equal(normalizeActivityPubIconUrl('/icons/version..png'), '/icons/version..png');
});

test('normalizeActivityPubIconUrl rejects unsafe values without echoing input', () => {
  assert.throws(
    () => normalizeActivityPubIconUrl('//evil.example/icon.png'),
    ActivityPubActorProfileError,
  );
  assert.throws(() => normalizeActivityPubIconUrl('http://insecure.example/icon.png'), /HTTPS/i);
  assert.throws(() => normalizeActivityPubIconUrl('/\\evil.example/icon.png'), /invalid/i);
  assert.equal(
    normalizeActivityPubIconUrl('/../evil.example/icon.png'),
    '/../evil.example/icon.png',
  );
  assert.throws(
    () => normalizeActivityPubIconUrl('https://user:pass@cdn.example.test/icon.png'),
    /credentials/i,
  );
  assert.throws(
    () => normalizeActivityPubIconUrl('https://cdn.example.test/icon.png#frag'),
    /fragment/i,
  );
});

test('normalizeActivityPubIconUrl enforces max length', () => {
  const tooLong = `/${'a'.repeat(2049)}`;
  assert.throws(() => normalizeActivityPubIconUrl(tooLong), /too long/i);
});

test('normalizeActivityPubDisplayName enforces trimmed non-empty length bounds', () => {
  assert.throws(() => normalizeActivityPubDisplayName('   '), /empty/i);
  assert.throws(() => normalizeActivityPubDisplayName('a'.repeat(101)), /100 characters/i);
  assert.equal(normalizeActivityPubDisplayName('  Sample  '), 'Sample');
});

test('normalizeActivityPubAdditionalPrompt enforces max length', () => {
  assert.equal(normalizeActivityPubAdditionalPrompt('   '), null);
  assert.throws(() => normalizeActivityPubAdditionalPrompt('x'.repeat(2001)), /too long/i);
});

test('resolveActivityPubIconUrl resolves same-origin paths against canonical origin', () => {
  assert.equal(
    resolveActivityPubIconUrl({
      canonicalOrigin: 'https://lens.test',
      iconUrl: '/icons/all.png',
    }),
    'https://lens.test/icons/all.png',
  );
  assert.equal(
    resolveActivityPubIconUrl({
      canonicalOrigin: 'https://lens.test',
      iconUrl: '/icons/version..png',
    }),
    'https://lens.test/icons/version..png',
  );
});

test('normalizeActivityPubActorProfile trims display name and prompt blanks', () => {
  const normalized = normalizeActivityPubActorProfile({
    displayName: '  All Projects  ',
    iconUrl: '',
    additionalPrompt: '   ',
  });
  assert.equal(normalized.displayName, 'All Projects');
  assert.equal(normalized.iconUrl, null);
  assert.equal(normalized.additionalPrompt, null);
});
