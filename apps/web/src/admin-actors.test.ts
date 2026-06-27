import assert from 'node:assert/strict';
import { buildProjectActorSummary } from './admin-actors.ts';

const actor = buildProjectActorSummary(
  {
    actor_type: 'person',
    created_at: '2026-06-13T08:00:00.000Z',
    disabled_at: null,
    disabled_by_user_id: null,
    disabled_reason: null,
    display_name: 'Alex Kim',
    graph_node_id: 'actor:github_login:alex-kim',
    id: 'actor-github',
    merged_into_actor_id: null,
    merged_into_actor_name: null,
    metadata: { resolution: { sourceType: 'github' } },
    primary_email: null,
    primary_login: 'alex-kim',
    status: 'active',
    updated_at: '2026-06-13T08:00:00.000Z',
  },
  [
    {
      aliasType: 'github_login',
      aliasValue: 'alex-kim',
      confidence: 1,
      source: 'github:author',
    },
  ],
);

assert.equal(actor.aliasCount, actor.aliases.length);
assert.equal(actor.aliases[0]?.aliasType, 'github_login');
assert.equal(actor.createdAt, '2026-06-13 17:00');
assert.equal(actor.primaryEmail, 'none');
assert.deepEqual(actor.sourceTypes, ['github']);

console.log('web admin actors tests passed');
