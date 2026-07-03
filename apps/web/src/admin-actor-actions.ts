'use server';

import { revalidatePath } from 'next/cache';
import type postgres from 'postgres';
import { type AdminActionActorRow, parseAdminActionActorRow } from './admin-actions-guards.ts';
import {
  requireAdminProject,
  requireFormValue,
  revalidateProject,
  withSql,
} from './admin-actions-shared.ts';
import {
  type ActorGraphReconcileInput,
  reconcileMergedActorGraphElements,
} from './graph-actor-reconcile.ts';

export async function mergeActors(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const primaryActorId = requireFormValue(formData, 'primaryActorId');
  const secondaryActorId = requireFormValue(formData, 'secondaryActorId');
  const reason = optionalFormValue(formData, 'reason');

  if (primaryActorId === secondaryActorId) {
    throw new Error('Cannot merge an actor into itself.');
  }

  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    let graphReconcileInput: ActorGraphReconcileInput | undefined;
    await sql.begin(async (tx) => {
      const { primaryActor, secondaryActor } = await lookupProjectActorPairForUpdate(tx, {
        primaryActorId,
        projectId: project.id,
        secondaryActorId,
      });
      graphReconcileInput = {
        graphName: project.graphName,
        primaryActorId: primaryActor.id,
        primaryGraphNodeId: primaryActor.graphNodeId,
        secondaryGraphNodeId: secondaryActor.graphNodeId,
      };
      requireActiveActors(primaryActor, secondaryActor, 'merged');

      await tx`
        UPDATE public.actor_aliases
        SET actor_id = ${primaryActor.id}
        WHERE project_id = ${project.id}
          AND actor_id = ${secondaryActor.id}
      `;
      await tx`
        UPDATE public.email_quotes
        SET sender_actor_id = ${primaryActor.id}
        WHERE project_id = ${project.id}
          AND sender_actor_id = ${secondaryActor.id}
      `;
      const updatedRows = (await tx`
        UPDATE public.actors
        SET status = 'merged',
            merged_into_actor_id = ${primaryActor.id},
            disabled_at = now(),
            disabled_by_user_id = ${project.adminUserId},
            disabled_reason = ${reason ?? `Merged into ${primaryActor.displayName}`},
            updated_at = now()
        WHERE project_id = ${project.id}
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
        createdByUserId: project.adminUserId,
        decisionType: 'merge',
        metadata: {
          secondaryActorDisplayName: secondaryActor.displayName,
          source: 'admin-actor-actions',
        },
        primaryActorId: primaryActor.id,
        projectId: project.id,
        reason,
        secondaryActorId: secondaryActor.id,
      });
    });
    if (graphReconcileInput) {
      await reconcileMergedActorGraphElements(sql, graphReconcileInput);
    }
  });

  revalidateActorPaths(projectSlug, primaryActorId, secondaryActorId);
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
    readonly metadata: Record<string, unknown>;
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
      ${sql.json(input.metadata as postgres.JSONValue)},
      ${input.createdByUserId}
    )
    ON CONFLICT DO NOTHING
  `;
}

function optionalFormValue(formData: FormData, key: string): string | null {
  const value = formData.get(key)?.toString().trim();
  return value ? value : null;
}

function revalidateActorPaths(
  projectSlug: string,
  primaryActorId: string,
  secondaryActorId: string,
): void {
  revalidateProject(projectSlug);
  revalidatePath(`/projects/${projectSlug}/admin/actors/${primaryActorId}`);
  revalidatePath(`/projects/${projectSlug}/admin/actors/${secondaryActorId}`);
}
