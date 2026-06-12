import assert from 'node:assert/strict';
import { buildActorMergeCandidates, type ProjectActorSummary } from './admin-actors.ts';

const baseActor = {
  actorType: 'person',
  aliases: [],
  createdAt: '2026-06-13 08:00',
  graphNodeId: 'actor:unresolved',
  primaryEmail: 'none',
  primaryLogin: 'none',
  sourceTypes: [],
  strongAliasCount: 0,
  updatedAt: '2026-06-13 08:00',
  weakAliasCount: 0,
} satisfies Omit<ProjectActorSummary, 'displayName' | 'id'>;

const candidates = buildActorMergeCandidates([
  {
    ...baseActor,
    aliases: [
      {
        aliasType: 'display_name',
        aliasValue: 'Alex Kim',
        confidence: 0.4,
        source: 'web:author',
        strength: 'weak',
      },
    ],
    displayName: 'Alex Kim',
    id: 'actor-web',
    sourceTypes: ['web'],
    weakAliasCount: 1,
  },
  {
    ...baseActor,
    aliases: [
      {
        aliasType: 'github_login',
        aliasValue: 'alex-kim',
        confidence: 1,
        source: 'github:author',
        strength: 'strong',
      },
    ],
    displayName: ' Alex   Kim ',
    graphNodeId: 'actor:github_login:alex-kim',
    id: 'actor-github',
    primaryLogin: 'alex-kim',
    sourceTypes: ['github'],
    strongAliasCount: 1,
  },
  {
    ...baseActor,
    displayName: 'Sam Lee',
    id: 'actor-sam',
  },
]);

assert.equal(candidates.length, 1);
assert.equal(candidates[0]?.actorA.id, 'actor-web');
assert.equal(candidates[0]?.actorB.id, 'actor-github');
assert.equal(candidates[0]?.confidence, 0.4);
assert.deepEqual(candidates[0]?.reasons, ['display_name が一致']);
assert.deepEqual(candidates[0]?.evidence, ['github', 'web']);

const commonNameCandidates = buildActorMergeCandidates(
  Array.from({ length: 20 }, (_, index) => ({
    ...baseActor,
    displayName: 'Support',
    id: `actor-support-${index}`,
  })),
);

assert.equal(commonNameCandidates.length, 105);
assert.equal(commonNameCandidates.at(-1)?.actorA.id, 'actor-support-13');
assert.equal(commonNameCandidates.at(-1)?.actorB.id, 'actor-support-14');
assert.equal(
  commonNameCandidates.some((candidate) => candidate.actorB.id === 'actor-support-15'),
  false,
);

console.log('web admin actors tests passed');
