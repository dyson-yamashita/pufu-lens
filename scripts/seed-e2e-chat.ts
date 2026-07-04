import postgres from 'postgres';
import { createPostgresPasswordCredentialRepository } from '../apps/web/src/password-auth.ts';

const defaultDatabaseUrl = 'postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens';
const defaultEmail = 'e2e-chat-member@example.test';
const defaultName = 'E2E Chat Member';
const defaultPassword = 'pufu-lens-e2e-chat-password';
const localDevProjectSlug = 'local-dev';

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim() || defaultDatabaseUrl;
  const email = process.env.PUFU_LENS_E2E_CHAT_EMAIL?.trim() || defaultEmail;
  const password = process.env.PUFU_LENS_E2E_CHAT_PASSWORD?.trim() || defaultPassword;
  const name = process.env.PUFU_LENS_E2E_CHAT_NAME?.trim() || defaultName;

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const projectId = await ensureLocalDevProject(sql);
    const userId = await createPostgresPasswordCredentialRepository(
      sql,
    ).createOrUpdatePasswordCredential({ email, name, password });
    await sql`
      INSERT INTO public.project_members (project_id, user_id, role)
      VALUES (${projectId}, ${userId}, 'member')
      ON CONFLICT (project_id, user_id)
      DO UPDATE SET role = EXCLUDED.role
    `;
    await sql`
      DELETE FROM public.private_chat_messages
      WHERE project_id = ${projectId}
        AND user_id = ${userId}
    `;
    console.log(`e2e chat member ready: ${email} (${userId})`);
  } finally {
    await sql.end();
  }
}

async function ensureLocalDevProject(sql: postgres.Sql): Promise<string> {
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO public.projects (slug, name, description, graph_name, storage_prefix, visibility)
    VALUES (
      ${localDevProjectSlug},
      'Local Development',
      'Fixture and CLI smoke test project',
      'graph_local_dev',
      ${localDevProjectSlug},
      'private'
    )
    ON CONFLICT (slug) DO UPDATE
    SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      graph_name = EXCLUDED.graph_name,
      storage_prefix = EXCLUDED.storage_prefix,
      visibility = EXCLUDED.visibility
    RETURNING id::text
  `;
  if (!project) {
    throw new Error(`Failed to ensure ${localDevProjectSlug} project.`);
  }
  return project.id;
}

await main();
