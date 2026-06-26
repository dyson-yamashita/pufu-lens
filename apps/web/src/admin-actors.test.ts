import assert from 'node:assert/strict';
import {
  actorPairKey,
  buildActorMergeCandidates,
  type ProjectActorSummary,
  resolveActorManualMergeSelection,
} from './admin-actors.ts';

const baseActor = {
  actorType: 'person',
  aliases: [],
  createdAt: '2026-06-13 08:00',
  disabledAt: 'none',
  disabledByUserId: 'none',
  disabledReason: 'none',
  graphNodeId: 'actor:unresolved',
  mergedIntoActorId: 'none',
  mergedIntoActorName: 'none',
  primaryEmail: 'none',
  primaryLogin: 'none',
  sourceTypes: [],
  status: 'active',
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

const missingNameCandidates = buildActorMergeCandidates([
  { ...baseActor, displayName: undefined as unknown as string, id: 'actor-missing-a' },
  { ...baseActor, displayName: null as unknown as string, id: 'actor-missing-b' },
]);

assert.equal(missingNameCandidates.length, 0);

const inactiveCandidates = buildActorMergeCandidates([
  { ...baseActor, displayName: 'Inactive Actor', id: 'actor-active' },
  { ...baseActor, displayName: 'Inactive Actor', id: 'actor-merged', status: 'merged' },
]);

assert.equal(inactiveCandidates.length, 0);

const rejectedPairCandidates = buildActorMergeCandidates(
  [
    { ...baseActor, displayName: 'Rejected Actor', id: 'actor-rejected-a' },
    { ...baseActor, displayName: 'Rejected Actor', id: 'actor-rejected-b' },
  ],
  new Set([actorPairKey('actor-rejected-b', 'actor-rejected-a')]),
);

assert.equal(rejectedPairCandidates.length, 0);

const manualMergeSelection = resolveActorManualMergeSelection(
  [
    { ...baseActor, displayName: 'Primary Actor', id: 'actor-primary' },
    { ...baseActor, displayName: 'Secondary Actor', id: 'actor-secondary' },
    { ...baseActor, displayName: 'Merged Actor', id: 'actor-merged', status: 'merged' },
  ],
  {
    primaryActorId: 'actor-primary',
    secondaryActorId: 'actor-secondary',
  },
);

assert.equal(manualMergeSelection.hasDuplicateSelection, false);
assert.equal(manualMergeSelection.primaryActor?.id, 'actor-primary');
assert.equal(manualMergeSelection.secondaryActor?.id, 'actor-secondary');

const inactiveManualMergeSelection = resolveActorManualMergeSelection(
  [
    { ...baseActor, displayName: 'Active Actor', id: 'actor-active' },
    { ...baseActor, displayName: 'Merged Actor', id: 'actor-merged', status: 'merged' },
  ],
  {
    primaryActorId: 'actor-active',
    secondaryActorId: 'actor-merged',
  },
);

assert.equal(inactiveManualMergeSelection.primaryActor?.id, 'actor-active');
assert.equal(inactiveManualMergeSelection.secondaryActor, null);

const duplicateManualMergeSelection = resolveActorManualMergeSelection(
  [{ ...baseActor, displayName: 'Duplicate Actor', id: 'actor-duplicate' }],
  {
    primaryActorId: 'actor-duplicate',
    secondaryActorId: 'actor-duplicate',
  },
);

assert.equal(duplicateManualMergeSelection.hasDuplicateSelection, true);
assert.equal(duplicateManualMergeSelection.primaryActor?.id, 'actor-duplicate');
assert.equal(duplicateManualMergeSelection.secondaryActor?.id, 'actor-duplicate');

console.log('web admin actors tests passed');
