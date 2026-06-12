import type postgres from 'postgres';

export type ProjectMemberRole = 'admin' | 'member';
export type AppMemberRole = 'admin' | 'member';

export interface ProjectMemberAccess {
  appRole: AppMemberRole;
  graphName: string | null;
  id: string;
  name: string;
  projectRole: ProjectMemberRole | null;
  slug: string;
  visibility: 'private' | 'public';
}

export async function lookupProjectMemberAccess(
  sql: postgres.Sql | postgres.TransactionSql,
  input: { projectSlug: string; userId: string },
): Promise<ProjectMemberAccess | undefined> {
  const rows = (await sql`
    SELECT
      p.id::text AS id,
      p.slug,
      p.name,
      p.graph_name AS "graphName",
      COALESCE(p.visibility, 'private') AS visibility,
      app_user.role AS "appRole",
      pm.role AS "projectRole"
    FROM public.projects p
    JOIN public.users app_user
      ON app_user.id = ${input.userId}
    LEFT JOIN public.project_members pm
      ON pm.project_id = p.id
     AND pm.user_id = app_user.id
    WHERE p.slug = ${input.projectSlug}
      AND (app_user.role = 'admin' OR pm.user_id IS NOT NULL)
    LIMIT 1
  `) as ProjectMemberAccess[];
  return rows[0];
}

export async function lookupProjectAdminAccess(
  sql: postgres.Sql | postgres.TransactionSql,
  input: { projectSlug: string; userId: string },
): Promise<ProjectMemberAccess | undefined> {
  const access = await lookupProjectMemberAccess(sql, input);
  if (!access) {
    return undefined;
  }
  return access.appRole === 'admin' || access.projectRole === 'admin' ? access : undefined;
}
