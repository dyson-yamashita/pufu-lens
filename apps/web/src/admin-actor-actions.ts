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

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

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
    await sql.begin(async (tx) => {
      const primaryActor = await lookupProjectActor(tx, project.id, primaryActorId);
      const secondaryActor = await lookupProjectActor(tx, project.id, secondaryActorId);
      if (primaryActor.status !== 'active' || secondaryActor.status !== 'active') {
        throw new Error('Only active actors can be merged.');
      }

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
      await tx`
        UPDATE public.actors
        SET status = 'merged',
            merged_into_actor_id = ${primaryActor.id},
            disabled_at = now(),
            disabled_by_user_id = ${project.adminUserId},
            disabled_reason = ${reason ?? `Merged into ${primaryActor.displayName}`},
            updated_at = now()
        WHERE project_id = ${project.id}
          AND id = ${secondaryActor.id}
      `;
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
  });

  revalidateActorPaths(projectSlug, primaryActorId, secondaryActorId);
}

export async function rejectActorMergeCandidate(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const primaryActorId = requireFormValue(formData, 'primaryActorId');
  const secondaryActorId = requireFormValue(formData, 'secondaryActorId');
  const reason = optionalFormValue(formData, 'reason');

  if (primaryActorId === secondaryActorId) {
    throw new Error('Cannot reject an actor against itself.');
  }

  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    await sql.begin(async (tx) => {
      await lookupProjectActor(tx, project.id, primaryActorId);
      await lookupProjectActor(tx, project.id, secondaryActorId);
      await upsertActorDecision(tx, {
        createdByUserId: project.adminUserId,
        decisionType: 'reject',
        metadata: { source: 'admin-actor-actions' },
        primaryActorId,
        projectId: project.id,
        reason,
        secondaryActorId,
      });
    });
  });

  revalidateActorPaths(projectSlug, primaryActorId, secondaryActorId);
}

async function lookupProjectActor(
  sql: SqlExecutor,
  projectId: string,
  actorId: string,
): Promise<AdminActionActorRow> {
  const rows = (await sql`
    SELECT
      id::text AS id,
      display_name AS "displayName",
      status
    FROM public.actors
    WHERE project_id = ${projectId}
      AND id = ${actorId}
    LIMIT 1
  `) as readonly unknown[];
  const actor = rows[0] ? parseAdminActionActorRow(rows[0]) : undefined;
  if (!actor) {
    throw new Error('Actor not found in project.');
  }
  return actor;
}

async function upsertActorDecision(
  sql: postgres.TransactionSql,
  input: {
    readonly createdByUserId: string;
    readonly decisionType: 'merge' | 'reject';
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
