import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import type postgres from 'postgres';

const scryptAsync = promisify(scrypt);
const keyLength = 64;
const saltBytes = 16;

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

export function createPostgresPasswordCredentialRepository(sql: SqlExecutor) {
  return {
    async createOrUpdatePasswordCredential(input: {
      readonly email: string;
      readonly name: string | null;
      readonly password: string;
    }): Promise<string> {
      const email = normalizeEmail(input.email);
      if (!email) {
        throw new Error('email is required.');
      }
      const passwordHash = await hashPassword(input.password);
      const rows = await sql<{ id: string }[]>`
        INSERT INTO public.users (email, name, role)
        VALUES (${email}, ${input.name}, 'member')
        ON CONFLICT (email) DO UPDATE SET name = COALESCE(EXCLUDED.name, public.users.name)
        RETURNING id::text
      `;
      const user = rows[0];
      if (!user) {
        throw new Error('Failed to create credentials user.');
      }
      await sql`
        INSERT INTO public.auth_password_credentials (user_id, password_hash)
        VALUES (${user.id}, ${passwordHash})
        ON CONFLICT (user_id)
        DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()
      `;
      return user.id;
    },
  };
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(saltBytes).toString('base64url');
  const hash = (await scryptAsync(password, salt, keyLength)) as Buffer;
  return `scrypt:v1:${salt}:${hash.toString('base64url')}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
