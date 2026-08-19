import type { GraphMutationRepository } from '@pufu-lens/graph';
import type postgres from 'postgres';
import { type AdminActionActorRow, parseAdminActionActorRow } from './admin-actions-guards.ts';

export interface ExecuteActorMergeInput {
  readonly adminUserId: string;
  readonly primaryActorId: string;
  readonly projectId: string;
  readonly reason: string | null;
  readonly secondaryActorId: string;
}

/**
 * Merges a secondary actor into a primary actor within the caller's open transaction.
 *
 * Relational reassignment, merge decision recording, and graph mutation reconciliation run
 * atomically. Graph mutation unavailable results or invariant failures reject the transaction
 * so relational updates roll back with the graph work.
 *
 * @param tx - Open postgres.js transaction that must remain uncommitted until this returns.
 * @param mutationRepository - Project-scoped graph mutation capability bound to the same transaction.
 * @param input - Project-scoped actor pair and merge metadata already validated by the caller.
 * @throws When either actor is missing, inactive, graph merge is unavailable, or reconciliation fails.
 */
export async function executeActorMerge(
  tx: postgres.TransactionSql,
  mutationRepository: GraphMutationRepository,
  input: ExecuteActorMergeInput,
): Promise<void> {
  const { primaryActor, secondaryActor } = await lookupProjectActorPairForUpdate(tx, {
    primaryActorId: input.primaryActorId,
    projectId: input.projectId,
    secondaryActorId: input.secondaryActorId,
  });
  requireActiveActors(primaryActor, secondaryActor, 'merged');

  await tx`
    UPDATE public.actor_aliases
    SET actor_id = ${primaryActor.id}
    WHERE project_id = ${input.projectId}
      AND actor_id = ${secondaryActor.id}
  `;
  await tx`
    UPDATE public.email_quotes
    SET sender_actor_id = ${primaryActor.id}
    WHERE project_id = ${input.projectId}
      AND sender_actor_id = ${secondaryActor.id}
  `;
  const updatedRows = (await tx`
    UPDATE public.actors
    SET status = 'merged',
        merged_into_actor_id = ${primaryActor.id},
        disabled_at = now(),
        disabled_by_user_id = ${input.adminUserId},
        disabled_reason = ${input.reason ?? `Merged into ${primaryActor.displayName}`},
        updated_at = now()
    WHERE project_id = ${input.projectId}
      AND id = ${secondaryActor.id}
      AND status = 'active'
    RETURNING
      id::text AS id,
      display_name AS "displayName",
      graph_node_id AS "graphNodeId",
      status
  `) as readonly unknown[];
  const updatedActor = updatedRows[0] ? parseAdminActionActorRow(updatedRows[0]) : undefined;
  if (!updatedActor) {
    throw new Error('Actor merge failed because the secondary actor is no longer active.');
  }
  await upsertActorDecision(tx, {
    createdByUserId: input.adminUserId,
    decisionType: 'merge',
    metadata: {
      secondaryActorDisplayName: secondaryActor.displayName,
      source: 'admin-actor-actions',
    },
    primaryActorId: primaryActor.id,
    projectId: input.projectId,
    reason: input.reason,
    secondaryActorId: secondaryActor.id,
  });

  const mergeResult = await mutationRepository.mergeActorGraphNodes({
    projectId: input.projectId,
    primaryActorId: primaryActor.id,
    primaryGraphNodeId: primaryActor.graphNodeId,
    secondaryGraphNodeId: secondaryActor.graphNodeId,
  });
  if (mergeResult.status === 'unavailable') {
    throw new Error('Actor graph merge unavailable.');
  }
}

async function lookupProjectActorPairForUpdate(
  sql: postgres.TransactionSql,
  input: {
    readonly primaryActorId: string;
    readonly projectId: string;
    readonly secondaryActorId: string;
  },
): Promise<{
  readonly primaryActor: AdminActionActorRow;
  readonly secondaryActor: AdminActionActorRow;
}> {
  const actorIds = [input.primaryActorId, input.secondaryActorId].sort();
  const rows = (await sql`
    SELECT
      id::text AS id,
      display_name AS "displayName",
      graph_node_id AS "graphNodeId",
      status
    FROM public.actors
    WHERE project_id = ${input.projectId}
      AND id IN ${sql(actorIds)}
    ORDER BY id
    FOR UPDATE
  `) as readonly unknown[];
  const actors = rows.map(parseAdminActionActorRow);
  const primaryActor = actors.find((actor) => actor.id === input.primaryActorId);
  const secondaryActor = actors.find((actor) => actor.id === input.secondaryActorId);
  if (!primaryActor || !secondaryActor) {
    throw new Error('Actor not found in project.');
  }
  return { primaryActor, secondaryActor };
}

function requireActiveActors(
  primaryActor: AdminActionActorRow,
  secondaryActor: AdminActionActorRow,
  action: 'merged',
): void {
  if (primaryActor.status !== 'active' || secondaryActor.status !== 'active') {
    throw new Error(`Only active actors can be ${action}.`);
  }
}

async function upsertActorDecision(
  sql: postgres.TransactionSql,
  input: {
    readonly createdByUserId: string;
    readonly decisionType: 'merge';
    readonly metadata: postgres.JSONValue;
    readonly primaryActorId: string;
    readonly projectId: string;
    readonly reason: string | null;
    readonly secondaryActorId: string;
  },
): Promise<void> {
  await sql`
    INSERT INTO public.actor_merge_decisions (
      project_id,
      primary_actor_id,
      secondary_actor_id,
      decision_type,
      reason,
      metadata,
      created_by_user_id
    )
    VALUES (
      ${input.projectId},
      ${input.primaryActorId},
      ${input.secondaryActorId},
      ${input.decisionType},
      ${input.reason},
      ${sql.json(input.metadata)},
      ${input.createdByUserId}
    )
    ON CONFLICT DO NOTHING
  `;
}
