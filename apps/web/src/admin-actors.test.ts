import assert from 'node:assert/strict';
import type { ProjectActorSummary } from './admin-actors.ts';

const actor = {
  actorType: 'person',
  aliasCount: 1,
  aliases: [
    {
      aliasType: 'github_login',
      aliasValue: 'alex-kim',
      confidence: 1,
      source: 'github:author',
    },
  ],
  createdAt: '2026-06-13 08:00',
  disabledAt: 'none',
  disabledByUserId: 'none',
  disabledReason: 'none',
  displayName: 'Alex Kim',
  graphNodeId: 'actor:github_login:alex-kim',
  id: 'actor-github',
  mergedIntoActorId: 'none',
  mergedIntoActorName: 'none',
  primaryEmail: 'none',
  primaryLogin: 'alex-kim',
  sourceTypes: ['github'],
  status: 'active',
  updatedAt: '2026-06-13 08:00',
} satisfies ProjectActorSummary;

assert.equal(actor.aliasCount, actor.aliases.length);
assert.equal(actor.aliases[0]?.aliasType, 'github_login');

console.log('web admin actors tests passed');
