import postgres from 'postgres';
import { createPostgresPasswordCredentialRepository } from '../apps/web/src/password-auth.ts';

const defaultDatabaseUrl = 'postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens';
const defaultEmail = 'e2e-chat-member@example.test';
const defaultName = 'E2E Chat Member';
const defaultPassword = 'pufu-lens-e2e-chat-password';
const localDevProjectId = '00000000-0000-0000-0000-000000000101';

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim() || defaultDatabaseUrl;
  const email = process.env.PUFU_LENS_E2E_CHAT_EMAIL?.trim() || defaultEmail;
  const password = process.env.PUFU_LENS_E2E_CHAT_PASSWORD?.trim() || defaultPassword;
  const name = process.env.PUFU_LENS_E2E_CHAT_NAME?.trim() || defaultName;

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await ensureLocalDevProject(sql);
    const userId = await createPostgresPasswordCredentialRepository(
      sql,
    ).createOrUpdatePasswordCredential({ email, name, password });
    await sql`
      INSERT INTO public.project_members (project_id, user_id, role)
      VALUES (${localDevProjectId}, ${userId}, 'member')
      ON CONFLICT (project_id, user_id)
      DO UPDATE SET role = EXCLUDED.role
    `;
    await sql`
      DELETE FROM public.private_chat_messages
      WHERE project_id = ${localDevProjectId}
        AND user_id = ${userId}
    `;
    console.log(`e2e chat member ready: ${email} (${userId})`);
  } finally {
    await sql.end();
  }
}

async function ensureLocalDevProject(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO public.projects (id, slug, name, description, graph_name, storage_prefix, visibility)
    VALUES (
      ${localDevProjectId},
      'local-dev',
      'Local Development',
      'Fixture and CLI smoke test project',
      'graph_local_dev',
      'local-dev',
      'private'
    )
    ON CONFLICT (slug) DO UPDATE
    SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      graph_name = EXCLUDED.graph_name,
      storage_prefix = EXCLUDED.storage_prefix,
      visibility = EXCLUDED.visibility
  `;
}

await main();
